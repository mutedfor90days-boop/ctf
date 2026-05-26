const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ── Constants ──────────────────────────────────────────────────────────────────
const TILE         = 20;
const COLS         = 80;
const ROWS         = 50;
const W            = COLS * TILE;
const H            = ROWS * TILE;
const SPEED        = 3.8;
const SPEED_FLAG   = 2.8;
const PLAYER_SIZE  = 18;
const TAG_RANGE    = 40;
const TAG_COOLDOWN = 70;
const FLAG_RETURN  = 250;
const FPS          = 50;
const MAX_SCORE    = 5;
const TEAM_SIZE    = 5;
const QUEUE_WAIT   = 20;

// ── Bot config ─────────────────────────────────────────────────────────────────
// Bots are mid-skill: they react with a delay, make occasional mistakes,
// and don't always take the optimal path.
const BOT_SPEED_MULT    = 0.82;   // slightly slower than max
const BOT_REACT_FRAMES  = 12;     // update decision every ~0.24s
const BOT_TAG_CHANCE    = 0.55;   // probability they actually fire tag when in range
const BOT_MISTAKE_CHANCE= 0.04;   // chance per tick they pick wrong direction
const BOT_NAMES = [
  'Alpha','Bravo','Charlie','Delta','Echo',
  'Foxtrot','Golf','Hotel','India','Juliet',
];

// ── Spawn / wall helpers ───────────────────────────────────────────────────────
function blueSpawns() {
  const bx = TILE * 3 + PLAYER_SIZE / 2;
  return [0.2,0.35,0.5,0.65,0.8].map(t => ({ x:bx, y:Math.round(H*t) }));
}
function redSpawns() {
  const rx = W - TILE*3 - PLAYER_SIZE/2;
  return [0.2,0.35,0.5,0.65,0.8].map(t => ({ x:rx, y:Math.round(H*t) }));
}
function makeWalls() {
  const C=COLS, R=ROWS;
  return [
    {x:6,y:10,w:3,h:8},{x:6,y:32,w:3,h:8},
    {x:C-9,y:10,w:3,h:8},{x:C-9,y:32,w:3,h:8},
    {x:18,y:8,w:6,h:3},{x:18,y:39,w:6,h:3},
    {x:C-24,y:8,w:6,h:3},{x:C-24,y:39,w:6,h:3},
    {x:C/2-2,y:5,w:4,h:5},{x:C/2-2,y:R-10,w:4,h:5},{x:C/2-2,y:R/2-2,w:4,h:4},
    {x:Math.round(C*0.28),y:Math.round(R*0.22),w:5,h:3},
    {x:Math.round(C*0.28),y:Math.round(R*0.65),w:5,h:3},
    {x:Math.round(C*0.67),y:Math.round(R*0.22),w:5,h:3},
    {x:Math.round(C*0.67),y:Math.round(R*0.65),w:5,h:3},
    {x:Math.round(C*0.40),y:Math.round(R*0.15),w:3,h:6},
    {x:Math.round(C*0.57),y:Math.round(R*0.15),w:3,h:6},
    {x:Math.round(C*0.40),y:Math.round(R*0.70),w:3,h:6},
    {x:Math.round(C*0.57),y:Math.round(R*0.70),w:3,h:6},
    {x:Math.round(C*0.35),y:Math.round(R*0.40),w:4,h:3},
    {x:Math.round(C*0.61),y:Math.round(R*0.40),w:4,h:3},
  ];
}
function wallsToRects(walls) {
  return walls.map(w => ({x:w.x*TILE,y:w.y*TILE,w:w.w*TILE,h:w.h*TILE}));
}
function collidesWall(px,py,rects) {
  const h=PLAYER_SIZE/2, l=px-h, r=px+h, t=py-h, b=py+h;
  return rects.some(w => l<w.x+w.w && r>w.x && t<w.y+w.h && b>w.y);
}
function dist2(a,b){ return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2); }

const WALLS=makeWalls(), RECTS=wallsToRects(WALLS);
const BLUE_SPAWNS=blueSpawns(), RED_SPAWNS=redSpawns();
const BLUE_BASE={x:TILE*2,y:H/2}, RED_BASE={x:W-TILE*2,y:H/2};

