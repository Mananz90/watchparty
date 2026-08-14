import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

/** rooms: Map<roomId, Set<ws>>. First member to join (still connected) is host. */
const rooms = new Map();

/** roomState: Map<roomId, { playing, time, ts }> — last known playback state, so a
 *  newly joined viewer can be brought to the current play/pause + position instead
 *  of starting from whatever the streaming site does by default (e.g. autoplay). */
const roomState = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(roomId, msg, exceptWs) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const client of members) {
    if (client !== exceptWs) send(client, msg);
  }
}

function hostOf(roomId) {
  const members = rooms.get(roomId);
  if (!members || members.size === 0) return null;
  return [...members][0]; // Set preserves insertion order — earliest survivor is host
}

function roster(roomId) {
  const members = rooms.get(roomId);
  if (!members) return [];
  const host = hostOf(roomId);
  return [...members].map((m) => ({ id: m.id, name: m.name, isHost: m === host }));
}

function broadcastRoster(roomId) {
  broadcast(roomId, { type: 'roster', members: roster(roomId) }, null);
}

wss.on('connection', (ws) => {
  ws.id = randomUUID();
  ws.roomId = null;
  ws.name = 'Guest';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.roomId || '').trim();
        if (!roomId) return;
        ws.roomId = roomId;
        ws.name = String(msg.name || 'Guest').slice(0, 40);
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        rooms.get(roomId).add(ws);

        console.log(`[join] "${ws.name}" -> room "${roomId}" (now ${rooms.get(roomId).size} in room)`);
        broadcast(roomId, { type: 'presence', event: 'joined', name: ws.name, count: rooms.get(roomId).size }, ws);
        send(ws, { type: 'joined', roomId, count: rooms.get(roomId).size, id: ws.id });
        broadcastRoster(roomId);

        // Bring the new viewer to the room's current play/pause + position
        // instead of leaving them on whatever the streaming site defaults to.
        const state = roomState.get(roomId);
        if (state) {
          const time = state.playing ? state.time + (Date.now() - state.ts) / 1000 : state.time;
          send(ws, { type: 'sync', action: state.playing ? 'play' : 'pause', time, from: 'room', ts: Date.now() });
        }
        break;
      }

      // Playback sync: play, pause, seek — just relayed to everyone else in room
      case 'sync': {
        if (!ws.roomId) return;
        console.log(`[sync] "${ws.name}" in "${ws.roomId}": ${msg.action} @ ${msg.time?.toFixed?.(1) ?? msg.time}s`);

        const prev = roomState.get(ws.roomId);
        roomState.set(ws.roomId, {
          playing: msg.action === 'play' ? true : msg.action === 'pause' ? false : (prev?.playing ?? false),
          time: msg.time,
          ts: Date.now(),
        });

        broadcast(ws.roomId, {
          type: 'sync',
          action: msg.action,       // 'play' | 'pause' | 'seek'
          time: msg.time,           // video currentTime in seconds
          from: ws.name,
          ts: Date.now(),
        }, ws);
        break;
      }

      case 'chat': {
        if (!ws.roomId) return;
        const text = String(msg.text || '').slice(0, 500);
        if (!text) return;
        console.log(`[chat] "${ws.name}" in "${ws.roomId}": ${text}`);
        broadcast(ws.roomId, { type: 'chat', name: ws.name, text, ts: Date.now() }, null);
        break;
      }

      case 'reaction': {
        if (!ws.roomId) return;
        const emoji = String(msg.emoji || '').slice(0, 8);
        if (!emoji) return;
        broadcast(ws.roomId, { type: 'reaction', name: ws.name, emoji, ts: Date.now() }, null);
        break;
      }

      case 'typing': {
        if (!ws.roomId) return;
        broadcast(ws.roomId, { type: 'typing', name: ws.name }, ws);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (ws.roomId && rooms.has(ws.roomId)) {
      const members = rooms.get(ws.roomId);
      members.delete(ws);
      if (members.size === 0) {
        rooms.delete(ws.roomId);
        roomState.delete(ws.roomId);
      } else {
        broadcast(ws.roomId, { type: 'presence', event: 'left', name: ws.name, count: members.size }, ws);
        broadcastRoster(ws.roomId);
      }
    }
  });
});

console.log(`watchparty sync server listening on ws://localhost:${PORT}`);
