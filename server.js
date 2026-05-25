const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

// Health check for Replit Autoscale
app.get("/health", (req, res) => res.status(200).send("OK"));

// ── Constants ──────────────────────────────────────────────────────────────────
const TILE         = 20;
const COLS         = 80;
const ROWS         = 50;
const W            = COLS * TILE;   // 1600px
const H            = ROWS * TILE;   // 1000px
const SPEED        = 2.8;
const PLAYER_SIZE  = 18;
const TAG_RANGE    = 40;
const TAG_COOLDOWN = 70;
const FLAG_RETURN  = 250;           // ~5s at 50fps
const FPS          = 50;
const MAX_SCORE    = 5;
const TEAM_SIZE    = 5;

// ── Spawn points (5 per team, spread vertically) ───────────────────────────────
function blueSpawns() {
  const bx = TILE * 3 + PLAYER_SIZE / 2;
  return [0.2, 0.35, 0.5, 0.65, 0.8].map(t => ({ x: bx, y: Math.round(H * t) }));
}
function redSpawns() {
  const rx = W - TILE * 3 - PLAYER_SIZE / 2;
  return [0.2, 0.35, 0.5, 0.65, 0.8].map(t => ({ x: rx, y: Math.round(H * t) }));
}

// ── Walls ──────────────────────────────────────────────────────────────────────
function makeWalls() {
  const C = COLS, R = ROWS;
  return [
    // Outer boundary pillars / barriers near bases
    { x:6,  y:10, w:3, h:8 }, { x:6,  y:32, w:3, h:8 },
    { x:C-9,y:10, w:3, h:8 }, { x:C-9,y:32, w:3, h:8 },
    // Mid-field horizontal walls
    { x:18, y:8,  w:6, h:3 }, { x:18, y:39, w:6, h:3 },
    { x:C-24,y:8, w:6, h:3 }, { x:C-24,y:39,w:6, h:3 },
    // Centre cross
    { x:C/2-2, y:5,    w:4, h:5  },
    { x:C/2-2, y:R-10, w:4, h:5  },
    { x:C/2-2, y:R/2-2,w:4, h:4  },
    // Quarter barriers
    { x:Math.round(C*0.28), y:Math.round(R*0.22), w:5, h:3 },
    { x:Math.round(C*0.28), y:Math.round(R*0.65), w:5, h:3 },
    { x:Math.round(C*0.67), y:Math.round(R*0.22), w:5, h:3 },
    { x:Math.round(C*0.67), y:Math.round(R*0.65), w:5, h:3 },
    // Diagonal-ish mid barriers
    { x:Math.round(C*0.40), y:Math.round(R*0.15), w:3, h:6 },
    { x:Math.round(C*0.57), y:Math.round(R*0.15), w:3, h:6 },
    { x:Math.round(C*0.40), y:Math.round(R*0.70), w:3, h:6 },
    { x:Math.round(C*0.57), y:Math.round(R*0.70), w:3, h:6 },
    // Centre lane blockers
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

// ── Game state ─────────────────────────────────────────────────────────────────
let game = null;
let gameLoop = null;
const clients = new Map(); // ws → { playerId, team, slotIndex }
let nextId = 1;

function makePlayer(team, slotIndex) {
  const spawns = team === 'blue' ? BLUE_SPAWNS : RED_SPAWNS;
  const sp = spawns[slotIndex] || spawns[0];
  return {
    id: nextId++,
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

function makeGame() {
  return {
    phase: 'waiting',
    players: {},    // id → player object
    blueFlag: { x: BLUE_BASE.x, y: BLUE_BASE.y, carriedBy: null, home: true, returnTimer: 0, homeX: BLUE_BASE.x, homeY: BLUE_BASE.y },
    redFlag:  { x: RED_BASE.x,  y: RED_BASE.y,  carriedBy: null, home: true, returnTimer: 0, homeX: RED_BASE.x,  homeY: RED_BASE.y  },
    scoreBlue: 0, scoreRed: 0,
    timeLeft: 300,  // 5 minutes
    tick: 0,
    flash: null, flashTimer: 0,
    tagEffects: [],
  };
}

function resetGame() {
  if (gameLoop) clearInterval(gameLoop);
  game = makeGame();
  // Re-register any already-connected players
  for (const [ws, info] of clients) {
    const p = makePlayer(info.team, info.slotIndex);
    info.playerId = p.id;
    game.players[p.id] = p;
  }
}

function countTeam(team) {
  return [...clients.values()].filter(c => c.team === team).length;
}

function canStart() {
  return countTeam('blue') >= 1 && countTeam('red') >= 1;
}

function startPlaying() {
  if (game.phase !== 'waiting') return;
  game.phase = 'playing';
  if (gameLoop) clearInterval(gameLoop);
  gameLoop = setInterval(tick, 1000 / FPS);
  broadcast({ type: 'phase', phase: 'playing' });
}

// ── Server tick ────────────────────────────────────────────────────────────────
function tick() {
  if (!game || game.phase !== 'playing') return;
  game.tick++;

  if (game.tick % FPS === 0) {
    game.timeLeft--;
    if (game.timeLeft <= 0) {
      endGame(game.scoreBlue > game.scoreRed ? 'blue' :
              game.scoreRed > game.scoreBlue ? 'red' : 'draw');
      return;
    }
  }

  const players = Object.values(game.players);
  const rf = game.redFlag;
  const bf = game.blueFlag;

  // Move all players
  for (const p of players) movePlayer(p);

  // Tag actions
  for (const p of players) {
    if (p.tagPressed) { p.tagPressed = false; doTag(p); }
    if (p.tagCooldown > 0) p.tagCooldown--;
  }

  // Flag pickups — only opposite team
  for (const p of players) {
    if (p.team === 'blue' && !p.hasFlag && rf.carriedBy === null && dist2(p, rf) < PLAYER_SIZE + 10) {
      p.hasFlag = true;
      rf.carriedBy = p.id; rf.home = false; rf.returnTimer = 0;
      setFlash('🔵 ' + teamLabel('blue', p) + ' grabbed the RED flag!');
    }
    if (p.team === 'red' && !p.hasFlag && bf.carriedBy === null && dist2(p, bf) < PLAYER_SIZE + 10) {
      p.hasFlag = true;
      bf.carriedBy = p.id; bf.home = false; bf.returnTimer = 0;
      setFlash('🔴 ' + teamLabel('red', p) + ' grabbed the BLUE flag!');
    }
  }

  // Move flags with carriers
  for (const p of players) {
    if (rf.carriedBy === p.id) { rf.x = p.x; rf.y = p.y; }
    if (bf.carriedBy === p.id) { bf.x = p.x; bf.y = p.y; }
  }

  // Return timers
  if (rf.carriedBy === null && !rf.home && rf.returnTimer > 0) {
    rf.returnTimer--;
    if (rf.returnTimer <= 0) { rf.x=rf.homeX; rf.y=rf.homeY; rf.home=true; setFlash('🔴 Red flag returned!'); }
  }
  if (bf.carriedBy === null && !bf.home && bf.returnTimer > 0) {
    bf.returnTimer--;
    if (bf.returnTimer <= 0) { bf.x=bf.homeX; bf.y=bf.homeY; bf.home=true; setFlash('🔵 Blue flag returned!'); }
  }

  // Captures
  for (const p of players) {
    if (p.team === 'blue' && p.hasFlag && dist2(p, BLUE_BASE) < PLAYER_SIZE + 14) {
      p.hasFlag = false;
      rf.carriedBy = null; rf.home = true; rf.x = rf.homeX; rf.y = rf.homeY; rf.returnTimer = 0;
      game.scoreBlue++;
      setFlash('⭐ BLUE CAPTURES! (' + game.scoreBlue + '/' + MAX_SCORE + ')');
      if (game.scoreBlue >= MAX_SCORE) { endGame('blue'); return; }
    }
    if (p.team === 'red' && p.hasFlag && dist2(p, RED_BASE) < PLAYER_SIZE + 14) {
      p.hasFlag = false;
      bf.carriedBy = null; bf.home = true; bf.x = bf.homeX; bf.y = bf.homeY; bf.returnTimer = 0;
      game.scoreRed++;
      setFlash('⭐ RED CAPTURES! (' + game.scoreRed + '/' + MAX_SCORE + ')');
      if (game.scoreRed >= MAX_SCORE) { endGame('red'); return; }
    }
  }

  // Flash timer
  if (game.flashTimer > 0) game.flashTimer--;

  // Tag effects
  for (let i = game.tagEffects.length - 1; i >= 0; i--) {
    game.tagEffects[i].r += 2; game.tagEffects[i].life--;
    if (game.tagEffects[i].life <= 0) game.tagEffects.splice(i, 1);
  }

  // Broadcast
  broadcast({
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

function doTag(attacker) {
  if (attacker.tagCooldown > 0) return;
  attacker.tagCooldown = TAG_COOLDOWN;
  game.tagEffects.push({ x:attacker.x, y:attacker.y, r:8, life:30, color: attacker.team==='blue'?'#00cfff':'#ff2244' });

  const enemies = Object.values(game.players).filter(p => p.team !== attacker.team);
  // Find closest enemy in range
  let closest = null, closestDist = TAG_RANGE;
  for (const e of enemies) {
    const d = dist2(attacker, e);
    if (d < closestDist) { closestDist = d; closest = e; }
  }
  if (!closest) return;

  // Drop their flag
  if (closest.hasFlag) {
    closest.hasFlag = false;
    const flagKey = closest.team === 'blue' ? 'redFlag' : 'blueFlag';
    const flag = game[flagKey];
    flag.carriedBy = null; flag.x = closest.x; flag.y = closest.y;
    flag.home = false; flag.returnTimer = FLAG_RETURN;
  }
  game.tagEffects.push({ x:closest.x, y:closest.y, r:24, life:40, color: closest.team==='blue'?'#00cfff':'#ff2244' });
  // Teleport to spawn
  closest.x = closest.spawnX; closest.y = closest.spawnY;
  setFlash('💥 ' + teamLabel(closest.team, closest) + ' sent back to spawn!');
}

function teamLabel(team, p) { return team.toUpperCase() + ' P' + (p.slotIndex + 1); }
function setFlash(msg) { game.flash = msg; game.flashTimer = 100; }

function endGame(winner) {
  game.phase = 'over';
  if (gameLoop) clearInterval(gameLoop);
  broadcast({ type: 'gameover', winner, scoreBlue: game.scoreBlue, scoreRed: game.scoreRed });
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const [ws] of clients) { if (ws.readyState === 1) ws.send(str); }
}
function sendTo(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

resetGame();

wss.on('connection', ws => {
  // Assign team (balance teams)
  const bc = countTeam('blue'), rc = countTeam('red');
  let team, slotIndex;
  if (bc <= rc && bc < TEAM_SIZE) {
    team = 'blue'; slotIndex = bc;
  } else if (rc < TEAM_SIZE) {
    team = 'red'; slotIndex = rc;
  } else {
    // Spectator
    sendTo(ws, { type: 'spectator', msg: 'Game is full (5v5). You are spectating.' });
    clients.set(ws, { team: 'spectator', slotIndex: 0, playerId: null });
    ws.on('close', () => clients.delete(ws));
    return;
  }

  const p = makePlayer(team, slotIndex);
  game.players[p.id] = p;
  clients.set(ws, { team, slotIndex, playerId: p.id });

  console.log(`Player ${p.id} joined as ${team} slot ${slotIndex}. Blue:${countTeam('blue')} Red:${countTeam('red')}`);

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
  });

  broadcast({ type: 'lobby', blue: countTeam('blue'), red: countTeam('red'), need: TEAM_SIZE });

  if (game.phase === 'waiting' && canStart()) {
    broadcast({ type: 'starting', countdown: 3 });
    setTimeout(startPlaying, 3000);
  }

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);
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
      resetGame();
      broadcast({ type: 'lobby', blue: countTeam('blue'), red: countTeam('red'), need: TEAM_SIZE });
      if (canStart()) { broadcast({ type: 'starting', countdown: 3 }); setTimeout(startPlaying, 3000); }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info && info.playerId) delete game.players[info.playerId];
    clients.delete(ws);
    console.log(`Player left. Blue:${countTeam('blue')} Red:${countTeam('red')}`);
    broadcast({ type: 'lobby', blue: countTeam('blue'), red: countTeam('red'), need: TEAM_SIZE });
    if (game.phase === 'playing' && !canStart()) {
      game.phase = 'waiting';
      if (gameLoop) clearInterval(gameLoop);
      broadcast({ type: 'playerdisconnected' });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`CTF 5v5 server on port ${PORT} | Map: ${W}x${H}`));