// ── Room helpers ───────────────────────────────────────────────────────────────
const rooms=new Map(), roomsByCode=new Map(), publicRooms=new Set();
let nextRoomId=1, nextPlayerId=1;

const ADJECTIVES=['ALPHA','BRAVO','CYBER','DELTA','EMBER','FLARE','GHOST','HYPER',
  'INFRA','JADE','KINETIC','LUNAR','MATRIX','NEON','ONYX','PIXEL','QUASAR','RAPID',
  'SIGMA','TITAN','ULTRA','VIPER','WAVE','XENON','YETI','ZETA'];
const NOUNS=['ACE','BOLT','COMET','DART','ECHO','FANG','GRID','HAWK',
  'ION','JAB','KITE','LANCE','MACH','NODE','ORB','PIKE','QUILL','RIFT',
  'SPARK','THORN','UNIT','VOLT','WARP','XRAY','YARN','ZONE'];

function makeCode(){
  let code; do { const a=ADJECTIVES[Math.floor(Math.random()*ADJECTIVES.length)];
    const n=NOUNS[Math.floor(Math.random()*NOUNS.length)];
    const d=Math.floor(Math.random()*90)+10; code=a+'-'+n+'-'+d;
  } while(roomsByCode.has(code)); return code;
}

function makeRoom(id){
  return { id, code:null, isPrivate:false, isQuickPlay:false,
    game:null, gameLoop:null, botLoop:null,
    clients:new Map(), startTimer:null, startCountdown:null, waitSecondsLeft:0 };
}
function makeGame(){
  return { phase:'waiting', players:{},
    blueFlag:{x:BLUE_BASE.x,y:BLUE_BASE.y,carriedBy:null,home:true,returnTimer:0,homeX:BLUE_BASE.x,homeY:BLUE_BASE.y},
    redFlag:{x:RED_BASE.x,y:RED_BASE.y,carriedBy:null,home:true,returnTimer:0,homeX:RED_BASE.x,homeY:RED_BASE.y},
    scoreBlue:0,scoreRed:0,timeLeft:300,tick:0,flash:null,flashTimer:0,tagEffects:[] };
}
function makePlayer(team,slotIndex,isBot=false,botName=null){
  const spawns=team==='blue'?BLUE_SPAWNS:RED_SPAWNS;
  const sp=spawns[slotIndex]||spawns[0];
  return { id:nextPlayerId++, team, slotIndex, isBot,
    name: isBot?(botName||'Bot'):'',
    x:sp.x, y:sp.y, spawnX:sp.x, spawnY:sp.y,
    hasFlag:false, tagCooldown:0, tagPressed:false,
    keys:{up:false,down:false,left:false,right:false},
    // Bot-only AI state
    botTarget:null, botReactTimer:0, botWanderDir:{dx:0,dy:0}, botWanderTime:0,
  };
}

