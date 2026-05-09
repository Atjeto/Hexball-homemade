// Lobby behaviors: create, join, same-name dedup, team picker, auto-balance,
// addBot/removeBot, host transfer.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, makeClient, sleep, randomPort } = require('./harness');

const PORT = randomPort();
let serverProc;

before(async () => { serverProc = await startServer(PORT); });
after(async () => { await stopServer(serverProc); });

test('create + join: roomCode flows + secret in response', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'A', opts: {} });
  const created = await a.wait('roomCreated');
  assert.match(created.code, /^[A-Z0-9]{4}$/);
  assert.ok(created.secret && created.secret.length > 8, 'secret missing');

  const b = await makeClient(PORT);
  await b.wait('welcome');
  b.send({ type: 'joinRoom', code: created.code, name: 'B' });
  const joined = await b.wait('roomJoined');
  assert.equal(joined.code, created.code);
  assert.ok(joined.secret);
  await sleep(150);
  const lobby = b.lobbies[b.lobbies.length - 1];
  assert.equal(lobby.players.length, 2);

  a.close(); b.close();
});

test('same-name uniqueness adds (2) suffix', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'Alex', opts: {} });
  const code = (await a.wait('roomCreated')).code;
  const b = await makeClient(PORT);
  await b.wait('welcome');
  b.send({ type: 'joinRoom', code, name: 'Alex' });
  await b.wait('lobby');
  await sleep(100);
  const names = b.lobbies[b.lobbies.length - 1].players.map(p => p.name).sort();
  assert.deepEqual(names, ['Alex', 'Alex (2)']);
  a.close(); b.close();
});

test('setTeam + autoBalance', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'A', opts: {} });
  const code = (await a.wait('roomCreated')).code;
  const b = await makeClient(PORT);
  await b.wait('welcome');
  b.send({ type: 'joinRoom', code, name: 'B' });
  await b.wait('lobby');
  await sleep(100);
  // Both should default to opposite teams
  let lobby = a.lobbies[a.lobbies.length - 1];
  const teams1 = lobby.players.map(p => p.team).sort();
  assert.deepEqual(teams1, ['blue', 'red']);
  // Force B onto same team as A
  const aTeam = lobby.players.find(p => p.id === a.playerId).team;
  b.send({ type: 'setTeam', team: aTeam });
  await sleep(150);
  lobby = b.lobbies[b.lobbies.length - 1];
  assert.equal(lobby.players.find(p => p.id === b.playerId).team, aTeam);
  // Auto-balance restores split
  a.send({ type: 'autoBalance' });
  await sleep(150);
  lobby = a.lobbies[a.lobbies.length - 1];
  const teams2 = lobby.players.map(p => p.team).sort();
  assert.deepEqual(teams2, ['blue', 'red']);
  a.close(); b.close();
});

test('addBot creates a bot row, removeBot drops it', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'Host', opts: {} });
  await a.wait('roomCreated');
  a.send({ type: 'addBot' });
  await sleep(150);
  let lobby = a.lobbies[a.lobbies.length - 1];
  const bot = lobby.players.find(p => p.isBot);
  assert.ok(bot, 'bot not created');
  assert.match(bot.name, /^🤖 /);
  a.send({ type: 'removeBot', id: bot.id });
  await sleep(150);
  lobby = a.lobbies[a.lobbies.length - 1];
  assert.equal(lobby.players.filter(p => p.isBot).length, 0);
  a.close();
});

test('explicit transferHost moves crown', async () => {
  const a = await makeClient(PORT);
  await a.wait('welcome');
  a.send({ type: 'createRoom', mode: 'match', name: 'A', opts: {} });
  const code = (await a.wait('roomCreated')).code;
  const b = await makeClient(PORT);
  await b.wait('welcome');
  b.send({ type: 'joinRoom', code, name: 'B' });
  await b.wait('lobby');
  await sleep(100);
  a.send({ type: 'transferHost', toId: b.playerId });
  await sleep(150);
  const lobby = a.lobbies[a.lobbies.length - 1];
  assert.equal(lobby.hostId, b.playerId);
  a.close(); b.close();
});
