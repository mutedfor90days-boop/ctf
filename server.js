const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

app.get("/health", (req, res) => res.status(200).send("OK"));

// ── Constants ──────────────────────────────────────────────────────────────────
const TILE         = 20;
const COLS         = 80;
const ROWS         = 50;
const W            = COLS * TILE;
const H            = ROWS * TILE;
const SPEED        = 2.8;
const PLAYER_SIZE  = 18;
const TAG_RANGE    = 40;
const TAG_COOLDOWN = 70;
const FLAG_RETURN  = 250;
const FPS          = 50;
const MAX_SCORE    = 5;
const TEAM_SIZE    = 5;
const QUEUE_WAIT   = 20; // seconds to wait after 2 players join before forcing start

// ── Spawn / wall helpers (unchanged) ──────────────────────────────────────────
function blueSpawns() {
  const bx = TILE * 3 + PLAYER_SIZE / 2;
  return [0.2, 0.35, 0.5, 0.65, 0.8].map(t => ({ x: bx, y: Math.round(H * t) }));
}
function redSpawns() {
  const rx = W - TILE * 3 - PLAYER_SIZE / 2;
  return [0.2, 0.35, 0.5, 0.65, 0.8].map(t => ({ x: rx, y: Math.round(H * t) }));
}

function makeWalls() {
  const C = COLS, R = ROWS;
  return [
    { x:6,  y:10, w:3, h:8 }, { x:6,  y:32, w:3, h:8 },
    { x:C-9,y:10, w:3, h:8 }, { x:C-9,y:32, w:3, h:8 },
    { x:18, y:8,  w:6, h:3 }, { x:18, y:39, w:6, h:3 },
    { x:C-24,y:8, w:6, h:3 }, { x:C-24,y:39,w:6, h:3 },
    { x:C/2-2, y:5,    w:4, h:5  },
    { x:C/2-2, y:R-10, w:4, h:5  },
    { x:C/2-2, y:R/2-2,w:4, h:4  },
    { x:Math.round(C*0.28), y:Math.round(R*0.22), w:5, h:3 },
    { x:Math.round(C*0.28), y:Math.round(R*0.65), w:5, h:3 },
    { x:Math.round(C*0.67), y:Math.round(R*0.22), w:5, h:3 },
    { x:Math.round(C*0.67), y:Math.round(R*0.65), w:5, h:3 },
    { x:Math.round(C*0.40), y:Math.round(R*0.15), w:3, h:6 },
    { x:Math.round(C*0.57), y:Math.round(R*0.15), w:3, h:6 },
    { x:Math.round(C*0.40), y:Math.round(R*0.70), w:3, h:6 },
    { x:Math.round(C*0.57), y:Math.round(R*0.70), w:3, h:6 },
    { x:Math.round(C*0.35), y:Math.round(R*0.40), w:4, h:3 },
    { x:Math.round(C*0.61), y:Math.round(R*0.40), w:4, h:3 },
  ];
}
function wallsToRects(walls) {
  return walls.map(w => ({ x: w.x*TILE, y: w.y*TILE, w: w.w*TILE, h: w.h*TILE }));
}
function collidesWall(px, py, rects) {
  const h = PLAYER_SIZE / 2;
  const l=px-h, r=px+h, t=py-h, b=py+h;
  return rects.some(w => l < w.x+w.w && r > w.x && t < w.y+w.h && b > w.y);
}
function dist2(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2); }

const WALLS = makeWalls();
const RECTS = wallsToRects(WALLS);
const BLUE_SPAWNS = blueSpawns();
const RED_SPAWNS  = redSpawns();
const BLUE_BASE   = { x: TILE*2, y: H/2 };
const RED_BASE    = { x: W - TILE*2, y: H/2 };

// ── Multi-queue state ──────────────────────────────────────────────────────────
// Each room: { id, game, gameLoop, clients: Map<ws, {playerId,team,slotIndex}>, nextId, startTimer, startCountdown }
const rooms = new Map(); // roomId -> room
let nextRoomId = 1;
let nextPlayerId = 1;