// ── Bot AI ─────────────────────────────────────────────────────────────────────
function tickBots(room){
  const game=room.game;
  if(!game||game.phase!=='playing') return;

  const bots=Object.values(game.players).filter(p=>p.isBot);
  const rf=game.redFlag, bf=game.blueFlag;

  for(const bot of bots){
    if(bot.tagCooldown>0) bot.tagCooldown--;
    bot.botReactTimer--;

    // Occasional mistake: pick a random wander direction and follow it briefly
    if(Math.random()<BOT_MISTAKE_CHANCE && bot.botWanderTime<=0){
      const angles=[0,Math.PI/2,Math.PI,3*Math.PI/2];
      const a=angles[Math.floor(Math.random()*angles.length)];
      bot.botWanderDir={dx:Math.cos(a),dy:Math.sin(a)};
      bot.botWanderTime=20+Math.floor(Math.random()*30);
    }

    if(bot.botWanderTime>0){
      bot.botWanderTime--;
      moveBotInDir(bot,bot.botWanderDir.dx,bot.botWanderDir.dy);
      tryBotTag(room,bot);
      continue;
    }

    // Only recalculate goal every BOT_REACT_FRAMES ticks
    if(bot.botReactTimer>0){
      // Keep moving toward last target
      if(bot.botTarget) moveBotToward(bot,bot.botTarget.x,bot.botTarget.y);
      tryBotTag(room,bot);
      continue;
    }
    bot.botReactTimer=BOT_REACT_FRAMES;

    // ── Decision logic ──────────────────────────────────────────────────────
    const myFlag  = bot.team==='blue' ? bf : rf;   // own flag
    const eneFlag = bot.team==='blue' ? rf : bf;   // enemy flag to steal
    const myBase  = bot.team==='blue' ? BLUE_BASE : RED_BASE;
    const eneBase = bot.team==='blue' ? RED_BASE : BLUE_BASE;
    const enemies = Object.values(game.players).filter(p=>p.team!==bot.team);
    const closestEnemy = enemies.reduce((best,e)=>{
      return !best||dist2(bot,e)<dist2(bot,best)?e:best;
    }, null);

    if(bot.hasFlag){
      // Carrying flag — head home, but dodge nearby enemies
      if(closestEnemy && dist2(bot,closestEnemy)<80){
        // Run away from enemy while still heading home
        const ex=bot.x-closestEnemy.x, ey=bot.y-closestEnemy.y;
        const len=Math.sqrt(ex*ex+ey*ey)||1;
        const mx=myBase.x+ex/len*60, my=myBase.y+ey/len*60;
        bot.botTarget={x:mx, y:my};
      } else {
        bot.botTarget={x:myBase.x, y:myBase.y};
      }
    } else if(!myFlag.home && myFlag.carriedBy===null){
      // Own flag is dropped — 40% chance a defender bot goes to retrieve it
      if(bot.slotIndex>=3 && Math.random()<0.4){
        bot.botTarget={x:myFlag.x, y:myFlag.y};
      } else {
        // Attacker — go for enemy flag or chase flag carrier
        botAttackDecision(bot,eneFlag,eneBase,closestEnemy,enemies);
      }
    } else if(eneFlag.carriedBy!==null && eneFlag.carriedBy!==bot.id){
      // Enemy is carrying our flag — 3 defenders chase them
      const carrier=Object.values(game.players).find(p=>p.id===eneFlag.carriedBy);
      if(carrier && bot.slotIndex<3){
        bot.botTarget={x:carrier.x, y:carrier.y};
      } else {
        botAttackDecision(bot,eneFlag,eneBase,closestEnemy,enemies);
      }
    } else {
      botAttackDecision(bot,eneFlag,eneBase,closestEnemy,enemies);
    }

    if(bot.botTarget) moveBotToward(bot,bot.botTarget.x,bot.botTarget.y);
    tryBotTag(room,bot);
  }
}

function botAttackDecision(bot,eneFlag,eneBase,closestEnemy,enemies){
  // Attackers go for the flag; defenders patrol near own base
  const isDefender = bot.slotIndex>=3;
  if(isDefender){
    // Patrol near own base — chase any nearby attacker who has the flag
    const carrier=enemies.find(e=>e.hasFlag);
    if(carrier && dist2(bot,carrier)<200){
      bot.botTarget={x:carrier.x, y:carrier.y};
    } else {
      // Patrol: add slight randomness to avoid all defenders stacking
      const px = (bot.team==='blue'?BLUE_BASE.x:RED_BASE.x) + (Math.random()-0.5)*80;
      const py = H/2 + (bot.slotIndex-3.5)*120;
      bot.botTarget={x:px, y:py};
    }
  } else {
    // Attacker — go for enemy flag
    if(eneFlag.carriedBy===null){
      bot.botTarget={x:eneFlag.x, y:eneFlag.y};
    } else {
      // Someone already has it — go block enemy base to intercept
      bot.botTarget={x:eneBase.x+(Math.random()-0.5)*60, y:eneBase.y+(Math.random()-0.5)*60};
    }
  }
}

function moveBotToward(bot,tx,ty){
  const dx=tx-bot.x, dy=ty-bot.y;
  const len=Math.sqrt(dx*dx+dy*dy)||1;
  moveBotInDir(bot,dx/len,dy/len);
}

