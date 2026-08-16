(() => {
  const SERVER_URL = 'wss://watchparty-sync.onrender.com';
  const REACTIONS = ['👍', '❤️', '😂', '😮', '🔥', '👏'];
  const AVATAR_COLORS = ['#e50914', '#0af', '#0c6', '#f90', '#a5f', '#0cc', '#f4a'];

  let ws = null;
  let roomId = null;
  let name = 'Guest';
  let myId = null;
  let video = null;
  let overlayEl = null;
  let roster = []; // [{ id, name, isHost }]
  let hostLockEnabled = false;
  let typingTimer = null;

  function log(...args) {
    console.log('[Watchparty]', ...args);
  }

  // When the extension is reloaded/updated in chrome://extensions while a tab
  // is already open, that tab's old content script keeps running but loses
  // its link to the extension — any further chrome.* call throws "Extension
  // context invalidated." These wrappers catch that instead of letting it go
  // uncaught, and prompt for the one-time page refresh that actually fixes it.
  let contextInvalidatedWarned = false;
  function isExtensionContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  function warnContextInvalidated() {
    if (contextInvalidatedWarned) return;
    contextInvalidatedWarned = true;
    if (overlayEl) {
      const banner = document.createElement('div');
      banner.id = 'wp-context-banner';
      banner.textContent = 'Watchparty was updated — refresh this page to reconnect.';
      overlayEl.prepend(banner);
    }
  }
  function safeStorageSet(obj) {
    if (!isExtensionContextValid()) return warnContextInvalidated();
    try { chrome.storage.local.set(obj); } catch { warnContextInvalidated(); }
  }
  function safeStorageGet(keys, cb) {
    if (!isExtensionContextValid()) return warnContextInvalidated();
    try { chrome.storage.local.get(keys, cb); } catch { warnContextInvalidated(); }
  }
  function safeStorageRemove(keys) {
    if (!isExtensionContextValid()) return warnContextInvalidated();
    try { chrome.storage.local.remove(keys); } catch { warnContextInvalidated(); }
  }

  function findVideo() {
    const adapter = window.__wpAdapter;
    return adapter ? adapter.getVideo() : document.querySelector('video');
  }

  function isHost() {
    const me = roster.find((m) => m.id === myId);
    return !!me?.isHost;
  }

  function colorFor(id) {
    let hash = 0;
    for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  let intentionalDisconnect = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  function connect(room, displayName) {
    if (ws) ws.close();
    clearTimeout(reconnectTimer);
    intentionalDisconnect = false;
    roomId = room;
    name = displayName || 'Guest';
    openSocket();
    safeStorageSet({ wpRoomId: room, wpName: name });
  }

  function openSocket() {
    ws = new WebSocket(SERVER_URL);
    ws.onopen = () => {
      reconnectAttempt = 0;
      ws.send(JSON.stringify({ type: 'join', roomId, name }));
      setStatus(`Connected — room ${roomId}`);
    };
    ws.onclose = () => {
      if (intentionalDisconnect || !roomId) {
        setStatus('Disconnected');
        return;
      }
      // Lost connection unexpectedly (e.g. a hosting proxy dropping an idle
      // socket) — reconnect and rejoin the same room automatically instead
      // of leaving the widget silently dead until the user notices and
      // clicks Join again.
      reconnectAttempt++;
      const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 15000);
      setStatus(`Reconnecting… (${Math.round(delay / 1000)}s)`);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(openSocket, delay);
    };
    ws.onerror = () => setStatus('Connection error');
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleServerMessage(msg);
    };
  }

  function handleServerMessage(msg) {
    if (msg.type === 'sync') {
      if (hostLockEnabled && !roster.find((m) => m.name === msg.from)?.isHost) return; // ignore non-host sync when locked
      applyRemoteSync(msg);
    } else if (msg.type === 'chat') {
      appendChat(msg.name, msg.text);
    } else if (msg.type === 'presence') {
      appendChat('System', `${msg.name} ${msg.event} (${msg.count} watching)`);
    } else if (msg.type === 'joined') {
      myId = msg.id;
      appendChat('System', `You joined room ${msg.roomId} (${msg.count} watching)`);
    } else if (msg.type === 'roster') {
      roster = msg.members;
      renderRoster();
    } else if (msg.type === 'reaction') {
      showFloatingReaction(msg.emoji, msg.name);
    } else if (msg.type === 'typing') {
      showTypingIndicator(msg.name);
    }
  }

  // ---------- Per-platform sync tuning ----------
  // Adapters can override any of these via window.__wpAdapter.syncConfig so
  // fixing one site's quirks (e.g. Hotstar's player) can't change behavior
  // on sites that already work fine (Netflix, Prime).
  const DEFAULT_SYNC_CONFIG = {
    seekJumpThreshold: 2.5,      // seconds — ignore smaller jumps as buffering, not a real seek
    driftCorrectionThreshold: 8, // seconds — only force-seek on play/pause if drift is this large
    minCorrectionGapMs: 1200,    // spacing between actual currentTime writes (DRM players can error on rapid seeks)
    usePolling: false,           // some players don't fire 'seeking'/'seeked' reliably — polling
                                  // currentTime directly is a robust fallback that doesn't depend
                                  // on any specific event firing at all
    pollIntervalMs: 400,
  };
  function getSyncConfig() {
    return { ...DEFAULT_SYNC_CONFIG, ...(window.__wpAdapter?.syncConfig || {}) };
  }

  let lastKnownTime = 0;
  let lastCorrectionAt = 0;
  let pendingCorrectionTimer = null;
  let pendingCorrectionTarget = null;

  // Tracks the most recent sync applied FROM the network, so a genuine new
  // local action (e.g. the user pressing Play) can be told apart from our
  // own correction echoing back through the player's native events. This
  // replaces a blanket "ignore everything locally for N ms" window, which
  // could swallow a real subsequent action if it landed inside that window —
  // that was the cause of "play doesn't sync sometimes".
  let lastAppliedSync = null; // { action, time, appliedAt }

  function isEchoOfAppliedSync(action, time) {
    if (!lastAppliedSync) return false;
    if (Date.now() - lastAppliedSync.appliedAt > 900) return false;
    if (Math.abs(time - lastAppliedSync.time) > 1.5) return false;
    // A 'seek' at a time close to whatever we just applied is almost always
    // a side effect of that correction (e.g. a play/pause correction that
    // had to jump position, which fires the player's own seeking/seeked
    // events) — regardless of what action originally caused it. Requiring
    // an exact action match here caused those side-effect seeks to be
    // rebroadcast as brand-new actions instead of recognized as echoes,
    // which built into a feedback loop bouncing both viewers between two
    // positions on Netflix. Play/pause still require an exact action match
    // so a genuine quick toggle right after a correction isn't swallowed.
    if (action === 'seek') return true;
    return lastAppliedSync.action === action;
  }

  function formatTime(t) {
    const s = Math.max(0, Math.round(t));
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  async function safeSetCurrentTime(t) {
    const config = getSyncConfig();
    const now = Date.now();
    const elapsed = now - lastCorrectionAt;
    if (elapsed < config.minCorrectionGapMs) {
      // Too soon after the last correction to apply another one safely —
      // remember this as the latest target and apply it once the cooldown
      // elapses, instead of dropping it. Dropping it silently is what made
      // back-to-back seeks (e.g. pressing +10 a few times quickly) look
      // "stuck" until something else eventually triggered a big enough
      // correction to catch up all at once.
      pendingCorrectionTarget = t;
      if (!pendingCorrectionTimer) {
        pendingCorrectionTimer = setTimeout(() => {
          pendingCorrectionTimer = null;
          const target = pendingCorrectionTarget;
          pendingCorrectionTarget = null;
          if (target != null) safeSetCurrentTime(target);
        }, config.minCorrectionGapMs - elapsed);
      }
      return;
    }
    lastCorrectionAt = now;
    const adapter = window.__wpAdapter;
    try {
      if (adapter?.seekTo) {
        // Sites with DRM-protected players (Netflix) need to go through their
        // own internal player API instead of a raw currentTime write — see
        // adapters/netflix.js + adapters/netflix-page-bridge.js.
        log(`seeking via adapter.seekTo -> ${formatTime(t)}`);
        await adapter.seekTo(video, t);
        log(`adapter.seekTo resolved, currentTime is now ${formatTime(video.currentTime)}`);
      } else {
        log(`seeking via direct currentTime write -> ${formatTime(t)}`);
        video.currentTime = t;
      }
    } catch (e) {
      log('seek failed, notifying instead', e);
      appendChat('System', `Couldn't auto-seek — the room is at ${formatTime(t)}, seek there manually to catch up.`);
    }
  }

  async function applyRemoteSync(msg) {
    video = video || findVideo();
    if (!video) {
      log('applyRemoteSync: no video element found, dropping', msg);
      return;
    }
    log(`applyRemoteSync: ${msg.action} @ ${formatTime(msg.time)} from "${msg.from}" (we're at ${formatTime(video.currentTime)})`);
    const config = getSyncConfig();
    lastAppliedSync = { action: msg.action, time: msg.time, appliedAt: Date.now() };
    if (msg.action === 'play') {
      if (Math.abs(video.currentTime - msg.time) > config.driftCorrectionThreshold) await safeSetCurrentTime(msg.time);
      video.play().catch((e) => log('video.play() rejected', e));
    } else if (msg.action === 'pause') {
      if (Math.abs(video.currentTime - msg.time) > config.driftCorrectionThreshold) await safeSetCurrentTime(msg.time);
      video.pause();
    } else if (msg.action === 'seek') {
      // Skip applying a negligible correction — it wouldn't be visible
      // anyway, and applying it can itself trigger more native player
      // events (extra noise to filter, and extra risk on DRM players).
      if (Math.abs(video.currentTime - msg.time) > config.seekJumpThreshold) await safeSetCurrentTime(msg.time);
      else log('applyRemoteSync: seek skipped, already close enough');
    }
    lastKnownTime = msg.time;
    // Refresh the echo window's timestamp now that the correction (if any)
    // has actually finished, so a slow multi-step correction doesn't count
    // as "stale" and let its own trailing native events slip through as a
    // new local action.
    lastAppliedSync = { action: msg.action, time: msg.time, appliedAt: Date.now() };
  }

  function sendSync(action, time) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !video) {
      log(`sendSync(${action}) dropped: ${!ws ? 'no socket' : ws.readyState !== WebSocket.OPEN ? 'socket not open' : 'no video'}`);
      return;
    }
    if (hostLockEnabled && !isHost()) {
      log(`sendSync(${action}) dropped: host-only controls enabled and we're not host`);
      return;
    }
    if (isEchoOfAppliedSync(action, time)) {
      log(`sendSync(${action}) dropped: echo of our own just-applied correction`);
      return;
    }
    log(`sendSync: broadcasting ${action} @ ${formatTime(time)}`);
    ws.send(JSON.stringify({ type: 'sync', action, time }));
  }

  function bindVideoElement(el) {
    video = el;
    lastKnownTime = video.currentTime;
    const config = getSyncConfig();

    video.addEventListener('play', () => sendSync('play', video.currentTime));
    video.addEventListener('pause', () => sendSync('pause', video.currentTime));
    video.addEventListener('timeupdate', () => {
      // Track normal playback progress so we can tell a real seek (big jump)
      // apart from a platform's own buffering/quality-switch stutters (small jump).
      if (!video.seeking) lastKnownTime = video.currentTime;
    });

    if (config.usePolling) {
      // Some custom players (Hotstar's included) don't reliably fire
      // 'seeking'/'seeked' at all, especially for short in-buffer skips —
      // event-based detection can silently miss real seeks there. Polling
      // currentTime directly and comparing its progression against real
      // elapsed time sidesteps the problem entirely, since it doesn't
      // depend on any specific event firing.
      const myVideo = el;
      let lastPollAt = performance.now();
      let lastPollVideoTime = myVideo.currentTime;
      const intervalId = setInterval(() => {
        if (video !== myVideo) { clearInterval(intervalId); return; } // rebound to a different element — stop
        const nowReal = performance.now();
        const realElapsedSec = (nowReal - lastPollAt) / 1000;
        const videoTime = myVideo.currentTime;
        const videoElapsedSec = videoTime - lastPollVideoTime;
        lastPollAt = nowReal;
        lastPollVideoTime = videoTime;

        const isSeek = myVideo.paused
          ? Math.abs(videoElapsedSec) > config.seekJumpThreshold
          : Math.abs(videoElapsedSec - realElapsedSec) > config.seekJumpThreshold;

        if (isSeek) {
          sendSync('seek', videoTime);
          lastKnownTime = videoTime;
        }
      }, config.pollIntervalMs);
    } else {
      // 'seeked' fires once the browser considers a seek genuinely complete —
      // more accurate than reading currentTime off 'seeking' + a guessed
      // timeout, since the seek itself can take longer to settle than that
      // timeout on some players. 'seeking' still arms a fallback timer in
      // case a given player never fires 'seeked' for a particular seek.
      let seekFallbackTimer = null;
      let seekHandled = true;
      const reportSeek = (source) => {
        seekHandled = true;
        clearTimeout(seekFallbackTimer);
        const jump = Math.abs(video.currentTime - lastKnownTime);
        log(`${source}: currentTime=${formatTime(video.currentTime)}, jump=${jump.toFixed(1)}s`);
        if (jump < config.seekJumpThreshold) { lastKnownTime = video.currentTime; return; } // buffering blip, not a real seek
        sendSync('seek', video.currentTime);
        lastKnownTime = video.currentTime;
      };
      video.addEventListener('seeking', () => {
        log('native "seeking" event fired');
        seekHandled = false;
        clearTimeout(seekFallbackTimer);
        seekFallbackTimer = setTimeout(() => {
          if (!seekHandled) { log('"seeked" never fired — using 700ms fallback'); reportSeek('seek-fallback'); }
        }, 700);
      });
      video.addEventListener('seeked', () => reportSeek('native "seeked" event'));
    }

    log(`Attached to ${window.__wpAdapter?.siteName || 'video'} player (${config.usePolling ? 'polling' : 'event'} seek detection)`);
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

  // ---------- Overlay UI ----------

  function leaveParty() {
    intentionalDisconnect = true;
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.close();
      ws = null;
    }
    roomId = null;
    roster = [];
    renderRoster();
    safeStorageRemove(['wpRoomId']);
    if (overlayEl) overlayEl.querySelector('#wp-room-input').value = '';
    setStatus('Not connected');
    appendChat('System', 'You left the party.');
  }

  function buildOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'wp-overlay';
    overlayEl.innerHTML = `
      <div id="wp-header">
        <span id="wp-title">🎬 Watchparty</span>
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
        <button id="wp-share-btn" title="Copy a link that auto-joins this room on this title">🔗 Copy invite link</button>
        <div id="wp-share-status"></div>
        <div id="wp-status">Not connected</div>
        <div id="wp-roster"></div>
        <label id="wp-host-lock-row">
          <input type="checkbox" id="wp-host-lock" />
          Host-only controls
        </label>
        <div id="wp-reactions"></div>
        <div id="wp-chat-log"></div>
        <div id="wp-typing"></div>
        <div id="wp-chat-row">
          <input id="wp-chat-input" placeholder="Say something…" />
          <button id="wp-chat-send">Send</button>
        </div>
      </div>
    `;
    const tab = document.createElement('button');
    tab.id = 'wp-edge-tab';
    tab.textContent = 'Watchparty';
    tab.onclick = () => {
      overlayEl.classList.remove('wp-hidden');
      tab.classList.remove('wp-visible');
    };

    const reactLayer = document.createElement('div');
    reactLayer.id = 'wp-reaction-layer';

    const parent = window.__wpAdapter?.getOverlayParent() || document.body;
    parent.appendChild(overlayEl);
    parent.appendChild(tab);
    parent.appendChild(reactLayer);

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
    overlayEl.querySelector('#wp-host-lock').onchange = (e) => {
      hostLockEnabled = e.target.checked;
      appendChat('System', hostLockEnabled
        ? 'Host-only controls enabled — only the host can play/pause/seek for everyone.'
        : 'Host-only controls disabled — anyone can control playback.');
    };
    overlayEl.querySelector('#wp-share-btn').onclick = async () => {
      let room = overlayEl.querySelector('#wp-room-input').value.trim();
      if (!room) {
        room = roomId || `stream-${Math.floor(1000 + Math.random() * 9000)}`;
        overlayEl.querySelector('#wp-room-input').value = room;
      }
      const url = new URL(window.location.href);
      url.searchParams.set('wp_room', room);
      const statusEl = overlayEl.querySelector('#wp-share-status');
      try {
        await navigator.clipboard.writeText(url.toString());
        statusEl.textContent = 'Link copied — send it so they land on this exact title and auto-join.';
      } catch {
        statusEl.textContent = url.toString(); // clipboard blocked — show it so it can be copied by hand
      }
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    };

    const reactionsEl = overlayEl.querySelector('#wp-reactions');
    for (const emoji of REACTIONS) {
      const btn = document.createElement('button');
      btn.className = 'wp-reaction-btn';
      btn.textContent = emoji;
      btn.onclick = () => {
        // Server echoes the reaction back to everyone in the room, sender included —
        // showFloatingReaction() fires from that broadcast, not from this click directly.
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reaction', emoji }));
        }
      };
      reactionsEl.appendChild(btn);
    }

    const chatInput = overlayEl.querySelector('#wp-chat-input');
    const sendChat = () => {
      const text = chatInput.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'chat', text }));
      chatInput.value = '';
    };
    overlayEl.querySelector('#wp-chat-send').onclick = sendChat;
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    chatInput.addEventListener('input', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(typingTimer);
      ws.send(JSON.stringify({ type: 'typing' }));
      typingTimer = setTimeout(() => {}, 1500);
    });

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

  function renderRoster() {
    const el = buildOverlay().querySelector('#wp-roster');
    if (!roster.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = roster.map((m) => `
      <span class="wp-avatar" style="background:${colorFor(m.id)}" title="${escapeHtml(m.name)}${m.isHost ? ' (host)' : ''}">
        ${escapeHtml(m.name.slice(0, 1).toUpperCase())}${m.isHost ? '<span class="wp-host-badge">★</span>' : ''}
      </span>
    `).join('');
  }

  function appendChat(from, text) {
    const logEl = buildOverlay().querySelector('#wp-chat-log');
    const line = document.createElement('div');
    line.className = 'wp-chat-line';
    line.innerHTML = `<strong>${escapeHtml(from)}:</strong> ${escapeHtml(text)}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  let typingHideTimer = null;
  function showTypingIndicator(who) {
    const el = buildOverlay().querySelector('#wp-typing');
    el.textContent = `${who} is typing…`;
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => { el.textContent = ''; }, 2000);
  }

  function showFloatingReaction(emoji, from) {
    const layer = document.getElementById('wp-reaction-layer');
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'wp-floating-emoji';
    el.textContent = emoji;
    el.style.left = `${20 + Math.random() * 60}%`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Init ----------

  function init() {
    buildOverlay();
    attachVideoListeners();

    safeStorageGet(['wpRoomId', 'wpName'], (data) => {
      data = data || {};
      if (data.wpRoomId) {
        overlayEl.querySelector('#wp-room-input').value = data.wpRoomId;
        overlayEl.querySelector('#wp-name-input').value = data.wpName || '';
      }

      // Invite link: https://…?wp_room=<code> — auto-join on load
      const urlRoom = new URLSearchParams(window.location.search).get('wp_room');
      if (urlRoom) {
        const nm = data.wpName || window.prompt('Joining Watchparty — enter your name:', '') || 'Guest';
        overlayEl.querySelector('#wp-room-input').value = urlRoom;
        overlayEl.querySelector('#wp-name-input').value = nm;
        connect(urlRoom, nm);

        // Clean the URL so the param doesn't linger / re-trigger on refresh
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('wp_room');
        window.history.replaceState({}, '', cleanUrl.toString());
      }
    });

    if (isExtensionContextValid()) {
      try {
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg.type === 'wp-join' && msg.roomId) {
            overlayEl.querySelector('#wp-room-input').value = msg.roomId;
            overlayEl.querySelector('#wp-name-input').value = msg.name || '';
            connect(msg.roomId, msg.name);
          }
        });
      } catch { warnContextInvalidated(); }
    }
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();
