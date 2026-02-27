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
import { execSync, spawn } from 'node:child_process';
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

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
${BOLD}cli-tunnel${RESET} — Tunnel any CLI app to your phone

${BOLD}Usage:${RESET}
  cli-tunnel [options] <command> [args...]

${BOLD}Options:${RESET}
  --tunnel           Enable remote access via devtunnel
  --port <n>         Bridge port (default: random)
  --name <name>      Session name (shown in dashboard)
  --help, -h         Show this help

${BOLD}Examples:${RESET}
  cli-tunnel copilot --yolo
  cli-tunnel --tunnel copilot --yolo
  cli-tunnel --tunnel --name wizard copilot --agent squad
  cli-tunnel --tunnel python -i
  cli-tunnel --tunnel htop

The command runs in a PTY (pseudo-terminal). You see the exact
output locally. With --tunnel, a devtunnel URL lets you see and
interact with the same session from your phone via xterm.js.

Sessions are ${BOLD}private${RESET} — only your MS/GitHub account can connect.
`);
  process.exit(0);
}

const hasTunnel = args.includes('--tunnel');
const portIdx = args.indexOf('--port');
const port = (portIdx !== -1 && args[portIdx + 1]) ? parseInt(args[portIdx + 1]!, 10) : 0;
const nameIdx = args.indexOf('--name');
const sessionName = (nameIdx !== -1 && args[nameIdx + 1]) ? args[nameIdx + 1]! : '';

// Everything that's not our flags is the command
const ourFlags = new Set(['--tunnel', '--port', '--name']);
const cmdArgs: string[] = [];
let skip = false;
for (let i = 0; i < args.length; i++) {
  if (skip) { skip = false; continue; }
  if (ourFlags.has(args[i]!) && args[i] !== '--tunnel') { skip = true; continue; }
  if (args[i] === '--tunnel') continue;
  cmdArgs.push(args[i]!);
}

if (cmdArgs.length === 0) {
  console.error('Error: no command specified. Run cli-tunnel --help for usage.');
  process.exit(1);
}

const command = cmdArgs[0]!;
const commandArgs = cmdArgs.slice(1);
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

// ─── Bridge server ──────────────────────────────────────────
const acpEventLog: string[] = [];
const connections = new Map<string, WebSocket>();

const server = http.createServer((req, res) => {
  // Sessions API
  if (req.url === '/api/sessions' && req.method === 'GET') {
    try {
      const output = execSync('devtunnel list --labels cli-tunnel --json', { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
    }
    return;
  }

  // Delete session
  if (req.url?.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const tunnelId = req.url.replace('/api/sessions/', '').replace(/\.\w+$/, '');
    try {
      execSync(`devtunnel delete ${tunnelId} --force`, { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: false }));
    }
    return;
  }

  // Static files
  const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../remote-ui');
  let filePath = path.join(uiDir, req.url === '/' ? 'index.html' : req.url || 'index.html');
  if (!filePath.startsWith(uiDir)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(filePath)) filePath = path.join(uiDir, 'index.html');
  const ext = path.extname(filePath);
  const mimes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).substring(2);
  connections.set(id, ws);

  // Replay history
  for (const event of acpEventLog) {
    ws.send(JSON.stringify({ type: '_replay', data: event }));
  }
  ws.send(JSON.stringify({ type: '_replay_done' }));

  ws.on('message', (data) => {
    const raw = data.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'pty_input' && ptyProcess) {
        ptyProcess.write(msg.data);
      }
      if (msg.type === 'pty_resize' && ptyProcess) {
        ptyProcess.resize(msg.cols, msg.rows);
      }
    } catch {
      if (ptyProcess) ptyProcess.write(raw + '\r');
    }
  });

  ws.on('close', () => connections.delete(id));
});

function broadcast(data: string): void {
  const msg = JSON.stringify({ type: 'pty', data });
  acpEventLog.push(msg);
  if (acpEventLog.length > 2000) acpEventLog.splice(0, acpEventLog.length - 2000);
  for (const [, ws] of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Start bridge ───────────────────────────────────────────
let ptyProcess: any = null;

async function main() {
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' ? addr!.port : port);
    });
    server.on('error', reject);
  });

  const { repo, branch } = getGitInfo();
  const machine = os.hostname();
  const displayName = sessionName || command;

  console.log(`\n${BOLD}cli-tunnel${RESET} ${DIM}v1.0.0${RESET}\n`);
  console.log(`  ${DIM}Command:${RESET}  ${command} ${commandArgs.join(' ')}`);
  console.log(`  ${DIM}Name:${RESET}     ${displayName}`);
  console.log(`  ${DIM}Port:${RESET}     ${actualPort}`);

  // Tunnel
  if (hasTunnel) {
    try {
      execSync('devtunnel --version', { stdio: 'pipe' });
      const labels = ['cli-tunnel', sanitizeLabel(sessionName || command), sanitizeLabel(repo), sanitizeLabel(branch), sanitizeLabel(machine), `port-${actualPort}`]
        .map(l => `--labels ${l}`).join(' ');
      const createOut = execSync(`devtunnel create ${labels} --expiration 1d --json`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const tunnelId = JSON.parse(createOut).tunnel?.tunnelId?.split('.')[0];
      const cluster = JSON.parse(createOut).tunnel?.tunnelId?.split('.')[1] || 'euw';
      execSync(`devtunnel port create ${tunnelId} -p ${actualPort} --protocol http`, { stdio: 'pipe' });
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

      console.log(`  ${GREEN}✓${RESET} Tunnel: ${BOLD}${url}${RESET}\n`);
      try {
        // @ts-ignore
        const qr = (await import('qrcode-terminal')) as any;
        qr.default.generate(url, { small: true }, (code: string) => console.log(code));
      } catch {}

      process.on('SIGINT', () => { hostProc.kill(); try { execSync(`devtunnel delete ${tunnelId} --force`, { stdio: 'pipe' }); } catch {} });
      process.on('exit', () => { hostProc.kill(); try { execSync(`devtunnel delete ${tunnelId} --force`, { stdio: 'pipe' }); } catch {} });
    } catch (err) {
      console.log(`  ${YELLOW}⚠${RESET} Tunnel failed: ${(err as Error).message}\n`);
    }
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
      const wherePaths = execSync(`where ${command}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n');
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

  ptyProcess = nodePty.spawn(resolvedCmd, commandArgs, {
    name: 'xterm-256color',
    cols, rows, cwd,
    env: process.env as Record<string, string>,
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