function moveBotInDir(bot,dx,dy){
  const spd=(bot.hasFlag?SPEED_FLAG:SPEED)*BOT_SPEED_MULT;
  let mx=dx*spd, my=dy*spd;
  const half=PLAYER_SIZE/2;
  const nx=Math.max(half,Math.min(W-half,bot.x+mx));
  const ny=Math.max(half,Math.min(H-half,bot.y+my));
  // Wall sliding: try each axis separately
  if(!collidesWall(nx,bot.y,RECTS)) bot.x=nx;
  else if(!collidesWall(bot.x+mx*0.5,bot.y,RECTS)) bot.x+=mx*0.5; // half-step
  if(!collidesWall(bot.x,ny,RECTS)) bot.y=ny;
  else if(!collidesWall(bot.x,bot.y+my*0.5,RECTS)) bot.y+=my*0.5;
}

function tryBotTag(room,bot){
  if(bot.tagCooldown>0) return;
  const game=room.game;
  const enemies=Object.values(game.players).filter(p=>p.team!==bot.team);
  const close=enemies.find(e=>dist2(bot,e)<TAG_RANGE);
  if(close && Math.random()<BOT_TAG_CHANCE){
    // Simulate tag press
    bot.tagCooldown=TAG_COOLDOWN;
    game.tagEffects.push({x:bot.x,y:bot.y,r:8,life:30,color:bot.team==='blue'?'#00cfff':'#ff2244'});
    if(dist2(bot,close)<TAG_RANGE){
      if(close.hasFlag){
        close.hasFlag=false;
        const flagKey=close.team==='blue'?'redFlag':'blueFlag';
        const flag=game[flagKey];
        flag.carriedBy=null;flag.x=close.x;flag.y=close.y;flag.home=false;flag.returnTimer=FLAG_RETURN;
      }
      game.tagEffects.push({x:close.x,y:close.y,r:24,life:40,color:close.team==='blue'?'#00cfff':'#ff2244'});
      close.x=close.spawnX;close.y=close.spawnY;
      setFlash(game,'💥 Bot tagged '+teamLabel(close.team,close)+'!');
    }
  }
}

// ── Quick Play: fill room with 9 bots ─────────────────────────────────────────
function createQuickPlayRoom(){
  const id=nextRoomId++;
  const room=makeRoom(id);
  room.game=makeGame();
  room.isQuickPlay=true;
  rooms.set(id,room);
  // Don't add to publicRooms — QP rooms are not matchmade into
  return room;
}

function fillWithBots(room, humanTeam, humanSlot){
  const game=room.game;
  let botNameIdx=0;
  // Fill all slots except the human's
  for(let slot=0;slot<TEAM_SIZE;slot++){
    if(humanTeam==='blue'&&slot===humanSlot) continue;
    const b=makePlayer('blue',slot,true,BOT_NAMES[botNameIdx++]||'Bot');
    game.players[b.id]=b;
  }
  for(let slot=0;slot<TEAM_SIZE;slot++){
    if(humanTeam==='red'&&slot===humanSlot) continue;
    const b=makePlayer('red',slot,true,BOT_NAMES[botNameIdx++]||'Bot');
    game.players[b.id]=b;
  }
}

// ── Room management ────────────────────────────────────────────────────────────
function findOrCreateRoom(){
  for(const id of publicRooms){
    const room=rooms.get(id);
    if(room&&room.game.phase==='waiting'&&countTeam(room,'blue')<TEAM_SIZE&&countTeam(room,'red')<TEAM_SIZE) return room;
  }
  const id=nextRoomId++;
  const room=makeRoom(id);
  room.game=makeGame();
  rooms.set(id,room);
  publicRooms.add(id);
  console.log(`Created room ${id}`);
  return room;
}
function createPrivateRoom(){
  const code=makeCode();
  const id=nextRoomId++;
  const room=makeRoom(id);
  room.game=makeGame();
  room.code=code;
  room.isPrivate=true;
  rooms.set(id,room);
  roomsByCode.set(code,room);
  console.log(`Created private room ${id} code ${code}`);
  return room;
}
function cleanupRoom(room){
  if(room.clients.size===0&&room.game.phase!=='playing'){
    if(room.gameLoop)clearInterval(room.gameLoop);
    if(room.botLoop)clearInterval(room.botLoop);
    if(room.startTimer)clearTimeout(room.startTimer);
    if(room.startCountdown)clearInterval(room.startCountdown);
    rooms.delete(room.id);publicRooms.delete(room.id);
    if(room.code)roomsByCode.delete(room.code);
    console.log(`Removed room ${room.id}`);
  }
}
function countTeam(room,team){return[...room.clients.values()].filter(c=>c.team===team).length;}
function totalPlayers(room){return[...room.clients.values()].filter(c=>c.team!=='spectator').length;}
function canStart(room){return countTeam(room,'blue')>=1&&countTeam(room,'red')>=1;}
function broadcastRoom(room,msg){const s=JSON.stringify(msg);for(const[ws]of room.clients)if(ws.readyState===1)ws.send(s);}
function sendTo(ws,msg){if(ws.readyState===1)ws.send(JSON.stringify(msg));}
function broadcastLobby(room){broadcastRoom(room,{type:'lobby',blue:countTeam(room,'blue'),red:countTeam(room,'red'),need:TEAM_SIZE,roomId:room.id});}