function makeRoom(id) {
  return {
    id,
    game: null,
    gameLoop: null,
    clients: new Map(),
    startTimer: null,      // the setTimeout handle for 20s wait
    startCountdown: null,  // the setInterval handle ticking the countdown
    waitSecondsLeft: 0,
  };
}

function makeGame() {
  return {
    phase: 'waiting',
    players: {},
    blueFlag: { x: BLUE_BASE.x, y: BLUE_BASE.y, carriedBy: null, home: true, returnTimer: 0, homeX: BLUE_BASE.x, homeY: BLUE_BASE.y },
    redFlag:  { x: RED_BASE.x,  y: RED_BASE.y,  carriedBy: null, home: true, returnTimer: 0, homeX: RED_BASE.x,  homeY: RED_BASE.y  },
    scoreBlue: 0, scoreRed: 0,
    timeLeft: 300,
    tick: 0,
    flash: null, flashTimer: 0,
    tagEffects: [],
  };
}

function makePlayer(team, slotIndex, room) {
  const spawns = team === 'blue' ? BLUE_SPAWNS : RED_SPAWNS;
  const sp = spawns[slotIndex] || spawns[0];
  return {
    id: nextPlayerId++,
    team, slotIndex,
    x: sp.x, y: sp.y,
    spawnX: sp.x, spawnY: sp.y,
    hasFlag: false,
    tagCooldown: 0,
    tagPressed: false,
    keys: { up:false, down:false, left:false, right:false },
    alive: true,
  };
}

function resetRoom(room) {
  if (room.gameLoop)       clearInterval(room.gameLoop);
  if (room.startTimer)     clearTimeout(room.startTimer);
  if (room.startCountdown) clearInterval(room.startCountdown);
  room.gameLoop = null;
  room.startTimer = null;
  room.startCountdown = null;
  room.waitSecondsLeft = 0;
  room.game = makeGame();
  for (const [ws, info] of room.clients) {
    const p = makePlayer(info.team, info.slotIndex, room);
    info.playerId = p.id;
    room.game.players[p.id] = p;
  }
}

function countTeam(room, team) {
  return [...room.clients.values()].filter(c => c.team === team).length;
}

function totalPlayers(room) {
  return [...room.clients.values()].filter(c => c.team !== 'spectator').length;
}

function canStart(room) {
  return countTeam(room, 'blue') >= 1 && countTeam(room, 'red') >= 1;
}

