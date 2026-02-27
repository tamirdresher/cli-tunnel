/**
 * cli-tunnel — Terminal-Style PWA (ACP Protocol)
 * Raw terminal rendering matching Copilot CLI output
 */
(function () {
  'use strict';

  // ─── Mobile keyboard viewport fix ────────────────────────
  // Keep the key bar visible above the on-screen keyboard
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const vv = window.visualViewport;
      const inputArea = document.getElementById('input-area');
      if (inputArea && vv) {
        const offset = window.innerHeight - vv.height - vv.offsetTop;
        inputArea.style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
      }
    });
    window.visualViewport.addEventListener('scroll', () => {
      const vv = window.visualViewport;
      const inputArea = document.getElementById('input-area');
      if (inputArea && vv) {
        const offset = window.innerHeight - vv.height - vv.offsetTop;
        inputArea.style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
      }
    });
  }

  let ws = null;
  let connected = false;
  let sessionId = null;
  let requestId = 0;
  let pendingRequests = {};
  let acpReady = false;
  let streamingEl = null;
  let replaying = false;
  let toolCalls = {};

  const $ = (sel) => document.querySelector(sel);
  const terminal = $('#terminal');
  const inputEl = $('#input');
  const formEl = $('#input-form');
  const statusEl = $('#status-indicator');
  const statusText = $('#status-text');
  const permOverlay = $('#permission-overlay');
  const dashboard = $('#dashboard');
  const termContainer = $('#terminal-container');
  let currentView = 'terminal'; // 'dashboard' or 'terminal'

  // ─── xterm.js Terminal ───────────────────────────────────
  let xterm = null;
  let fitAddon = null;

  function initXterm() {
    if (xterm) return;
    xterm = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#3fb950',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#c9d1d9',
        brightBlack: '#6e7681',
        brightRed: '#f85149',
        brightGreen: '#3fb950',
        brightYellow: '#d29922',
        brightBlue: '#58a6ff',
        brightMagenta: '#bc8cff',
        brightCyan: '#39c5cf',
        brightWhite: '#f0f6fc',
      },
      fontFamily: "'Cascadia Code', 'SF Mono', 'Fira Code', 'Menlo', monospace",
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
    });

    fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(termContainer);
    fitAddon.fit();

    // Send terminal size to PTY so copilot renders correctly
    function sendResize() {
      if (ws && ws.readyState === WebSocket.OPEN && xterm) {
        ws.send(JSON.stringify({ type: 'pty_resize', cols: xterm.cols, rows: xterm.rows }));
      }
    }

    // Handle resize
    window.addEventListener('resize', () => {
      if (fitAddon) { fitAddon.fit(); sendResize(); }
    });

    // Send initial size
    setTimeout(sendResize, 500);

    // Keyboard input → send to bridge → PTY
    xterm.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pty_input', data }));
      }
    });
  }

  // ─── Dashboard ───────────────────────────────────────────
  let showOffline = false;

  async function loadSessions() {
    try {
      const resp = await fetch('/api/sessions');
      const data = await resp.json();
      renderDashboard(data.sessions || []);
    } catch (err) {
      dashboard.innerHTML = '<div style="padding:12px;color:var(--red)">' + escapeHtml('Failed to load sessions: ' + err.message) + '</div>';
    }
  }

  function renderDashboard(sessions) {
    const filtered = showOffline ? sessions : sessions.filter(s => s.online);
    const offlineCount = sessions.filter(s => !s.online).length;
    const onlineCount = sessions.filter(s => s.online).length;

    let html = `<div style="padding:8px 4px;display:flex;align-items:center;gap:8px">
      <span style="color:var(--text-dim);font-size:12px">${onlineCount} online${offlineCount > 0 ? ', ' + offlineCount + ' offline' : ''}</span>
      <span style="flex:1"></span>
      <button onclick="toggleOffline()" style="background:none;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">${showOffline ? 'Hide offline' : 'Show offline'}</button>
      ${offlineCount > 0 ? '<button onclick="cleanOffline()" style="background:none;border:1px solid var(--red);color:var(--red);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">Clean offline</button>' : ''}
      <button onclick="loadSessions()" style="background:none;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">↻</button>
    </div>`;

    if (filtered.length === 0) {
      html += '<div style="padding:20px 12px;color:var(--text-dim);text-align:center">' +
        (sessions.length === 0 ? 'No Squad RC sessions found.' : 'No online sessions. Tap "Show offline" to see stale ones.') +
        '</div>';
    } else {
      html += filtered.map(s => `
        <div class="session-card" ${s.online ? 'onclick="openSession(\'' + escapeHtml(s.url) + '\')"' : ''}>
          <span class="status-dot ${s.online ? 'online' : 'offline'}"></span>
          <div class="info">
            <div class="repo">📦 ${escapeHtml(s.repo)}</div>
            <div class="branch">🌿 ${escapeHtml(s.branch)}</div>
            <div class="machine">💻 ${escapeHtml(s.machine)}</div>
          </div>
          ${s.online ? '<span class="arrow">→</span>' :
            '<button onclick="event.stopPropagation();deleteSession(\'' + escapeHtml(s.id) + '\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px" title="Remove">✕</button>'}
        </div>
      `).join('');
    }
    dashboard.innerHTML = html;
  }

  window.openSession = (url) => {
    window.location.href = url;
  };

  window.toggleOffline = () => {
    showOffline = !showOffline;
    loadSessions();
  };

  window.cleanOffline = async () => {
    const resp = await fetch('/api/sessions');
    const data = await resp.json();
    const offline = (data.sessions || []).filter(s => !s.online);
    for (const s of offline) {
      await fetch('/api/sessions/' + s.id, { method: 'DELETE' });
    }
    loadSessions();
  };

  window.deleteSession = async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
    loadSessions();
  };

  window.toggleView = () => {
    if (currentView === 'terminal') {
      currentView = 'dashboard';
      terminal.classList.add('hidden');
      termContainer.classList.add('hidden');
      $('#input-area').classList.add('hidden');
      dashboard.classList.remove('hidden');
      $('#btn-sessions').textContent = 'Terminal';
      loadSessions();
    } else {
      currentView = 'terminal';
      dashboard.classList.add('hidden');
      $('#input-area').classList.remove('hidden');
      if (ptyMode) {
        termContainer.classList.remove('hidden');
        $('#input-form').classList.add('hidden');
        if (fitAddon) fitAddon.fit();
        if (xterm) xterm.focus();
      } else {
        terminal.classList.remove('hidden');
      }
      $('#btn-sessions').textContent = 'Sessions';
    }
  };

  // ─── Terminal Output ─────────────────────────────────────
  function write(html, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.innerHTML = html;
    terminal.appendChild(div);
    if (!replaying) scrollToBottom();
  }

  function writeSys(text) { write(escapeHtml(text), 'sys'); }

  function writeUserInput(text) {
    write(escapeHtml(text), 'user-input');
  }

  function startStreaming() {
    streamingEl = document.createElement('div');
    streamingEl.className = 'agent-text';
    streamingEl.innerHTML = '<span class="cursor"></span>';
    terminal.appendChild(streamingEl);
  }

  function appendStreaming(text) {
    if (!streamingEl) startStreaming();
    // Remove cursor, append text, re-add cursor
    const cursor = streamingEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    streamingEl.innerHTML += escapeHtml(text);
    const c = document.createElement('span');
    c.className = 'cursor';
    streamingEl.appendChild(c);
    if (!replaying) scrollToBottom();
  }

  function endStreaming() {
    if (streamingEl) {
      const cursor = streamingEl.querySelector('.cursor');
      if (cursor) cursor.remove();
      // Render markdown-ish formatting
      streamingEl.innerHTML = formatText(streamingEl.textContent || '');
      streamingEl = null;
    }
  }

  // ─── Tool Call Rendering ─────────────────────────────────
  function renderToolCall(update) {
    const id = update.id || update.toolCallId || ('tc-' + Date.now());
    const name = update.name || 'tool';
    const icons = { read: '📖', edit: '✏️', write: '✏️', shell: '▶️', search: '🔍', think: '💭', fetch: '🌐' };
    const guessKind = name.includes('read') ? 'read' : name.includes('edit') || name.includes('write') ? 'edit' :
      name.includes('shell') || name.includes('exec') || name.includes('run') ? 'shell' :
      name.includes('search') || name.includes('grep') || name.includes('glob') ? 'search' :
      name.includes('think') || name.includes('reason') ? 'think' : 'other';
    const icon = icons[guessKind] || '⚙️';

    const el = document.createElement('div');
    el.className = 'tool-call';
    el.id = 'tool-' + id;
    el.dataset.toolId = id;

    const inputStr = update.input ? (typeof update.input === 'string' ? update.input : JSON.stringify(update.input)) : '';
    const shortInput = inputStr.length > 80 ? inputStr.substring(0, 80) + '...' : inputStr;

    el.innerHTML = `<span class="tool-icon">${icon}</span><span class="tool-name">${escapeHtml(name)}</span> ${escapeHtml(shortInput)}<span class="tool-status in_progress">⟳</span><div class="tool-body"></div>`;
    el.addEventListener('click', () => el.classList.toggle('expanded'));

    terminal.appendChild(el);
    toolCalls[id] = el;
    if (!replaying) scrollToBottom();
  }

  function updateToolCall(update) {
    const id = update.id || update.toolCallId;
    const el = toolCalls[id];
    if (!el) return;

    if (update.status) {
      el.classList.remove('completed', 'failed');
      if (update.status === 'completed') el.classList.add('completed');
      if (update.status === 'failed' || update.status === 'errored') el.classList.add('failed');

      const badge = el.querySelector('.tool-status');
      if (badge) {
        badge.className = 'tool-status ' + update.status;
        badge.textContent = update.status === 'completed' ? '✓' : update.status === 'failed' || update.status === 'errored' ? '✗' : '⟳';
      }
    }

    if (update.content) {
      const body = el.querySelector('.tool-body');
      if (body) {
        for (const item of (Array.isArray(update.content) ? update.content : [update.content])) {
          if (item.type === 'diff' && item.diff) {
            let diffHtml = `<div class="diff"><div class="diff-header">${escapeHtml(item.path || '')}</div>`;
            if (item.diff.before) diffHtml += `<div class="diff-del">${escapeHtml(item.diff.before)}</div>`;
            if (item.diff.after) diffHtml += `<div class="diff-add">${escapeHtml(item.diff.after)}</div>`;
            diffHtml += '</div>';
            body.innerHTML += diffHtml;
          } else if (item.type === 'text' && item.text) {
            body.innerHTML += `<div class="code-block">${escapeHtml(item.text)}</div>`;
          } else if (typeof item === 'string') {
            body.innerHTML += `<div class="code-block">${escapeHtml(item)}</div>`;
          }
        }
        el.classList.add('expanded');
      }
    }
  }

  // ─── ACP JSON-RPC ────────────────────────────────────────
  function sendRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests[id] = { resolve, reject };
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
      const timeout = timeoutMs !== undefined ? timeoutMs : (method === 'initialize' ? 60000 : 120000);
      if (timeout > 0) {
        setTimeout(() => {
          if (pendingRequests[id]) { delete pendingRequests[id]; reject(new Error(`${method} timed out`)); }
        }, timeout);
      }
    });
  }

  // ─── ACP Initialize ─────────────────────────────────────
  async function initializeACP(attempt) {
    attempt = attempt || 1;
    setStatus('connecting', attempt === 1 ? 'Initializing...' : `Retry ${attempt}/5...`);
    if (attempt === 1) writeSys('Waiting for Copilot to load (~15-20s)...');

    try {
      const result = await sendRequest('initialize', {
        protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'squad-rc', title: 'Squad RC', version: '1.0.0' },
      });
      writeSys('Connected to Copilot ' + (result.agentInfo?.version || ''));
      const sessionResult = await sendRequest('session/new', { cwd: '.', mcpServers: [] });
      sessionId = sessionResult.sessionId;
      acpReady = true;
      setStatus('online', 'Ready');
      writeSys('Session ready. Type a message below.');
    } catch (err) {
      if (attempt < 5) {
        writeSys('Not ready, retrying in 5s... (' + attempt + '/5)');
        setTimeout(() => initializeACP(attempt + 1), 5000);
      } else {
        setStatus('offline', 'Failed');
        writeSys('Failed to connect: ' + err.message);
      }
    }
  }

  // ─── Detect hub mode (no token in URL) ────────────────────
  const isHubMode = !new URLSearchParams(window.location.search).get('token');

  // ─── WebSocket ───────────────────────────────────────────
  let reconnectAttempt = 0;

  async function connect() {
    if (isHubMode) {
      // Hub mode — hide terminal UI, show sessions only
      setStatus('online', 'Hub');
      terminal.classList.add('hidden');
      termContainer.classList.add('hidden');
      $('#input-area').classList.add('hidden');
      $('#btn-sessions').classList.add('hidden');
      dashboard.classList.remove('hidden');
      loadSessions();
      // Auto-refresh every 10s
      setInterval(loadSessions, 10000);
      return;
    }

    const tokenParam = new URLSearchParams(window.location.search).get('token');
    if (!tokenParam) { setStatus('offline', 'No credentials'); return; }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

    // F-02: Try ticket-based auth first
    try {
      const resp = await fetch('/api/auth/ticket', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tokenParam }
      });
      if (resp.ok) {
        const { ticket } = await resp.json();
        ws = new WebSocket(`${proto}//${location.host}?ticket=${encodeURIComponent(ticket)}`);
      } else {
        // Fallback to token-in-URL (backward compat)
        ws = new WebSocket(`${proto}//${location.host}?token=${encodeURIComponent(tokenParam)}`);
      }
    } catch {
      // Fallback to token-in-URL
      ws = new WebSocket(`${proto}//${location.host}?token=${encodeURIComponent(tokenParam)}`);
    }
    setStatus('connecting', 'Connecting...');

    ws.onopen = () => {
      connected = true;
      reconnectAttempt = 0;
      setTimeout(() => initializeACP(1), 1000);
    };
    ws.onclose = () => {
      connected = false; acpReady = false; sessionId = null;
      setStatus('offline', 'Disconnected');
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt)) + Math.random() * 1000;
      reconnectAttempt++;
      setTimeout(connect, delay);
    };
    ws.onerror = () => setStatus('offline', 'Error');
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch {}
    };
  }

  // ─── Message Handler ─────────────────────────────────────
  function handleMessage(msg) {
    // Replay events from bridge recording
    if (msg.type === '_replay') {
      replaying = true;
      try { handleMessage(JSON.parse(msg.data)); } catch {}
      return;
    }
    if (msg.type === '_replay_done') {
      replaying = false;
      scrollToBottom();
      return;
    }

    // PTY data — raw terminal output → xterm.js
    if (msg.type === 'pty') {
      if (!ptyMode) {
        ptyMode = true;
        setStatus('online', 'PTY Mirror');
        terminal.classList.add('hidden');
        // Hide text input form but keep key bar visible
        $('#input-form').classList.add('hidden');
        termContainer.classList.remove('hidden');
        initXterm();
      }
      xterm.write(msg.data);
      return;
    }

    // JSON-RPC response (ACP mode fallback)
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pendingRequests[msg.id];
      if (p) {
        delete pendingRequests[msg.id];
        msg.error ? p.reject(new Error(msg.error.message || 'Error')) : p.resolve(msg.result);
      }
      if (msg.result?.stopReason) endStreaming();
      return;
    }

    // session/update notification (ACP mode fallback)
    if (msg.method === 'session/update' && msg.params) {
      const u = msg.params.update || msg.params;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        appendStreaming(u.content.text);
      }
      if (u.sessionUpdate === 'tool_call') renderToolCall(u);
      if (u.sessionUpdate === 'tool_call_update') updateToolCall(u);
      return;
    }

    // Permission request (ACP mode)
    if (msg.method === 'session/request_permission') {
      showPermission(msg);
      return;
    }
  }

  // ─── PTY Terminal Rendering ──────────────────────────────
  function appendTerminalData(data) {
    // Strip some ANSI sequences that don't render well in HTML
    // but keep colors and basic formatting
    const html = ansiToHtml(data);
    terminal.innerHTML += html;
    if (!replaying) scrollToBottom();
  }

  function ansiToHtml(text) {
    // Convert ANSI escape codes to HTML spans
    let html = escapeHtml(text);

    // Color codes → spans
    const colorMap = {
      '30': '#6e7681', '31': '#f85149', '32': '#3fb950', '33': '#d29922',
      '34': '#58a6ff', '35': '#bc8cff', '36': '#39c5cf', '37': '#c9d1d9',
      '90': '#6e7681', '91': '#f85149', '92': '#3fb950', '93': '#d29922',
      '94': '#58a6ff', '95': '#bc8cff', '96': '#39c5cf', '97': '#f0f6fc',
    };

    // Replace \x1b[Xm patterns
    html = html.replace(/\x1b\[(\d+)m/g, (_, code) => {
      if (code === '0') return '</span>';
      if (code === '1') return '<span style="font-weight:bold">';
      if (code === '2') return '<span style="opacity:0.6">';
      if (code === '4') return '<span style="text-decoration:underline">';
      if (colorMap[code]) return `<span style="color:${colorMap[code]}">`;
      return '';
    });

    // Clean up escape sequences we don't handle
    html = html.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    // Clean \r
    html = html.replace(/\r/g, '');

    return html;
  }

  // ─── Permission Dialog ───────────────────────────────────
  function showPermission(msg) {
    const p = msg.params || {};
    // Extract readable info from the permission request
    const toolCall = p.toolCall || {};
    const title = toolCall.title || p.tool || 'Tool action';
    const kind = toolCall.kind || 'unknown';
    const kindIcons = { read: '📖', edit: '✏️', execute: '▶️', delete: '🗑️' };
    const icon = kindIcons[kind] || '🔧';
    // For shell commands, show just the first line
    const command = toolCall.rawInput?.command || toolCall.rawInput?.commands?.[0] || '';
    const shortCmd = command.split('\n')[0].substring(0, 100) + (command.length > 100 ? '...' : '');

    permOverlay.classList.remove('hidden');
    permOverlay.innerHTML = `<div class="perm-dialog">
      <h3>${icon} ${escapeHtml(title)}</h3>
      <p>${escapeHtml(shortCmd || JSON.stringify(p).substring(0, 200))}</p>
      <div class="perm-actions">
        <button class="btn-deny">Deny</button>
        <button class="btn-approve">Approve</button>
      </div>
    </div>`;
    permOverlay.querySelector('.btn-deny').addEventListener('click', () => window.handlePerm(msg.id, false));
    permOverlay.querySelector('.btn-approve').addEventListener('click', () => window.handlePerm(msg.id, true));
  }
  window.handlePerm = (id, approved) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { outcome: approved ? 'approved' : 'denied' } }));
    }
    permOverlay.classList.add('hidden');
  };

  // ─── Mobile Key Bar ───────────────────────────────────────
  window.sendKey = (key) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pty_input', data: key }));
    }
    if (xterm) xterm.focus();
  };

  // ─── Send Prompt ─────────────────────────────────────────
  let ptyMode = false;

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';

    if (ptyMode) {
      // xterm.js handles input directly — focus it
      if (xterm) xterm.focus();
      return;
    }

    // ACP mode
    if (!acpReady || !sessionId) return;
    writeUserInput(text);
    try {
      await sendRequest('session/prompt', {
        sessionId, prompt: [{ type: 'text', text }],
      }, 0);
    } catch (err) {
      endStreaming();
      writeSys('Error: ' + err.message);
    }
  });

  // ─── Helpers ─────────────────────────────────────────────
  function setStatus(state, text) {
    statusEl.className = state;
    statusText.textContent = text;
  }
  function scrollToBottom() {
    requestAnimationFrame(() => { terminal.scrollTop = terminal.scrollHeight; });
  }
  function escapeHtml(s) {
    const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/'/g, '&#39;');
  }
  function formatText(text) {
    return escapeHtml(text)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<div class="code-block">$2</div>')
      .replace(/`([^`]+)`/g, '<code style="background:var(--bg-tool);padding:1px 4px;border-radius:3px">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text-bright)">$1</strong>')
      .replace(/\n/g, '<br>');
  }

  // ─── Start ───────────────────────────────────────────────
  writeSys('cli-tunnel');
  connect();
})();

