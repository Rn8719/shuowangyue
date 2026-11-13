const deck = Rules.prepare(cardRows);
const cardMap = new Map(deck.map(card => [card.id, card]));
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', jpg: 'image/jpeg', webp: 'image/webp' };

function serialize(lobby) {
  return JSON.stringify([...lobby.rooms.values()].map(room => {
    const game = room.game;
    return { ...room, members: [...room.members], game: game ? {
      ...game, cards: undefined, deck: game.deck.map(card => card.id), community: game.community.id,
      seats: game.seats.map(seat => ({ ...seat, cards: seat.cards.map(card => card.id) })),
      playing: game.playing.map(seat => seat.id), pending: game.pending.map(seat => seat.id),
      order: game.order.map(seat => seat.id), dealOrder: game.dealOrder.map(seat => seat.id),
      offer: game.offer?.id ?? null, result: game.result ? {
        ...game.result, winners: game.result.winners.map(seat => seat.id),
        rankings: game.result.rankings.map(({ seat, place }) => ({ id: seat.id, place }))
      } : null
    } : null };
  }));
}

function restore(payload) {
  const lobby = new Lobby(deck);
  for (const room of JSON.parse(payload)) {
    room.members = new Map(room.members);
    if (room.game) {
      const game = Object.assign(Object.create(Rules.Match.prototype), room.game);
      game.cards = deck;
      game.deck = game.deck.map(id => cardMap.get(id));
      game.community = cardMap.get(game.community);
      for (const seat of game.seats) seat.cards = seat.cards.map(id => cardMap.get(id));
      for (const key of ['playing', 'pending', 'order', 'dealOrder']) game[key] = game[key].map(id => game.seats[id]);
      game.offer = game.offer === null ? null : game.seats[game.offer];
      if (game.result) {
        game.result.winners = game.result.winners.map(id => game.seats[id]);
        game.result.rankings = game.result.rankings.map(({ id, place }) => ({ seat: game.seats[id], place }));
      }
      room.game = game;
    }
    lobby.rooms.set(room.code, room);
    for (const token of room.members.keys()) lobby.seatRooms.set(token, room);
  }
  return lobby;
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function handleApi(request, url, db) {
  if (request.method !== 'POST') return json({ error: '无效的请求方式' }, 405);
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4096) { await reader.cancel(); return json({ error: '请求过大' }, 413); }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  }
  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch { return json({ error: '无效的请求' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: '无效的请求' }, 400);
  const [, , operation, code] = url.pathname.split('/');
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await db.prepare('SELECT revision, payload FROM friend_state WHERE id = 1').first();
    const lobby = restore(row?.payload ?? '[]');
    lobby.tick();
    let result;
    try {
      result = operation === 'create' ? lobby.create(body.name, body.count, body.rounds, body.code)
        : operation === 'join' ? lobby.join(code, body.name) : lobby.request(code, token, operation, body);
    } catch (error) { return json({ error: error.message }, 400); }
    if (result === null) return json({ error: '座位已失效或已被移出房间' }, 403);
    const payload = serialize(lobby);
    const saved = row
      ? await db.prepare('UPDATE friend_state SET revision = revision + 1, payload = ? WHERE id = 1 AND revision = ?')
        .bind(payload, row.revision).run()
      : await db.prepare('INSERT OR IGNORE INTO friend_state VALUES (1, 0, ?)').bind(payload).run();
    if (saved.meta.changes === 1) return json(result);
  }
  return json({ error: '房间正在同步，请稍后再试' }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, url, env.DB); }
      catch (error) {
        console.error(error);
        return json({ error: '联机服务暂时无法连接' }, 503);
      }
    }
    let file;
    try { file = decodeURIComponent(url.pathname.slice(1)) || 'index.html'; }
    catch { return new Response(null, { status: 400 }); }
    if (!['GET', 'HEAD'].includes(request.method) || !Object.hasOwn(ASSETS, file)) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(ASSETS[file]), char => char.charCodeAt(0)), {
      headers: { 'Content-Type': mime[file.split('.').pop()], 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': file === 'index.html' ? 'no-cache' : 'public, max-age=300' }
    });
  }
};
