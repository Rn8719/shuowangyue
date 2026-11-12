'use strict';

const get = id => document.getElementById(id);
const phases = ['新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];
const lines = ['呵呵打的不错哟', '干得漂亮', '差距自己找，重开右上角', 'easy',
  '就这？就这？', '有真人吗？', '别浪费我的流量了好吗'];
const roundNames = ['第一轮', '第二轮', '第三轮', '第四轮'];
const cards = Rules.prepare(typeof cardRows === 'undefined' ? [] : cardRows);
const info = get('info-dialog');
const pauseDialog = get('pause-dialog');
const notebookWindow = get('notebook-window');
const calendarWindow = get('calendar-window');
const noteEditor = get('note-editor');
const createUtterance = window.SpeechSynthesisUtterance ? text => new SpeechSynthesisUtterance(text) : null;
const victoryLine = '都是同龄人，我原本没想降维打击';
let announcementActive = false;
let speechActive = false;
function updateSkipVoice() {
  get('skip-voice').disabled = !announcementActive && !speechActive;
}
const voice = new TableVoice(text => makeSpeechAudio(window.speechSynthesis, createUtterance, text),
  active => { announcementActive = active; updateSkipVoice(); });
const tauntVoice = new TableVoice(text => text === victoryLine
  ? makeVictoryAudio(dealAudio) : makeRecordedAudio(dealAudio, text),
  active => { speechActive = active; updateSkipVoice(); });
let match;
let timer;
let started;
let elapsed;
let warned;
let paused = false;
let lastAnnouncement = '';
let announcing = false;
let pendingAction;
let resultVisible = false;
let championshipVisible = false;
let botTaunts = 0;
let windowLayer = 10;
let notes = '';
let pendingCards = new Set();
let dealing = false;
let activeFlight;
let dealAudio;
let shuffleSound;
let musicBuffer;
let musicSource;
let musicEnabled = true;
const notesKey = 'shuowangyue-notebook';
try { notes = localStorage.getItem(notesKey) ?? ''; } catch {}

function saveNotes(value) {
  notes = value;
  if (noteEditor.value !== notes) noteEditor.value = notes;
  try { localStorage.setItem(notesKey, notes); } catch {}
}

function unlockDealAudio() {
  const Audio = window.AudioContext ?? window.webkitAudioContext;
  if (!Audio) return;
  try {
    if (!dealAudio) {
      dealAudio = new Audio();
      shuffleSound = dealAudio.createBuffer(1, Math.ceil(dealAudio.sampleRate * .09), dealAudio.sampleRate);
      const samples = shuffleSound.getChannelData(0);
      for (let index = 0; index < samples.length; index++) {
        samples[index] = (Math.random() * 2 - 1) * (1 - index / samples.length) ** 2;
      }
    }
    dealAudio.resume().catch(() => {});
  } catch {}
}

function playDealSound() {
  if (paused || !shuffleSound) return;
  const source = dealAudio.createBufferSource();
  const filter = dealAudio.createBiquadFilter();
  const volume = dealAudio.createGain();
  source.buffer = shuffleSound;
  filter.type = 'bandpass';
  filter.frequency.value = 2200;
  volume.gain.value = .22;
  source.connect(filter).connect(volume).connect(dealAudio.destination);
  source.start();
}

function syncMusic() {
  if (!musicEnabled || !match) {
    musicSource?.stop();
    musicSource = null;
    return;
  }
  if (!dealAudio || musicSource) return;
  musicBuffer ??= createTableMusic(dealAudio);
  const source = dealAudio.createBufferSource();
  source.buffer = musicBuffer;
  source.loop = true;
  source.connect(dealAudio.destination);
  source.start();
  musicSource = source;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function moonImage(phase, size = 120) {
  const canvas = element('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const image = context.createImageData(size, size);
  const angle = phase * Math.PI / 4;
  const disc = size * 55 / 120;
  const craters = [[-.48, -.28, .19], [.24, -.36, .23], [.43, .25, .14],
    [-.18, .55, .11], [-.36, .16, .07], [.05, -.08, .11], [.56, -.1, .06]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + .5 - size / 2) / disc;
      const ny = (y + .5 - size / 2) / disc;
      const radius = Math.hypot(nx, ny);
      if (radius > 1) continue;
      const z = Math.sqrt(1 - radius ** 2);
      const sunlight = nx * Math.sin(angle) - z * Math.cos(angle);
      const terrain = Math.sin(nx * 14 + Math.cos(ny * 12)) * Math.sin(ny * 16) +
        Math.cos(nx * 26 + ny * 21) * .4 + Math.sin(x * 51.3 + y * 73.7) * .23;
      let relief = 0;
      for (const [cx, cy, craterRadius] of craters) {
        const distance = Math.hypot(nx - cx, ny - cy) / craterRadius;
        if (distance < 1) relief -= 24 * (1 - distance ** 2);
        else if (distance < 1.18) relief += 14 * (1.18 - distance) / .18;
      }
      const light = Math.min(1, Math.max(0, sunlight * 15 + .18));
      const brightness = 167 + 52 * z + terrain * 19 + relief;
      const offset = (y * size + x) * 4;
      image.data.set([26 + light * brightness, 37 + light * brightness * .86,
        46 + light * brightness * .65, Math.min(255, (1 - radius) * 14000)], offset);
    }
  }
  context.putImageData(image, 0, 0);
  const img = element('img');
  img.src = canvas.toDataURL();
  img.alt = phases[phase];
  return img;
}

function showInfo(...nodes) {
  get('info-content').replaceChildren(...nodes);
  if (!info.open) info.showModal();
}

function addLog(text) {
  const entries = get('log-entries');
  const atEnd = entries.scrollHeight - entries.clientHeight - entries.scrollTop < 20;
  entries.append(element('li', '', text));
  if (atEnd) entries.scrollTop = entries.scrollHeight;
}

function clearLog() {
  get('log-entries').replaceChildren();
}

function announceText(spoken, displayed = spoken, { onStart } = {}) {
  return voice.speak(spoken, () => {
    lastAnnouncement = displayed;
    addLog(displayed);
    onStart?.();
    renderClock();
  });
}

function announceTaunt(speaker, line) {
  return tauntVoice.speak(line, () => addLog(`${speaker}：${line}`));
}

function resetHandTools() {
  saveNotes('');
  clearLog();
  botTaunts = 0;
}

function cardTile(card, label, size = '', slot) {
  const tile = element('div', `card-tile ${size}`);
  if (slot) {
    tile.dataset.dealSlot = slot;
    tile.classList.toggle('awaiting-deal', pendingCards.has(slot));
  }
  const image = element('img', 'card-image');
  image.src = card ? `卡牌/${card.id}_${card.name}.webp` : '卡牌/00_牌背.webp';
  image.alt = card ? card.name : '暗牌牌背';
  if (card) {
    const button = element('button', 'card-button');
    button.type = 'button';
    button.setAttribute('aria-label', `放大${card.name}`);
    button.append(image, element('span', 'card-name', card.name));
    button.onclick = () => {
      const enlarged = image.cloneNode();
      enlarged.className = 'enlarged';
      showInfo(element('h2', '', card.name), enlarged);
    };
    tile.append(button);
  } else tile.append(image);
  if (label) tile.append(element('span', 'card-label', label));
  return tile;
}

const handSlot = (seat, index) => `${seat.id}-${index}`;

function openingDeal() {
  return ['community', ...match.dealOrder.flatMap(seat => [handSlot(seat, 0), handSlot(seat, 1)]),
    ...match.dealOrder.filter(seat => seat.cards.length === 3).map(seat => handSlot(seat, 2))];
}

async function animateDeal(slots, currentMatch) {
  dealing = true;
  renderClock();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const slot of slots) {
    if (match !== currentMatch) return;
    const tile = document.querySelector(`[data-deal-slot="${slot}"]`);
    if (!tile) continue;
    const cardRect = tile.querySelector('img').getBoundingClientRect();
    const table = get('public-cards').closest('.table-area').getBoundingClientRect();
    const flyer = element('img', 'flying-card');
    flyer.alt = '';
    flyer.src = '卡牌/00_牌背.webp';
    Object.assign(flyer.style, { left: `${cardRect.left}px`, top: `${cardRect.top}px`,
      width: `${cardRect.width}px`, height: `${cardRect.height}px` });
    document.body.append(flyer);
    const dx = table.left + table.width / 2 - cardRect.left - cardRect.width / 2;
    const dy = table.top + table.height / 2 - cardRect.top - cardRect.height / 2;
    playDealSound();
    if (flyer.animate) {
      activeFlight = flyer.animate(reducedMotion
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ transform: `translate(${dx}px, ${dy}px) rotate(-12deg)` }, { transform: 'none' }],
      { duration: reducedMotion ? 95 : 180, easing: 'ease-out' });
      if (paused) activeFlight.pause();
      try { await activeFlight.finished; } catch {}
    }
    flyer.remove();
    if (match !== currentMatch) return;
    activeFlight = null;
    pendingCards.delete(slot);
    tile.classList.remove('awaiting-deal');
  }
  pendingCards.clear();
  dealing = false;
}

