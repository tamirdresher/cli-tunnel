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
import readline from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'node:os';
import { redactSecrets } from './redact.js';

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

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

// ─── Session file registry (IPC via filesystem) ────────────
const sessionsDir = path.join(os.homedir(), '.cli-tunnel', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
let sessionFilePath: string | null = null;

function writeSessionFile(tunnelId: string, tunnelUrl: string, port: number): void {
  sessionFilePath = path.join(sessionsDir, `${tunnelId}.json`);
  const data = JSON.stringify({
    token: sessionToken, name: sessionName || command,
    tunnelId, tunnelUrl, port, hubMode,
    machine: os.hostname(), pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(sessionFilePath, data, { mode: 0o600 });
}

function removeSessionFile(): void {
  if (sessionFilePath) { try { fs.unlinkSync(sessionFilePath); } catch {} }
}

function readLocalSessions(): Array<{ token: string; name: string; tunnelId: string; tunnelUrl: string; port: number; hubMode: boolean }> {
  try {
    return fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8')); } catch { return null; } })
      .filter((s): s is any => s !== null && !s.hubMode);
  } catch { return []; }
}

// ─── F-18: Session TTL (4 hours) ───────────────────────────
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours
const sessionCreatedAt = Date.now();

// ─── F-02: One-time ticket store for WebSocket auth ────────
const tickets = new Map<string, { expires: number }>();

// #30: Ticket GC — clean expired tickets every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (t.expires < now) tickets.delete(id);
  }
}, 30000);

// ─── Security: Redact secrets from replay events ────────────

// ─── Bridge server ──────────────────────────────────────────
const acpEventLog: string[] = [];
const connections = new Map<string, WebSocket>();

// #10: Session TTL enforcement — periodically close expired connections
setInterval(() => {
  if (Date.now() - sessionCreatedAt > SESSION_TTL) {
    for (const [id, ws] of connections) {
      ws.close(1000, 'Session expired');
      connections.delete(id);
    }
  }
}, 60000);

// ─── F-8: Per-IP rate limiter ───────────────────────────────
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const ticketRateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, map: Map<string, { count: number; resetAt: number }>, maxRequests: number): boolean {
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || entry.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= maxRequests;
}

// Clean up rate limit maps every 60s
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) { if (entry.resetAt < now) rateLimits.delete(ip); }
  for (const [ip, entry] of ticketRateLimits) { if (entry.resetAt < now) ticketRateLimits.delete(ip); }
}, 60000);

