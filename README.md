# 🚩 Capture the Flag — 5v5 Online Multiplayer

## How to run on Replit

1. Go to **replit.com** and click **+ Create Repl**
2. Choose **"Import from ZIP"** (or create a Node.js repl and upload the files)
3. Upload all three files:
   - `server.js`
   - `public/index.html`
   - `package.json`
   - `.replit`
4. Click the green **Run** button
5. Replit will install dependencies and start the server
6. Copy the URL from the preview window (e.g. `https://your-repl.username.repl.co`)
7. Share that URL with up to 9 friends — first come, first served for team slots!

## How to play

- **Move:** WASD or Arrow Keys
- **Tag:** Space or F
- Steal the enemy flag and return it to your base
- Tag an enemy to send them back to spawn and drop their flag
- Dropped flags return home in 5 seconds
- First team to **5 captures** wins!

## Game details

- **Map size:** 1600 × 1000px (big!)
- **Teams:** Up to 5 Blue vs 5 Red
- **Extra players** beyond 5 per team become spectators
- **Camera** follows your own player — minimap shows the full field
- **Game starts** as soon as at least 1 player joins each team

## File structure

```
ctf-multiplayer/
├── server.js          ← Node.js game server (WebSocket + Express)
├── package.json       ← Dependencies (express, ws)
├── .replit            ← Replit run config
└── public/
    └── index.html     ← Game client (runs in browser)
```