function wagerPile(amount, direction) {
  const pile = element('div', `chip-pile chip-pile-${direction}`);
  pile.setAttribute('role', 'img');
  pile.setAttribute('aria-label', `本局已下注 ${amount} 枚代币`);
  pile.title = `本局已下注 ${amount} 枚代币`;
  const columns = Math.min(amount, 6);
  const step = Math.min(2.3, 14 / Math.max(1, Math.ceil(amount / columns) - 1));
  for (let column = 0; column < columns; column++) {
    const stack = element('span', 'chip-column');
    for (let index = column, layer = 0; index < amount; index += columns, layer++) {
      const token = element('span', 'moon-chip');
      token.style.bottom = `${layer * step}px`;
      stack.append(token);
    }
    pile.append(stack);
  }
  return pile;
}

function renderSeats() {
  const seats = match.playing.map((seat, index) => {
    const item = element('article', 'seat');
    const angle = Math.PI / 2 + index * 2 * Math.PI / match.playing.length;
    item.style.left = `${50 + 40 * Math.cos(angle)}%`;
    item.style.top = `${50 + 35 * Math.sin(angle)}%`;
    const active = !announcing && match.actor === seat;
    item.classList.toggle('active', active);
    item.classList.toggle('folded', seat.folded);
    item.classList.toggle('out', Boolean(seat.out));
    const action = pendingAction?.id === seat.id ? pendingAction.previous
      : seat.out ? 'OUT · 出局' : active ? '行动中' : seat.action;
    item.append(element('strong', '', seat.name),
      element('span', 'seat-action', action),
      element('span', 'stack', `☾ ${seat.chips}`));
    if (seat.id) {
      const hand = element('div', 'cards seat-cards');
      hand.append(cardTile(seat.cards[0], '', 'small', handSlot(seat, 0)),
        ...seat.cards.slice(1).map((_, index) => cardTile(null, '', 'small', handSlot(seat, index + 1))));
      item.append(hand);
    }
    if (seat.wagered) {
      const horizontal = Math.cos(angle);
      const direction = horizontal < -.28 ? 'right' : horizontal > .28 ? 'left' : Math.sin(angle) > 0 ? 'top' : 'bottom';
      item.append(wagerPile(seat.wagered, direction));
    }
    return item;
  });
  get('seats').replaceChildren(...seats);
}

