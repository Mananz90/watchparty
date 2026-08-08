(() => {
  const SERVER_URL = 'wss://watchparty-sync.onrender.com';

  let ws = null;
  let roomId = null;
  let name = 'Guest';
  let video = null;
  let suppressSync = false; // true while we're applying a remote event, to avoid echo loops
  let lastSentAction = null;
  let overlayEl = null;

  function log(...args) {
    console.log('[WatchParty]', ...args);
  }

  function findVideo() {
    const adapter = window.__wpAdapter;
    return adapter ? adapter.getVideo() : document.querySelector('video');
  }

  function connect(room, displayName) {
    if (ws) ws.close();
    roomId = room;
    name = displayName || 'Guest';

    ws = new WebSocket(SERVER_URL);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', roomId, name }));
      setStatus(`Connected — room ${roomId}`);
    };
    ws.onclose = () => setStatus('Disconnected');
    ws.onerror = () => setStatus('Connection error');
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleServerMessage(msg);
    };

    chrome.storage.local.set({ wpRoomId: room, wpName: name });
  }

  function handleServerMessage(msg) {
    if (msg.type === 'sync') {
      applyRemoteSync(msg);
    } else if (msg.type === 'chat') {
      appendChat(msg.name, msg.text);
    } else if (msg.type === 'presence') {
      appendChat('System', `${msg.name} ${msg.event} (${msg.count} watching)`);
    } else if (msg.type === 'joined') {
      appendChat('System', `You joined room ${msg.roomId} (${msg.count} watching)`);
    }
  }

  const SEEK_JUMP_THRESHOLD = 2.5; // seconds — ignore smaller jumps as buffering, not a real seek
  let lastKnownTime = 0;

  function applyRemoteSync(msg) {
    video = video || findVideo();
    if (!video) return;
    suppressSync = true;
    if (msg.action === 'play') {
      if (Math.abs(video.currentTime - msg.time) > 1.5) video.currentTime = msg.time;
      video.play().catch(() => {});
    } else if (msg.action === 'pause') {
      if (Math.abs(video.currentTime - msg.time) > 1.5) video.currentTime = msg.time;
      video.pause();
    } else if (msg.action === 'seek') {
      video.currentTime = msg.time;
    }
    lastKnownTime = msg.time;
    // Netflix/Hotstar keep firing buffering-related events for a bit after we
    // apply a correction; hold suppression longer than the old 300ms so those
    // don't get mistaken for a new user seek and echoed straight back.
    setTimeout(() => { suppressSync = false; }, 1200);
  }

  function sendSync(action, time) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !video || suppressSync) return;
    ws.send(JSON.stringify({ type: 'sync', action, time }));
  }

  function bindVideoElement(el) {
    video = el;
    lastKnownTime = video.currentTime;
    video.addEventListener('play', () => sendSync('play', video.currentTime));
    video.addEventListener('pause', () => sendSync('pause', video.currentTime));
    video.addEventListener('timeupdate', () => {
      // Track normal playback progress so we can tell a real seek (big jump)
      // apart from Netflix's own buffering/quality-switch stutters (small jump).
      if (!video.seeking) lastKnownTime = video.currentTime;
    });
    let seekTimer = null;
    video.addEventListener('seeking', () => {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        const jump = Math.abs(video.currentTime - lastKnownTime);
        if (jump < SEEK_JUMP_THRESHOLD) return; // buffering blip, not a real seek — don't broadcast
        sendSync('seek', video.currentTime);
        lastKnownTime = video.currentTime;
      }, 400);
    });
    log(`Attached to ${window.__wpAdapter?.siteName || 'video'} player`);
  }

  function attachVideoListeners() {
    const found = findVideo();
    if (found && found !== video) {
      bindVideoElement(found);
    }
    // Sites like Hotstar/Netflix swap out the <video> element mid-playback
    // (ad breaks, quality switches). Keep polling so we re-attach when that happens.
    setTimeout(attachVideoListeners, 1000);
  }

  // ---------- Overlay UI (chat + room controls) ----------

  function leaveParty() {
    if (ws) {
      ws.close();
      ws = null;
    }
    roomId = null;
    chrome.storage.local.remove(['wpRoomId']);
    setStatus('Not connected');
    appendChat('System', 'You left the party.');
  }

  function buildOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'wp-overlay';
    overlayEl.innerHTML = `
      <div id="wp-header">
        <span id="wp-title">Watch Party</span>
        <div id="wp-header-btns">
          <button id="wp-leave" title="Leave party">Leave</button>
          <button id="wp-toggle" title="Minimize">—</button>
        </div>
      </div>
      <div id="wp-body">
        <div id="wp-room-row">
          <input id="wp-room-input" placeholder="Room code" />
          <input id="wp-name-input" placeholder="Your name" />
          <button id="wp-join-btn">Join</button>
        </div>
        <div id="wp-status">Not connected</div>
        <div id="wp-chat-log"></div>
        <div id="wp-chat-row">
          <input id="wp-chat-input" placeholder="Say something…" />
          <button id="wp-chat-send">Send</button>
        </div>
      </div>
    `;
    const tab = document.createElement('button');
    tab.id = 'wp-edge-tab';
    tab.textContent = 'Watch Party';
    tab.onclick = () => {
      overlayEl.classList.remove('wp-hidden');
      tab.classList.remove('wp-visible');
    };

    const parent = window.__wpAdapter?.getOverlayParent() || document.body;
    parent.appendChild(overlayEl);
    parent.appendChild(tab);

    overlayEl.querySelector('#wp-toggle').onclick = () => {
      overlayEl.classList.add('wp-hidden');
      tab.classList.add('wp-visible');
    };
    overlayEl.querySelector('#wp-leave').onclick = leaveParty;
    overlayEl.querySelector('#wp-join-btn').onclick = () => {
      const room = overlayEl.querySelector('#wp-room-input').value.trim();
      const nm = overlayEl.querySelector('#wp-name-input').value.trim() || 'Guest';
      if (room) connect(room, nm);
    };
    const chatInput = overlayEl.querySelector('#wp-chat-input');
    const sendChat = () => {
      const text = chatInput.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'chat', text }));
      chatInput.value = '';
    };
    overlayEl.querySelector('#wp-chat-send').onclick = sendChat;
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    // Fully hide the widget while the window/tab isn't visible (e.g. minimized),
    // and bring it back automatically once it's visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        overlayEl.classList.add('wp-hidden');
        tab.classList.remove('wp-visible');
      } else {
        overlayEl.classList.remove('wp-hidden');
      }
    });

    return overlayEl;
  }

  function setStatus(text) {
    buildOverlay().querySelector('#wp-status').textContent = text;
  }

  function appendChat(from, text) {
    const logEl = buildOverlay().querySelector('#wp-chat-log');
    const line = document.createElement('div');
    line.className = 'wp-chat-line';
    line.innerHTML = `<strong>${escapeHtml(from)}:</strong> ${escapeHtml(text)}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Init ----------

  function init() {
    buildOverlay();
    attachVideoListeners();

    chrome.storage.local.get(['wpRoomId', 'wpName'], (data) => {
      if (data.wpRoomId) {
        overlayEl.querySelector('#wp-room-input').value = data.wpRoomId;
        overlayEl.querySelector('#wp-name-input').value = data.wpName || '';
      }

      // Invite link: https://…?wp_room=<code> — auto-join on load
      const urlRoom = new URLSearchParams(window.location.search).get('wp_room');
      if (urlRoom) {
        const nm = data.wpName || window.prompt('Joining Watch Party — enter your name:', '') || 'Guest';
        overlayEl.querySelector('#wp-room-input').value = urlRoom;
        overlayEl.querySelector('#wp-name-input').value = nm;
        connect(urlRoom, nm);

        // Clean the URL so the param doesn't linger / re-trigger on refresh
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('wp_room');
        window.history.replaceState({}, '', cleanUrl.toString());
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'wp-join' && msg.roomId) {
        overlayEl.querySelector('#wp-room-input').value = msg.roomId;
        overlayEl.querySelector('#wp-name-input').value = msg.name || '';
        connect(msg.roomId, msg.name);
      }
    });
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();
