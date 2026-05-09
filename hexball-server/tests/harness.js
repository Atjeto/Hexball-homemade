// Shared test harness: spawns a server subprocess on a chosen port,
// returns helpers for opening WebSocket clients, sending/receiving messages,
// waiting on conditions, and tearing it all down.
//
// We deliberately use the running server.js process (not the Room class
// directly) so tests cover the real network path. Each test file picks a
// different port via TEST_PORT env to avoid stomping a manually-running dev
// server on 3000.

'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const SERVER_FILE = path.join(__dirname, '..', 'server.js');

async function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [SERVER_FILE], {
    env: {
      ...process.env,
      PORT: String(port),
      // Tests bypass rate limits unless they specifically opt in to test them.
      HEXBALL_DISABLE_RATE_LIMITS: '1',
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait until the server logs "listening" (or 5s, whichever first)
  await new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error('server start timeout')); }
    }, 5000);
    child.stdout.on('data', (b) => {
      if (!resolved && /listening on/.test(b.toString())) {
        resolved = true; clearTimeout(timer); resolve();
      }
    });
    child.on('exit', (code) => {
      if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error('server exited code ' + code)); }
    });
  });
  return child;
}

async function stopServer(child) {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => {
    child.on('exit', r);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch(e){} r(); }, 3000);
  });
}

function makeClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = {
      ws,
      events: [],
      states: [],
      lobbies: [],
      goals: [],
      chats: [],
      playerId: null,
      secret: null,
      // Per-type cursor so each wait() consumes the next un-waited event of that
      // type. Without this, repeated wait('roomCreated') keeps re-matching the
      // first one in the buffer instead of waiting for the new response.
      _cursor: {},
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      wait(type, predicate, ms = 5000) {
        return new Promise((res, rej) => {
          const startIdx = c._cursor[type] || 0;
          const check = () => {
            for (let i = startIdx; i < c.events.length; i++) {
              const e = c.events[i];
              if (e.type === type && (!predicate || predicate(e))) {
                c._cursor[type] = i + 1;
                cleanup();
                res(e);
                return true;
              }
            }
            return false;
          };
          let timer;
          const onMsg = () => check();
          function cleanup() {
            if (timer) clearTimeout(timer);
            ws.removeListener('message', onMsg);
          }
          if (check()) return;
          ws.on('message', onMsg);
          timer = setTimeout(() => { cleanup(); rej(new Error('timeout waiting for ' + type)); }, ms);
        });
      },
    };
    ws.on('open', () => resolve(c));
    ws.on('error', (e) => { try { ws.close(); } catch(_){} reject(e); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type === 'welcome') c.playerId = m.playerId;
      if (m.type === 'roomCreated' || m.type === 'roomJoined' || m.type === 'rejoinSuccess') {
        if (m.secret) c.secret = m.secret;
        if (m.playerId) c.playerId = m.playerId;
      }
      if (m.type === 'state') c.states.push(m);
      if (m.type === 'lobby') c.lobbies.push(m);
      if (m.type === 'goal') c.goals.push(m);
      if (m.type === 'chat') c.chats.push(m);
      c.events.push(m);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pick a random ephemeral port in the user range to avoid conflicts.
function randomPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

module.exports = { startServer, stopServer, makeClient, sleep, randomPort };