function renderResult() {
  const panel = get('result');
  panel.hidden = !match.result || !resultVisible;
  panel.replaceChildren();
  if (panel.hidden) return;
  const { winners, award, remainder, final, rankings, scoreValue } = match.result;
  if (final && championshipVisible) {
    const champions = rankings.filter(entry => entry.place === 1);
    const championship = element('section', 'championship');
    const picture = element('img', 'championship-picture');
    picture.src = '录音/胜利配图.jpg';
    picture.alt = '';
    championship.append(picture, element('h3', '', `总冠军 · ${champions.map(({ seat }) => seat.name).join('、')}`));
    panel.append(championship);
  }
  const title = winners.length ? `${winners.map(winner => winner.name).join('、')}获胜` : '本局无人获胜';
  panel.append(element('h2', '', title));
  if (winners.length) {
    panel.append(element('p', 'award', `${winners.length > 1 ? '每位获得' : '获得'} ${award} 枚代币`));
  }
  const revealed = scoreValue ? [...winners, ...match.contenders.filter(seat => !winners.includes(seat))] : winners;
  if (revealed.length) {
    const hands = element('div', 'winner-hands');
    for (const seat of revealed) {
      const row = element('div', 'winner-hand');
      const tiles = element('div', 'cards');
      tiles.append(...seat.cards.map((card, index) => cardTile(card, index ? '暗牌' : '明牌')));
      const won = winners.includes(seat);
      row.classList.toggle('won', won);
      row.append(element('strong', '', `${seat.name} · ${won ? '获胜' : '未获胜'}`), tiles);
      hands.append(row);
    }
    panel.append(hands);
  }
  if (remainder && !final) panel.append(element('p', '', `${remainder} 枚代币顺延至下一局`));
  if (final) {
    const playerRank = rankings.find(entry => entry.seat.id === 0);
    panel.append(element('h3', '', `游戏结束 · 你的排名第 ${playerRank.place} 名`));
    const standings = element('div', 'standings');
    standings.append(...rankings.map(({ seat, place }) =>
      element('span', '', `第 ${place} 名 · ${seat.name} · ☾ ${seat.chips}`)));
    panel.append(standings);
  }
  const next = element('button', 'primary', final ? '返回开局' : '下一局');
  next.disabled = announcing;
  next.onclick = () => {
    if (final) return exit();
    unlockDealAudio();
    tauntVoice.reset();
    match.next();
    resetHandTools();
    lastAnnouncement = '';
    return announceTransition(null, openingDeal());
  };
  panel.append(next);
}