function broadcastRoom(room, msg) {
  const str = JSON.stringify(msg);
  for (const [ws] of room.clients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastLobby(room) {
  broadcastRoom(room, {
    type: 'lobby',
    blue: countTeam(room, 'blue'),
    red: countTeam(room, 'red'),
    need: TEAM_SIZE,
    roomId: room.id,
  });
}

// ── Start flow: 20s countdown after 2+ players, then start ────────────────────
function scheduleStart(room) {
  if (room.game.phase !== 'waiting') return;
  // Already scheduled
  if (room.startTimer !== null) return;

  room.waitSecondsLeft = QUEUE_WAIT;
  broadcastRoom(room, { type: 'waitStart', seconds: QUEUE_WAIT });

  // Tick the countdown every second
  room.startCountdown = setInterval(() => {
    room.waitSecondsLeft--;
    broadcastRoom(room, { type: 'waitTick', seconds: room.waitSecondsLeft });
    if (room.waitSecondsLeft <= 0) {
      clearInterval(room.startCountdown);
      room.startCountdown = null;
    }
  }, 1000);

  // After 20s, start playing
  room.startTimer = setTimeout(() => {
    room.startTimer = null;
    startPlaying(room);
  }, QUEUE_WAIT * 1000);
}

function cancelStart(room) {
  if (room.startTimer)     { clearTimeout(room.startTimer);   room.startTimer = null; }
  if (room.startCountdown) { clearInterval(room.startCountdown); room.startCountdown = null; }
  room.waitSecondsLeft = 0;
  if (room.game.phase === 'waiting') {
    broadcastRoom(room, { type: 'waitCancelled' });
  }
}

function startPlaying(room) {
  if (room.game.phase !== 'waiting') return;
  if (!canStart(room)) return; // safety check
  room.game.phase = 'playing';
  if (room.gameLoop) clearInterval(room.gameLoop);
  room.gameLoop = setInterval(() => tick(room), 1000 / FPS);
  broadcastRoom(room, { type: 'phase', phase: 'playing' });
}

// ── Tick ───────────────────────────────────────────────────────────────────────
function tick(room) {
  const game = room.game;
  if (!game || game.phase !== 'playing') return;
  game.tick++;

  if (game.tick % FPS === 0) {
    game.timeLeft--;
    if (game.timeLeft <= 0) {
      endGame(room, game.scoreBlue > game.scoreRed ? 'blue' :
                    game.scoreRed > game.scoreBlue ? 'red' : 'draw');
      return;
    }
  }

  const players = Object.values(game.players);
  const rf = game.redFlag;
  const bf = game.blueFlag;

  for (const p of players) movePlayer(p);

  for (const p of players) {
    if (p.tagPressed) { p.tagPressed = false; doTag(room, p); }
    if (p.tagCooldown > 0) p.tagCooldown--;
  }

  for (const p of players) {
    if (p.team === 'blue' && !p.hasFlag && rf.carriedBy === null && dist2(p, rf) < PLAYER_SIZE + 10) {
      p.hasFlag = true; rf.carriedBy = p.id; rf.home = false; rf.returnTimer = 0;
      setFlash(game, '🔵 ' + teamLabel('blue', p) + ' grabbed the RED flag!');
    }
    if (p.team === 'red' && !p.hasFlag && bf.carriedBy === null && dist2(p, bf) < PLAYER_SIZE + 10) {
      p.hasFlag = true; bf.carriedBy = p.id; bf.home = false; bf.returnTimer = 0;
      setFlash(game, '🔴 ' + teamLabel('red', p) + ' grabbed the BLUE flag!');
    }
  }

  for (const p of players) {
    if (rf.carriedBy === p.id) { rf.x = p.x; rf.y = p.y; }
    if (bf.carriedBy === p.id) { bf.x = p.x; bf.y = p.y; }
  }

  if (rf.carriedBy === null && !rf.home && rf.returnTimer > 0) {
    rf.returnTimer--;
    if (rf.returnTimer <= 0) { rf.x=rf.homeX; rf.y=rf.homeY; rf.home=true; setFlash(game, '🔴 Red flag returned!'); }
  }
  if (bf.carriedBy === null && !bf.home && bf.returnTimer > 0) {
    bf.returnTimer--;
    if (bf.returnTimer <= 0) { bf.x=bf.homeX; bf.y=bf.homeY; bf.home=true; setFlash(game, '🔵 Blue flag returned!'); }
  }

  for (const p of players) {
    if (p.team === 'blue' && p.hasFlag && dist2(p, BLUE_BASE) < PLAYER_SIZE + 14) {
      p.hasFlag = false;
      rf.carriedBy = null; rf.home = true; rf.x = rf.homeX; rf.y = rf.homeY; rf.returnTimer = 0;
      game.scoreBlue++;
      setFlash(game, '⭐ BLUE CAPTURES! (' + game.scoreBlue + '/' + MAX_SCORE + ')');
      if (game.scoreBlue >= MAX_SCORE) { endGame(room, 'blue'); return; }
    }
    if (p.team === 'red' && p.hasFlag && dist2(p, RED_BASE) < PLAYER_SIZE + 14) {
      p.hasFlag = false;
      bf.carriedBy = null; bf.home = true; bf.x = bf.homeX; bf.y = bf.homeY; bf.returnTimer = 0;
      game.scoreRed++;
      setFlash(game, '⭐ RED CAPTURES! (' + game.scoreRed + '/' + MAX_SCORE + ')');
      if (game.scoreRed >= MAX_SCORE) { endGame(room, 'red'); return; }
    }
  }

  if (game.flashTimer > 0) game.flashTimer--;
  for (let i = game.tagEffects.length - 1; i >= 0; i--) {
    game.tagEffects[i].r += 2; game.tagEffects[i].life--;
    if (game.tagEffects[i].life <= 0) game.tagEffects.splice(i, 1);
  }

  broadcastRoom(room, {
    type: 'state',
    players: players.map(p => ({ id:p.id, team:p.team, x:p.x, y:p.y, hasFlag:p.hasFlag, tagCooldown:p.tagCooldown })),
    blueFlag: { x:bf.x, y:bf.y, carriedBy:bf.carriedBy, home:bf.home, returnTimer:bf.returnTimer },
    redFlag:  { x:rf.x, y:rf.y, carriedBy:rf.carriedBy, home:rf.home, returnTimer:rf.returnTimer },
    scoreBlue: game.scoreBlue, scoreRed: game.scoreRed,
    timeLeft: game.timeLeft,
    flash: game.flashTimer > 0 ? game.flash : null,
    flashTimer: game.flashTimer,
    tagEffects: game.tagEffects.slice(),
  });
}

function movePlayer(p) {
  const k = p.keys;
  let dx=0, dy=0;
  if (k.up)    dy -= SPEED;
  if (k.down)  dy += SPEED;
  if (k.left)  dx -= SPEED;
  if (k.right) dx += SPEED;
  if (dx && dy) { dx *= 0.707; dy *= 0.707; }
  const half = PLAYER_SIZE / 2;
  const nx = Math.max(half, Math.min(W - half, p.x + dx));
  const ny = Math.max(half, Math.min(H - half, p.y + dy));
  if (!collidesWall(nx, p.y, RECTS)) p.x = nx;
  if (!collidesWall(p.x, ny, RECTS)) p.y = ny;
}

function doTag(room, attacker) {
  const game = room.game;
  if (attacker.tagCooldown > 0) return;
  attacker.tagCooldown = TAG_COOLDOWN;
  game.tagEffects.push({ x:attacker.x, y:attacker.y, r:8, life:30, color: attacker.team==='blue'?'#00cfff':'#ff2244' });
  const enemies = Object.values(game.players).filter(p => p.team !== attacker.team);
  let closest = null, closestDist = TAG_RANGE;
  for (const e of enemies) {
    const d = dist2(attacker, e);
    if (d < closestDist) { closestDist = d; closest = e; }
  }
  if (!closest) return;
  if (closest.hasFlag) {
    closest.hasFlag = false;
    const flagKey = closest.team === 'blue' ? 'redFlag' : 'blueFlag';
    const flag = game[flagKey];
    flag.carriedBy = null; flag.x = closest.x; flag.y = closest.y;
    flag.home = false; flag.returnTimer = FLAG_RETURN;
  }
  game.tagEffects.push({ x:closest.x, y:closest.y, r:24, life:40, color: closest.team==='blue'?'#00cfff':'#ff2244' });
  closest.x = closest.spawnX; closest.y = closest.spawnY;
  setFlash(game, '💥 ' + teamLabel(closest.team, closest) + ' sent back to spawn!');
}

function teamLabel(team, p) { return team.toUpperCase() + ' P' + (p.slotIndex + 1); }
function setFlash(game, msg) { game.flash = msg; game.flashTimer = 100; }

function endGame(room, winner) {
  room.game.phase = 'over';
  if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
  broadcastRoom(room, { type: 'gameover', winner, scoreBlue: room.game.scoreBlue, scoreRed: room.game.scoreRed });
}

// ── Room assignment ────────────────────────────────────────────────────────────
// Find a waiting room that has space, or create a new one
function findOrCreateRoom() {
  for (const [id, room] of rooms) {
    if (room.game.phase === 'waiting' &&
        countTeam(room, 'blue') < TEAM_SIZE &&
        countTeam(room, 'red') < TEAM_SIZE) {
      return room;
    }
  }
  // Create new room
  const id = nextRoomId++;
  const room = makeRoom(id);
  room.game = makeGame();
  rooms.set(id, room);
  console.log(`Created room ${id}`);
  return room;
}

function cleanupRoom(room) {
  // If a room is empty and not playing, remove it
  if (room.clients.size === 0 && room.game.phase !== 'playing') {
    if (room.gameLoop)       clearInterval(room.gameLoop);
    if (room.startTimer)     clearTimeout(room.startTimer);
    if (room.startCountdown) clearInterval(room.startCountdown);
    rooms.delete(room.id);
    console.log(`Removed empty room ${room.id}`);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const room = findOrCreateRoom();
  const game = room.game;

  const bc = countTeam(room, 'blue'), rc = countTeam(room, 'red');
  let team, slotIndex;

  if (bc <= rc && bc < TEAM_SIZE) {
    team = 'blue'; slotIndex = bc;
  } else if (rc < TEAM_SIZE) {
    team = 'red'; slotIndex = rc;
  } else {
    sendTo(ws, { type: 'spectator', msg: 'Game is full (5v5). You are spectating.' });
    room.clients.set(ws, { team: 'spectator', slotIndex: 0, playerId: null });
    ws.on('close', () => { room.clients.delete(ws); cleanupRoom(room); });
    return;
  }

  const p = makePlayer(team, slotIndex, room);
  game.players[p.id] = p;
  room.clients.set(ws, { team, slotIndex, playerId: p.id });

  const total = totalPlayers(room);
  console.log(`Room ${room.id}: Player ${p.id} joined as ${team} slot ${slotIndex}. Blue:${countTeam(room,'blue')} Red:${countTeam(room,'red')}`);

  sendTo(ws, {
    type: 'init',
    playerId: p.id, team, slotIndex,
    W, H, COLS, ROWS,
    walls: WALLS,
    blueBase: BLUE_BASE, redBase: RED_BASE,
    blueSpawns: BLUE_SPAWNS, redSpawns: RED_SPAWNS,
    phase: game.phase,
    scoreBlue: game.scoreBlue, scoreRed: game.scoreRed,
    timeLeft: game.timeLeft,
    maxScore: MAX_SCORE,
    roomId: room.id,
  });

  broadcastLobby(room);

  // Start the 20s wait when the SECOND player joins (1 per team minimum)
  if (game.phase === 'waiting' && canStart(room) && room.startTimer === null) {
    scheduleStart(room);
  }

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const info = room.clients.get(ws);
    if (!info || info.team === 'spectator') return;
    const player = game.players[info.playerId];
    if (!player) return;

    if (msg.type === 'keys') {
      player.keys.up    = !!msg.up;
      player.keys.down  = !!msg.down;
      player.keys.left  = !!msg.left;
      player.keys.right = !!msg.right;
    }
    if (msg.type === 'tag') player.tagPressed = true;
    if (msg.type === 'restart' && game.phase === 'over') {
      resetRoom(room);
      broadcastLobby(room);
      if (canStart(room)) scheduleStart(room);
    }
  });

  ws.on('close', () => {
    const info = room.clients.get(ws);
    if (info && info.playerId) delete game.players[info.playerId];
    room.clients.delete(ws);
    console.log(`Room ${room.id}: Player left. Blue:${countTeam(room,'blue')} Red:${countTeam(room,'red')}`);

    broadcastLobby(room);

    if (game.phase === 'waiting') {
      if (!canStart(room)) {
        // No longer have players on both teams — cancel the scheduled start
        cancelStart(room);
      }
    } else if (game.phase === 'playing' && !canStart(room)) {
      game.phase = 'waiting';
      if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
      broadcastRoom(room, { type: 'playerdisconnected' });
    }

    cleanupRoom(room);
  });
});

// ── Broadcast server-wide room list (for lobby screen) ────────────────────────
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const [id, room] of rooms) {
    list.push({
      id,
      phase: room.game.phase,
      blue: countTeam(room, 'blue'),
      red: countTeam(room, 'red'),
      waitSecondsLeft: room.waitSecondsLeft,
    });
  }
  res.json(list);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`CTF 5v5 multi-room server on port ${PORT}`));