// ── Start flow ─────────────────────────────────────────────────────────────────
function scheduleStart(room){
  if(room.game.phase!=='waiting'||room.startTimer!==null)return;
  room.waitSecondsLeft=QUEUE_WAIT;
  broadcastRoom(room,{type:'waitStart',seconds:QUEUE_WAIT});
  room.startCountdown=setInterval(()=>{
    room.waitSecondsLeft--;
    broadcastRoom(room,{type:'waitTick',seconds:room.waitSecondsLeft});
    if(room.waitSecondsLeft<=0){clearInterval(room.startCountdown);room.startCountdown=null;}
  },1000);
  room.startTimer=setTimeout(()=>{room.startTimer=null;startPlaying(room);},QUEUE_WAIT*1000);
}
function cancelStart(room){
  if(room.startTimer){clearTimeout(room.startTimer);room.startTimer=null;}
  if(room.startCountdown){clearInterval(room.startCountdown);room.startCountdown=null;}
  room.waitSecondsLeft=0;
  if(room.game.phase==='waiting')broadcastRoom(room,{type:'waitCancelled'});
}
function startPlaying(room){
  if(room.game.phase!=='waiting'||!canStart(room))return;
  room.game.phase='playing';
  if(room.gameLoop)clearInterval(room.gameLoop);
  if(room.botLoop)clearInterval(room.botLoop);
  room.gameLoop=setInterval(()=>tick(room),1000/FPS);
  // Run bot AI at a lower rate than the game loop (every 2 frames)
  room.botLoop=setInterval(()=>tickBots(room),1000/FPS*2);
  broadcastRoom(room,{type:'phase',phase:'playing'});
}

