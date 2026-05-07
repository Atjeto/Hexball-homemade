# HEXBALL

Online multiplayer 2D football + golf-fight, mobile-first.

## Modes

- **⚽ Football** — Red vs Blue teams. First to N goals wins.
- **⛳ Golf Fight** — Everyone has their own ball on the same hole. Knock other people's balls into water. Lowest strokes wins.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service** → connect the repo.
3. Settings (auto-detected from `render.yaml`):
   - Runtime: **Node**
   - Build: `npm install`
   - Start: `npm start`
   - Plan: **Free** is fine
4. Deploy. You'll get a URL like `hexball-xxxx.onrender.com`.

That's it. The server serves the client over HTTP and handles WebSocket on the same port.

## Local development

```bash
npm install
npm start
# Open http://localhost:3000 in two browser tabs to test multiplayer
```

## How to play with friends

1. Open the site, enter your name.
2. Pick mode → **CREATE ROOM**.
3. Share the 4-letter code, or tap **COPY LINK** — friends paste the URL and are auto-joined.
4. Host starts the game. Up to 6 players per room.

## Architecture

- **Server** (`server.js`): Authoritative simulation at 30Hz. Clients send inputs only; server runs physics and broadcasts state. No client-side cheating possible.
- **Client** (`public/index.html`): Single file. Renders the server-pushed state. Touch controls drawn on canvas. Light/dark theme.
- **Networking**: WebSocket (`ws` library). Same port serves HTTP + WS.

## Files

- `server.js` — full game server + room manager
- `public/index.html` — single-file client
- `package.json` — Node 18+, only `ws` as a runtime dep
- `render.yaml` — Render Blueprint config
