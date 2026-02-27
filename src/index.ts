#!/usr/bin/env node

/**
 * cli-tunnel — Tunnel any CLI app to your phone
 *
 * Usage:
 *   cli-tunnel <command> [args...]              # local only
 *   cli-tunnel --tunnel <command> [args...]      # with devtunnel remote access
 *   cli-tunnel --tunnel --name myapp <command>   # named session
 *
 * Examples:
 *   cli-tunnel copilot --yolo
 *   cli-tunnel --tunnel copilot --yolo
 *   cli-tunnel --tunnel --name wizard copilot --agent squad
 *   cli-tunnel --tunnel python -i
 *   cli-tunnel --tunnel --port 4000 node server.js
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'node:os';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

// ─── Parse args ─────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
${BOLD}cli-tunnel${RESET} — Tunnel any CLI app to your phone

${BOLD}Usage:${RESET}
  cli-tunnel [options] <command> [args...]
  cli-tunnel                              # hub mode — sessions dashboard only

${BOLD}Options:${RESET}
  --local            Disable devtunnel (localhost only)
  --port <n>         Bridge port (default: random)
  --name <name>      Session name (shown in dashboard)
  --replay           Enable replay buffer (off by default)
  --help, -h         Show this help

${BOLD}Examples:${RESET}
  cli-tunnel copilot --yolo               # tunnel + run copilot
  cli-tunnel copilot --model claude-sonnet-4 --agent squad
  cli-tunnel k9s                          # tunnel + run k9s
  cli-tunnel python -i                    # tunnel + run python
  cli-tunnel --name wizard copilot        # named session
  cli-tunnel --local copilot --yolo       # localhost only, no devtunnel
  cli-tunnel                              # hub: see all active sessions

Devtunnel is enabled by default. All flags after the command name
pass through to the underlying app. cli-tunnel's own flags
(--local, --port, --name) must come before the command.
`);
  process.exit(0);
}

const hasLocal = args.includes('--local');
const hasTunnel = !hasLocal;
const hasReplay = args.includes('--replay');
const portIdx = args.indexOf('--port');
const port = (portIdx !== -1 && args[portIdx + 1]) ? parseInt(args[portIdx + 1]!, 10) : 0;
const nameIdx = args.indexOf('--name');
const sessionName = (nameIdx !== -1 && args[nameIdx + 1]) ? args[nameIdx + 1]! : '';

// Everything that's not our flags is the command
const ourFlags = new Set(['--local', '--tunnel', '--port', '--name', '--replay']);
const cmdArgs: string[] = [];
let skip = false;
for (let i = 0; i < args.length; i++) {
  if (skip) { skip = false; continue; }
  if (args[i] === '--port' || args[i] === '--name') { skip = true; continue; }
  if (args[i] === '--local' || args[i] === '--tunnel' || args[i] === '--replay') continue;
  cmdArgs.push(args[i]!);
}

// Hub mode — no command, just show sessions dashboard
const hubMode = cmdArgs.length === 0;

const command = hubMode ? '' : cmdArgs[0]!;
const commandArgs = hubMode ? [] : cmdArgs.slice(1);
const cwd = process.cwd();

// ─── Tunnel helpers ─────────────────────────────────────────
function sanitizeLabel(l: string): string {
  const clean = l.replace(/[^a-zA-Z0-9_\-=]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
  return clean || 'unknown';
}

function getGitInfo(): { repo: string; branch: string } {
  try {
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const repo = remote.split('/').pop()?.replace('.git', '') || 'unknown';
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || 'unknown';
    return { repo, branch };
  } catch {
    return { repo: path.basename(cwd), branch: 'unknown' };
  }
}

// ─── Security: Session token for WebSocket auth ────────────
const sessionToken = crypto.randomUUID();

// ─── F-18: Session TTL (24 hours) ──────────────────────────
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const sessionCreatedAt = Date.now();

// ─── F-02: One-time ticket store for WebSocket auth ────────
const tickets = new Map<string, { expires: number }>();

// ─── Security: Redact secrets from replay events ────────────
function redactSecrets(text: string): string {
  return text
    // Generic patterns: key=value, key: value, key="value"
    .replace(/(?:token|secret|key|password|credential|authorization|api_key|private_key|access_key|connection_string|db_pass|signing)[\s:="']+\S{8,}/gi, '[REDACTED]')
    // OpenAI keys
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED]')
    // GitHub tokens
    .replace(/gh[ps]_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    // AWS keys
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]')
    // Azure connection strings
    .replace(/DefaultEndpointsProtocol=[^;\s]{20,}/gi, '[REDACTED]')
    .replace(/AccountKey=[^;\s]{20,}/gi, 'AccountKey=[REDACTED]')
    // Database URLs
    .replace(/(postgres|mongodb|mysql|redis):\/\/[^\s"']{10,}/gi, '[REDACTED]')
    // Bearer tokens in headers
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, 'Bearer [REDACTED]');
}

// ─── Bridge server ──────────────────────────────────────────
const acpEventLog: string[] = [];
const connections = new Map<string, WebSocket>();

const server = http.createServer((req, res) => {
  // F-18: Session expiry check for API routes
  if (!hubMode && req.url?.startsWith('/api/') && Date.now() - sessionCreatedAt > SESSION_TTL) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session expired' }));
    return;
  }

  // F-02: Ticket endpoint — exchange session token for one-time WS ticket
  if (req.url === '/api/auth/ticket' && req.method === 'POST') {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== sessionToken) { res.writeHead(401); res.end(); return; }
    const ticket = crypto.randomUUID();
    tickets.set(ticket, { expires: Date.now() + 60000 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ticket, expires: Date.now() + 60000 }));
    return;
  }

  // F-01: Session token check for all API routes (skip in hub mode)
  if (!hubMode && req.url?.startsWith('/api/')) {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const authToken = req.headers.authorization?.replace('Bearer ', '') || reqUrl.searchParams.get('token');
    if (authToken !== sessionToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // Sessions API
  if (req.url === '/api/sessions' && req.method === 'GET') {
    try {
      const output = execFileSync('devtunnel', ['list', '--labels', 'cli-tunnel', '--json'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      const data = JSON.parse(output);
      const sessions = (data.tunnels || []).map((t: any) => {
        const labels = t.labels || [];
        const id = t.tunnelId?.replace(/\.\w+$/, '') || t.tunnelId;
        const cluster = t.tunnelId?.split('.').pop() || 'euw';
        const portLabel = labels.find((l: string) => l.startsWith('port-'));
        const p = portLabel ? parseInt(portLabel.replace('port-', ''), 10) : 3456;
        return {
          id, tunnelId: t.tunnelId,
          name: labels[1] || 'unnamed',
          repo: labels[2] || 'unknown',
          branch: (labels[3] || 'unknown').replace(/_/g, '/'),
          machine: labels[4] || 'unknown',
          online: (t.hostConnections || 0) > 0,
          port: p,
          url: `https://${id}-${p}.${cluster}.devtunnels.ms`,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ sessions }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ sessions: [] }));
    }
    return;
  }

  // Delete session
  if (req.url?.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const tunnelId = req.url.replace('/api/sessions/', '').replace(/\.\w+$/, '');
    if (!/^[a-zA-Z0-9._-]+$/.test(tunnelId)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Invalid tunnel ID' }));
      return;
    }
    try {
      execFileSync('devtunnel', ['delete', tunnelId, '--force'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ deleted: true }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ deleted: false }));
    }
    return;
  }

  // Static files
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../remote-ui');
  const decodedUrl = decodeURIComponent(req.url || '/');
  if (decodedUrl.includes('..')) { res.writeHead(400); res.end(); return; }
  let filePath = path.resolve(uiDir, decodedUrl === '/' ? 'index.html' : decodedUrl.replace(/^\//, ''));
  if (!filePath.startsWith(uiDir)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(filePath)) filePath = path.resolve(uiDir, 'index.html');
  const ext = path.extname(filePath);
  const mimes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const securityHeaders: Record<string, string> = {
    'Content-Type': mimes[ext] || 'application/octet-stream',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws://localhost:* wss://*.devtunnels.ms;",
  };
  res.writeHead(200, securityHeaders);
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 1048576,
  verifyClient: (info: { req: http.IncomingMessage }) => {
    if (hubMode) return true; // Hub mode doesn't need WS auth
    // F-18: Session expiry
    if (Date.now() - sessionCreatedAt > SESSION_TTL) return false;
    const url = new URL(info.req.url!, `http://${info.req.headers.host}`);
    // F-02: Accept one-time ticket
    const ticket = url.searchParams.get('ticket');
    if (ticket && tickets.has(ticket)) {
      const t = tickets.get(ticket)!;
      tickets.delete(ticket); // Single use
      return t.expires > Date.now();
    }
    // Backward compat: accept token
    if (url.searchParams.get('token') !== sessionToken) return false;
    // Validate origin if present
    const origin = info.req.headers.origin;
    if (origin && !origin.includes('devtunnels.ms') && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return false;
    }
    return true;
  },
});

// ─── Security: Audit log for remote PTY input ──────────────
const auditDir = path.join(os.homedir(), '.cli-tunnel', 'audit');
fs.mkdirSync(auditDir, { recursive: true });
const auditLogPath = path.join(auditDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
const auditLog = fs.createWriteStream(auditLogPath, { flags: 'a' });

wss.on('connection', (ws, req) => {
  // F-10: Connection cap
  if (connections.size >= 5) {
    ws.close(1013, 'Max connections reached');
    return;
  }
  const id = crypto.randomUUID();
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  connections.set(id, ws);

  // Replay history with secrets redacted (only if replay is enabled)
  if (hasReplay) {
    for (const event of acpEventLog) {
      ws.send(JSON.stringify({ type: '_replay', data: redactSecrets(event) }));
    }
    ws.send(JSON.stringify({ type: '_replay_done' }));
  }

  ws.on('message', (data) => {
    const raw = data.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'pty_input' && ptyProcess) {
        auditLog.write(JSON.stringify({ ts: new Date().toISOString(), src: remoteAddress, type: 'pty_input', data: msg.data }) + '\n');
        ptyProcess.write(msg.data);
      }
      if (msg.type === 'pty_resize' && ptyProcess) {
        const cols = Math.max(1, Math.min(500, msg.cols));
        const rows = Math.max(1, Math.min(200, msg.rows));
        ptyProcess.resize(cols, rows);
      }
    } catch {
      auditLog.write(JSON.stringify({ ts: new Date().toISOString(), src: remoteAddress, type: 'raw_input', data: raw }) + '\n');
      if (raw.length <= 100 && ptyProcess) {
        ptyProcess.write(raw + '\r');
      }
    }
  });

  ws.on('close', () => connections.delete(id));
});

function broadcast(data: string): void {
  const msg = JSON.stringify({ type: 'pty', data });
  if (hasReplay) {
    acpEventLog.push(msg);
    if (acpEventLog.length > 2000) acpEventLog.splice(0, acpEventLog.length - 2000);
  }
  for (const [, ws] of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Start bridge ───────────────────────────────────────────
let ptyProcess: any = null;

async function main() {
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' ? addr!.port : port);
    });
    server.on('error', reject);
  });

  const { repo, branch } = getGitInfo();
  const machine = os.hostname();
  const displayName = sessionName || command;

  console.log(`\n${BOLD}cli-tunnel${RESET} ${DIM}v1.1.0${RESET}\n`);
  if (hubMode) {
    console.log(`  ${BOLD}📋 Hub Mode${RESET} — sessions dashboard`);
    console.log(`  ${DIM}Port:${RESET}     ${actualPort}\n`);
  } else {
    console.log(`  ${DIM}Command:${RESET}  ${command} ${commandArgs.join(' ')}`);
    console.log(`  ${DIM}Name:${RESET}     ${displayName}`);
    console.log(`  ${DIM}Port:${RESET}     ${actualPort}`);
    console.log(`  ${DIM}Audit log:${RESET} ${auditLogPath}`);
    console.log(`  ${DIM}Session expires:${RESET} ${new Date(sessionCreatedAt + SESSION_TTL).toLocaleTimeString()}`);
  }

  // Tunnel
  if (hasTunnel) {
    // Check if devtunnel is installed
    let devtunnelInstalled = false;
    try {
      execFileSync('devtunnel', ['--version'], { stdio: 'pipe' });
      devtunnelInstalled = true;
    } catch {
      console.log(`\n  ${YELLOW}⚠ devtunnel CLI not found!${RESET}\n`);
      console.log(`  ${BOLD}To enable remote access, install Microsoft Dev Tunnels:${RESET}\n`);
      if (process.platform === 'win32') {
        console.log(`    ${GREEN}winget install Microsoft.devtunnel${RESET}`);
      } else if (process.platform === 'darwin') {
        console.log(`    ${GREEN}brew install --cask devtunnel${RESET}`);
      } else {
        console.log(`    ${GREEN}curl -sL https://aka.ms/DevTunnelCliInstall | bash${RESET}`);
      }
      console.log(`\n  Then authenticate once:\n`);
      console.log(`    ${GREEN}devtunnel user login${RESET}\n`);
      console.log(`  ${DIM}More info: https://aka.ms/devtunnels/doc${RESET}\n`);
      console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
    }

    // Check if logged in
    if (devtunnelInstalled) {
      try {
        const userInfo = execFileSync('devtunnel', ['user', 'show'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (userInfo.includes('not logged in') || userInfo.includes('No user')) {
          throw new Error('not logged in');
        }
      } catch {
        console.log(`\n  ${YELLOW}⚠ devtunnel not authenticated!${RESET}\n`);
        console.log(`  Run this once to log in:\n`);
        console.log(`    ${GREEN}devtunnel user login${RESET}\n`);
        console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
        devtunnelInstalled = false;
      }
    }

    if (devtunnelInstalled) {
      try {
      const labelValues = ['cli-tunnel', sanitizeLabel(sessionName || command), sanitizeLabel(repo), sanitizeLabel(branch), sanitizeLabel(machine), `port-${actualPort}`];
      const labelArgs = labelValues.flatMap(l => ['--labels', l]);
      const createOut = execFileSync('devtunnel', ['create', ...labelArgs, '--expiration', '1d', '--json'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const tunnelId = JSON.parse(createOut).tunnel?.tunnelId?.split('.')[0];
      const cluster = JSON.parse(createOut).tunnel?.tunnelId?.split('.')[1] || 'euw';
      execFileSync('devtunnel', ['port', 'create', tunnelId, '-p', String(actualPort), '--protocol', 'http'], { stdio: 'pipe' });
      const hostProc = spawn('devtunnel', ['host', tunnelId], { stdio: 'pipe', detached: false });

      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Tunnel timeout')), 15000);
        let out = '';
        hostProc.stdout?.on('data', (d: Buffer) => {
          out += d.toString();
          const match = out.match(/https:\/\/[^\s]+/);
          if (match) { clearTimeout(timeout); resolve(match[0]); }
        });
        hostProc.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });

      const tunnelUrlWithToken = `${url}?token=${sessionToken}`;
      console.log(`  ${GREEN}✓${RESET} Tunnel: ${BOLD}${tunnelUrlWithToken}${RESET}\n`);
      try {
        // @ts-ignore
        const qr = (await import('qrcode-terminal')) as any;
        qr.default.generate(tunnelUrlWithToken, { small: true }, (code: string) => console.log(code));
      } catch {}

      process.on('SIGINT', () => { hostProc.kill(); try { execFileSync('devtunnel', ['delete', tunnelId, '--force'], { stdio: 'pipe' }); } catch {} });
      process.on('exit', () => { hostProc.kill(); try { execFileSync('devtunnel', ['delete', tunnelId, '--force'], { stdio: 'pipe' }); } catch {} });
    } catch (err) {
      console.log(`  ${YELLOW}⚠${RESET} Tunnel failed: ${(err as Error).message}\n`);
    }
    } // end if (devtunnelInstalled)
  }

  if (hubMode) {
    // Hub mode — just serve the sessions dashboard, no PTY
    console.log(`  ${GREEN}✓${RESET} Hub running — open in browser to see all sessions\n`);
    console.log(`  ${DIM}Press Ctrl+C to stop.${RESET}\n`);
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    // Keep process alive
    await new Promise(() => {});
  }

  console.log(`  ${DIM}Starting ${command}...${RESET}\n`);

  // Spawn PTY
  const nodePty = await import('node-pty');
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;

  // Resolve command path for node-pty on Windows
  let resolvedCmd = command;
  if (process.platform === 'win32') {
    try {
      const wherePaths = execFileSync('where', [command], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n');
      // Prefer .exe or .cmd over .ps1 for node-pty compatibility
      const exePath = wherePaths.find(p => p.trim().endsWith('.exe')) || wherePaths.find(p => p.trim().endsWith('.cmd'));
      if (exePath) {
        resolvedCmd = exePath.trim();
      } else {
        // For .ps1 scripts, wrap with powershell
        resolvedCmd = 'powershell';
        commandArgs.unshift('-File', wherePaths[0]!.trim());
      }
    } catch { /* use as-is */ }
  }

  // F-07: Security — allowlist safe environment variables for PTY
  const SAFE_ENV_VARS = new Set([
    'PATH', 'HOME', 'USERPROFILE', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'USER', 'LOGNAME', 'EDITOR', 'VISUAL', 'COLORTERM', 'TERM_PROGRAM',
    'HOSTNAME', 'COMPUTERNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR', 'TMP', 'TEMP',
    'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'NODE_PATH', 'NODE_ENV', 'NODE_OPTIONS',
    'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
    'JAVA_HOME', 'MAVEN_HOME', 'GRADLE_HOME',
    'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV',
    'KUBECONFIG', 'DOCKER_HOST', 'DOCKER_CONFIG',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'SSH_AUTH_SOCK', 'GPG_TTY',
  ]);

  const safeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SAFE_ENV_VARS.has(k) && v !== undefined) {
      safeEnv[k] = v;
    }
  }

  ptyProcess = nodePty.spawn(resolvedCmd, commandArgs, {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: safeEnv,
  });

  ptyProcess.onData((data: string) => {
    process.stdout.write(data);
    broadcast(data);
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    console.log(`\n${DIM}Process exited (code ${exitCode}).${RESET}`);
    server.close();
    process.exit(exitCode);
  });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => ptyProcess.write(data.toString()));
  process.stdout.on('resize', () => ptyProcess.resize(process.stdout.columns || 120, process.stdout.rows || 30));
}

main().catch((err) => { console.error(err); process.exit(1); });
