'use strict';

const Rules = (() => {
  const seasons = ['春', '夏', '秋', '冬'];
  const styles = ['稳健', '欺骗', '综合'];
  const pointLimit = 24;
  const raiseLimit = 2;
  const startingStacks = [null, 10, 25, 35, 40];
  const randomInt = limit => {
    const sample = new Uint32Array(1);
    const ceiling = 2 ** 32 - (2 ** 32 % limit);
    do { crypto.getRandomValues(sample); } while (sample[0] >= ceiling);
    return sample[0] % limit;
  };

  function shuffle(items) {
    const deck = [...items];
    for (let index = deck.length - 1; index > 0; index--) {
      const other = randomInt(index + 1);
      [deck[index], deck[other]] = [deck[other], deck[index]];
    }
    return deck;
  }

  function prepare(rows) {
    return rows.map(card => {
      const [month, day] = card.date.match(/\d+/g).map(Number);
      const date = [month, day].map(value => String(value).padStart(2, '0'));
      const digits = [...date.join('')].map(Number).filter(Boolean);
      return { ...card, dateLabel: `${date[0]} 月 ${date[1]} 日`, order: month * 100 + day,
        digits, sum: digits.reduce((sum, digit) => sum + digit, 0) };
    });
  }

  function compare(left, right) {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference) return difference;
    }
    return 0;
  }

  function score(cards, community, hand) {
    if (hand > 4) {
      const own = cards.reduce((sum, card) => sum + card.sum, 0);
      return [own > pointLimit ? -1 : own + community.sum <= pointLimit ? own + community.sum : own];
    }
    const counts = Array(10).fill(0);
    const seasonal = Array(4).fill(0);
    for (const card of [...cards, community]) {
      for (const digit of card.digits) counts[digit]++;
      seasonal[seasons.indexOf(card.season)] += card.digits.length;
    }
    const ranks = [9, 8, 7, 6, 5, 4, 3, 2, 1];
    const five = ranks.find(rank => counts[rank] >= 5);
    if (five) return [8, five];
    const straight = ranks.find(rank => rank >= 5 && counts.slice(rank - 4, rank + 1).every(Boolean));
    if (straight) return [7, straight];
    const four = ranks.find(rank => counts[rank] >= 4);
    if (four) return [6, four];
    const three = ranks.find(rank => counts[rank] >= 3);
    const pairs = ranks.filter(rank => counts[rank] >= 2);
    if (three) {
      const pair = pairs.find(rank => rank !== three);
      if (pair) return [5, three, pair];
    }
    const flush = seasonal.findLastIndex(count => count >= 5);
    if (flush !== -1) return [4, flush];
    if (three) return [3, three];
    if (pairs.length >= 2) return [2, ...pairs.slice(0, 2)];
    if (pairs.length) return [1, pairs[0]];
    return [0, ...ranks.filter(rank => counts[rank]).slice(0, 5)];
  }

  class Match {
    constructor(cards, count, roundLimit = 4, startingChips = startingStacks[roundLimit], humans) {
      if (!Number.isInteger(roundLimit) || roundLimit < 1 || roundLimit > 4 ||
          !Number.isInteger(startingChips) || startingChips < 1) throw Error('无效的对局设置');
      this.cards = cards;
      this.multiplayer = Boolean(humans);
      this.roundLimit = roundLimit;
      this.round = 1;
      this.hand = 1;
      this.carry = 0;
      const profiles = shuffle([...styles, ...Array.from({ length: count - 4 }, () => styles[randomInt(3)])]);
      this.seats = Array.from({ length: count }, (_, id) => ({
        id, name: humans?.[id] ?? (id ? `人机${id}` : '玩家'), chips: startingChips,
        human: humans ? id < humans.length : id === 0, style: profiles[id - 1] ?? '综合'
      }));
      this.startHand();
    }

    startHand() {
      this.playing = this.seats.filter(seat => !seat.out);
      this.deck = shuffle(this.cards);
      this.community = this.deck.pop();
      this.direction = randomInt(2);
      this.dealOrder = [this.playing[0], ...(this.direction ? this.playing.slice(1) : this.playing.slice(1).reverse())];
      this.pot = this.carry;
      this.carry = 0;
      this.history = [];
      this.result = null;
      for (const seat of this.dealOrder) {
        Object.assign(seat, { cards: [this.deck.pop(), this.deck.pop()], folded: false,
          insolvent: false, action: '待行动', committed: 0, wagered: 0 });
        this.pay(seat, 1);
      }
      this.order = [...this.playing].sort((a, b) => b.cards[0].order - a.cards[0].order || a.id - b.id);
      this.startBetting(1);
      if (this.canRunOut(this.contenders)) this.finishBetting(this.contenders);
    }

    get contenders() { return this.order.filter(seat => !seat.folded); }
    get actor() { return this.pending[0]; }

    pay(seat, amount) {
      if (!Number.isInteger(amount) || amount < 0 || amount > seat.chips) throw Error('无效的下注金额');
      seat.chips -= amount;
      this.pot += amount;
    }

    startBetting(stage) {
      this.stage = stage;
      this.target = 0;
      this.raises = 0;
      this.offer = null;
      this.pending = this.contenders;
      for (const seat of this.pending) {
        seat.committed = 0;
      }
    }

    options() {
      const seat = this.actor;
      if (!seat) return null;
      const due = this.target - seat.committed;
      const contenders = this.contenders;
      const opponent = contenders.find(other => other !== seat);
      const canInitiateAllIn = contenders.length === 2 &&
        (seat.human || !opponent.human || this.round === this.roundLimit);
      const allInTotal = canInitiateAllIn
        ? Math.min(seat.chips + seat.committed, opponent.chips + opponent.committed) : 0;
      const opening = this.target === 0;
      const atRaiseLimit = !opening && this.raises >= raiseLimit;
      const amountLimit = this.roundLimit <= 2 ? 3 : 5;
      return { due, atRaiseLimit, maxRaise: atRaiseLimit ? 0 : Math.min(amountLimit, seat.chips - due),
        allIn: !this.offer && !atRaiseLimit && allInTotal > 0 && allInTotal >= this.target &&
          allInTotal > seat.committed && allInTotal > opponent.committed ? allInTotal : 0,
        offered: Boolean(this.offer), opening };
    }

    act(kind, amount = 0) {
      const seat = this.actor;
      const options = this.options();
      if (!seat) return null;
      let label;
      const advance = this.pending.slice(1);
      this.pending = advance;
      if (kind === 'fold') {
        seat.folded = true;
        label = '弃牌';
      } else if (kind === 'allin' && options.allIn) {
        if (!options.opening) this.raises++;
        this.target = options.allIn;
        this.commit(seat, this.target - seat.committed);
        this.offer = seat;
        this.pending = this.contenders.filter(other => other !== seat);
        label = `梭哈${seat.committed}个币`;
      } else if (kind === 'raise' && !options.offered && amount >= 1 && amount <= options.maxRaise && Number.isInteger(amount)) {
        if (!options.opening) this.raises++;
        this.commit(seat, options.due + amount);
        this.target = seat.committed;
        const index = this.order.indexOf(seat);
        this.pending = [...this.order.slice(index + 1), ...this.order.slice(0, index)]
          .filter(other => !other.folded);
        label = `${options.opening ? '下注' : '加注'}${amount}个币`;
      } else if (kind === 'call' && !options.opening) {
        if (options.due > seat.chips) {
          seat.folded = true;
          seat.insolvent = true;
          label = '代币不足，出局';
        } else {
          this.commit(seat, options.due);
          label = `跟注${options.due}个币`;
        }
      } else {
        this.pending = [seat, ...advance];
        return null;
      }
      seat.action = label;
      const action = { id: seat.id, label };
      this.history.push(action);
      this.checkBetting();
      return action;
    }

    foldSeat(seat, label) {
      if (this.result || seat.folded || !this.playing.includes(seat)) return;
      seat.folded = true;
      seat.action = label;
      this.pending = this.pending.filter(other => other !== seat);
      this.history.push({ id: seat.id, label });
      this.checkBetting();
    }

    checkBetting() {
      const contenders = this.contenders;
      if (contenders.length === 1) this.settle(contenders);
      else if (!this.pending.length || this.canRunOut(contenders)) this.finishBetting(contenders);
    }

    canRunOut(contenders) {
      if (!contenders.every(seat => seat.committed === this.target)) return false;
      return contenders.every(seat => seat.chips === 0) ||
        (contenders.length === 2 && contenders.some(seat => seat.chips === 0));
    }

    finishBetting(contenders) {
      if (this.stage === 1) {
        for (const seat of this.dealOrder) {
          if (!seat.folded) seat.cards.push(this.deck.pop());
        }
        if (!this.canRunOut(contenders)) {
          this.startBetting(2);
          return;
        }
      }
      this.showdown();
    }

    commit(seat, amount) {
      this.pay(seat, amount);
      seat.committed += amount;
      seat.wagered += amount;
    }

    showdown() {
      let best = [-1];
      let winners = [];
      for (const seat of this.contenders) {
        const value = score(seat.cards, this.community, this.hand);
        if (value[0] < 0) continue;
        const difference = compare(value, best);
        if (difference > 0) {
          best = value;
          winners = [seat];
        } else if (!difference) winners.push(seat);
      }
      this.settle(winners, best);
    }

    settle(winners, scoreValue) {
      const pot = this.pot;
      const award = winners.length ? Math.floor(pot / winners.length) : 0;
      const remainder = pot - award * winners.length;
      for (const winner of winners) winner.chips += award;
      const stillIn = this.playing.filter(seat => seat.chips > 0 && !seat.insolvent);
      const eliminated = stillIn.length <= 1 || (!this.multiplayer && !stillIn.some(seat => seat.id === 0));
      const final = this.round === this.roundLimit && this.hand === 8 || eliminated;
      for (const seat of this.playing) {
        if (!stillIn.includes(seat)) seat.out = (this.round - 1) * 8 + this.hand;
      }
      this.carry = final ? 0 : remainder;
      this.pending = [];
      this.result = { winners, award, pot, remainder, final, eliminated, scoreValue, rankings: final ? this.rankings() : [] };
    }

    rankings() {
      const sorted = [...this.seats].sort((a, b) => (b.out ?? Infinity) - (a.out ?? Infinity) || b.chips - a.chips);
      return sorted.map((seat, index) => {
        const tied = sorted.findIndex(other => other.out === seat.out && other.chips === seat.chips);
        return { seat, place: Math.min(index, tied) + 1 };
      });
    }

    next() {
      if (!this.result || this.result.final) return;
      this.hand++;
      if (this.hand === 9) {
        this.round++;
        this.hand = 1;
      }
      this.startHand();
    }

    botView() {
      const seat = this.actor;
      return {
        cards: this.cards, community: this.community, hand: this.hand, round: this.round,
        stage: this.stage, pot: this.pot, history: this.history.slice(),
        options: this.options(), self: { ...seat, cards: seat.cards.slice() },
        others: this.playing.filter(other => other !== seat).map(other => ({
          id: other.id, chips: other.chips, folded: other.folded, face: other.cards[0]
        }))
      };
    }
  }

  function estimateEquity(view) {
    const { self, hand, others, community } = view;
    const exposed = new Set([community, ...self.cards, ...others.map(other => other.face)]);
    const unknown = view.cards.filter(card => !exposed.has(card));
    const opponents = others.filter(other => !other.folded);
    let wins = 0;
    for (let trial = 0; trial < 100; trial++) {
      const sample = shuffle(unknown);
      const own = self.cards.length === 3 ? self.cards : [...self.cards, sample.pop()];
      const value = score(own, community, hand);
      if (value[0] < 0) continue;
      let tied = 1;
      for (const other of opponents) {
        const rival = score([other.face, sample.pop(), sample.pop()], community, hand);
        const difference = compare(value, rival);
        if (difference < 0) { tied = 0; break; }
        if (!difference) tied++;
      }
      if (tied) wins += 1 / tied;
    }
    return wins / 100;
  }

  function botDecision(view) {
    const { options, self, stage, round, pot, others } = view;
    const opponents = others.filter(other => !other.folded);
    const equity = estimateEquity(view);
    const rivalStack = Math.max(...others.map(other => other.chips));
    const behind = self.chips < rivalStack;
    const headsUp = opponents.length === 1;
    const pressure = options.due / Math.max(1, self.chips);
    const potOdds = options.due / Math.max(1, pot + options.due);
    const bluff = self.style !== '稳健' && stage === 1 && pressure < .18 &&
      randomInt(100) < (self.style === '欺骗' ? 27 : 12);
    const urgency = behind ? .03 * round + (self.chips <= 18 ? .08 : 0) : 0;
    const floor = self.style === '稳健' ? (stage === 1 ? .4 : .5)
      : Math.max(1 / (opponents.length + 1) - .11, potOdds + pressure * .16 - urgency, .10);
    if (options.offered) {
      const threshold = Math.max(floor, potOdds + .09 - urgency, .44);
      return [equity >= threshold && options.due <= self.chips ? 'call' : 'fold'];
    }
    const pushThreshold = (self.style === '稳健' ? .82 : .71) - urgency - (stage === 2 ? .05 : 0);
    if (options.allIn && equity >= pushThreshold) return ['allin'];
    if (options.due > self.chips || (equity < floor && !bluff)) return ['fold'];
    const fairShare = 1 / (opponents.length + 1);
    const valueRaise = equity >= Math.max(floor, fairShare + (headsUp ? .1 : .12));
    if (options.maxRaise > 0 && (options.opening || bluff || valueRaise)) {
      const slowPlay = self.style === '综合' && stage === 1 && equity >= .78 && !headsUp;
      const raise = slowPlay ? 1 : bluff || valueRaise ? 5 : Math.ceil(equity * 5);
      return ['raise', Math.min(options.maxRaise, Math.max(1, raise))];
    }
    return [options.opening ? 'fold' : 'call'];
  }

  return { Match, prepare, score, compare, estimateEquity, botDecision, startingStacks: Object.freeze(startingStacks) };
})();

if (typeof module !== 'undefined') module.exports = Rules;