function renderControls() {
  const yourTurn = !announcing && match.actor?.id === 0;
  const options = yourTurn ? match.options() : null;
  const amount = get('raise-amount');
  const raiseAvailable = Boolean(options && !options.offered && options.maxRaise > 0);
  for (const option of amount.options) option.disabled = Number(option.value) > (options?.maxRaise ?? 0);
  if (raiseAvailable && Number(amount.value) > options.maxRaise) amount.value = String(options.maxRaise);
  amount.disabled = !raiseAvailable;
  get('raise').disabled = !raiseAvailable;
  get('raise').textContent = options?.opening ? '下注' : options?.atRaiseLimit ? '加注已满' : '加注';
  get('call').disabled = !options || options.opening;
  get('call').textContent = options && !options.opening
    ? options.offered ? `接受梭哈 ${options.due} 币` : options.due > match.actor.chips
      ? '跟注（代币不足）' : `跟注 ${options.due} 币`
    : '跟注';
  get('fold').disabled = !yourTurn;
  get('allin').disabled = !options?.allIn;
  get('speak').disabled = Boolean(match.result?.final);
}

function render() {
  get('round-label').textContent = roundNames[match.round - 1];
  get('hand-label').textContent = `第 ${match.hand}/8 局`;
  [...get('moon-track').children].forEach((node, index) => {
    if (index + 1 === match.hand) node.setAttribute('aria-current', 'step');
    else node.removeAttribute('aria-current');
  });
  const player = match.seats[0];
  get('player-chips').textContent = `☾ ${player.chips} 枚`;
  get('player-cards').replaceChildren(cardTile(player.cards[0], '明牌', '', handSlot(player, 0)),
    ...player.cards.slice(1).map((card, index) => cardTile(card, `暗牌 ${index + 1}`, '', handSlot(player, index + 1))));
  get('public-cards').replaceChildren(cardTile(match.community, '公共牌', '', 'community'));
  get('pot').textContent = `${match.result ? '本局底池' : '底池'} ☾ ${match.pot}`;
  renderSeats();
  renderResult();
  renderControls();
  renderClock();
}

function renderClock() {
  const status = get('turn-status');
  status.replaceChildren();
  if (lastAnnouncement) status.append(element('span', 'last-action', lastAnnouncement));
  if (announcing) {
    status.append(element('strong', '', dealing ? '正在发牌' : '正在播报'));
    return;
  }
  const actor = match?.actor;
  if (!actor) return;
  status.append(element('strong', '', actor.id ? `${actor.name}行动中` : '轮到你行动'));
  if (actor.id) return;
  status.append(element('span', 'clock'));
  updateClockDisplay();
}

function updateClockDisplay() {
  const clock = get('turn-status').querySelector('.clock');
  if (!clock || !match?.actor) return;
  const remaining = Math.max(0, Math.ceil((playerTurnTime - elapsed) / 1000));
  const warning = remaining <= 10;
  clock.textContent = `剩余 ${remaining} 秒`;
  clock.classList.toggle('urgent', warning);
  if (warning && !warned && !paused && remaining > 0) {
    warned = true;
    announceText('还剩十秒');
  }
}

const playerTurnTime = 120000;

function stopClock() {
  clearInterval(timer);
  clearTimeout(timer);
}

function startClock() {
  stopClock();
  elapsed = 0;
  warned = false;
  if (!match.actor) return;
  resumeClock();
  updateClockDisplay();
}

