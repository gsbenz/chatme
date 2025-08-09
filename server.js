const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch'); // Make sure to install: npm install node-fetch

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ===== State =====
const rooms = new Map(); // Map<roomName, Set<WebSocket>>
const roomPermissions = new Map(); // Map<roomName, { admins: Set, muted: Set }>
const typingUsers = {};  // { roomName: Set<username> }
const typingTimestamps = new Map(); // Throttle typing: Map<user_room, timestamp>

// ===== Helpers =====

const parseJSON = (msg) => {
  try {
    return JSON.parse(msg);
  } catch {
    return null;
  }
};

const send = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const requireFields = (ws, data, ...fields) => {
  const missing = fields.filter(f => typeof data[f] !== 'string' || !data[f].trim());
  if (missing.length) {
    send(ws, { type: 'error', message: `Missing or invalid fields: ${missing.join(', ')}` });
    return false;
  }
  return true;
};

const broadcastToRoom = (room, payload, excludeWs = null) => {
  if (!rooms.has(room)) return;
  const msg = JSON.stringify(payload);
  for (const client of rooms.get(room)) {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(msg);
    }
  }
};

const broadcastPresence = (room) => {
  if (!rooms.has(room)) return;
  const users = [...rooms.get(room)].map(c => c.username).filter(Boolean);
  broadcastToRoom(room, { type: 'presence', room, users });
};

// ===== Room Management =====

// Mock Google Apps Script call
const fetchRoomAdmins = async (room) => {
  // Replace this with actual Apps Script Web App URL
  const URL = `https://script.google.com/macros/s/YOUR_DEPLOYED_SCRIPT/exec?action=getAdmins&room=${room}`;
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error('Apps Script error');
    const data = await res.json();
    return data.admins || [];
  } catch {
    return []; // fallback: no admins
  }
};

const createRoom = async (ws, room) => {
  if (rooms.has(room)) {
    return send(ws, { type: 'error', message: 'Room already exists' });
  }

  rooms.set(room, new Set());
  roomPermissions.set(room, {
    admins: new Set([ws.username]), // Creator becomes admin
    muted: new Set()
  });

  send(ws, { type: 'system', content: `Room "${room}" created` });
};

const joinRoom = (ws, room) => {
  if (!rooms.has(room)) {
    return send(ws, { type: 'error', message: `Room "${room}" does not exist` });
  }

  rooms.get(room).add(ws);
  ws.rooms.add(room);

  broadcastToRoom(room, { type: 'user_joined', room, sender: ws.username }, ws);
  send(ws, { type: 'system', content: `Joined room: ${room}` });
  broadcastPresence(room);
};

const leaveRoom = (ws, room) => {
  if (rooms.has(room)) {
    rooms.get(room).delete(ws);
    if (rooms.get(room).size === 0) {
      rooms.delete(room);
      roomPermissions.delete(room);
    }
  }
  ws.rooms.delete(room);

  if (typingUsers[room]) {
    typingUsers[room].delete(ws.username);
    if (typingUsers[room].size === 0) {
      delete typingUsers[room];
    } else {
      broadcastToRoom(room, {
        type: 'typing',
        room,
        typingUsers: Array.from(typingUsers[room])
      });
    }
  }

  broadcastToRoom(room, { type: 'user_left', room, sender: ws.username }, ws);
  send(ws, { type: 'system', content: `Left room: ${room}` });
  broadcastPresence(room);
};

// ===== Message Handlers =====

const messageHandlers = {
  create: async (ws, data) => {
    if (requireFields(ws, data, 'room', 'sender')) {
      ws.username = data.sender;
      await createRoom(ws, data.room);
    }
  },

  join: (ws, data) => {
    if (requireFields(ws, data, 'room', 'sender')) {
      ws.username = data.sender;
      joinRoom(ws, data.room);
    }
  },

  leave: (ws, data) => {
    if (requireFields(ws, data, 'room')) {
      leaveRoom(ws, data.room);
    }
  },

  message: (ws, data) => {
    if (requireFields(ws, data, 'room', 'content') && ws.rooms.has(data.room)) {
      const perms = roomPermissions.get(data.room);
      if (perms?.muted.has(ws.username)) {
        return send(ws, { type: 'error', message: 'You are muted in this room' });
      }

      broadcastToRoom(data.room, {
        type: 'message',
        room: data.room,
        sender: ws.username,
        content: data.content,
        timestamp: data.timestamp || Date.now(),
        reply: data.reply || null
      });
    }
  },

  reaction: (ws, data) => {
    if (requireFields(ws, data, 'room', 'target', 'emoji') && ws.rooms.has(data.room)) {
      broadcastToRoom(data.room, {
        type: 'reaction',
        room: data.room,
        sender: ws.username,
        target: data.target,
        emoji: data.emoji,
        timestamp: data.timestamp || Date.now()
      });
    }
  },

  presence_request: (ws, data) => {
    if (requireFields(ws, data, 'room') && ws.rooms.has(data.room)) {
      broadcastPresence(data.room);
    }
  },

  typing: (ws, data) => {
    if (!requireFields(ws, data, 'room')) return;
    const room = data.room;
    const user = ws.username;
    if (!user || !ws.rooms.has(room)) return;

    const key = `${user}_${room}`;
    const now = Date.now();
    const last = typingTimestamps.get(key) || 0;

    if (now - last < 2000) return;
    typingTimestamps.set(key, now);

    if (!typingUsers[room]) typingUsers[room] = new Set();
    data.typing ? typingUsers[room].add(user) : typingUsers[room].delete(user);

    broadcastToRoom(room, {
      type: 'typing',
      room,
      typingUsers: Array.from(typingUsers[room])
    });
  },

  moderate: (ws, data) => {
    if (requireFields(ws, data, 'room', 'action', 'target') && ws.rooms.has(data.room)) {
      const perms = roomPermissions.get(data.room);
      if (!perms?.admins.has(ws.username)) {
        return send(ws, { type: 'error', message: 'You are not an admin in this room' });
      }

      const { action, target } = data;

      switch (action) {
        case 'mute':
          perms.muted.add(target);
          broadcastToRoom(data.room, {
            type: 'system',
            content: `${target} was muted by ${ws.username}`,
            room: data.room
          });
          break;

        case 'unmute':
          perms.muted.delete(target);
          break;

        case 'kick':
          for (const client of rooms.get(data.room)) {
            if (client.username === target) {
              leaveRoom(client, data.room);
              break;
            }
          }
          break;

        case 'promote':
          perms.admins.add(target);
          break;

        case 'demote':
          perms.admins.delete(target);
          break;

        default:
          send(ws, { type: 'error', message: 'Unknown moderation action' });
      }
    }
  }
};

// ===== Connection =====

wss.on('connection', (ws) => {
  ws.rooms = new Set();
  ws.username = null;

  ws.on('message', async (msg) => {
    const data = parseJSON(msg);
    if (!data) return send(ws, { type: 'error', message: 'Invalid JSON' });

    const handler = messageHandlers[data.type];
    if (handler) {
      await handler(ws, data);
    } else {
      send(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
    }
  });

  ws.on('close', () => {
    for (const room of ws.rooms) {
      leaveRoom(ws, room);
    }
  });
});

// ===== Start =====

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
