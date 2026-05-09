// Scoring + match-flow regressions: persistence across goal resets,
// kickoff countdown, time-limit auto-end, draw result.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, makeClient, sleep, randomPort } = require('./harness');

const PORT = randomPort();
let serverProc;

before(async () => { serverProc = await startServer(PORT); });
after(async () => { await stopServer(serverProc); });

async function setupSoloMatch(name, opts = {}) {
  const c = await makeClient(PORT);
  await c.wait('welcome');
  c.send({ type: 'createRoom', mode: 'match', name, opts });
  await c.wait('roomCreated');
  c.send({ type: 'startGame' });
  // Wait for kickoff to expire (server uses 3s)
  while (true) {
    const s = c.states[c.states.length - 1];
    if (s && s.state === 'playing' && (!s.kickoff || s.kickoff === 0)) break;
    await sleep(80);
  }
  return c;
}

test('state msg includes kickoff:3 immediately after startGame', async () => {
  const c = await makeClient(PORT);
  await c.wait('welcome');
  c.send({ type: 'createRoom', mode: 'match', name: 'K', opts: {} });
  await c.wait('roomCreated');
  c.send({ type: 'startGame' });
  await c.wait('state', (s) => s.kickoff === 3, 4000);
  c.close();
});

test('extraBalls is always an array (even when length 0)', async () => {
  const c = await setupSoloMatch('B');
  const s = c.states[c.states.length - 1];
  assert.ok(Array.isArray(s.extraBalls), 'extraBalls must be an array');
  assert.equal(s.extraBalls.length, 0);
  c.close();
});

test('time limit ends match automatically', async () => {
  const c = await makeClient(PORT);
  await c.wait('welcome');
  c.send({ type: 'createRoom', mode: 'match', name: 'T', opts: { goalsToWin: 99 } });
  await c.wait('roomCreated');
  c.send({ type: 'updateOpts', matchOpts: { timeLimit: 4 } });
  await sleep(100);
  c.send({ type: 'startGame' });
  // 3s kickoff + 4s play + small buffer
  const me = await c.wait('matchEnd', null, 12000);
  assert.equal(me.winner, 'draw');
  assert.equal(me.scoreRed, 0);
  assert.equal(me.scoreBlue, 0);
  c.close();
});

test('matchEnd carries playerStats and goalLog arrays', async () => {
  const c = await makeClient(PORT);
  await c.wait('welcome');
  c.send({ type: 'createRoom', mode: 'match', name: 'S', opts: { goalsToWin: 99 } });
  await c.wait('roomCreated');
  c.send({ type: 'updateOpts', matchOpts: { timeLimit: 4 } });
  await sleep(100);
  c.send({ type: 'startGame' });
  const me = await c.wait('matchEnd', null, 12000);
  assert.ok(Array.isArray(me.playerStats));
  assert.ok(Array.isArray(me.goalLog));
  c.close();
});

test('rematch resets scores and starts again without going through lobby', async () => {
  const c = await makeClient(PORT);
  await c.wait('welcome');
  c.send({ type: 'createRoom', mode: 'match', name: 'R', opts: { goalsToWin: 99 } });
  await c.wait('roomCreated');
  c.send({ type: 'updateOpts', matchOpts: { timeLimit: 3 } });
  await sleep(100);
  c.send({ type: 'startGame' });
  await c.wait('matchEnd', null, 12000);
  // Rematch
  c.send({ type: 'rematch' });
  await c.wait('gameStart', null, 4000);
  // Wait for the new state to flow
  await c.wait('state', (s) => s.state === 'playing', 4000);
  const last = c.states[c.states.length - 1];
  assert.equal(last.scoreRed, 0);
  assert.equal(last.scoreBlue, 0);
  c.close();
});
