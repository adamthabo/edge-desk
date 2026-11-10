// POST /desk/book end to end against a fake Kalshi: event check, fresh books, all legs at once, sell-back of a short leg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { worker } from './_load.mjs';

const edPem = nodeCrypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = { DESK_PASSWORD: 'pw', KALSHI_KEY_ID: 'kid', KALSHI_PRIVATE_KEY: edPem, MAX_ORDER_CONTRACTS: '100', MAX_ORDER_DOLLARS: '100' };
const EV = 'KXTEMP-26NOV12';
const T = { LOW: EV + '-LOW', MID: EV + '-MID', HIGH: EV + '-HIGH' };

// Temperature buckets (one must win). YES asks come from NO bids: 28¢ then 31¢ / 33¢ / 30¢.
function world(over) {
  const k = Object.assign({
    event: { event_ticker: EV, series_ticker: 'KXTEMP', mutually_exclusive: true, markets: [
      { ticker: T.LOW, market_type: 'binary', status: 'active', yes_sub_title: '48° or below', strike_type: 'less' },
      { ticker: T.MID, market_type: 'binary', status: 'active', yes_sub_title: '49° to 52°', strike_type: 'between' },
      { ticker: T.HIGH, market_type: 'binary', status: 'active', yes_sub_title: '53° or above', strike_type: 'greater' }] },
    books: {
      [T.LOW]: { yes_dollars: [['0.2600', '40.00']], no_dollars: [['0.7200', '20.00'], ['0.6900', '50.00']] },
      [T.MID]: { yes_dollars: [['0.3100', '40.00']], no_dollars: [['0.6700', '25.00']] },
      [T.HIGH]: { yes_dollars: [['0.2800', '40.00']], no_dollars: [['0.7000', '30.00']] } },
    depth: {}, block: null, orders: [], hosts: [], gets: []
  }, over || {});
  globalThis.fetch = async (url, init) => {
    init = init || {}; const u = new URL(url); const p = u.pathname.replace('/trade-api/v2', ''); const method = init.method || 'GET';
    k.hosts.push(u.host);
    const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json' } });
    if (k.block && u.host === k.block) return new Response('blocked at the edge', { status: 403 });
    if (method === 'GET') k.gets.push(p);
    if (method === 'GET' && p === '/events/' + EV) return json({ event: k.event });
    if (method === 'GET' && p === '/series/KXTEMP') return json({ series: { ticker: 'KXTEMP', fee_multiplier: 1 } });
    let m;
    if (method === 'GET' && (m = /^\/markets\/([^/]+)\/orderbook$/.exec(p))) { const b = k.books[decodeURIComponent(m[1])]; return b ? json({ orderbook_fp: b }) : json({ error: { code: 'not_found' } }, 404); }
    if (method === 'POST' && p === '/portfolio/events/orders') {
      assert.ok(init.headers['KALSHI-ACCESS-SIGNATURE'] && init.headers['KALSHI-ACCESS-KEY'] === 'kid', 'every order is signed');
      assert.match(init.headers['User-Agent'], /Mozilla/, 'same headers as the relay');
      const o = JSON.parse(init.body); k.orders.push(o);
      const count = Number(o.count);
      if (o.reduce_only) return json({ order_id: 'u' + k.orders.length, fill_count: String(count), remaining_count: '0' }, 201);
      const b = k.books[o.ticker];
      // buying YES (bid) meets NO bids; buying NO (ask at the YES price) meets YES bids
      const levels = o.side === 'bid' ? b.no_dollars.map(([pp, s]) => [1 - Number(pp), Number(s)]) : b.yes_dollars.map(([pp, s]) => [Number(pp), Number(s)]);
      let avail = 0; for (const [pp, s] of levels) if (o.side === 'bid' ? pp <= Number(o.price) + 1e-9 : pp >= Number(o.price) - 1e-9) avail += s;
      const fill = Math.min(count, avail, k.depth[o.ticker] === undefined ? Infinity : k.depth[o.ticker]);
      return json({ order_id: 'o' + k.orders.length, fill_count: String(fill), remaining_count: '0', average_fill_price: '0.30' }, 201);
    }
    return json({ error: { code: 'not_found', message: p } }, 404);
  };
  return k;
}
const call = (body, env) => worker.fetch(new Request('https://w.test/desk/book', { method: 'POST', headers: { 'Authorization': 'Bearer pw', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), Object.assign({}, ENV, env || {}), {}).then(async r => ({ status: r.status, body: await r.json() }));
const yesBook = (extra) => Object.assign({ event: EV, side: 'yes', tickers: [T.LOW, T.MID, T.HIGH], maxSets: 100, maxCost: 50, minEdge: 0.005 }, extra || {});

test('clean YES book: fresh books size it, every leg goes out fill-or-cancel at its limit, all fill', async () => {
  const k = world();
  const r = await call(yesBook());
  assert.equal(r.status, 200, JSON.stringify(r.body)); const b = r.body;
  assert.equal(b.sets, 25); assert.equal(b.planned, 25); assert.equal(b.payout, 25); assert.equal(b.unhedged, 0);
  assert.equal(k.orders.length, 3, 'one order per leg, no sell-backs');
  const byT = Object.fromEntries(k.orders.map(o => [o.ticker, o]));
  assert.deepEqual([byT[T.LOW].price, byT[T.MID].price, byT[T.HIGH].price], ['0.31', '0.33', '0.30'], 'each leg at the worst price its size needs');
  assert.ok(k.orders.every(o => o.side === 'bid' && o.count === '25' && o.time_in_force === 'immediate_or_cancel' && !o.reduce_only), 'buy YES, fill-or-cancel');
  assert.equal(new Set(k.orders.map(o => o.client_order_id)).size, 3, 'distinct client ids');
  assert.ok(b.locked > 0.9 && b.locked < 1.0, 'locks about 97¢ (' + b.locked.toFixed(4) + ')');
  assert.ok(k.gets.includes('/events/' + EV) && k.gets.filter(g => /orderbook$/.test(g)).length === 3, 'event and every book read first');
});

test('short leg: the extra contracts on the other legs are sold straight back, reduce-only', async () => {
  const k = world({ depth: { [T.MID]: 10 } });
  const b = (await call(yesBook())).body;
  assert.equal(b.sets, 10, 'complete sets = the shortest leg'); assert.equal(b.planned, 25);
  const sells = k.orders.filter(o => o.reduce_only);
  assert.equal(sells.length, 2, 'two legs had extras');
  assert.ok(sells.every(o => o.side === 'ask' && o.count === '15' && o.time_in_force === 'immediate_or_cancel'), 'sell 15 YES each, fill-or-cancel');
  assert.deepEqual(sells.map(o => o.price).sort(), ['0.23', '0.25'], 'priced 3¢ under the best bid so they fill');
  assert.equal(b.unhedged, 0); assert.equal(b.legs.find(l => l.ticker === T.LOW).sold, 15);
  assert.ok(b.unwindPnl < 0, 'selling back costs a little (' + b.unwindPnl.toFixed(2) + ')');
});

test('refusals: not one-winner, an outcome missing, not exhaustive, lock gone, dry run — and nothing is sent', async () => {
  let k = world(); k.event.mutually_exclusive = false;
  let r = await call(yesBook()); assert.equal(r.status, 409); assert.ok(r.body.gone); assert.match(r.body.error, /not mark this event as one-winner/); assert.equal(k.orders.length, 0);
  k = world(); k.event.markets.push({ ticker: EV + '-X', market_type: 'binary', status: 'active', yes_sub_title: 'Exactly 50°' });
  r = await call(yesBook()); assert.equal(r.status, 409); assert.match(r.body.error, /now has 4 open outcomes/); assert.equal(k.orders.length, 0);
  k = world(); k.event.markets.forEach((m, i) => { m.yes_sub_title = ['Smith', 'Jones', 'Lee'][i]; m.strike_type = ''; });
  r = await call(yesBook()); assert.equal(r.status, 409); assert.match(r.body.error, /not a lock: the listed outcomes are not exhaustive/); assert.equal(k.orders.length, 0);
  k = world(); for (const t of Object.values(T)) k.books[t].no_dollars = [['0.6600', '50.00']];
  r = await call(yesBook()); assert.equal(r.status, 409); assert.match(r.body.error, /the lock is gone: one set costs/); assert.equal(r.body.plan.sets, 0); assert.equal(k.orders.length, 0);
  k = world();
  r = await call(yesBook({ dryRun: true })); assert.equal(r.status, 200); assert.equal(r.body.dryRun, true); assert.equal(r.body.plan.sets, 25); assert.equal(k.orders.length, 0);
});

test('NO book on a one-winner candidate list: buys NO on every leg (asks on the YES book), pays legs − 1', async () => {
  const k = world();
  k.event.markets = ['A', 'B', 'C', 'D'].map(x => ({ ticker: EV + '-' + x, market_type: 'binary', status: 'active', yes_sub_title: 'Candidate ' + x }));
  [0.32, 0.30, 0.28, 0.25].forEach((p, i) => { k.books[EV + '-' + 'ABCD'[i]] = { yes_dollars: [[p.toFixed(4), '40.00']], no_dollars: [['0.5000', '10.00']] }; });
  const b = (await call({ event: EV, side: 'no', tickers: ['A', 'B', 'C', 'D'].map(x => EV + '-' + x), maxSets: 100, maxCost: 200 })).body;
  assert.equal(b.sets, 40); assert.equal(b.payout, 120);
  assert.ok(k.orders.every(o => o.side === 'ask' && !o.reduce_only), 'buy NO = ask on the YES book');
  assert.deepEqual(k.orders.map(o => o.price), ['0.32', '0.30', '0.28', '0.25'], 'at the YES bid each NO meets');
  assert.ok(b.locked > 3 && b.locked < 4, 'about 9¢ a set over 40 sets (' + b.locked.toFixed(2) + ')');
});

test('caps, validation and the second Kalshi host', async () => {
  let k = world();
  let r = await call(yesBook(), { MAX_ORDER_DOLLARS: '5' });
  assert.equal(r.status, 200); assert.equal(r.body.sets, 15, 'the per-order dollar cap binds on the 33¢ leg');
  r = await call(yesBook({ tickers: [T.LOW] })); assert.equal(r.status, 400);
  r = await call(yesBook({ maxCost: 0 })); assert.equal(r.status, 400);
  r = await call(yesBook({ tickers: [T.LOW, T.LOW] })); assert.equal(r.status, 400);
  k = world({ block: 'external-api.kalshi.com' });
  r = await call(yesBook());
  assert.equal(r.status, 200); assert.equal(r.body.sets, 25, 'works through the other host');
  assert.ok(k.hosts.includes('api.elections.kalshi.com') && k.orders.length === 3, 'reads and orders went to api.elections.kalshi.com');
  const wrong = await worker.fetch(new Request('https://w.test/desk/book', { method: 'POST', headers: { 'Authorization': 'Bearer nope', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' }), ENV, {});
  assert.equal(wrong.status, 401);
});