// ── Tick ───────────────────────────────────────────────────────────────────────
function tick(room){
  const game=room.game;
  if(!game||game.phase!=='playing')return;
  game.tick++;

  if(game.tick%FPS===0){
    game.timeLeft--;
    if(game.timeLeft<=0){endGame(room,game.scoreBlue>game.scoreRed?'blue':game.scoreRed>game.scoreBlue?'red':'draw');return;}
  }

  const players=Object.values(game.players).filter(p=>!p.isBot); // only human players move here
  const rf=game.redFlag,bf=game.blueFlag;

  for(const p of players) movePlayer(p);
  for(const p of players){if(p.tagPressed){p.tagPressed=false;doTag(room,p);}if(p.tagCooldown>0)p.tagCooldown--;}

  const allPlayers=Object.values(game.players);

  // Flag pickups
  for(const p of allPlayers){
    if(p.isBot)continue; // bots handle own pickup in tickBots indirectly via position — actually let's allow all
  }
  for(const p of allPlayers){
    if(p.team==='blue'&&!p.hasFlag&&rf.carriedBy===null&&dist2(p,rf)<PLAYER_SIZE+10){
      p.hasFlag=true;rf.carriedBy=p.id;rf.home=false;rf.returnTimer=0;
      setFlash(game,'🔵 '+(p.isBot?p.name:'BLUE P'+(p.slotIndex+1))+' grabbed the RED flag!');
    }
    if(p.team==='red'&&!p.hasFlag&&bf.carriedBy===null&&dist2(p,bf)<PLAYER_SIZE+10){
      p.hasFlag=true;bf.carriedBy=p.id;bf.home=false;bf.returnTimer=0;
      setFlash(game,'🔴 '+(p.isBot?p.name:'RED P'+(p.slotIndex+1))+' grabbed the BLUE flag!');
    }
  }
  for(const p of allPlayers){
    if(rf.carriedBy===p.id){rf.x=p.x;rf.y=p.y;}
    if(bf.carriedBy===p.id){bf.x=p.x;bf.y=p.y;}
  }

  if(rf.carriedBy===null&&!rf.home&&rf.returnTimer>0){rf.returnTimer--;if(rf.returnTimer<=0){rf.x=rf.homeX;rf.y=rf.homeY;rf.home=true;setFlash(game,'🔴 Red flag returned!');}}
  if(bf.carriedBy===null&&!bf.home&&bf.returnTimer>0){bf.returnTimer--;if(bf.returnTimer<=0){bf.x=bf.homeX;bf.y=bf.homeY;bf.home=true;setFlash(game,'🔵 Blue flag returned!');}}

  for(const p of allPlayers){
    if(p.team==='blue'&&p.hasFlag&&dist2(p,BLUE_BASE)<PLAYER_SIZE+14){
      p.hasFlag=false;rf.carriedBy=null;rf.home=true;rf.x=rf.homeX;rf.y=rf.homeY;rf.returnTimer=0;
      game.scoreBlue++;setFlash(game,'⭐ BLUE CAPTURES! ('+game.scoreBlue+'/'+MAX_SCORE+')');
      if(game.scoreBlue>=MAX_SCORE){endGame(room,'blue');return;}
    }
    if(p.team==='red'&&p.hasFlag&&dist2(p,RED_BASE)<PLAYER_SIZE+14){
      p.hasFlag=false;bf.carriedBy=null;bf.home=true;bf.x=bf.homeX;bf.y=bf.homeY;bf.returnTimer=0;
      game.scoreRed++;setFlash(game,'⭐ RED CAPTURES! ('+game.scoreRed+'/'+MAX_SCORE+')');
      if(game.scoreRed>=MAX_SCORE){endGame(room,'red');return;}
    }
  }

  if(game.flashTimer>0)game.flashTimer--;
  for(let i=game.tagEffects.length-1;i>=0;i--){game.tagEffects[i].r+=2;game.tagEffects[i].life--;if(game.tagEffects[i].life<=0)game.tagEffects.splice(i,1);}

  broadcastRoom(room,{
    type:'state',
    players:allPlayers.map(p=>({id:p.id,team:p.team,name:p.name,isBot:p.isBot,x:p.x,y:p.y,hasFlag:p.hasFlag,tagCooldown:p.tagCooldown,slotIndex:p.slotIndex})),
    blueFlag:{x:bf.x,y:bf.y,carriedBy:bf.carriedBy,home:bf.home,returnTimer:bf.returnTimer},
    redFlag:{x:rf.x,y:rf.y,carriedBy:rf.carriedBy,home:rf.home,returnTimer:rf.returnTimer},
    scoreBlue:game.scoreBlue,scoreRed:game.scoreRed,
    timeLeft:game.timeLeft,
    flash:game.flashTimer>0?game.flash:null,flashTimer:game.flashTimer,
    tagEffects:game.tagEffects.slice(),
  });
}

function movePlayer(p){
  const k=p.keys; let dx=0,dy=0;
  const spd=p.hasFlag?SPEED_FLAG:SPEED;
  if(k.up)dy-=spd;if(k.down)dy+=spd;if(k.left)dx-=spd;if(k.right)dx+=spd;
  if(dx&&dy){dx*=0.707;dy*=0.707;}
  const half=PLAYER_SIZE/2;
  const nx=Math.max(half,Math.min(W-half,p.x+dx));
  const ny=Math.max(half,Math.min(H-half,p.y+dy));
  if(!collidesWall(nx,p.y,RECTS))p.x=nx;
  if(!collidesWall(p.x,ny,RECTS))p.y=ny;
}

