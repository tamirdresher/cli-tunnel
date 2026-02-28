# cli-tunnel

Tunnel any CLI app to your phone — see the exact terminal output in your browser and type back into it.

```bash
npx cli-tunnel --tunnel copilot --yolo
npx cli-tunnel --tunnel python -i
npx cli-tunnel --tunnel htop
```

## How It Works

1. Your command runs in a **PTY** (pseudo-terminal) — full TUI with colors, diffs, interactive prompts
2. Raw terminal output is streamed over **WebSocket** to **xterm.js** in your browser
3. **Microsoft Dev Tunnels** provide an authenticated HTTPS relay — zero servers to deploy
4. **Bidirectional**: type on your phone → keystrokes go into the CLI session
5. **Private by default**: only your Microsoft/GitHub account can access the tunnel

## Install

```bash
npm install -g cli-tunnel
```

Or use directly with npx:

```bash
npx cli-tunnel --tunnel <command> [args...]
```

## Usage

Any flags after the command name are passed directly to the underlying app — cli-tunnel doesn't interpret them.

```bash
# Start copilot with remote access (--yolo is a copilot flag, not ours)
cli-tunnel --tunnel copilot --yolo

# Pass any flags to the underlying command
cli-tunnel --tunnel copilot --model claude-sonnet-4 --agent squad
cli-tunnel --tunnel copilot --allow-all --resume

# Name your session (shows in dashboard)
cli-tunnel --tunnel --name wizard copilot --agent squad

# Specific port
cli-tunnel --tunnel --port 4000 copilot

# Works with any CLI app — all their flags pass through
cli-tunnel --tunnel python -i
cli-tunnel --tunnel vim myfile.txt
cli-tunnel --tunnel htop
cli-tunnel --tunnel ssh user@server

# Local only (no tunnel)
cli-tunnel copilot
```

**cli-tunnel's own flags** (`--tunnel`, `--port`, `--name`) must come **before** the command. Everything after the command name passes through unchanged.

## What You See on Your Phone

- **Full terminal** rendered by xterm.js — exact same output as your local terminal
- **Key bar** with ↑ ↓ → ← Tab Enter Esc Ctrl+C for mobile navigation
- **Sessions dashboard** — see all running sessions, tap to connect
- **Session cleanup** — remove stale tunnels

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Microsoft Dev Tunnels CLI](https://aka.ms/devtunnels/doc) (for `--tunnel` mode)
  ```bash
  winget install Microsoft.devtunnel   # Windows
  brew install --cask devtunnel        # macOS
  ```
  Then authenticate once: `devtunnel user login`

## Security

cli-tunnel uses a layered security model:

**Network layer** — Microsoft Dev Tunnels are private by default. Only the Microsoft or GitHub account that created the tunnel can connect. TLS encryption is handled by Microsoft's relay infrastructure. No inbound ports are opened on your machine.

**Session authentication** — Each session generates a unique token (cryptographic random UUID). All HTTP API and WebSocket connections require this token. The token is embedded in the URL you receive at startup — anyone without it cannot connect.

**WebSocket auth** — cli-tunnel uses a ticket-based handshake: the browser exchanges the session token for a single-use, short-lived ticket (60 seconds) to establish the WebSocket connection. This avoids keeping the long-lived token in WebSocket upgrade logs.

**Input validation** — Only structured JSON messages are accepted over WebSocket. Raw text is rejected and logged. Terminal resize commands are bounds-checked to prevent abuse.

**Environment isolation** — The child process receives a filtered set of environment variables (an allowlist of ~40 safe variables like PATH, HOME, TERM). Sensitive variables and NODE_OPTIONS are excluded to prevent code injection.

**Audit logging** — All remote keyboard input is logged to `~/.cli-tunnel/audit/` in JSONL format with timestamps and source addresses. Secrets are automatically redacted from audit entries.

**Connection limits** — Maximum 5 concurrent WebSocket connections. Sessions expire after 24 hours.

## Terminal Size Behavior

cli-tunnel uses a single PTY (pseudo-terminal) shared between your local terminal and all remote viewers. When a phone or tablet connects, the PTY resizes to match the remote device's screen dimensions. This ensures the CLI app renders correctly on the device you're actively using to interact with it.

Because the PTY can only have one size at a time, the local terminal on your machine will reflect the remote device's dimensions while it's connected. This is by design — cli-tunnel prioritizes the remote viewing experience since the primary use case is controlling your CLI from another device.

**Tips for the best experience:**
- Rotate your phone to landscape for a wider terminal
- Use the key bar (↑↓←→ Tab Enter Esc Ctrl+C) at the bottom for navigation
- If multiple devices connect, the last one to resize wins

## FAQ

**Can multiple devices connect to the same session?**
Yes, up to 5 devices simultaneously. All viewers see the same terminal output in real time. Input from any device goes to the same CLI session.

**What happens if my phone disconnects?**
The CLI session keeps running on your machine. When you reconnect, you'll see live output from that point forward. Use `--replay` to enable history replay so reconnecting devices catch up on what they missed.

**Does cli-tunnel work with any CLI app?**
Yes. Any command that runs in a terminal works — copilot, vim, htop, python, ssh, k9s, node, and more. cli-tunnel doesn't interpret the command's output; it streams raw terminal bytes.

**Is there a central server?**
No. cli-tunnel runs entirely on your machine. Microsoft Dev Tunnels provides the relay infrastructure, but no third-party server sees your terminal content.

**What about the anti-phishing page?**
The first time you open a devtunnel URL, Microsoft shows an interstitial warning page. This is a devtunnel security feature — it confirms you trust the tunnel. You only see it once per tunnel.

**Does the tool work without devtunnel?**
Yes. Use `--local` to skip tunnel creation. The terminal is available at `http://127.0.0.1:<port>` on your local network only.

**What's hub mode?**
Run `cli-tunnel` with no command to start hub mode — a sessions dashboard that shows all active cli-tunnel sessions on your machine. Tap any online session to connect to it.

## How It's Built

- **[node-pty](https://github.com/microsoft/node-pty)** — spawns the command in a pseudo-terminal
- **[xterm.js](https://xtermjs.org/)** — terminal emulator in the browser (loaded from CDN)
- **[ws](https://github.com/websockets/ws)** — WebSocket server for real-time streaming
- **[Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/)** — authenticated HTTPS relay

## Blog Post

[Your Copilot CLI on Your Phone — Building Squad Remote Control](https://www.tamirdresher.com/blog/2026/02/26/squad-remote-control)

## License

MIT
