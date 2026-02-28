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
  let currentView = 'terminal'; // 'dashboard', 'terminal', or 'grid'
  let cachedSessions = [];
  let gridTerminals = []; // { xterm, fitAddon, ws, session, panel }
  var gridMode = 'thumbnails';
  var focusedIndex = 0;
  var tmuxPreset = 'equal';

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
      const tokenParam = new URLSearchParams(window.location.search).get('token');
      const headers = tokenParam ? { 'Authorization': 'Bearer ' + tokenParam } : {};
      const resp = await fetch('/api/sessions', { headers });
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
    const connectable = filtered.filter(s => s.online && s.token);

    let html = `<div style="padding:8px 4px;display:flex;align-items:center;gap:8px">
      <span style="color:var(--text-dim);font-size:12px">${onlineCount} online${offlineCount > 0 ? ', ' + offlineCount + ' offline' : ''}</span>
      <span style="flex:1"></span>
      ${connectable.length > 1 ? '<button data-action="grid-view" style="background:none;border:1px solid var(--blue);color:var(--blue);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">⊞ Grid</button>' : ''}
      <button data-action="toggle-offline" style="background:none;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">${showOffline ? 'Hide offline' : 'Show offline'}</button>
      ${offlineCount > 0 ? '<button data-action="clean-offline" style="background:none;border:1px solid var(--red);color:var(--red);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">Clean offline</button>' : ''}
      <button data-action="refresh" style="background:none;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font);font-size:11px;padding:3px 8px;border-radius:4px;cursor:pointer">↻</button>
    </div>`;

    if (filtered.length === 0) {
      html += '<div style="padding:20px 12px;color:var(--text-dim);text-align:center">' +
        (sessions.length === 0 ? 'No cli-tunnel sessions found.' : 'No online sessions. Tap "Show offline" to see stale ones.') +
        '</div>';
    } else {
      html += filtered.map(s => {
        const hasAccess = s.hasToken;
        return `
        <div class="session-card" ${s.online && hasAccess ? 'data-session-port="' + s.port + '" data-session-base-url="' + escapeHtml(s.url) + '"' : ''}>
          <span class="status-dot ${s.online ? 'online' : 'offline'}"></span>
          <div class="info">
            <div class="session-name">${escapeHtml(s.name)}</div>
            <div class="repo">📦 ${escapeHtml(s.repo)}</div>
            <div class="branch">🌿 ${escapeHtml(s.branch)}</div>
            <div class="machine">💻 ${escapeHtml(s.machine)}${!hasAccess && s.online ? ' 🔒' : ''}</div>
          </div>
          ${s.online && hasAccess ? '<span class="arrow">→</span>' :
            !s.online ? '<button data-delete-id="' + escapeHtml(s.id) + '" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px" title="Remove">✕</button>'
            : '<span style="color:var(--text-dim);font-size:11px">remote</span>'}
        </div>`;
      }).join('');
    }
    dashboard.innerHTML = html;
    cachedSessions = sessions;
    // Event delegation
    dashboard.querySelectorAll('.session-card[data-session-port]').forEach(function(card) {
      card.addEventListener('click', function() {
        var port = card.dataset.sessionPort;
        var baseUrl = card.dataset.sessionBaseUrl;
        var tokenParam = new URLSearchParams(window.location.search).get('token');
        var proxyUrl = '/api/proxy/ticket/' + port;
        fetch(proxyUrl, {
          method: 'POST',
          headers: tokenParam ? { 'Authorization': 'Bearer ' + tokenParam } : {}
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data.ticket) {
            window.location.href = baseUrl + '?ticket=' + encodeURIComponent(data.ticket);
          } else {
            window.location.href = baseUrl;
          }
        }).catch(function() {
          window.location.href = baseUrl;
        });
      });
    });
    dashboard.querySelectorAll('[data-delete-id]').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); deleteSession(btn.dataset.deleteId); });
    });
    dashboard.querySelector('[data-action="toggle-offline"]')?.addEventListener('click', function() { toggleOffline(); });
    dashboard.querySelector('[data-action="clean-offline"]')?.addEventListener('click', function() { cleanOffline(); });
    dashboard.querySelector('[data-action="refresh"]')?.addEventListener('click', function() { loadSessions(); });
    dashboard.querySelector('[data-action="grid-view"]')?.addEventListener('click', function() { showGridView(sessions); });
  }

  window.openSession = (url) => {
    window.location.href = url;
  };

  window.toggleOffline = () => {
    showOffline = !showOffline;
    loadSessions();
  };

  window.cleanOffline = async () => {
    const tokenParam = new URLSearchParams(window.location.search).get('token');
    const headers = tokenParam ? { 'Authorization': 'Bearer ' + tokenParam } : {};
    const resp = await fetch('/api/sessions', { headers });
    const data = await resp.json();
    const offline = (data.sessions || []).filter(s => !s.online);
    for (const s of offline) {
      await fetch('/api/sessions/' + s.id, { method: 'DELETE', headers });
    }
    loadSessions();
  };

  window.deleteSession = async (id) => {
    const tokenParam = new URLSearchParams(window.location.search).get('token');
    const headers = tokenParam ? { 'Authorization': 'Bearer ' + tokenParam } : {};
    await fetch('/api/sessions/' + id, { method: 'DELETE', headers });
    loadSessions();
  };

  // ─── Grid View (multi-terminal with layout modes) ───────────
  function showGridView(sessions) {
    var connectable = sessions.filter(function(s) { return s.online && s.token; });
    if (connectable.length === 0) return;

    // Clean up previous grid
    destroyGrid();

    currentView = 'grid';
    gridMode = 'thumbnails';
    focusedIndex = 0;
    tmuxPreset = 'equal';
    dashboard.classList.add('hidden');
    terminal.classList.add('hidden');
    termContainer.classList.add('hidden');
    $('#input-area').classList.add('hidden');

    var gridEl = document.getElementById('grid-view');
    if (!gridEl) {
      gridEl = document.createElement('div');
      gridEl.id = 'grid-view';
      document.getElementById('app').insertBefore(gridEl, document.getElementById('input-area'));
    }
    gridEl.classList.remove('hidden');
    gridEl.innerHTML = '';

    // ── Toolbar ──
    var toolbar = document.createElement('div');
    toolbar.className = 'grid-toolbar';

    var modes = [
      { id: 'thumbnails', label: '\u229E Tiles' },
      { id: 'tmux', label: '\u229F Tmux' },
      { id: 'focus', label: '\u25C9 Focus' },
      { id: 'fullscreen', label: '\u2A21 Full' }
    ];
    modes.forEach(function(m) {
      var btn = document.createElement('button');
      btn.textContent = m.label;
      btn.dataset.mode = m.id;
      if (m.id === gridMode) btn.classList.add('active');
      btn.addEventListener('click', function() { switchGridMode(m.id); });
      toolbar.appendChild(btn);
    });

    // Tmux preset buttons (visible only in tmux mode)
    var presetGroup = document.createElement('span');
    presetGroup.className = 'grid-toolbar-presets hidden';
    presetGroup.id = 'tmux-presets';
    var presets = [
      { id: 'equal', label: '\u2550 Equal' },
      { id: 'main-side', label: '\u2590 Main+Side' },
      { id: 'stacked', label: '\u2261 Stacked' }
    ];
    presets.forEach(function(p) {
      var btn = document.createElement('button');
      btn.textContent = p.label;
      btn.dataset.preset = p.id;
      if (p.id === tmuxPreset) btn.classList.add('active');
      btn.addEventListener('click', function() { switchTmuxPreset(p.id); });
      presetGroup.appendChild(btn);
    });
    toolbar.appendChild(presetGroup);

    var spacer = document.createElement('span');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    var listBtn = document.createElement('button');
    listBtn.textContent = '\u2190 List';
    listBtn.addEventListener('click', function() {
      destroyGrid();
      currentView = 'dashboard';
      dashboard.classList.remove('hidden');
      if ($('#btn-sessions')) $('#btn-sessions').textContent = 'Terminal';
      loadSessions();
    });
    toolbar.appendChild(listBtn);
    gridEl.appendChild(toolbar);

    // ── Content container ──
    var contentEl = document.createElement('div');
    contentEl.id = 'grid-content';
    gridEl.appendChild(contentEl);

    // ── Create panels & connect ──
    connectable.forEach(function(s, index) {
      var panel = document.createElement('div');
      panel.className = 'grid-panel';
      panel.dataset.index = index;

      var header = document.createElement('div');
      header.className = 'grid-panel-header';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'grid-panel-name';
      nameSpan.textContent = s.name;
      var machineSpan = document.createElement('span');
      machineSpan.className = 'grid-panel-machine';
      machineSpan.textContent = s.machine;
      var statusDot = document.createElement('span');
      statusDot.className = 'grid-panel-status';
      statusDot.textContent = '\u25CF';
      header.appendChild(nameSpan);
      header.appendChild(machineSpan);
      header.appendChild(statusDot);
      panel.appendChild(header);

      var termDiv = document.createElement('div');
      termDiv.className = 'grid-panel-terminal';
      panel.appendChild(termDiv);

      // Append to contentEl so xterm.open has a DOM-attached container
      contentEl.appendChild(panel);

      // xterm instance
      var panelXterm = new Terminal({
        theme: {
          background: '#0d1117', foreground: '#c9d1d9', cursor: '#3fb950',
          selectionBackground: '#264f78',
        },
        fontFamily: "'Cascadia Code', 'SF Mono', 'Fira Code', 'Menlo', monospace",
        fontSize: 11,
        scrollback: 1000,
        cursorBlink: true,
      });
      var panelFit = new FitAddon.FitAddon();
      panelXterm.loadAddon(panelFit);
      panelXterm.open(termDiv);

      // Store entry before async connect so index is stable
      var entry = { xterm: panelXterm, fitAddon: panelFit, ws: null, session: s, panel: panel };
      gridTerminals.push(entry);

      // Connect WebSocket to this session
      (function connectPanel() {
        // Use hub's proxy endpoint to get a ticket for the session
        var tokenParam = new URLSearchParams(window.location.search).get('token');
        var proxyUrl = '/api/proxy/ticket/' + s.port;
        var wsBase = s.isLocal ? 'ws://127.0.0.1:' + s.port : s.url.replace('https://', 'wss://');

        fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + tokenParam }
        }).then(function(resp) {
          if (!resp.ok) throw new Error('Auth failed');
          return resp.json();
        }).then(function(data) {
          var panelWs = new WebSocket(wsBase + '?ticket=' + encodeURIComponent(data.ticket));
          entry.ws = panelWs;

          panelWs.onopen = function() {
            if (statusDot) { statusDot.style.color = 'var(--green)'; statusDot.title = 'Connected'; }
            panelWs.send(JSON.stringify({ type: 'pty_resize', cols: panelXterm.cols, rows: panelXterm.rows }));
          };
          panelWs.onclose = function() {
            if (statusDot) { statusDot.style.color = 'var(--red)'; statusDot.title = 'Disconnected'; }
          };
          panelWs.onerror = function() {
            if (statusDot) { statusDot.style.color = 'var(--red)'; }
          };
          panelWs.onmessage = function(e) {
            try {
              var msg = JSON.parse(e.data);
              if (msg.type === 'pty') {
                panelXterm.write(msg.data);
              }
            } catch (err) {}
          };

          panelXterm.onData(function(data) {
            if (panelWs && panelWs.readyState === WebSocket.OPEN) {
              panelWs.send(JSON.stringify({ type: 'pty_input', data: data }));
            }
          });
        }).catch(function() {
          if (statusDot) { statusDot.style.color = 'var(--red)'; statusDot.title = 'Auth failed'; }
        });
      })();
    });

    // ── Event delegation for panel clicks ──
    contentEl.addEventListener('click', function(e) {
      var panel = e.target.closest('.grid-panel');
      if (!panel) return;
      var idx = parseInt(panel.dataset.index, 10);
      if (isNaN(idx)) return;

      if (gridMode === 'thumbnails') {
        focusedIndex = idx;
        switchGridMode('fullscreen');
      } else if (gridMode === 'focus' && panel.classList.contains('focus-strip')) {
        focusedIndex = idx;
        applyGridLayout('focus');
      } else if (gridMode === 'tmux') {
        focusedIndex = idx;
        contentEl.querySelectorAll('.grid-panel').forEach(function(p) { p.classList.remove('active'); });
        panel.classList.add('active');
      }
    });

    // Apply initial layout
    applyGridLayout(gridMode);

    // Handle window resize
    window.removeEventListener('resize', fitGridPanels);
    window.addEventListener('resize', fitGridPanels);
    if ($('#btn-sessions')) { $('#btn-sessions').textContent = 'List'; }
  }

  function switchGridMode(mode) {
    gridMode = mode;
    if (mode === 'fullscreen') {
      $('#input-area').classList.remove('hidden');
      $('#input-form').classList.add('hidden');
    } else {
      $('#input-area').classList.add('hidden');
    }
    applyGridLayout(mode);
  }

  function switchTmuxPreset(preset) {
    tmuxPreset = preset;
    var presetGroup = document.getElementById('tmux-presets');
    if (presetGroup) {
      presetGroup.querySelectorAll('[data-preset]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.preset === preset);
      });
    }
    if (gridMode === 'tmux') applyGridLayout('tmux');
  }

  function applyGridLayout(mode) {
    gridMode = mode;
    var contentEl = document.getElementById('grid-content');
    if (!contentEl || gridTerminals.length === 0) return;

    // Clamp focusedIndex
    if (focusedIndex >= gridTerminals.length) focusedIndex = 0;

    // Update toolbar button states
    var toolbar = contentEl.parentElement.querySelector('.grid-toolbar');
    if (toolbar) {
      toolbar.querySelectorAll('[data-mode]').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });
      var presetsEl = document.getElementById('tmux-presets');
      if (presetsEl) presetsEl.classList.toggle('hidden', mode !== 'tmux');
    }

    // Detach all panels without destroying them
    gridTerminals.forEach(function(gt, i) {
      if (gt.panel.parentNode) gt.panel.parentNode.removeChild(gt.panel);
      gt.panel.className = 'grid-panel';
      gt.panel.dataset.index = i;
      var termDiv = gt.panel.querySelector('.grid-panel-terminal');
      if (termDiv) termDiv.style.cssText = '';
      gt.panel.style.cssText = '';
    });

    // Remove leftover elements (focus-strips, back-to-grid button)
    while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);

    // Reset content styles
    contentEl.className = 'mode-' + mode;
    contentEl.style.cssText = '';

    switch (mode) {
      case 'thumbnails':
        gridTerminals.forEach(function(gt) {
          gt.panel.classList.add('thumbnail');
          var termDiv = gt.panel.querySelector('.grid-panel-terminal');
          termDiv.style.width = '560px';
          termDiv.style.height = '360px';
          termDiv.style.transform = 'scale(0.5)';
          termDiv.style.transformOrigin = 'top left';
          contentEl.appendChild(gt.panel);
        });
        break;

      case 'tmux':
        gridTerminals.forEach(function(gt, i) {
          if (i === focusedIndex) gt.panel.classList.add('active');
          contentEl.appendChild(gt.panel);
        });
        if (tmuxPreset === 'equal') {
          var cols = gridTerminals.length <= 2 ? gridTerminals.length : gridTerminals.length <= 4 ? 2 : 3;
          contentEl.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
        } else if (tmuxPreset === 'main-side') {
          contentEl.style.gridTemplateColumns = '70% 30%';
          var sideCount = Math.max(gridTerminals.length - 1, 1);
          contentEl.style.gridTemplateRows = 'repeat(' + sideCount + ', 1fr)';
          if (gridTerminals.length > 0) gridTerminals[0].panel.style.gridRow = '1 / -1';
        } else if (tmuxPreset === 'stacked') {
          contentEl.style.gridTemplateColumns = '1fr';
        }
        break;

      case 'focus':
        var mainGt = gridTerminals[focusedIndex];
        mainGt.panel.classList.add('focus-main');
        contentEl.appendChild(mainGt.panel);
        if (gridTerminals.length > 1) {
          var stripsEl = document.createElement('div');
          stripsEl.className = 'focus-strips';
          gridTerminals.forEach(function(gt, i) {
            if (i === focusedIndex) return;
            gt.panel.classList.add('focus-strip');
            stripsEl.appendChild(gt.panel);
          });
          contentEl.appendChild(stripsEl);
        }
        break;

      case 'fullscreen':
        var fullGt = gridTerminals[focusedIndex];
        fullGt.panel.classList.add('fullscreen');
        contentEl.appendChild(fullGt.panel);
        var backBtn = document.createElement('button');
        backBtn.className = 'back-to-grid';
        backBtn.textContent = '\u2190 Grid';
        backBtn.addEventListener('click', function() { switchGridMode('thumbnails'); });
        contentEl.appendChild(backBtn);
        break;
    }

    // Fit visible terminals after DOM settles
    setTimeout(function() {
      gridTerminals.forEach(function(gt) {
        if (!document.contains(gt.panel)) return;
        if (gt.fitAddon) {
          try {
            gt.fitAddon.fit();
            if (gt.ws && gt.ws.readyState === WebSocket.OPEN && gt.xterm) {
              gt.ws.send(JSON.stringify({ type: 'pty_resize', cols: gt.xterm.cols, rows: gt.xterm.rows }));
            }
          } catch(e) {}
        }
      });
    }, 100);
  }

  function fitGridPanels() {
    gridTerminals.forEach(function(gt) {
      if (!document.contains(gt.panel)) return;
      if (gt.fitAddon) {
        try {
          gt.fitAddon.fit();
          if (gt.ws && gt.ws.readyState === WebSocket.OPEN && gt.xterm) {
            gt.ws.send(JSON.stringify({ type: 'pty_resize', cols: gt.xterm.cols, rows: gt.xterm.rows }));
          }
        } catch(e) {}
      }
    });
  }

  function destroyGrid() {
    gridTerminals.forEach(function(gt) {
      if (gt.ws) { try { gt.ws.close(); } catch(e) {} }
      if (gt.xterm) { try { gt.xterm.dispose(); } catch(e) {} }
    });
    gridTerminals = [];
    window.removeEventListener('resize', fitGridPanels);
    var gridEl = document.getElementById('grid-view');
    if (gridEl) { gridEl.innerHTML = ''; gridEl.classList.add('hidden'); }
    $('#input-area').classList.add('hidden');
    gridMode = 'thumbnails';
    focusedIndex = 0;
    tmuxPreset = 'equal';
  }

  window.toggleView = () => {
    if (currentView === 'grid') {
      // Grid → dashboard (list view)
      destroyGrid();
      currentView = 'dashboard';
      dashboard.classList.remove('hidden');
      $('#btn-sessions').textContent = 'Terminal';
      loadSessions();
      return;
    }
    if (currentView === 'terminal') {
      currentView = 'dashboard';
      terminal.classList.add('hidden');
      termContainer.classList.add('hidden');
      $('#input-area').classList.add('hidden');
      dashboard.classList.remove('hidden');
      $('#btn-sessions').textContent = 'Terminal';
      loadSessions();
    } else {
      destroyGrid();
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
  const isHubMode = new URLSearchParams(window.location.search).get('hub') === '1';

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

    // F-02: Ticket-based auth (required)
    try {
      const resp = await fetch('/api/auth/ticket', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tokenParam }
      });
      if (resp.ok) {
        const { ticket } = await resp.json();
        ws = new WebSocket(`${proto}//${location.host}?ticket=${encodeURIComponent(ticket)}`);
      } else {
        setStatus('offline', 'Auth failed');
        return;
      }
    } catch {
      setStatus('offline', 'Auth failed');
      return;
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
  // F-5: Event delegation for key-bar buttons (no inline onclick)
  const keyBar = document.getElementById('key-bar');
  if (keyBar) {
    var keyMap = {
      '\\x1b[A': '\x1b[A', '\\x1b[B': '\x1b[B', '\\x1b[C': '\x1b[C', '\\x1b[D': '\x1b[D',
      '\\t': '\t', '\\r': '\r', '\\x1b': '\x1b', '\\x03': '\x03', ' ': ' ', '\\x7f': '\x7f',
    };
    keyBar.addEventListener('click', function(e) {
      var btn = e.target;
      if (btn && btn.tagName === 'BUTTON' && btn.dataset.key) {
        var key = keyMap[btn.dataset.key] || btn.dataset.key;
        if (currentView === 'grid' && gridMode === 'fullscreen' && gridTerminals[focusedIndex]) {
          var gt = gridTerminals[focusedIndex];
          if (gt.ws && gt.ws.readyState === WebSocket.OPEN) {
            gt.ws.send(JSON.stringify({ type: 'pty_input', data: key }));
          }
          if (gt.xterm) gt.xterm.focus();
        } else {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pty_input', data: key }));
          }
          if (xterm) xterm.focus();
        }
      }
    });
  }

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
    const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
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

