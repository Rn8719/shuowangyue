'use strict';

(() => {
  const hosting = document.querySelector('meta[name="friend-server"]');
  if (!hosting) return;
  get('mode-menu').hidden = false;
  get('lobby').hidden = true;
  get('single-title').textContent = '人机对战';
  get('single-back').hidden = false;
  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('room') ?? '';
  const codePattern = /^[0-9]{6}$/;
  const endpoint = hosting.content.replace(/\/$/, '');
  const storageKey = 'shuowangyue-friend-seat';
  const cardById = new Map(cards.map(card => [card.id, card]));
  const hint = get('online-message');
  let session;
  let state;
  let polling;
  let clock;
  let networkBusy = false;
  let pendingCommand;
  let busy = false;
  let previousHand;
  let historyLength;
  let previousResult;
  let generation = 0;

  function saveSeat(seat, code = seat?.code) {
    try {
      if (seat) {
        sessionStorage.setItem(storageKey, JSON.stringify(seat));
        localStorage.setItem(`${storageKey}:${code}`, JSON.stringify(seat));
      } else {
        sessionStorage.removeItem(storageKey);
        if (code) localStorage.removeItem(`${storageKey}:${code}`);
      }
    } catch {}
  }

  function showLobby() {
    get('mode-menu').hidden = true;
    get('lobby').hidden = true;
    get('online-lobby').hidden = false;
    get('online-entry').hidden = Boolean(session);
    get('online-room').hidden = !session;
  }

  function returnHome() {
    generation++;
    clearInterval(polling);
    clearInterval(clock);
    onlineMatch = null;
    saveSeat(null, session?.code);
    session = state = null;
    busy = networkBusy = false;
    pendingCommand = null;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    get('online-lobby').hidden = true;
    get('online-manage').hidden = true;
    get('pause').hidden = get('restart').hidden = false;
    get('player-chips').previousElementSibling.textContent = '玩家';
    exit();
    get('lobby').hidden = true;
    get('mode-menu').hidden = false;
  }

  async function leave() {
    if (!session) return returnHome();
    if (busy) return;
    busy = true;
    pendingCommand = null;
    const epoch = generation;
    try {
      await request('leave');
      if (epoch === generation) returnHome();
    } catch (error) {
      if (epoch !== generation) return;
      if (error.revoked) returnHome();
      else report(Error('退出未确认，请检查网络后重试'));
    } finally {
      if (epoch === generation) busy = false;
    }
  }

  async function request(operation, body = {}, code = session?.code) {
    if (location.protocol === 'file:' && !endpoint) throw Error('请通过联机服务打开游戏，见联机说明。');
    const response = await fetch(`${endpoint}/api/${operation}${code ? '/' + code : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    const data = await response.json().catch(() => null);
    if (response.status === 403) {
      const error = Error(data?.error ?? '座位已失效');
      error.revoked = true;
      throw error;
    }
    if (!response.ok || !data) throw Error(data?.error ?? '无法连接好友房服务');
    return data;
  }

  function roomMembers(target) {
    target.replaceChildren();
    for (const member of state.members) {
      const row = element('li', '', `${member.name}${member.id === state.host ? '（房主）' : ''}${member.connected ? '' : ' · 已掉线'} `);
      if (state.you === state.host && member.id !== state.you) {
        const kick = element('button', '', '移出');
        kick.onclick = () => {
          if (info.open) info.close();
          send('kick', { member: member.id });
        };
        row.append(kick);
      }
      target.append(row);
    }
  }

  function showState(snapshot) {
    if (snapshot.code !== session.code) {
      try { localStorage.removeItem(`${storageKey}:${session.code}`); } catch {}
      session.code = snapshot.code;
      saveSeat(session);
      const url = new URL(location.href);
      url.searchParams.set('room', session.code);
      history.replaceState(null, '', url);
    }
    state = snapshot;
    if (!state.game) {
      get('online-room-code').textContent = `房间码 ${state.code} · ${state.count} 人桌 · ${state.rounds} 轮`;
      roomMembers(get('online-members'));
      const start = get('online-start');
      start.hidden = state.you !== state.host;
      get('online-rename').hidden = state.you !== state.host;
      start.disabled = state.members.filter(member => member.connected).length < 2;
      return;
    }
    const data = state.game;
    const first = !onlineMatch;
    if (first) {
      unlockDealAudio();
      get('online-lobby').hidden = true;
      get('game').hidden = false;
      get('online-manage').hidden = false;
      get('pause').hidden = get('restart').hidden = true;
      clock = setInterval(updateClockDisplay, 250);
    }
    onlineMatch = { self: data.self, deadline: Date.now() + (data.deadline - data.now), offline: false, send, leave };
    const seats = data.seats.map(seat => ({ ...seat, cards: seat.cards.map(id => cardById.get(id) ?? null) }));
    const result = data.result;
    match = { ...data, seats, community: cardById.get(data.community),
      playing: data.playing.map(id => seats[id]), contenders: data.contenders.map(id => seats[id]),
      actor: seats[data.actor], options: () => data.options,
      result: result ? { ...result, winners: result.winners.map(id => seats[id]),
        rankings: result.rankings.map(({ id, place }) => ({ seat: seats[id], place })) } : null };
    if (first) syncMusic();
    const handKey = `${data.round}/${data.hand}`;
    if (handKey !== previousHand) {
      resetHandTools();
      lastAnnouncement = '';
      historyLength = 0;
      previousResult = false;
      previousHand = handKey;
    }
    if (data.history.length > historyLength) {
      for (const entry of data.history.slice(historyLength)) {
        lastAnnouncement = `${seats[entry.id].name}${entry.label}`;
        addLog(lastAnnouncement);
      }
      if (!first) {
        voice.reset();
        voice.speak(lastAnnouncement);
      }
      historyLength = data.history.length;
    }
    if (!previousResult && result?.final) tauntVoice.speak(victoryLine);
    previousResult = Boolean(result);
    resultVisible = Boolean(result);
    championshipVisible = Boolean(result?.final);
    announcing = false;
    pendingAction = null;
    get('player-chips').previousElementSibling.textContent = seats[data.self].name;
    render();
  }

  function report(error) {
    if (error.revoked) {
      returnHome();
      showLobby();
    } else if (onlineMatch) {
      addLog(error.message);
      return;
    }
    hint.textContent = error.message;
  }

  async function send(operation, body = {}) {
    if (!session || busy) return;
    const serial = state?.game?.serial;
    if (networkBusy) {
      if (operation !== 'state' && !pendingCommand) pendingCommand = { operation, body, serial };
      return;
    }
    networkBusy = true;
    const epoch = generation;
    try {
      const snapshot = await request(operation, { ...body, serial });
      if (epoch === generation && !busy) showState(snapshot);
    } catch (error) {
      if (epoch !== generation) return;
      if (operation === 'state' && onlineMatch && !error.revoked) {
        onlineMatch.offline = true;
        renderControls();
        renderClock();
      } else report(error);
    } finally {
      if (epoch === generation) {
        networkBusy = false;
        const queued = pendingCommand;
        pendingCommand = null;
        if (queued && queued.serial === state?.game?.serial) send(queued.operation, queued.body);
      }
    }
  }

  function connect(seat) {
    session = seat;
    saveSeat(seat);
    const url = new URL(location.href);
    url.searchParams.set('room', seat.code);
    history.replaceState(null, '', url);
    previousHand = null;
    showLobby();
    send('state');
    clearInterval(polling);
    polling = setInterval(() => send('state'), 550);
  }

  async function enter(operation) {
    if (busy || session) return;
    busy = true;
    const epoch = generation;
    try {
      const code = get('online-code').value.trim();
      if (!codePattern.test(code)) throw Error('请输入六位数字房间号');
      unlockDealAudio();
      const seat = await request(operation, {
        name: get('online-name').value, code,
        count: Number(get('online-count').value), rounds: Number(get('online-rounds').value)
      }, operation === 'join' ? code : undefined);
      if (epoch !== generation) return;
      busy = false;
      hint.textContent = '';
      connect(seat);
    } catch (error) {
      if (epoch === generation) report(error);
    } finally {
      if (epoch === generation) busy = false;
    }
  }

  get('online-open').onclick = showLobby;
  get('single-open').onclick = () => {
    get('mode-menu').hidden = true;
    get('lobby').hidden = false;
  };
  get('single-back').onclick = () => {
    get('lobby').hidden = true;
    get('mode-menu').hidden = false;
  };
  get('online-back').onclick = leave;
  get('online-create').onclick = () => enter('create');
  get('online-join').onclick = () => enter('join');
  get('online-start').onclick = () => send('start');
  function renameRoom() {
    const code = window.prompt('输入新的六位数字房间号', state.code)?.trim();
    if (code === undefined) return;
    if (!codePattern.test(code)) {
      report(Error('房间号必须是六位数字'));
      return;
    }
    if (info.open) info.close();
    hint.textContent = '';
    send('rename', { code });
  }
  get('online-rename').onclick = renameRoom;
  get('online-manage').onclick = () => {
    const members = element('ul');
    roomMembers(members);
    const heading = element('h2', '', `房间 ${state.code}`);
    if (state.you !== state.host) return showInfo(heading, members);
    const rename = element('button', '', '修改房间号');
    rename.onclick = renameRoom;
    showInfo(heading, members, rename);
  };
  get('online-copy').onclick = async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', session.code);
    try { await navigator.clipboard.writeText(url.href); hint.textContent = '邀请链接已复制'; }
    catch { hint.replaceChildren(element('a', '', url.href)); hint.firstChild.href = url.href; }
  };
  if (codePattern.test(inviteCode)) {
    get('online-code').value = inviteCode;
    showLobby();
  }
  try {
    const seat = JSON.parse(inviteCode ? localStorage.getItem(`${storageKey}:${inviteCode}`) ??
      sessionStorage.getItem(storageKey) : sessionStorage.getItem(storageKey));
    if (codePattern.test(seat?.code) && (!inviteCode || seat.code === inviteCode)) connect(seat);
  } catch {}
})();