function doTag(room,attacker){
  const game=room.game;
  if(attacker.tagCooldown>0)return;
  attacker.tagCooldown=TAG_COOLDOWN;
  game.tagEffects.push({x:attacker.x,y:attacker.y,r:8,life:30,color:attacker.team==='blue'?'#00cfff':'#ff2244'});
  const enemies=Object.values(game.players).filter(p=>p.team!==attacker.team);
  let closest=null,closestDist=TAG_RANGE;
  for(const e of enemies){const d=dist2(attacker,e);if(d<closestDist){closestDist=d;closest=e;}}
  if(!closest)return;
  if(closest.hasFlag){
    closest.hasFlag=false;
    const flagKey=closest.team==='blue'?'redFlag':'blueFlag';
    const flag=game[flagKey];
    flag.carriedBy=null;flag.x=closest.x;flag.y=closest.y;flag.home=false;flag.returnTimer=FLAG_RETURN;
  }
  game.tagEffects.push({x:closest.x,y:closest.y,r:24,life:40,color:closest.team==='blue'?'#00cfff':'#ff2244'});
  closest.x=closest.spawnX;closest.y=closest.spawnY;
  setFlash(game,'💥 '+teamLabel(attacker.team,attacker)+' tagged '+teamLabel(closest.team,closest)+'!');
}

function teamLabel(team,p){return p.name||(team.toUpperCase()+' P'+(p.slotIndex+1));}
function setFlash(game,msg){game.flash=msg;game.flashTimer=100;}

function endGame(room,winner){
  room.game.phase='over';
  if(room.gameLoop){clearInterval(room.gameLoop);room.gameLoop=null;}
  if(room.botLoop){clearInterval(room.botLoop);room.botLoop=null;}
  broadcastRoom(room,{type:'gameover',winner,scoreBlue:room.game.scoreBlue,scoreRed:room.game.scoreRed});
}

function resetRoom(room){
  if(room.gameLoop)clearInterval(room.gameLoop);
  if(room.botLoop)clearInterval(room.botLoop);
  if(room.startTimer)clearTimeout(room.startTimer);
  if(room.startCountdown)clearInterval(room.startCountdown);
  room.gameLoop=null;room.botLoop=null;room.startTimer=null;room.startCountdown=null;
  room.waitSecondsLeft=0;
  room.game=makeGame();
  for(const[ws,info]of room.clients){
    const p=makePlayer(info.team,info.slotIndex,false);
    info.playerId=p.id;
    room.game.players[p.id]=p;
  }
  // If quickplay, re-fill bots
  if(room.isQuickPlay){
    for(const info of room.clients.values()){
      fillWithBots(room,info.team,info.slotIndex);
    }
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection',(ws,req)=>{
  const urlParams=new URL(req.url,'http://localhost').searchParams;
  const codeParam=(urlParams.get('room')||'').toUpperCase().trim();
  const quickPlay=urlParams.get('quickplay')==='1';

  let room;

  if(quickPlay){
    // Quick play — solo room with 9 bots, starts immediately
    room=createQuickPlayRoom();
    const team=Math.random()<0.5?'blue':'red';
    const slotIndex=0;
    const p=makePlayer(team,slotIndex,false);
    room.game.players[p.id]=p;
    room.clients.set(ws,{team,slotIndex,playerId:p.id});
    fillWithBots(room,team,slotIndex);

    sendTo(ws,{
      type:'init',playerId:p.id,team,slotIndex,
      W,H,COLS,ROWS,walls:WALLS,
      blueBase:BLUE_BASE,redBase:RED_BASE,
      blueSpawns:BLUE_SPAWNS,redSpawns:RED_SPAWNS,
      phase:'waiting',maxScore:MAX_SCORE,
      roomId:room.id,roomCode:null,isQuickPlay:true,
    });

    // Start immediately (3s countdown)
    room.waitSecondsLeft=3;
    broadcastRoom(room,{type:'waitStart',seconds:3});
    room.startCountdown=setInterval(()=>{
      room.waitSecondsLeft--;
      broadcastRoom(room,{type:'waitTick',seconds:room.waitSecondsLeft});
      if(room.waitSecondsLeft<=0){clearInterval(room.startCountdown);room.startCountdown=null;}
    },1000);
    room.startTimer=setTimeout(()=>{room.startTimer=null;startPlaying(room);},3000);

    attachHandlers(ws,room);
    console.log(`Quick play room ${room.id} created for team ${team}`);
    return;
  }

  if(codeParam){
    room=roomsByCode.get(codeParam);
    if(!room){sendTo(ws,{type:'error',code:'ROOM_NOT_FOUND',msg:'Room code not found.'});ws.close();return;}
    if(room.game.phase==='over'){sendTo(ws,{type:'error',code:'ROOM_OVER',msg:'That game has ended.'});ws.close();return;}
  } else {
    room=findOrCreateRoom();
  }

  const bc=countTeam(room,'blue'),rc=countTeam(room,'red');
  let team,slotIndex;
  if(bc<=rc&&bc<TEAM_SIZE){team='blue';slotIndex=bc;}
  else if(rc<TEAM_SIZE){team='red';slotIndex=rc;}
  else{
    sendTo(ws,{type:'spectator',msg:'Game is full (5v5). You are spectating.'});
    room.clients.set(ws,{team:'spectator',slotIndex:0,playerId:null});
    ws.on('close',()=>{room.clients.delete(ws);cleanupRoom(room);});
    return;
  }

  const p=makePlayer(team,slotIndex,false);
  room.game.players[p.id]=p;
  room.clients.set(ws,{team,slotIndex,playerId:p.id});

  sendTo(ws,{
    type:'init',playerId:p.id,team,slotIndex,
    W,H,COLS,ROWS,walls:WALLS,
    blueBase:BLUE_BASE,redBase:RED_BASE,
    blueSpawns:BLUE_SPAWNS,redSpawns:RED_SPAWNS,
    phase:room.game.phase,maxScore:MAX_SCORE,
    roomId:room.id,roomCode:room.code||null,isQuickPlay:false,
  });

  broadcastLobby(room);
  if(room.game.phase==='waiting'&&canStart(room)&&room.startTimer===null) scheduleStart(room);

  attachHandlers(ws,room);
  console.log(`Room ${room.id}: ${team} slot ${slotIndex} joined`);
});

