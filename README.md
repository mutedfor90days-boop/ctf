# ⚡ CHASE — Online Multiplayer Tag Game

> Kill the marked. Become the hunted.

## Gameplay
- One player is **marked** — everyone can see them
- **Kill the marked player** (touch them) → you become marked
- Being marked gives **constant points** + **speed boost**
- But now **everyone hunts you**

## Tech Stack
- **Backend**: Node.js + Express + Socket.io
- **Frontend**: HTML5 Canvas (no framework needed)
- **Realtime**: WebSockets at 60 tick/sec

## Local Development

```bash
npm install
npm run dev   # uses nodemon for hot reload
# or
npm start
```

Open http://localhost:3000

## Deploy to Railway

### Option 1: GitHub Deploy (Recommended)
1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. That's it! Railway assigns you a public URL

### Option 2: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Game Constants (server.js)
Tweak these to adjust feel:

| Constant | Default | Effect |
|---|---|---|
| `BASE_SPEED` | 220 px/s | How fast everyone moves |
| `MARKED_SPEED_MULT` | 1.22 | Marked player speed bonus |
| `MARK_POINTS_PER_SEC` | 8 | Points earned per second while marked |
| `KILL_BONUS` | 150 | Bonus points for stealing the mark |
| `MARK_KILL_COOLDOWN` | 800ms | Grace period after becoming marked |
| `TICK_RATE` | 60 | Server updates per second |

## Controls
- **WASD** or **Arrow Keys** to move
- Mobile: on-screen D-pad (auto-shown on touch devices)
