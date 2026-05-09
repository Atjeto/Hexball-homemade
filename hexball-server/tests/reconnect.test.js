// Reconnect/resume + rate-limiting + graceful shutdown.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, makeClient, sleep, randomPort } = require('./harness');

const PORT = randomPort();
let serverProc;

before(async () => { serverProc = await startServer(PORT); });
after(async () => { await stopServer(serverProc); });

test('rejoin restores the same playerId and host status after a socket drop', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'Resume', opts: {} });
  const created = await a.wait('roomCreated');
  const oldId = a.playerId;
  const secret = a.secret;
  // Drop the socket WITHOUT explicit leaveRoom — soft disconnect path
  a.close();
  await sleep(300);

  // Open a new socket and rejoin
  const a2 = await makeClient(PORT);
  await a2.wait('welcome');
  a2.send({ type: 'rejoin', code: created.code, playerId: oldId, secret });
  const success = await a2.wait('rejoinSuccess', null, 4000);
  assert.equal(success.playerId, oldId, 'should adopt old playerId');
  assert.equal(success.code, created.code);
  assert.equal(success.isHost, true, 'should still be host since we dropped briefly');
  a2.close();
});

test('rejoin fails cleanly when secret is wrong', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'Sec', opts: {} });
  const created = await a.wait('roomCreated');
  const oldId = a.playerId;
  a.close();
  await sleep(200);
  const b = await makeClient(PORT);
  await b.wait('welcome');
  b.send({ type: 'rejoin', code: created.code, playerId: oldId, secret: 'wrong-secret' });
  const failed = await b.wait('rejoinFailed', null, 3000);
  assert.match(failed.reason || '', /no matching slot|secret/i);
  b.close();
});

test('explicit leaveRoom drops the slot — rejoin fails afterwards', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'Hard', opts: {} });
  const created = await a.wait('roomCreated');
  const oldId = a.playerId;
  const secret = a.secret;
  a.send({ type: 'leaveRoom' });
  await sleep(200);
  a.close();
  await sleep(200);
  const a2 = await makeClient(PORT);
  await a2.wait('welcome');
  a2.send({ type: 'rejoin', code: created.code, playerId: oldId, secret });
  const failed = await a2.wait('rejoinFailed', null, 3000);
  assert.ok(failed.reason);
  a2.close();
});