const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || 'unknown';

  // F-8: Rate limiting for HTTP endpoints
  if (req.url?.startsWith('/api/')) {
    const isTicket = req.url === '/api/auth/ticket';
    if (isTicket) {
      if (!checkRateLimit(clientIp, ticketRateLimits, 10)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
    } else {
      if (!checkRateLimit(clientIp, rateLimits, 30)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
    }
  }
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
    const expiresAt = Date.now() + 60000;
    tickets.set(ticket, { expires: expiresAt });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ticket, expires: expiresAt }));
    return;
  }

  // F-01: Session token check for all API routes
  if (req.url?.startsWith('/api/')) {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const authToken = req.headers.authorization?.replace('Bearer ', '') || reqUrl.searchParams.get('token');
    if (authToken !== sessionToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // Hub ticket proxy — fetch ticket from local session on behalf of grid client
  if (hubMode && req.url?.startsWith('/api/proxy/ticket/') && req.method === 'POST') {
    const ticketPathMatch = req.url?.match(/^\/api\/proxy\/ticket\/(\d+)$/);
    if (!ticketPathMatch) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid port' })); return; }
    const targetPort = parseInt(ticketPathMatch[1], 10);
    if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid port' })); return;
    }
    // Find token for this port from session files
    const localSessions = readLocalSessions();
    const session = localSessions.find(s => s.port === targetPort);
    if (!session) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
    try {
      const ticketResp = await fetch(`http://127.0.0.1:${targetPort}/api/auth/ticket`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${session.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!ticketResp.ok) throw new Error('Ticket request failed');
      const ticketData = await ticketResp.json() as { ticket: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: ticketData.ticket, port: targetPort }));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session unreachable' })); return;
    }
    return;
  }

  // Sessions API
  if ((req.url === '/api/sessions' || req.url?.startsWith('/api/sessions?')) && req.method === 'GET') {
    try {
      const output = execFileSync('devtunnel', ['list', '--labels', 'cli-tunnel', '--json'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      const data = JSON.parse(output);
      const localMachine = os.hostname();
      const localSessions = hubMode ? readLocalSessions() : [];
      const tokenMap = new Map(localSessions.map(s => [s.tunnelId, s.token]));

      const sessions = (data.tunnels || []).map((t: any) => {
        const labels = t.labels || [];
        const id = t.tunnelId?.replace(/\.\w+$/, '') || t.tunnelId;
        const cluster = t.tunnelId?.split('.').pop() || 'euw';
        const portLabel = labels.find((l: string) => l.startsWith('port-'));
        const p = portLabel ? parseInt(portLabel.replace('port-', ''), 10) : 3456;
        const machine = labels[4] || 'unknown';
        const session: any = {
          id, tunnelId: t.tunnelId,
          name: labels[1] || 'unnamed',
          repo: labels[2] || 'unknown',
          branch: (labels[3] || 'unknown').replace(/_/g, '/'),
          machine,
          online: (t.hostConnections || 0) > 0,
          port: p,
          url: `https://${id}-${p}.${cluster}.devtunnels.ms`,
          isLocal: machine === localMachine,
        };
        // Attach token from local session files (hub mode only)
        const baseId = t.tunnelId?.split('.')[0] || t.tunnelId;
        const token = tokenMap.get(baseId) || tokenMap.get(t.tunnelId);
        if (token) session.hasToken = true;
        return session;
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
  // #18: Guard against malformed URI encoding
  let decodedUrl: string;
  try {
    // Strip query string before resolving file path
    const urlPath = (req.url || '/').split('?')[0]!;
    decodedUrl = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400); res.end(); return;
  }
  if (decodedUrl.includes('..')) { res.writeHead(400); res.end(); return; }
  let filePath = path.resolve(uiDir, decodedUrl === '/' ? 'index.html' : decodedUrl.replace(/^\//, ''));
  if (!filePath.startsWith(uiDir)) { res.writeHead(403); res.end(); return; }
  // #2: EISDIR guard — check if path is a directory before createReadStream
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    }
  } catch { res.writeHead(404); res.end(); return; }
  const ext = path.extname(filePath);
  const mimes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const securityHeaders: Record<string, string> = {
    'Content-Type': mimes[ext] || 'application/octet-stream',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://*.devtunnels.ms https://*.devtunnels.ms;",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
  res.writeHead(200, securityHeaders);
  // #8: Handle createReadStream errors
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) { res.writeHead(500); } res.end(); });
  stream.pipe(res);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 1048576,
  verifyClient: (info: { req: http.IncomingMessage }) => {

    // F-18: Session expiry
    if (Date.now() - sessionCreatedAt > SESSION_TTL) return false;
    // F-3: Validate origin BEFORE ticket acceptance
    const origin = info.req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const host = originUrl.hostname;
        if (host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.devtunnels.ms')) {
          return false;
        }
      } catch { return false; }
    }
    const url = new URL(info.req.url!, `http://${info.req.headers.host}`);
    // F-02: Accept one-time ticket (only auth method for WS)
    const ticket = url.searchParams.get('ticket');
    if (ticket && tickets.has(ticket)) {
      const t = tickets.get(ticket)!;
      tickets.delete(ticket); // Single use
      return t.expires > Date.now();
    }
    return false;
  },
});

// ─── Security: Audit log for remote PTY input ──────────────
const auditDir = path.join(os.homedir(), '.cli-tunnel', 'audit');
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
const auditLogPath = path.join(auditDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
const auditLog = fs.createWriteStream(auditLogPath, { flags: 'a' });
auditLog.on('error', (err) => { console.error('Audit log error:', err.message); });

wss.on('connection', (ws, req) => {
  // F-10: Connection cap (global + per-IP)
  if (connections.size >= 5) {
    ws.close(1013, 'Max connections reached');
    return;
  }
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  let perIpCount = 0;
  for (const [, c] of connections) {
    if ((c as any)._remoteAddress === remoteAddress) perIpCount++;
  }
  if (perIpCount >= 2) {
    ws.close(1013, 'Max connections per IP reached');
    return;
  }
  const id = crypto.randomUUID();
  (ws as any)._remoteAddress = remoteAddress;
  connections.set(id, ws);

  // F-10: WS ping/pong heartbeat
  (ws as any)._isAlive = true;
  ws.on('pong', () => { (ws as any)._isAlive = true; });

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
        auditLog.write(JSON.stringify({ ts: new Date().toISOString(), src: remoteAddress, type: 'pty_input', data: redactSecrets(JSON.stringify(msg.data)) }) + '\n');
        ptyProcess.write(msg.data);
      }
      // #7: NaN guard on pty_resize
      if (msg.type === 'pty_resize') {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && ptyProcess) {
          ptyProcess.resize(Math.max(1, Math.min(500, cols)), Math.max(1, Math.min(200, rows)));
        }
      }
    } catch {
      // #3: Log but do NOT write to PTY — only structured pty_input messages allowed
      auditLog.write(JSON.stringify({ ts: new Date().toISOString(), type: 'rejected', reason: 'non-json', length: raw.length }) + '\n');
    }
  });

  ws.on('close', () => connections.delete(id));
});

