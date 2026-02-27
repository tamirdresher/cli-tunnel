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

```bash
# Run copilot with remote access
cli-tunnel --tunnel copilot --yolo

# Name your session (shows in dashboard)
cli-tunnel --tunnel --name wizard copilot --agent squad

# Specific port
cli-tunnel --tunnel --port 4000 copilot

# Any CLI app works
cli-tunnel --tunnel python -i
cli-tunnel --tunnel vim myfile.txt
cli-tunnel --tunnel htop

# Local only (no tunnel)
cli-tunnel copilot --yolo
```

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

Tunnels are **private by default** — only the Microsoft/GitHub account that created the tunnel can connect. Auth is enforced at Microsoft's relay layer before traffic reaches your machine.

- No inbound ports opened
- No anonymous access
- No central server
- TLS encryption via devtunnel relay

## How It's Built

- **[node-pty](https://github.com/microsoft/node-pty)** — spawns the command in a pseudo-terminal
- **[xterm.js](https://xtermjs.org/)** — terminal emulator in the browser (loaded from CDN)
- **[ws](https://github.com/websockets/ws)** — WebSocket server for real-time streaming
- **[Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/)** — authenticated HTTPS relay

## Blog Post

[Your Copilot CLI on Your Phone — Building Squad Remote Control](https://www.tamirdresher.com/blog/2026/02/26/squad-remote-control)

## License

MIT
