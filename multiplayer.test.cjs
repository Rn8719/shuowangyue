'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { Lobby, disconnectMs, hostTimeoutMs } = require('./multiplayer.cjs');
const { createServer } = require('./server.cjs');
const Rules = require('./rules.js');
const cards = Rules.prepare(vm.runInNewContext(fs.readFileSync(path.join(__dirname, '数据/牌桌数据.js'), 'utf8') + '\ncardRows'));

test('rooms isolate private cards, enforce host permissions and reclaim disconnected seats next hand', () => {
  let now = 0;
  const lobby = new Lobby(cards, () => now);
  const host = lobby.create('房主', 6, 2, '012345');
  const guest = lobby.join(host.code, '好友');
  const ask = (seat, command, body = {}) => lobby.request(seat.code, seat.token, command, body);
  assert.throws(() => ask(guest, 'start'));
  const home = ask(host, 'start');
  const away = ask(guest, 'state');
  assert.equal(home.game.seats.filter(seat => seat.human).length, 2);
  for (const view of [home.game, away.game]) {
    assert(view.seats[view.self].cards.every(Boolean));
    for (const seat of view.seats.filter(seat => seat.id !== view.self)) {
      assert(seat.cards[0]);
      assert(seat.cards.slice(1).every(card => card === null));
    }
    assert(!Object.hasOwn(view, 'deck'));
  }
  assert.throws(() => ask(guest, 'kick', { member: home.you }));
  const room = lobby.rooms.get(host.code);
  now = disconnectMs - 100;
  ask(guest, 'state');
  now += 101;
  const disconnected = ask(guest, 'state');
  assert.equal(disconnected.members.find(member => member.id === home.you).connected, false);
  assert.equal(disconnected.game.seats[0].folded, true);
  const reconnected = ask(host, 'state');
  assert.equal(reconnected.host, home.you);
  assert.equal(reconnected.game.seats[0].folded, true);
  while (!room.game.result) room.game.act('fold');
  const serial = ask(guest, 'state').game.serial;
  const next = ask(guest, 'next', { serial });
  assert.equal(next.game.hand, 2);
  assert.equal(next.game.seats[0].folded, false);
  assert.throws(() => ask(host, 'next', { serial }));
  const kicked = ask(host, 'kick', { member: away.you });
  assert.equal(kicked.game.seats[1].folded, true);
  assert.equal(kicked.game.seats[1].human, false);
  assert.equal(ask(guest, 'state'), null);
});

test('HTTP serves the game and lets independent clients start a friend room', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(base)).text();
    assert.match(html, /好友联机/);
    assert.match(html, /<meta name="friend-server" content="">/);
    assert.equal((await fetch(base + '/multiplayer.cjs')).status, 404);
    async function ask(route, body, token) {
      return fetch(base + '/api/' + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body)
      });
    }
    const host = await (await ask('create', { name: '房主', count: 6, rounds: 1, code: '012345' })).json();
    const guest = await (await ask('join/' + host.code, { name: '好友' })).json();
    assert.equal((await ask('state/' + host.code, {})).status, 403);
    const start = await ask('start/' + host.code, {}, host.token);
    assert.equal(start.status, 200);
    const view = await (await ask('state/' + host.code, {}, guest.token)).json();
    assert.equal(view.game.self, 1);
    assert.equal(view.game.seats[0].cards[1], null);
    assert(view.game.seats[1].cards[1]);
    assert.equal((await ask('leave/' + host.code, {}, host.token)).status, 200);
    assert.equal((await ask('state/' + host.code, {}, guest.token)).status, 403);
    assert.equal((await ask('create', { name: '新房主', count: 6, rounds: 1, code: host.code })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('host timeout uses the last host heartbeat, and reconnect resets the deadline', () => {
  let now = 0;
  const lobby = new Lobby(cards, () => now);
  const host = lobby.create('房主', 6, 2, '000123');
  const guest = lobby.join(host.code, '好友');
  now = hostTimeoutMs - 1;
  assert(lobby.request(guest.code, guest.token, 'state', {}));
  assert.throws(() => lobby.create('重复', 6, 2, host.code), /已存在/);
  assert(lobby.request(host.code, host.token, 'state', {}));
  now += hostTimeoutMs - 1;
  lobby.tick();
  assert(lobby.request(guest.code, guest.token, 'state', {}));
  now++;
  lobby.tick();
  assert.equal(lobby.request(host.code, host.token, 'state', {}), null);
  assert.equal(lobby.request(guest.code, guest.token, 'state', {}), null);
  assert.equal(lobby.create('新房主', 6, 2, host.code).code, host.code);
});

test('guest leaving preserves the room; host leaving releases a renamed room immediately', () => {
  const lobby = new Lobby(cards);
  const host = lobby.create('房主', 6, 2, '000123');
  const guest = lobby.join(host.code, '好友');
  assert.deepEqual(lobby.request(guest.code, guest.token, 'leave', {}), { left: true });
  assert.equal(lobby.request(host.code, host.token, 'state', {}).members.length, 1);
  const other = lobby.join(host.code, '另一位好友');
  lobby.request(host.code, host.token, 'rename', { code: '000321' });
  assert.deepEqual(lobby.request(host.code, host.token, 'leave', {}), { left: true });
  assert.equal(lobby.request(other.code, other.token, 'state', {}), null);
  assert.equal(lobby.create('新房主', 6, 2, '000321').code, '000321');
});

test('six-digit room numbers are unique and renaming preserves seats', () => {
  const lobby = new Lobby(cards);
  assert.throws(() => lobby.create('无效', 6, 2, '12345'), /六位数字/);
  const host = lobby.create('房主', 6, 2, '000123');
  const guest = lobby.join(host.code, '好友');
  lobby.create('另一房主', 6, 2, '123456');
  assert.throws(() => lobby.create('重复', 6, 2, '000123'), /已存在/);
  assert.throws(() => lobby.request(host.code, guest.token, 'rename', { code: '000321' }), /只有房主/);
  assert.throws(() => lobby.request(host.code, host.token, 'rename', { code: '123456' }), /已存在/);
  const renamed = lobby.request(host.code, host.token, 'rename', { code: '000321' });
  assert.equal(renamed.code, '000321');
  assert.throws(() => lobby.join('000123', '新玩家'), /不存在/);
  assert.equal(lobby.request(guest.code, guest.token, 'state', {}).code, '000321');
  assert.equal(lobby.join('000321', '新玩家').code, '000321');
  assert.equal(lobby.create('原房号可复用', 6, 2, '000123').code, '000123');
});
