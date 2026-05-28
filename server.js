const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Game Constants ──────────────────────────────────────────────
const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1800;
const PLAYER_RADIUS = 18;
const BASE_SPEED = 220;          // px/sec
const MARKED_SPEED_MULT = 1.22;  // marked player is 22% faster
const TICK_RATE = 60;            // server ticks per second
const MARK_POINTS_PER_SEC = 8;   // pts/sec while marked
const KILL_BONUS = 150;          // pts for stealing the mark
const MARK_KILL_COOLDOWN = 800;  // ms before newly marked can be killed again

// Obstacles (rect: x, y, w, h)
const OBSTACLES = [
  { x: 200,  y: 200,  w: 180, h: 40  },
  { x: 600,  y: 100,  w: 40,  h: 220 },
  { x: 900,  y: 300,  w: 200, h: 40  },
  { x: 300,  y: 500,  w: 40,  h: 200 },
  { x: 700,  y: 600,  w: 250, h: 40  },
  { x: 1100, y: 200,  w: 40,  h: 300 },
  { x: 1400, y: 400,  w: 200, h: 40  },
  { x: 1700, y: 150,  w: 40,  h: 260 },
  { x: 1900, y: 500,  w: 300, h: 40  },
  { x: 400,  y: 900,  w: 40,  h: 220 },
  { x: 800,  y: 1000, w: 300, h: 40  },
  { x: 1200, y: 800,  w: 40,  h: 200 },
  { x: 1500, y: 1100, w: 200, h: 40  },
  { x: 2000, y: 900,  w: 40,  h: 250 },
  { x: 600,  y: 1400, w: 300, h: 40  },
  { x: 1100, y: 1300, w: 40,  h: 200 },
  { x: 1800, y: 1300, w: 200, h: 40  },
  { x: 2200, y: 300,  w: 40,  h: 300 },
  { x: 2000, y: 1600, w: 300, h: 40  },
  { x: 100,  y: 1200, w: 200, h: 40  },
];

// ── State ────────────────────────────────────────────────────────
let players = {};        // socketId → player obj
let markedId = null;     // who is currently marked
let markCooldownUntil = 0; // timestamp when kill is allowed again

function randomSpawn() {
  return {
    x: PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - PLAYER_RADIUS * 2),
    y: PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - PLAYER_RADIUS * 2),
  };
}

function randomColor() {
  const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7',
                  '#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function pickFirstMark() {
  const ids = Object.keys(players);
  if (ids.length > 0) {
    markedId = ids[Math.floor(Math.random() * ids.length)];
    markCooldownUntil = Date.now() + MARK_KILL_COOLDOWN;
  }
}

// AABB collision with obstacles
function collidesWithObstacle(x, y, r) {
  for (const o of OBSTACLES) {
    const nearX = Math.max(o.x, Math.min(x, o.x + o.w));
    const nearY = Math.max(o.y, Math.min(y, o.y + o.h));
    const dx = x - nearX, dy = y - nearY;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

// ── Game Loop ────────────────────────────────────────────────────
let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  const playerList = Object.values(players);
  if (playerList.length === 0) return;

  // Award points to marked player
  if (markedId && players[markedId]) {
    players[markedId].score += MARK_POINTS_PER_SEC * dt;
  }

  // Move players
  for (const p of playerList) {
    if (!p.input) continue;
    const { up, down, left, right } = p.input;
    let dx = 0, dy = 0;
    if (up)    dy -= 1;
    if (down)  dy += 1;
    if (left)  dx -= 1;
    if (right) dx += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len; dy /= len;

      const speed = p.id === markedId
        ? BASE_SPEED * MARKED_SPEED_MULT
        : BASE_SPEED;

      const nx = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH  - PLAYER_RADIUS, p.x + dx * speed * dt));
      const ny = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y + dy * speed * dt));

      // Slide along obstacles
      const blockX = collidesWithObstacle(nx, p.y, PLAYER_RADIUS);
      const blockY = collidesWithObstacle(p.x, ny, PLAYER_RADIUS);

      if (!blockX) p.x = nx;
      if (!blockY) p.y = ny;
    }

    // Check kill: non-marked touching marked
    if (p.id !== markedId && markedId && players[markedId]) {
      if (now > markCooldownUntil) {
        const m = players[markedId];
        const ddx = p.x - m.x, ddy = p.y - m.y;
        if (ddx * ddx + ddy * ddy < (PLAYER_RADIUS * 2) ** 2) {
          // Steal the mark!
          p.score += KILL_BONUS;
          const prevMarked = markedId;
          markedId = p.id;
          markCooldownUntil = now + MARK_KILL_COOLDOWN;
          io.emit('markStolen', { by: p.id, from: prevMarked, byName: p.name });
        }
      }
    }
  }

  // Build state snapshot
  const state = {
    players: playerList.map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      color: p.color,
      score: Math.floor(p.score),
      isMarked: p.id === markedId,
    })),
    markedId,
    ts: now,
  };

  io.emit('state', state);
}, 1000 / TICK_RATE);

// ── Socket Handlers ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('join', ({ name }) => {
    const spawn = randomSpawn();
    players[socket.id] = {
      id: socket.id,
      name: name ? name.slice(0, 16) : 'Player',
      x: spawn.x,
      y: spawn.y,
      color: randomColor(),
      score: 0,
      input: { up: false, down: false, left: false, right: false },
    };

    if (!markedId || !players[markedId]) {
      pickFirstMark();
    }

    socket.emit('init', {
      id: socket.id,
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
      obstacles: OBSTACLES,
      playerRadius: PLAYER_RADIUS,
    });
  });

  socket.on('input', (input) => {
    if (players[socket.id]) {
      players[socket.id].input = input;
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    if (markedId === socket.id) {
      markedId = null;
      pickFirstMark();
      if (markedId) io.emit('newMark', { id: markedId });
    }
    console.log('Player disconnected:', socket.id);
  });
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chase server running on port ${PORT}`);
});
