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

  // Save token before it's stripped from URL bar
  var savedToken = new URLSearchParams(window.location.search).get('token') || '';

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
  let gridTerminals = []; // { xterm, fitAddon, session, panel }
  var gridMode = 'thumbnails';
  var focusedIndex = 0;
  var tmuxPreset = 'equal';

  // ─── Terminal Recording (MediaRecorder API) ───────────────
  var mediaRecorder = null;
  var recordedChunks = [];
  var isRecording = false;
  var recordTimer = null;

  function startRecording() {
    var canvas = null;
    if (currentView === 'grid' && gridMode === 'fullscreen' && gridTerminals[focusedIndex]) {
      canvas = gridTerminals[focusedIndex].panel.querySelector('canvas');
    } else {
      var tc = document.getElementById('terminal-container');
      if (tc) canvas = tc.querySelector('canvas');
    }
    if (!canvas) {
      // Fallback: try to find any canvas in the xterm container
      var xtermEl = document.querySelector('.xterm');
      if (xtermEl) canvas = xtermEl.querySelector('canvas');
    }
    if (!canvas || !canvas.captureStream) {
      if (statusText) { var prev = statusText.textContent; statusText.textContent = 'Recording not supported'; setTimeout(function() { statusText.textContent = prev; }, 3000); }
      return false;
    }
    try {
      var stream = canvas.captureStream(30); // 30 fps
      var mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8'
        : 'video/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType, videoBitsPerSecond: 2500000 });
      recordedChunks = [];
      mediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = function() {
        var blob = new Blob(recordedChunks, { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = 'cli-tunnel-' + timestamp + '.webm';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
      };
      mediaRecorder.start(1000); // collect data every 1s
      isRecording = true;
      // Auto-stop after 10 minutes to prevent memory issues
      setTimeout(function() {
        if (isRecording) { toggleRecording(); }
      }, 10 * 60 * 1000);
      return true;
    } catch (e) {
      console.error('Recording failed:', e);
      return false;
    }
  }

  function stopRecording() {
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    mediaRecorder = null;
  }

  function toggleRecording() {
    var btn = document.getElementById('btn-record');
    if (isRecording) {
      stopRecording();
      if (btn) { btn.classList.remove('recording'); btn.textContent = '⏺'; btn.title = 'Record terminal'; }
    } else {
      if (startRecording()) {
        if (btn) { btn.classList.add('recording'); btn.textContent = '⏹'; btn.title = 'Stop recording & download'; btn.setAttribute('aria-label', 'Stop recording'); }
        var recordStartTime = Date.now();
        recordTimer = setInterval(function() {
          if (!isRecording) { clearInterval(recordTimer); recordTimer = null; return; }
          var elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
          var min = Math.floor(elapsed / 60);
          var sec = elapsed % 60;
          if (btn) btn.textContent = '⏹ ' + min + ':' + (sec < 10 ? '0' : '') + sec;
        }, 1000);
      } else {
        // Show error to user
        var prevText = statusText ? statusText.textContent : '';
        if (statusText) { statusText.textContent = 'Recording not available'; }
        setTimeout(function() { if (statusText && statusText.textContent === 'Recording not available') statusText.textContent = prevText; }, 3000);
      }
    }
  }

  function takeScreenshot() {
    var canvas = null;
    if (currentView === 'grid' && gridMode === 'fullscreen' && gridTerminals[focusedIndex]) {
      canvas = gridTerminals[focusedIndex].panel.querySelector('canvas');
    } else {
      var tc = document.getElementById('terminal-container');
      if (tc) canvas = tc.querySelector('canvas');
    }
    if (!canvas) {
      // Fallback: try to find any canvas in the xterm container
      var xtermEl = document.querySelector('.xterm');
      if (xtermEl) canvas = xtermEl.querySelector('canvas');
    }
    if (!canvas) {
      if (statusText) { var prev = statusText.textContent; statusText.textContent = 'No terminal to capture'; setTimeout(function() { statusText.textContent = prev; }, 2000); }
      return;
    }
    try {
      var dataUrl = canvas.toDataURL('image/png');
      var a = document.createElement('a');
      var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = dataUrl;
      a.download = 'cli-tunnel-' + timestamp + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Flash effect
      canvas.style.opacity = '0.5';
      setTimeout(function() { canvas.style.opacity = '1'; }, 150);
    } catch (e) {
      if (statusText) { var prev2 = statusText.textContent; statusText.textContent = 'Screenshot failed'; setTimeout(function() { statusText.textContent = prev2; }, 2000); }
    }
  }

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
    var lastCols = 0, lastRows = 0;
    var resizeTimer = null;
    function sendResize() {
      if (ws && ws.readyState === WebSocket.OPEN && xterm) {
        if (xterm.cols !== lastCols || xterm.rows !== lastRows) {
          lastCols = xterm.cols;
          lastRows = xterm.rows;
          ws.send(JSON.stringify({ type: 'pty_resize', cols: xterm.cols, rows: xterm.rows }));
        }
      }
    }

    // Handle resize — debounced to avoid rapid PTY resizes (mobile keyboard, URL bar, etc.)
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (fitAddon) { fitAddon.fit(); sendResize(); }
      }, 150);
    });

    // Initial size is sent on WS open (see ws.onopen)

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
      var headers = savedToken ? { 'Authorization': 'Bearer ' + savedToken } : {};
      var resp = await fetch('/api/sessions', { headers: headers });
      if (!resp.ok) throw new Error('Status ' + resp.status);
      var data = await resp.json();
      if (!isHubMode) {
        renderNonHubSessions(data.sessions || []);
      } else {
        renderDashboard(data.sessions || []);
      }
    } catch (err) {
      dashboard.innerHTML = '<div style="padding:20px 12px;color:var(--text-dim);text-align:center">' +
        escapeHtml('Sessions unavailable. Use Hub mode (cli-tunnel with no command) to see all sessions.') + '</div>';
    }
  }

  function renderNonHubSessions(sessions) {
    var currentName = document.title || 'this session';
    var html = '<div class="non-hub-view">' +
      '<div class="non-hub-current">You\'re connected to: <strong>' + escapeHtml(currentName) + '</strong></div>' +
      '<div class="non-hub-back"><a href="#" data-action="back-to-terminal">← Back to terminal</a></div>' +
      '<div class="non-hub-hint">Start a Hub to see all sessions: <code>cli-tunnel</code> (no command)</div>' +
      '</div>';
    dashboard.innerHTML = html;
    var backLink = dashboard.querySelector('[data-action="back-to-terminal"]');
    if (backLink) {
      backLink.addEventListener('click', function(e) { e.preventDefault(); toggleView(); });
    }
  }

  function renderDashboard(sessions) {
    var filtered = showOffline ? sessions : sessions.filter(function(s) { return s.online; });
    var offlineCount = sessions.filter(function(s) { return !s.online; }).length;
    var connectable = filtered.filter(function(s) { return s.online && s.hasToken; });
    var remoteCount = filtered.length - connectable.length;

    // Hub header
    var html = '<div class="hub-header">' +
      '<h2 class="hub-title">cli-tunnel Hub</h2>' +
      '<div class="hub-stats">' + connectable.length + ' connectable · ' + remoteCount + ' remote' +
        (offlineCount > 0 ? ' · ' + offlineCount + ' offline' : '') +
        ' <span class="hub-refresh-indicator" title="Auto-refreshes every 10s">↻</span>' +
      '</div>' +
      '</div>';

    // Toolbar actions
    html += '<div class="hub-toolbar">' +
      '<button data-action="toggle-offline" class="hub-toolbar-btn">' + (showOffline ? 'Hide offline' : 'Show offline') + '</button>' +
      (offlineCount > 0 ? '<button data-action="clean-offline" class="hub-toolbar-btn hub-toolbar-btn-danger">Clean offline</button>' : '') +
      '<button data-action="refresh" class="hub-toolbar-btn">↻ Refresh</button>' +
      '</div>';

    // Grid banner when 2+ connectable
    if (connectable.length >= 2) {
      html += '<div class="grid-banner" data-action="grid-view">' +
        '<span>Monitor all sessions live</span>' +
        '<span class="grid-banner-btn">⊞ Open Grid View</span>' +
        '</div>';
    }

    if (filtered.length === 0) {
      html += '<div style="padding:20px 12px;color:var(--text-dim);text-align:center">' +
        (sessions.length === 0 ? 'No cli-tunnel sessions found.' : 'No online sessions. Tap "Show offline" to see stale ones.') +
        '</div>';
    } else {
      filtered.forEach(function(s) {
        var canConnect = s.online && s.hasToken;
        html += '<div class="session-card-v2' + (canConnect ? ' connectable' : '') + '"' +
          (canConnect ? ' data-session-port="' + s.port + '" data-session-base-url="' + escapeHtml(s.url) + '"' : '') + '>' +
          '<div class="card-header">' +
            '<span class="card-status ' + (s.online ? 'online' : 'offline') + '"></span>' +
            '<span class="card-name">' + escapeHtml(s.name) + '</span>' +
            (canConnect ? '<span class="card-connect">Connect →</span>' :
             s.online ? '<span class="card-remote">Remote 🔒</span>' :
             '<span class="card-offline">Offline</span>') +
          '</div>' +
          '<div class="card-details">' +
            '<span>💻 ' + escapeHtml(s.machine) + '</span>' +
            '<span>📦 ' + escapeHtml(s.repo) + '</span>' +
            '<span>🌿 ' + escapeHtml(s.branch) + '</span>' +
          '</div>' +
          (!s.online ? '<button data-delete-id="' + escapeHtml(s.id) + '" class="card-delete" title="Remove">✕</button>' : '') +
          '</div>';
      });
    }

    dashboard.innerHTML = html;
    cachedSessions = sessions;

    // Event delegation
    dashboard.querySelectorAll('.session-card-v2[data-session-port]').forEach(function(card) {
      card.addEventListener('click', function(e) {
        if (e.target.closest('[data-delete-id]')) return;
        var port = card.dataset.sessionPort;
        var baseUrl = card.dataset.sessionBaseUrl;
        var proxyUrl = '/api/proxy/ticket/' + port;
        fetch(proxyUrl, {
          method: 'POST',
          headers: savedToken ? { 'Authorization': 'Bearer ' + savedToken } : {}
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
    const headers = savedToken ? { 'Authorization': 'Bearer ' + savedToken } : {};
    const resp = await fetch('/api/sessions', { headers });
    const data = await resp.json();
    const offline = (data.sessions || []).filter(s => !s.online);
    for (const s of offline) {
      await fetch('/api/sessions/' + s.id, { method: 'DELETE', headers });
    }
    loadSessions();
  };

  window.deleteSession = async (id) => {
    const headers = savedToken ? { 'Authorization': 'Bearer ' + savedToken } : {};
    await fetch('/api/sessions/' + id, { method: 'DELETE', headers });
    loadSessions();
  };

  // ─── Grid View (multi-terminal with layout modes) ───────────
  function showGridView(sessions) {
    var connectable = sessions.filter(function(s) { return s.online && s.hasToken; });
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
      var entry = { xterm: panelXterm, fitAddon: panelFit, session: s, panel: panel };
      gridTerminals.push(entry);

      // Connect via hub relay — send grid_connect message
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'grid_connect', port: s.port }));
      }

      panelXterm.onData(function(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'grid_input', port: s.port, data: data }));
        }
      });
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
          } catch(e) {}
        }
      });
    }, 100);
  }

  var gridResizeTimer = null;
  function fitGridPanels() {
    if (gridResizeTimer) clearTimeout(gridResizeTimer);
    gridResizeTimer = setTimeout(function() {
      gridTerminals.forEach(function(gt) {
        if (!document.contains(gt.panel)) return;
        if (gt.fitAddon) {
          try {
            var prevCols = gt.xterm ? gt.xterm.cols : 0;
            var prevRows = gt.xterm ? gt.xterm.rows : 0;
            gt.fitAddon.fit();
          } catch(e) {}
        }
      });
    }, 150);
  }

  function destroyGrid() {
    if (isRecording) { stopRecording(); var btn = document.getElementById('btn-record'); if (btn) { btn.classList.remove('recording'); btn.textContent = '⏺'; btn.title = 'Record terminal'; } }
    gridTerminals.forEach(function(gt) {
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
      if (isRecording) { stopRecording(); var btn = document.getElementById('btn-record'); if (btn) { btn.classList.remove('recording'); btn.textContent = '⏺'; btn.title = 'Record terminal'; } }
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
      // Hub mode — show sessions dashboard
      setStatus('online', 'Hub');
      terminal.classList.add('hidden');
      termContainer.classList.add('hidden');
      $('#input-area').classList.add('hidden');
      $('#btn-sessions').classList.add('hidden');
      dashboard.classList.remove('hidden');
      loadSessions();
      setInterval(loadSessions, 10000);

      // Hub also needs a WS connection for grid relay
      if (savedToken) {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        try {
          var resp = await fetch('/api/auth/ticket', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + savedToken }
          });
          if (resp.ok) {
            var data = await resp.json();
            ws = new WebSocket(proto + '//' + location.host + '?ticket=' + encodeURIComponent(data.ticket));
            ws.onopen = function() { connected = true; console.log('[hub] WS connected for grid relay'); };
            ws.onclose = function() { connected = false; ws = null; };
            ws.onerror = function() { ws = null; };
            ws.onmessage = function(e) {
              try { handleMessage(JSON.parse(e.data)); } catch(err) {}
            };
          }
        } catch(err) { console.log('[hub] WS connect failed:', err); }
      }
      return;
    }

    const ticketParam = new URLSearchParams(window.location.search).get('ticket');

    if (!savedToken && !ticketParam) { setStatus('offline', 'No credentials'); return; }

    // Strip token from URL bar to prevent leaking via Referer/history
    if (savedToken) {
      var cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('token');
      history.replaceState(null, '', cleanUrl.toString());
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

    // If we have a ticket (from hub Connect button), use it directly
    if (ticketParam) {
      ws = new WebSocket(`${proto}//${location.host}?ticket=${encodeURIComponent(ticketParam)}`);
    } else {
      // Exchange token for ticket
      try {
        const resp = await fetch('/api/auth/ticket', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + savedToken }
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
    }
    setStatus('connecting', 'Connecting...');

    ws.onopen = () => {
      connected = true;
      reconnectAttempt = 0;
      setStatus('online', 'Connected');
      // Reset resize tracking so initial pty_resize is always sent on new connection
      if (xterm) { lastCols = 0; lastRows = 0; sendResize(); }
    };
    ws.onclose = () => {
      if (isRecording) { stopRecording(); var btn = document.getElementById('btn-record'); if (btn) { btn.classList.remove('recording'); btn.textContent = '⏺'; btn.title = 'Record terminal'; } }
      connected = false; acpReady = false; sessionId = null;
      if (reconnectAttempt >= 10) {
        setStatus('offline', 'Connection lost');
        return;
      }
      setStatus('offline', 'Reconnecting...');
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

  // Reconnect immediately when phone comes back from background
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && !connected && !isHubMode) {
      reconnectAttempt = 0;
      connect();
    }
  });

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

    // Grid relay messages from hub
    if (msg.type === 'grid_pty') {
      var gt = gridTerminals.find(function(g) { return g.session && g.session.port === msg.port; });
      if (gt && gt.xterm) { gt.xterm.write(msg.data); }
      return;
    }

    if (msg.type === 'grid_connected') {
      var gt = gridTerminals.find(function(g) { return g.session && g.session.port === msg.port; });
      if (gt) {
        var dot = gt.panel.querySelector('.grid-panel-status');
        if (dot) { dot.style.color = 'var(--green)'; dot.title = 'Connected'; }
      }
      return;
    }

    if (msg.type === 'grid_disconnected') {
      var gt = gridTerminals.find(function(g) { return g.session && g.session.port === msg.port; });
      if (gt) {
        var dot = gt.panel.querySelector('.grid-panel-status');
        if (dot) { dot.style.color = 'var(--red)'; dot.title = 'Disconnected'; }
      }
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
      if (btn && btn.tagName === 'BUTTON' && btn.dataset.action === 'toggle-record') {
        toggleRecording();
        return;
      }
      if (btn && btn.tagName === 'BUTTON' && btn.dataset.action === 'take-screenshot') {
        takeScreenshot();
        return;
      }
      if (btn && btn.tagName === 'BUTTON' && btn.dataset.key) {
        var key = keyMap[btn.dataset.key] || btn.dataset.key;
        if (currentView === 'grid' && gridMode === 'fullscreen' && gridTerminals[focusedIndex]) {
          var gt = gridTerminals[focusedIndex];
          if (ws && ws.readyState === WebSocket.OPEN && gt.session) {
            ws.send(JSON.stringify({ type: 'grid_input', port: gt.session.port, data: key }));
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

