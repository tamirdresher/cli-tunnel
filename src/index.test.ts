import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// ─── Helpers ────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(__dirname, '..', 'dist', 'index.js');
const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface ServerInfo {
  proc: ChildProcess;
  port: number;
  token: string;
  baseUrl: string;
  readonly stdout: string;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* already exited */ }
}

async function spawnServer(
  extraArgs: string[] = [],
  env?: Record<string, string>,
): Promise<ServerInfo> {
  const proc = spawn('node', [SERVER_SCRIPT, '--local', ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    cwd: path.resolve(__dirname, '..'),
  });

  const state = { stdout: '', resolved: false };

  return new Promise<ServerInfo>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!state.resolved) {
        state.resolved = true;
        killTree(proc.pid);
        reject(new Error(`Server start timeout.\nstdout: ${state.stdout}`));
      }
    }, 20000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      state.stdout += chunk.toString();
      if (state.resolved) return;
      const clean = state.stdout.replace(ANSI_RE, '');
      const match = clean.match(/Local URL:\s*http:\/\/127\.0\.0\.1:(\d+)\?token=([a-f0-9-]+)/);
      if (match) {
        state.resolved = true;
        clearTimeout(timeout);
        const port = parseInt(match[1]!, 10);
        const token = match[2]!;
        resolve({
          proc,
          port,
          token,
          baseUrl: `http://127.0.0.1:${port}`,
          get stdout() { return state.stdout; },
        });
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      state.stdout += chunk.toString(); // capture stderr too for debugging
    });

    proc.on('error', (err) => {
      if (!state.resolved) { state.resolved = true; clearTimeout(timeout); reject(err); }
    });

    proc.on('exit', (code) => {
      if (!state.resolved) {
        state.resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}.\nstdout: ${state.stdout}`));
      }
    });
  });
}

async function getTicket(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

async function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
    setTimeout(resolve, 2000);
  });
}

// ─── Redaction function (copied from src/index.ts — not exported) ───

function redactSecrets(text: string): string {
  return text
    .replace(/(?:token|secret|key|password|credential|authorization|api_key|private_key|access_key|connection_string|db_pass|signing)[\s:="']+\S{8,}/gi, '[REDACTED]')
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED]')
    .replace(/gh[ps]_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]')
    .replace(/DefaultEndpointsProtocol=[^;\s]{20,}/gi, '[REDACTED]')
    .replace(/AccountKey=[^;\s]{20,}/gi, 'AccountKey=[REDACTED]')
    .replace(/(postgres|mongodb|mysql|redis):\/\/[^\s"']{10,}/gi, '[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/xox[bpras]-[a-zA-Z0-9-]{10,}/g, '[REDACTED]')
    .replace(/npm_[a-zA-Z0-9]{20,}/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED]');
}

// ─── Shared server for HTTP / WS / Security tests ──────────

let mainServer: ServerInfo;

beforeAll(async () => {
  mainServer = await spawnServer(['node', '-e', 'process.stdin.resume()']);
}, 25000);

afterAll(() => {
  killTree(mainServer?.proc.pid);
});

// ─── HTTP Server Tests ─────────────────────────────────────

describe('HTTP Server', () => {
  it('1 — GET / returns 200 with HTML', async () => {
    const res = await fetch(`${mainServer.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('2 — GET /app.js returns 200 with JavaScript', async () => {
    const res = await fetch(`${mainServer.baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('3 — GET /styles.css returns 200 with CSS', async () => {
    const res = await fetch(`${mainServer.baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('4 — GET /nonexistent returns 404', async () => {
    const res = await fetch(`${mainServer.baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('5 — path traversal returns 400 or 403', async () => {
    const res = await fetch(`${mainServer.baseUrl}/..%2F..%2Fetc%2Fpasswd`);
    expect([400, 403]).toContain(res.status);
  });

  it('6 — malformed URL returns 400', async () => {
    const res = await fetch(`${mainServer.baseUrl}/%ZZ`);
    expect(res.status).toBe(400);
  });

  it('7 — security headers present on static files', async () => {
    const res = await fetch(`${mainServer.baseUrl}/`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('8 — GET /api/sessions without auth returns 401', async () => {
    const res = await fetch(`${mainServer.baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('9 — GET /api/sessions with valid token returns 200 + JSON', async () => {
    const res = await fetch(`${mainServer.baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${mainServer.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body).toHaveProperty('sessions');
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('10 — POST /api/auth/ticket without auth returns 401', async () => {
    const res = await fetch(`${mainServer.baseUrl}/api/auth/ticket`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('11 — POST /api/auth/ticket with valid token returns 200 + ticket', async () => {
    const res = await fetch(`${mainServer.baseUrl}/api/auth/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mainServer.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expires: number };
    expect(body.ticket).toBeTruthy();
    expect(typeof body.ticket).toBe('string');
    expect(body.expires).toBeGreaterThan(Date.now());
  });
});

// ─── Rate Limiting Tests ───────────────────────────────────

describe('Rate Limiting', () => {
  let rlServer: ServerInfo;

  beforeAll(async () => {
    rlServer = await spawnServer(['node', '-e', 'process.stdin.resume()']);
  }, 25000);

  afterAll(() => { killTree(rlServer?.proc.pid); });

  it('12 — returns 429 after 35+ rapid API requests', async () => {
    const requests = Array.from({ length: 35 }, () =>
      fetch(`${rlServer.baseUrl}/api/sessions`),
    );
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);
    expect(statuses).toContain(429);
  });
});

// ─── WebSocket Tests ───────────────────────────────────────

describe('WebSocket', () => {
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(openSockets.map((ws) => closeWs(ws)));
    openSockets.length = 0;
    // Brief pause to let server-side cleanup propagate
    await new Promise((r) => setTimeout(r, 200));
  });

  it('13 — WS without ticket/token is rejected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${mainServer.port}`);
    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', () => resolve('rejected'));
      ws.on('error', () => resolve('rejected'));
    });
    expect(result).toBe('rejected');
    ws.terminate();
  });

  it('14 — WS with valid ticket is accepted', async () => {
    const ticket = await getTicket(mainServer.baseUrl, mainServer.token);
    const ws = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${ticket}`,
      { headers: { Origin: 'http://localhost' } },
    );
    openSockets.push(ws);
    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', () => resolve('rejected'));
      ws.on('error', () => resolve('rejected'));
    });
    expect(result).toBe('open');
  });

  it('15 — WS with expired/invalid ticket is rejected', async () => {
    // Using a UUID that was never registered — equivalent outcome to an expired ticket
    const fakeTicket = crypto.randomUUID();
    const ws = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${fakeTicket}`,
      { headers: { Origin: 'http://localhost' } },
    );
    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', () => resolve('rejected'));
      ws.on('error', () => resolve('rejected'));
    });
    expect(result).toBe('rejected');
    ws.terminate();
  });

  it('16 — WS ticket is single-use (second attempt fails)', async () => {
    const ticket = await getTicket(mainServer.baseUrl, mainServer.token);

    // First use — succeeds
    const ws1 = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${ticket}`,
      { headers: { Origin: 'http://localhost' } },
    );
    openSockets.push(ws1);
    await new Promise<void>((resolve, reject) => {
      ws1.on('open', resolve);
      ws1.on('error', reject);
    });

    // Close ws1 first so per-IP cap doesn't interfere
    await closeWs(ws1);
    openSockets.length = 0;
    await new Promise((r) => setTimeout(r, 200));

    // Second use with same ticket — fails
    const ws2 = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${ticket}`,
      { headers: { Origin: 'http://localhost' } },
    );
    const result = await new Promise<string>((resolve) => {
      ws2.on('open', () => resolve('open'));
      ws2.on('unexpected-response', () => resolve('rejected'));
      ws2.on('error', () => resolve('rejected'));
    });
    expect(result).toBe('rejected');
    ws2.terminate();
  });

  it('17 — WS connection cap (max per IP)', async () => {
    const tickets = await Promise.all([
      getTicket(mainServer.baseUrl, mainServer.token),
      getTicket(mainServer.baseUrl, mainServer.token),
      getTicket(mainServer.baseUrl, mainServer.token),
    ]);

    const ws1 = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${tickets[0]}`,
      { headers: { Origin: 'http://localhost' } },
    );
    openSockets.push(ws1);
    await new Promise<void>((resolve) => { ws1.on('open', resolve); });

    const ws2 = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${tickets[1]}`,
      { headers: { Origin: 'http://localhost' } },
    );
    openSockets.push(ws2);
    await new Promise<void>((resolve) => { ws2.on('open', resolve); });

    // Third connection from same IP should be rejected (per-IP cap = 2)
    const ws3 = new WebSocket(
      `ws://127.0.0.1:${mainServer.port}?ticket=${tickets[2]}`,
      { headers: { Origin: 'http://localhost' } },
    );
    openSockets.push(ws3);
    const closeCode = await new Promise<number>((resolve) => {
      ws3.on('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(1013);
  });
});

// ─── Hub Mode Tests ────────────────────────────────────────

describe('Hub Mode', () => {
  let hubServer: ServerInfo;

  beforeAll(async () => {
    hubServer = await spawnServer([]); // No command = hub mode
  }, 25000);

  afterAll(() => { killTree(hubServer?.proc.pid); });

  it('18 — hub mode serves page at / (200)', async () => {
    const res = await fetch(`${hubServer.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('19 — hub mode /api/sessions requires auth token', async () => {
    const res = await fetch(`${hubServer.baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('20 — hub mode returns sessions list with valid token', async () => {
    const res = await fetch(`${hubServer.baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${hubServer.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

// ─── Security Tests ────────────────────────────────────────

describe('Security', () => {
  it('21 — CSP script-src does NOT contain unsafe-inline', async () => {
    const res = await fetch(`${mainServer.baseUrl}/`);
    const csp = res.headers.get('content-security-policy') || '';
    // script-src should not have unsafe-inline; style-src may have it
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] || '';
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('22 — HSTS header present', async () => {
    const res = await fetch(`${mainServer.baseUrl}/`);
    const hsts = res.headers.get('strict-transport-security') || '';
    expect(hsts).toContain('max-age=');
    expect(hsts).toContain('includeSubDomains');
  });

  it('23 — SSH_AUTH_SOCK not in spawned env', async () => {
    // Write a temp script that checks the env and writes result to a file
    const tmpScript = path.join(os.tmpdir(), `cli-tunnel-env-check-${Date.now()}.cjs`);
    const tmpResult = path.join(os.tmpdir(), `cli-tunnel-env-result-${Date.now()}.txt`);
    fs.writeFileSync(tmpScript, [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(tmpResult)}, String(process.env.SSH_AUTH_SOCK || "FILTERED"));`,
      'process.stdin.resume();',
    ].join('\n'));

    let envServer: ServerInfo | undefined;
    try {
      envServer = await spawnServer(
        ['node', tmpScript],
        { SSH_AUTH_SOCK: '/tmp/test-agent.sock' },
      );
      // Wait for PTY to execute the script
      await new Promise((r) => setTimeout(r, 5000));
      const result = fs.readFileSync(tmpResult, 'utf-8');
      expect(result).toBe('FILTERED');
    } finally {
      killTree(envServer?.proc.pid);
      try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpResult); } catch { /* ignore */ }
    }
  }, 30000);
});

// ─── Redaction Tests ───────────────────────────────────────

describe('Redaction', () => {
  it('24 — OpenAI key redacted', () => {
    const input = 'key is sk-abc123def456ghi789jkl012mno';
    expect(redactSecrets(input)).toContain('[REDACTED]');
    expect(redactSecrets(input)).not.toContain('sk-abc123');
  });

  it('25 — GitHub token redacted', () => {
    const input = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AB';
    expect(redactSecrets(input)).toBe('[REDACTED]');
  });

  it('26 — AWS key redacted', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE';
    expect(redactSecrets(input)).toBe('[REDACTED]');
  });

  it('27 — JWT redacted', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(jwt)).toBe('[REDACTED]');
  });

  it('28 — Slack token redacted', () => {
    const prefix = 'xox' + 'b-';
    const input = prefix + '12345678901-abcdefghijklmn';
    expect(redactSecrets(input)).toContain('[REDACTED]');
    expect(redactSecrets(input)).not.toContain(prefix);
  });

  it('29 — npm token redacted', () => {
    const input = 'npm_aBcDeFgHiJkLmNoPqRsTuVwXy';
    expect(redactSecrets(input)).toBe('[REDACTED]');
  });

  it('30 — PEM key redacted', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ0123456789ABCDEF\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED]');
  });

  it('31 — Bearer token redacted', () => {
    const input = 'Bearer abcdefghijklmnopqrstuvwxyz1234567890';
    expect(redactSecrets(input)).toContain('[REDACTED]');
    expect(redactSecrets(input)).not.toContain('abcdefghij');
  });

  it('32 — generic key=value redacted', () => {
    expect(redactSecrets('token=abc12345678901234567890')).toContain('[REDACTED]');
    expect(redactSecrets('password: supersecretpassword123')).toContain('[REDACTED]');
    expect(redactSecrets('secret="my_very_long_secret_val"')).toContain('[REDACTED]');
  });
});