function resumeClock() {
  if (paused || announcing || !match?.actor) return;
  const actor = match.actor;
  if (actor.id) {
    timer = setTimeout(() => {
      if (!paused && !announcing && match?.actor === actor) perform(...Rules.botDecision(match.botView()));
    }, 0);
    return;
  }
  started = performance.now() - elapsed;
  timer = setInterval(() => {
    elapsed = performance.now() - started;
    updateClockDisplay();
    if (elapsed >= playerTurnTime) perform('fold');
  }, 100);
}

async function perform(kind, amount) {
  if (paused || announcing || !match?.actor) return;
  const previous = match.actor.action;
  const firstBetting = match.stage === 1;
  const action = match.act(kind, amount);
  if (!action) return;
  const seat = match.seats[action.id];
  pendingAction = { id: seat.id, previous };
  const slots = firstBetting ? match.dealOrder.filter(player => player.cards.length === 3)
    .map(player => handSlot(player, 2)) : [];
  const taunt = seat.id && !match.result && botTaunts < 3 && Math.random() < .2
    ? { speaker: seat.name, line: lines[Math.floor(Math.random() * lines.length)] } : null;
  if (taunt) botTaunts++;
  await announceTransition({ spoken: `${seat.name}，${action.label}`, displayed: `${seat.name}${action.label}` }, slots, taunt);
}

async function announceTransition(action, slots, taunt) {
  const currentMatch = match;
  stopClock();
  announcing = true;
  resultVisible = false;
  championshipVisible = false;
  pendingCards = new Set(slots);
  dealing = slots.length > 0 && !action;
  elapsed = 0;
  warned = false;
  render();
  if (action) {
    const announcement = announceText(action.spoken, action.displayed, { onStart() {
      pendingAction = null;
      renderSeats();
    } });
    if (taunt) announceTaunt(taunt.speaker, taunt.line);
    await announcement;
  }
  if (match !== currentMatch) return;
  if (slots.length) {
    await animateDeal(slots, currentMatch);
    if (match !== currentMatch) return;
    render();
  }
  if (match.result) {
    const names = match.result.winners.map(winner => winner.name).join('、');
    const outcome = names ? `${names}获胜，获得${match.result.award}枚代币` : '本局无人获胜';
    await announceText(outcome, outcome, { onStart() {
      resultVisible = true;
      renderResult();
    } });
    if (match !== currentMatch) return;
    if (match.result.final) {
      tauntVoice.reset();
      await tauntVoice.speak(victoryLine, () => {
        championshipVisible = true;
        addLog(victoryLine);
        renderResult();
        get('result').scrollTop = 0;
      });
      if (match !== currentMatch) return;
    }
  }
  announcing = false;
  render();
  startClock();
}

function start() {
  stopClock();
  activeFlight?.cancel();
  activeFlight = null;
  unlockDealAudio();
  voice.reset();
  tauntVoice.reset();
  pendingAction = null;
  match = new Rules.Match(cards, Number(get('player-count').value));
  syncMusic();
  paused = false;
  resetHandTools();
  elapsed = 0;
  warned = false;
  lastAnnouncement = '';
  get('lobby').hidden = true;
  get('game').hidden = false;
  return announceTransition(null, openingDeal());
}

function exit() {
  stopClock();
  activeFlight?.cancel();
  activeFlight = null;
  voice.reset();
  tauntVoice.reset();
  for (const panel of [pauseDialog, notebookWindow, calendarWindow, info]) {
    if (panel.open) panel.close();
  }
  paused = false;
  get('pause-shade').hidden = true;
  get('game').inert = false;
  get('game').hidden = true;
  get('lobby').hidden = false;
  match = null;
  syncMusic();
}

get('moon-track').append(...phases.map((_, index) => {
  const frame = element('div', 'moon');
  frame.append(moonImage(index));
  return frame;
}));
document.body.style.setProperty('--moon-art', `url("${moonImage(4, 680).src}")`);
get('start-game').disabled = cards.length !== 36;
if (cards.length !== 36) {
  get('load-error').textContent = '未能载入完整的 36 张牌。';
  get('load-error').hidden = false;
}
get('start-game').onclick = get('restart').onclick = start;
get('exit').onclick = exit;
for (const action of ['call', 'fold', 'allin', 'raise']) {
  get(action).onclick = () => {
    if (match.actor?.id === 0) perform(action, Number(get('raise-amount').value));
  };
}
function populateCalendar() {
  const columns = get('calendar-content');
  for (const [type, heading] of [['节气', '二十四节气'], ['节日', '十二传统节日']]) {
    const section = element('section');
    section.append(element('h3', '', heading));
    for (const card of cards.filter(card => card.type === type)) {
      const row = element('div', 'date-row');
      row.append(element('span', '', card.name), element('time', '', card.dateLabel));
      section.append(row);
    }
    columns.append(section);
  }
}

