'use strict';

const { randomBytes } = require('node:crypto');
const Rules = require('./rules.js');

const disconnectMs = 15000;
const turnMs = 120000;
const botMs = 850;
const roomLifetime = 2 * 60 * 60 * 1000;
const roomCode = /^[0-9]{6}$/;
const actions = ['raise', 'call', 'fold', 'allin'];

class Lobby {
  constructor(cards, now = Date.now) {
    this.cards = cards;
    this.now = now;
    this.rooms = new Map();
    this.seatRooms = new Map();
  }

  validateCode(code) {
    if (typeof code !== 'string' || !roomCode.test(code)) throw Error('房间号必须是六位数字');
    if (this.rooms.has(code)) throw Error('该房间号已存在，请换一个');
  }

  create(name, count, rounds, code) {
    if (![6, 7, 8].includes(count) || ![1, 2, 3, 4].includes(rounds)) throw Error('无效的房间设置');
    this.validateCode(code);
    if (this.rooms.size >= 100) throw Error('房间已满，请稍后再试');
    const room = { code, count, rounds, members: new Map(), touched: this.now(), serial: 0 };
    const member = this.addMember(room, name);
    room.host = member.id;
    this.rooms.set(code, room);
    return { code, token: member.token };
  }

  addMember(room, name) {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (!normalized || [...normalized].length > 16) throw Error('昵称须为 1–16 个字符');
    const member = { id: randomBytes(8).toString('hex'), name: normalized,
      token: randomBytes(24).toString('hex'), lastSeen: this.now(), connected: true };
    room.members.set(member.token, member);
    this.seatRooms.set(member.token, room);
    return member;
  }

  removeMember(room, token) {
    room.members.delete(token);
    this.seatRooms.delete(token);
  }

  join(code, name) {
    const room = this.rooms.get(code);
    if (!room) throw Error('房间不存在或已关闭');
    if (room.game) throw Error('牌局已开始，请使用原设备重连');
    if (room.members.size >= room.count) throw Error('房间已满');
    const member = this.addMember(room, name);
    room.touched = this.now();
    return { code, token: member.token };
  }

  tick() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (now - room.touched > roomLifetime) {
        this.rooms.delete(room.code);
        for (const token of room.members.keys()) this.seatRooms.delete(token);
        continue;
      }
      this.advance(room, now);
    }
  }

  advance(room, now) {
    const game = room.game;
    for (const member of room.members.values()) {
      if (member.connected && now - member.lastSeen >= disconnectMs) {
        member.connected = false;
        if (game && !game.result) {
          const wasActor = game.actor?.id === member.seat;
          game.foldSeat(game.seats[member.seat], '掉线弃牌');
          if (wasActor || game.result) this.schedule(room);
          else room.serial++;
        }
      }
    }
    if (game?.result && !game.result.final && now >= room.deadline &&
        [...room.members.values()].every(player => game.seats[player.seat].out)) {
      this.nextHand(room);
      return;
    }
    if (!game?.actor || now < room.deadline) return;
    const choice = game.actor.human ? ['fold'] : Rules.botDecision(game.botView());
    game.act(...choice);
    this.schedule(room);
  }

  schedule(room) {
    room.serial++;
    room.deadline = this.now() + (room.game.actor?.human ? turnMs : room.game.actor ? botMs : 4000);
  }

  nextHand(room) {
    room.game.next();
    for (const player of room.members.values()) {
      if (!player.connected) room.game.foldSeat(room.game.seats[player.seat], '掉线弃牌');
    }
    this.schedule(room);
  }

  request(code, token, command, body) {
    const room = this.seatRooms.get(token);
    const member = room?.members.get(token);
    if (!member) return null;
    this.advance(room, this.now());
    room.touched = member.lastSeen = this.now();
    member.connected = true;
    const game = room.game;
    const host = member.id === room.host;
    switch (command) {
      case 'state': break;
      case 'rename': {
        if (!host) throw Error('只有房主可以修改房间号');
        if (body.code === room.code) break;
        this.validateCode(body.code);
        this.rooms.delete(room.code);
        room.code = body.code;
        this.rooms.set(room.code, room);
        break;
      }
      case 'start': {
        if (!host || game) throw Error('只有房主可以开局');
        const players = [...room.members.values()].filter(player => player.connected);
        if (players.length < 2) throw Error('至少需要两名在线真人');
        for (const [key, player] of room.members) if (!player.connected) this.removeMember(room, key);
        players.forEach((player, index) => { player.seat = index; });
        room.game = new Rules.Match(this.cards, room.count, room.rounds, undefined, players.map(player => player.name));
        this.schedule(room);
        break;
      }
      case 'act': {
        if (!game?.actor || game.actor.id !== member.seat || body.serial !== room.serial) throw Error('行动已变化，请查看牌桌');
        if (!actions.includes(body.action) || !game.act(body.action, body.amount)) throw Error('无效的下注操作');
        this.schedule(room);
        break;
      }
      case 'next': {
        if (!game?.result || game.result.final || game.seats[member.seat].out ||
            body.serial !== room.serial) throw Error('当前不能进入下一局');
        this.nextHand(room);
        break;
      }
      case 'kick': {
        if (!host) throw Error('只有房主可以移出玩家');
        const target = [...room.members.values()].find(player => player.id === body.member);
        if (!target || target === member) throw Error('无法移出该玩家');
        this.removeMember(room, target.token);
        if (game) {
          const seat = game.seats[target.seat];
          const wasActor = game.actor === seat;
          game.foldSeat(seat, '被移出房间，弃牌');
          seat.human = false;
          if (wasActor || game.result) this.schedule(room);
          else room.serial++;
        }
        break;
      }
      default: throw Error('未知房间操作');
    }
    return this.snapshot(room, member);
  }

  snapshot(room, member) {
    const game = room.game;
    const result = game?.result;
    const seats = game?.seats.map(seat => ({
      id: seat.id, name: seat.name, chips: seat.chips, action: seat.action, human: seat.human,
      out: seat.out, folded: seat.folded, wagered: seat.wagered,
      cards: seat.cards.map((card, index) => index === 0 || seat.id === member.seat ||
        (result?.scoreValue && game.contenders.includes(seat)) || result?.winners.includes(seat) ? card.id : null)
    }));
    return { code: room.code, count: room.count, rounds: room.rounds, host: room.host, you: member.id,
      members: [...room.members.values()].map(({ id, name, connected }) => ({ id, name, connected })),
      game: game ? {
        round: game.round, hand: game.hand, roundLimit: game.roundLimit, pot: game.pot, seats,
        self: member.seat, serial: room.serial, deadline: room.deadline, now: this.now(),
        actor: game.actor?.id, options: game.actor?.id === member.seat ? game.options() : null,
        playing: game.playing.map(seat => seat.id), contenders: game.contenders.map(seat => seat.id),
        community: game.community.id, history: game.history,
        result: result ? { award: result.award, remainder: result.remainder, final: result.final,
          scoreValue: result.scoreValue, winners: result.winners.map(seat => seat.id),
          rankings: result.rankings.map(({ seat, place }) => ({ id: seat.id, place })) } : null
      } : null };
  }
}

module.exports = { Lobby, disconnectMs };