// F-10: WS heartbeat — ping every 30s, close unresponsive after 10s
setInterval(() => {
  for (const [id, ws] of connections) {
    if ((ws as any)._isAlive === false) {
      ws.terminate();
      connections.delete(id);
      continue;
    }
    (ws as any)._isAlive = false;
    ws.ping();
  }
}, 30000);

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
    console.log(`  ${DIM}Port:${RESET}     ${actualPort}`);
    console.log(`  ${DIM}Local URL:${RESET} http://127.0.0.1:${actualPort}?token=${sessionToken}&hub=1\n`);
  } else {
    console.log(`  ${DIM}Command:${RESET}  ${command} ${commandArgs.join(' ')}`);
    console.log(`  ${DIM}Name:${RESET}     ${displayName}`);
    console.log(`  ${DIM}Port:${RESET}     ${actualPort}`);
    console.log(`  ${DIM}Audit log:${RESET} ${auditLogPath}`);
    console.log(`  ${DIM}Local URL:${RESET} http://127.0.0.1:${actualPort}?token=${sessionToken}`);
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
      let installCmd = '';
      if (process.platform === 'win32') {
        installCmd = 'winget install Microsoft.devtunnel';
      } else if (process.platform === 'darwin') {
        installCmd = 'brew install --cask devtunnel';
      } else {
        installCmd = 'curl -sL https://aka.ms/DevTunnelCliInstall | bash';
      }
      const answer = await askUser(`  Would you like to install it now? (${GREEN}${installCmd}${RESET}) [Y/n] `);
      if (answer === '' || answer === 'y' || answer === 'yes') {
        console.log(`\n  ${DIM}Installing devtunnel...${RESET}\n`);
        try {
          const installParts = installCmd.split(' ');
          const installProc = spawn(installParts[0]!, installParts.slice(1), { stdio: 'inherit', shell: process.platform !== 'win32' && installCmd.includes('|') });
          await new Promise<void>((resolve, reject) => {
            installProc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Install exited with code ${code}`)));
            installProc.on('error', reject);
          });
          // Refresh PATH — winget updates the registry but current process has stale PATH
          if (process.platform === 'win32') {
            try {
              const userPath = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              const sysPath = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              const extractPath = (out: string) => out.split('\n').find(l => l.includes('REG_'))?.split('REG_EXPAND_SZ')[1]?.trim() || out.split('\n').find(l => l.includes('REG_'))?.split('REG_SZ')[1]?.trim() || '';
              process.env.PATH = `${extractPath(userPath)};${extractPath(sysPath)}`;
            } catch { /* keep existing PATH */ }
          }
          // Verify installation
          execFileSync('devtunnel', ['--version'], { stdio: 'pipe' });
          console.log(`\n  ${GREEN}✓${RESET} devtunnel installed successfully!\n`);
          devtunnelInstalled = true;
        } catch (err) {
          console.log(`\n  ${YELLOW}⚠${RESET} Installation failed: ${(err as Error).message}`);
          console.log(`  ${DIM}You can install it manually: ${installCmd}${RESET}\n`);
          console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
        }
      } else {
        console.log(`\n  ${DIM}More info: https://aka.ms/devtunnels/doc${RESET}`);
        console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
      }
    }

    if (devtunnelInstalled) {
      // Check if logged in before attempting tunnel creation
      try {
        const userInfo = execFileSync('devtunnel', ['user', 'show'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (userInfo.includes('not logged in') || userInfo.includes('No user') || userInfo.includes('Anonymous')) {
          throw new Error('not logged in');
        }
      } catch {
        console.log(`\n  ${YELLOW}⚠ devtunnel not authenticated.${RESET}\n`);
        const loginAnswer = await askUser(`  Would you like to log in now? [Y/n] `);
        if (loginAnswer === '' || loginAnswer === 'y' || loginAnswer === 'yes') {
          try {
            const loginProc = spawn('devtunnel', ['user', 'login'], { stdio: 'inherit' });
            await new Promise<void>((resolve, reject) => {
              loginProc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Login exited with code ${code}`)));
              loginProc.on('error', reject);
            });
            console.log(`\n  ${GREEN}✓${RESET} Logged in successfully!\n`);
          } catch {
            console.log(`\n  ${YELLOW}⚠${RESET} Login failed. Run manually: ${GREEN}devtunnel user login${RESET}\n`);
            console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
            devtunnelInstalled = false;
          }
        } else {
          console.log(`\n  ${DIM}Run this once to log in: ${GREEN}devtunnel user login${RESET}`);
          console.log(`  ${DIM}Continuing without tunnel (local only)...${RESET}\n`);
          devtunnelInstalled = false;
        }
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

      const tunnelUrlWithToken = `${url}?token=${sessionToken}${hubMode ? '&hub=1' : ''}`;
      console.log(`  ${GREEN}✓${RESET} Tunnel: ${BOLD}${tunnelUrlWithToken}${RESET}\n`);

      // Write session file for hub discovery
      writeSessionFile(tunnelId, url, actualPort);

      try {
        // @ts-ignore
        const qr = (await import('qrcode-terminal')) as any;
        qr.default.generate(tunnelUrlWithToken, { small: true }, (code: string) => console.log(code));
      } catch {}

      process.on('SIGINT', () => { removeSessionFile(); hostProc.kill(); try { execFileSync('devtunnel', ['delete', tunnelId, '--force'], { stdio: 'pipe' }); } catch {} });
      process.on('exit', () => { removeSessionFile(); hostProc.kill(); try { execFileSync('devtunnel', ['delete', tunnelId, '--force'], { stdio: 'pipe' }); } catch {} });
    } catch (err) {
      const errMsg = (err as Error).message || '';
      // Detect auth failure at create time (expired token, anonymous, etc.)
      if (errMsg.includes('Anonymous') || errMsg.includes('Unauthorized') || errMsg.includes('not permitted')) {
        console.log(`\n  ${YELLOW}⚠ devtunnel session expired or not authenticated.${RESET}\n`);
        const loginAnswer = await askUser(`  Would you like to log in now? [Y/n] `);
        if (loginAnswer === '' || loginAnswer === 'y' || loginAnswer === 'yes') {
          try {
            const loginProc = spawn('devtunnel', ['user', 'login'], { stdio: 'inherit' });
            await new Promise<void>((resolve, reject) => {
              loginProc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Login exited with code ${code}`)));
              loginProc.on('error', reject);
            });
            console.log(`\n  ${GREEN}✓${RESET} Logged in! Please run cli-tunnel again to create the tunnel.\n`);
          } catch {
            console.log(`\n  ${YELLOW}⚠${RESET} Login failed. Run manually: ${GREEN}devtunnel user login${RESET}\n`);
          }
        }
      } else {
        console.log(`  ${YELLOW}⚠${RESET} Tunnel failed: ${errMsg}\n`);
      }
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

  // Wait for user to scan QR / copy URL before starting the CLI tool
  if (hasTunnel) {
    console.log(`  ${BOLD}Press any key to start ${command}...${RESET}`);
    await new Promise<void>((resolve) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      });
    });
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

  // F-07: Security — filter dangerous environment variables for PTY
  // Blocklist approach: pass everything except known dangerous vars and secrets
  const DANGEROUS_VARS = new Set(['NODE_OPTIONS', 'NODE_REPL_HISTORY', 'NODE_EXTRA_CA_CERTS',
    'NODE_PATH', 'NODE_REDIRECT_WARNINGS', 'NODE_PENDING_DEPRECATION',
    'UV_THREADPOOL_SIZE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    'SSH_AUTH_SOCK', 'GPG_TTY',
    'PYTHONPATH', 'BASH_ENV', 'BASH_FUNC', 'JAVA_TOOL_OPTIONS', 'JAVA_OPTIONS', '_JAVA_OPTIONS',
    'PROMPT_COMMAND', 'ENV', 'ZDOTDIR', 'PERL5OPT', 'RUBYOPT']);
  const sensitivePattern = /token|secret|key|password|credential|api_key|private_key|access_key|connection_string|auth|kubeconfig|docker_host|docker_config/i;

  const safeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !DANGEROUS_VARS.has(k) && !sensitivePattern.test(k)) {
      safeEnv[k] = v;
    }
  }

  ptyProcess = nodePty.spawn(resolvedCmd, commandArgs, {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: safeEnv,
  });

  // Detect CSPRNG crash (rare Node.js + PTY issue) and show helpful message
  let earlyExitCode: number | null = null;
  const earlyExitCheck = new Promise<void>((resolve) => {
    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      earlyExitCode = exitCode;
      resolve();
    });
    setTimeout(resolve, 2000);
  });

  await earlyExitCheck;
  if (earlyExitCode !== null) {
    if (earlyExitCode === 134 || earlyExitCode === 3221226505) {
      const nodeVer = process.version;
      console.log(`  ${YELLOW}⚠${RESET} The command crashed (CSPRNG assertion failure).`);
      console.log(`  This is a known issue with Node.js ${nodeVer} + PTY on Windows.`);
      console.log(`  ${BOLD}Fix:${RESET} Install Node.js 22 LTS: ${GREEN}nvm install 22${RESET} or ${GREEN}winget install OpenJS.NodeJS.LTS${RESET}\n`);
      process.exit(1);
    } else {
      console.log(`\n${DIM}Process exited (code ${earlyExitCode}).${RESET}`);
      server.close();
      process.exit(earlyExitCode);
    }
  }

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