function bringForward(panel) {
  panel.style.zIndex = String(++windowLayer);
}

function openWindow(panel) {
  if (!panel.open) panel.show();
  bringForward(panel);
  keepOnScreen(panel);
}

function positionWindow(panel, left, top) {
  const { width, height } = panel.getBoundingClientRect();
  const x = Math.max(0, Math.min(left, document.documentElement.clientWidth - width));
  const y = Math.max(0, Math.min(top, document.documentElement.clientHeight - height));
  Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
}

function keepOnScreen(panel) {
  const { left, top, right, bottom } = panel.getBoundingClientRect();
  if (left < 0 || top < 0 || right > document.documentElement.clientWidth ||
      bottom > document.documentElement.clientHeight) positionWindow(panel, left, top);
}

function enableDrag(panel) {
  const handle = panel.querySelector('[data-drag]');
  let drag;
  panel.addEventListener('pointerdown', () => bringForward(panel));
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const { left, top } = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - left, y: event.clientY - top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) positionWindow(panel, event.clientX - drag.x, event.clientY - drag.y);
  });
  handle.addEventListener('lostpointercapture', () => { drag = null; });
}

const floatingWindows = [pauseDialog, notebookWindow, calendarWindow];
floatingWindows.forEach(enableDrag);
window.addEventListener('resize', () => floatingWindows.filter(panel => panel.open).forEach(keepOnScreen));
populateCalendar();
noteEditor.value = notes;
noteEditor.oninput = () => saveNotes(noteEditor.value);
get('calendar').onclick = get('pause-calendar').onclick = get('notebook-both').onclick = () => openWindow(calendarWindow);
get('notebook').onclick = get('pause-notebook').onclick = get('calendar-both').onclick = () => openWindow(notebookWindow);
get('notebook-switch').onclick = () => { notebookWindow.close(); openWindow(calendarWindow); };
get('calendar-switch').onclick = () => { calendarWindow.close(); openWindow(notebookWindow); };
get('clear-log').onclick = clearLog;
get('skip-voice').onclick = () => (announcementActive ? voice : tauntVoice).skip();
get('speak').onclick = () => {
  const choices = element('div', 'speech-lines');
  for (const line of lines) {
    const button = element('button', '', line);
    button.onclick = () => { announceTaunt('玩家', line); info.close(); };
    choices.append(button);
  }
  showInfo(element('h2', '', '发言'), choices);
};
get('music').onclick = get('pause-music').onclick = () => {
  musicEnabled = !musicEnabled;
  for (const id of ['music', 'pause-music']) {
    get(id).textContent = musicEnabled ? '音乐：开' : '音乐：关';
    get(id).setAttribute('aria-pressed', String(musicEnabled));
  }
  if (musicEnabled) unlockDealAudio();
  syncMusic();
};
get('pause').onclick = () => {
  if (paused || !match) return;
  paused = true;
  if (match.actor?.id === 0 && !announcing) elapsed = performance.now() - started;
  stopClock();
  activeFlight?.pause();
  voice.pause();
  tauntVoice.pause();
  if (info.open) info.close();
  get('game').inert = true;
  get('pause-shade').hidden = false;
  openWindow(pauseDialog);
};
pauseDialog.addEventListener('cancel', event => event.preventDefault());
get('resume').onclick = () => {
  if (!paused) return;
  pauseDialog.close();
  paused = false;
  get('game').inert = false;
  get('pause-shade').hidden = true;
  activeFlight?.play();
  voice.resume();
  tauntVoice.resume();
  resumeClock();
};
document.addEventListener('keydown', event => {
  if (!match || event.code !== 'Space' || event.isComposing ||
      event.target.closest('textarea, input, select, [contenteditable]')) return;
  event.preventDefault();
  if (event.repeat) return;
  get(paused ? 'resume' : 'pause').click();
});
