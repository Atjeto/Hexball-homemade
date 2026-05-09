// Rate-limit-specific tests. Spins up a server with limits ENABLED but tuned
// to fast windows so tests don't take forever.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, makeClient, sleep, randomPort } = require('./harness');

const PORT = randomPort();
let serverProc;

before(async () => {
  serverProc = await startServer(PORT, {
    HEXBALL_DISABLE_RATE_LIMITS: '0', // enable
    HEXBALL_CREATE_COOLDOWN_MS: '600', // 0.6s window for fast tests
    HEXBALL_CHAT_WINDOW_MS: '1000',
    HEXBALL_CHAT_MAX: '3', // smaller cap for fast burst tests
  });
});
after(async () => { await stopServer(serverProc); });

test('createRoom rate-limit: rapid second create returns error', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'X', opts: {} });
  await a.wait('roomCreated');
  a.send({ type: 'leaveRoom' });
  await sleep(80);
  a.send({ type: 'createRoom', mode: 'match', name: 'Y', opts: {} });
  // Wait for either roomCreated OR error; the rate limit should fire (60ms < 600ms cooldown).
  const got = await new Promise((res) => {
    const timer = setTimeout(() => res({ type: 'timeout' }), 800);
    const onMsg = (raw) => {
      const e = JSON.parse(raw);
      if (e.type === 'roomCreated' || e.type === 'error') {
        clearTimeout(timer); a.ws.removeListener('message', onMsg); res(e);
      }
    };
    a.ws.on('message', onMsg);
  });
  assert.equal(got.type, 'error', 'expected rate-limit error');
  assert.match(got.message || '', /slow down|try again/i);
  a.close();
});

test('createRoom rate-limit: works again after cooldown elapses', async () => {
  // Wait long enough that the prior test's cooldown is gone.
  await sleep(800);
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'P', opts: {} });
  await a.wait('roomCreated', null, 2000);
  a.send({ type: 'leaveRoom' });
  await sleep(800); // > 600ms cooldown
  a.send({ type: 'createRoom', mode: 'match', name: 'Q', opts: {} });
  await a.wait('roomCreated', null, 2000);
  a.close();
});

test('chat rate-limit: 4th message in window drops with error', async () => {
  // Drain any IP-level createRoom cooldown left by prior tests.
  await sleep(800);
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'CH', opts: {} });
  await a.wait('roomCreated', null, 2000);
  // CHAT_MAX is 3 in this server config. Burst 5 messages.
  for (let i = 0; i < 5; i++) a.send({ type: 'chat', text: 'msg ' + i });
  await sleep(300);
  const chats = a.chats.length;
  const errs = a.events.filter(e => e.type === 'error' && /chatting too fast/i.test(e.message || ''));
  assert.equal(chats, 3, 'expected 3 broadcast chats; got ' + chats);
  assert.ok(errs.length >= 2, 'expected at least 2 rate-limit errors');
  a.close();
});