function attachHandlers(ws,room){
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    const info=room.clients.get(ws);
    if(!info||info.team==='spectator')return;
    const player=room.game.players[info.playerId];
    if(!player)return;
    if(msg.type==='keys'){player.keys.up=!!msg.up;player.keys.down=!!msg.down;player.keys.left=!!msg.left;player.keys.right=!!msg.right;}
    if(msg.type==='tag')player.tagPressed=true;
    if(msg.type==='nickname'&&typeof msg.name==='string')player.name=msg.name.trim().slice(0,16)||null;
    if(msg.type==='restart'&&room.game.phase==='over'){resetRoom(room);broadcastLobby(room);if(canStart(room))scheduleStart(room);}
  });
  ws.on('close',()=>{
    const info=room.clients.get(ws);
    if(info&&info.playerId)delete room.game.players[info.playerId];
    room.clients.delete(ws);
    if(room.game.phase==='waiting'){if(!canStart(room))cancelStart(room);}
    else if(room.game.phase==='playing'&&room.clients.size===0){
      // All humans left — end game
      if(room.gameLoop){clearInterval(room.gameLoop);room.gameLoop=null;}
      if(room.botLoop){clearInterval(room.botLoop);room.botLoop=null;}
      room.game.phase='over';
    }
    broadcastLobby(room);
    cleanupRoom(room);
    console.log(`Room ${room.id}: player left`);
  });
}

// ── API ────────────────────────────────────────────────────────────────────────
app.post('/api/rooms/create',(req,res)=>{const room=createPrivateRoom();res.json({code:room.code,roomId:room.id});});
app.get('/api/rooms',(req,res)=>{
  const list=[];
  for(const[id,room]of rooms)list.push({id,code:room.code||null,isPrivate:room.isPrivate,isQuickPlay:room.isQuickPlay,phase:room.game.phase,blue:countTeam(room,'blue'),red:countTeam(room,'red'),waitSecondsLeft:room.waitSecondsLeft});
  res.json(list);
});

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`CTF 5v5+Bots server on port ${PORT}`));
