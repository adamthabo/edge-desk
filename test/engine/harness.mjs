// In-process stand-ins for the Durable Object runtime: SQLite storage, alarms, a fake Kalshi + sharp-lines
// server behind globalThis.fetch, and a clock the tests can move. Lets a whole engine tick run in plain Node.
import { DatabaseSync } from 'node:sqlite';
import nodeCrypto from 'node:crypto';

export function fakeSql() {
  const db = new DatabaseSync(':memory:'); const cache = new Map(); // workerd caches prepared statements too
  const prep = (q) => { let st = cache.get(q); if (!st) { st = db.prepare(q); cache.set(q, st); } return st; };
  const cursor = (rows) => ({ toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  return {
    exec(q, ...params) {
      const p = params.map(v => v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
      if (!p.length && q.split(';').filter(s => s.trim()).length > 1) { db.exec(q); return cursor([]); }
      const stmt = prep(q);
      if (/^\s*(SELECT|WITH)/i.test(q)) return cursor(stmt.all(...p));
      stmt.run(...p); return cursor([]);
    }
  };
}
export function fakeState() {
  let alarm = null;
  return { alarm: () => alarm, storage: { sql: fakeSql(), getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; }, deleteAlarm: async () => { alarm = null; } } };
}
export const edPem = nodeCrypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const dateTag = (ts) => { const d = new Date(ts); return String(d.getUTCFullYear()).slice(2) + MON[d.getUTCMonth()] + String(d.getUTCDate()).padStart(2, '0'); };

// A small world: one NFL slate two hours out. NE is cheap on Kalshi versus the sharp line (taker buy),
// BUF is fairly priced (maker quote), DAL/PHI has a wide spread (maker only), XXX/YYY has no sportsbook line.
export function world(now, kickOffset) {
  const kick = now + (kickOffset === undefined ? 2 * 3600000 : kickOffset); const tag = dateTag(kick);
  const EV1 = 'KXNFLGAME-' + tag + 'NEBUF', EV2 = 'KXNFLGAME-' + tag + 'DALPHI', EV3 = 'KXNFLGAME-' + tag + 'XXXYYY';
  const w = {
    now, kick, EV1, EV2, EV3, oddsCalls: 0, oddsStatus: 200, oddsRemaining: '19000', requests: [], orders: [], resting: [], positions: [], results: {}, ntfy: [], exchangeOpen: true,
    markets: [
      { ticker: EV1 + '-NE', event_ticker: EV1, series_ticker: 'KXNFLGAME', market_type: 'binary', status: 'active', yes_sub_title: 'NE Patriots', yes_bid_dollars: '0.3300', yes_ask_dollars: '0.3500', yes_ask_size_fp: '400.00', yes_bid_size_fp: '300.00' },
      { ticker: EV1 + '-BUF', event_ticker: EV1, series_ticker: 'KXNFLGAME', market_type: 'binary', status: 'active', yes_sub_title: 'BUF Bills', yes_bid_dollars: '0.6000', yes_ask_dollars: '0.6300', yes_ask_size_fp: '400.00', yes_bid_size_fp: '300.00' },
      { ticker: EV2 + '-DAL', event_ticker: EV2, series_ticker: 'KXNFLGAME', market_type: 'binary', status: 'active', yes_sub_title: 'DAL Cowboys', yes_bid_dollars: '0.4000', yes_ask_dollars: '0.5000', yes_ask_size_fp: '50.00', yes_bid_size_fp: '50.00' },
      { ticker: EV2 + '-PHI', event_ticker: EV2, series_ticker: 'KXNFLGAME', market_type: 'binary', status: 'active', yes_sub_title: 'PHI Eagles', yes_bid_dollars: '0.5000', yes_ask_dollars: '0.6000', yes_ask_size_fp: '50.00', yes_bid_size_fp: '50.00' },
      { ticker: EV3 + '-XXX', event_ticker: EV3, series_ticker: 'KXNFLGAME', market_type: 'binary', status: 'active', yes_sub_title: 'XXX Nobodies', yes_bid_dollars: '0.4000', yes_ask_dollars: '0.6000' },
      { ticker: EV3 + '-YYY', event_ticker: EV3, series_ticker: 'KXNFLGAME', market_type: 'binary', status: 'active', yes_sub_title: 'YYY Anybodies', yes_bid_dollars: '0.4000', yes_ask_dollars: '0.6000' }
    ],
    odds: [
      { id: 'e1', sport_key: 'americanfootball_nfl', commence_time: Math.floor(kick / 1000), home_team: 'Buffalo Bills', away_team: 'New England Patriots', bookmakers: [
        { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', last_update: Math.floor(now / 1000), outcomes: [{ name: 'Buffalo Bills', price: 1.62 }, { name: 'New England Patriots', price: 2.45 }] }] },
        { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', last_update: Math.floor(now / 1000), outcomes: [{ name: 'Buffalo Bills', price: 1.57 }, { name: 'New England Patriots', price: 2.50 }] }] }] },
      { id: 'e2', sport_key: 'americanfootball_nfl', commence_time: Math.floor(kick / 1000), home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys', bookmakers: [
        { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', last_update: Math.floor(now / 1000), outcomes: [{ name: 'Philadelphia Eagles', price: 1.83 }, { name: 'Dallas Cowboys', price: 2.05 }] }] }] }
    ],
    setKick(ts) { w.kick = ts; for (const e of w.odds) e.commence_time = Math.floor(ts / 1000); },
    quote(ticker, bid, ask) { const m = w.markets.find(x => x.ticker === ticker); m.yes_bid_dollars = bid.toFixed(4); m.yes_ask_dollars = ask.toFixed(4); },
    market(ticker) { return w.markets.find(x => x.ticker === ticker); }
  };
  return w;
}

// globalThis.fetch replacement routing to the world. Records every request as {method, path, query, body}.
export function installFetch(w) {
  const json = (o, s, h) => new Response(JSON.stringify(o), { status: s || 200, headers: Object.assign({ 'content-type': 'application/json' }, h || {}) });
  globalThis.fetch = async (url, init) => {
    init = init || {}; const u = new URL(url); const method = init.method || 'GET';
    let body = null; if (init.body) { try { body = JSON.parse(init.body); } catch (e) { body = String(init.body); } }
    w.requests.push({ method, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers || {} });
    if (u.host === 'ntfy.sh') { w.ntfy.push({ topic: u.pathname.slice(1), title: init.headers.Title, body: init.body }); return new Response('{}'); }
    const p = u.pathname;
    if (p.startsWith('/v4/sports/')) { w.oddsCalls++; if (w.oddsStatus !== 200) return json({ message: 'down' }, w.oddsStatus, { 'x-requests-remaining': w.oddsRemaining }); return json(w.odds, 200, { 'x-requests-remaining': w.oddsRemaining }); }
    const signed = init.headers['KALSHI-ACCESS-KEY'] && init.headers['KALSHI-ACCESS-SIGNATURE'] && init.headers['KALSHI-ACCESS-TIMESTAMP'];
    if (p === '/trade-api/v2/exchange/status') return json({ exchange_active: true, trading_active: w.exchangeOpen });
    if (p === '/trade-api/v2/markets') {
      const s = u.searchParams.get('series_ticker'), tk = u.searchParams.get('tickers');
      if (tk !== null) {
        if (w.tickersMode === 'other') return json({ markets: [{ ticker: 'KXOTHER-1', event_ticker: 'KXOTHER', status: 'active', yes_bid_dollars: '0.10', yes_ask_dollars: '0.12' }], cursor: '' }); // an API that ignores the filter
        const set = new Set(tk.split(',')); return json({ markets: w.markets.filter(m => set.has(m.ticker)), cursor: '' });
      }
      return json({ markets: w.markets.filter(m => !s || m.series_ticker === s), cursor: '' });
    }
    if (/^\/trade-api\/v2\/markets\/[^/]+$/.test(p)) { const t = decodeURIComponent(p.split('/').pop()); const m = w.market(t); if (!m) return json({ error: { code: 'not_found' } }, 404); return json({ market: Object.assign({}, m, { result: w.results[t] || '' }) }); }
    if (/^\/trade-api\/v2\/series\/[^/]+$/.test(p)) return json({ series: { ticker: 'KXNFLGAME', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } });
    if (p.startsWith('/trade-api/v2/portfolio/')) {
      if (!signed) return json({ error: { code: 'unauthorized', message: 'missing signature' } }, 401);
      if (p.endsWith('/portfolio/balance')) { if (w.balanceStatus && w.balanceStatus !== 200) return json({ error: { code: 'internal_server_error', message: 'balance unavailable' } }, w.balanceStatus); return json({ balance: 50000, balance_dollars: '500.00', portfolio_value: 50000 }); }
      if (p.endsWith('/portfolio/positions')) return json({ market_positions: w.positions, event_positions: [] });
      if (p.endsWith('/portfolio/orders') && method === 'GET') return json({ orders: w.resting, cursor: '' });
      if (p.endsWith('/portfolio/events/orders') && method === 'POST') {
        const o = body; const id = 'ord-' + (w.orders.length + 1); w.orders.push(Object.assign({ order_id: id }, o));
        const m = w.market(o.ticker); const ask = Number(m.yes_ask_dollars), count = Number(o.count), price = Number(o.price);
        const bid = Number(m.yes_bid_dollars);
        if (o.time_in_force === 'immediate_or_cancel') {
          if (o.side === 'bid' && price >= ask) { w.positions.push({ ticker: o.ticker, position_fp: o.count + '.00', market_exposure_dollars: (count * ask).toFixed(2) }); return json({ order_id: id, client_order_id: o.client_order_id, fill_count: String(count), remaining_count: '0', average_fill_price: ask.toFixed(2), average_fee_paid: '0.01', ts_ms: Date.now() }, 201); }
          if (o.side === 'ask' && price <= bid) {
            const pos = w.positions.find(p => p.ticker === o.ticker); const have = pos ? Number(pos.position_fp) : 0; const sold = Math.min(have, count);
            if (sold <= 0) return json({ order_id: id, client_order_id: o.client_order_id, fill_count: '0', remaining_count: '0', ts_ms: Date.now() }, 201);
            pos.position_fp = (have - sold).toFixed(2); if (have - sold <= 0) w.positions = w.positions.filter(p => p !== pos);
            return json({ order_id: id, client_order_id: o.client_order_id, fill_count: String(sold), remaining_count: '0', average_fill_price: bid.toFixed(2), average_fee_paid: '0.01', ts_ms: Date.now() }, 201);
          }
          return json({ order_id: id, client_order_id: o.client_order_id, fill_count: '0', remaining_count: '0', ts_ms: Date.now() }, 201);
        }
        w.resting.push({ order_id: id, ticker: o.ticker, side: 'yes', action: o.side === 'ask' ? 'sell' : 'buy', yes_price_dollars: price.toFixed(4), remaining_count_fp: count.toFixed(2), initial_count_fp: count.toFixed(2), status: 'resting', client_order_id: o.client_order_id });
        return json({ order_id: id, client_order_id: o.client_order_id, fill_count: '0', remaining_count: String(count), ts_ms: Date.now() }, 201);
      }
      if (/\/portfolio\/events\/orders\/[^/]+$/.test(p) && method === 'DELETE') { const id = p.split('/').pop(); const n = w.resting.length; w.resting = w.resting.filter(o => o.order_id !== id); return json({ order_id: id, reduced_by: String(n - w.resting.length) }); }
      if (/\/portfolio\/orders\/[^/]+$/.test(p)) { const id = p.split('/').pop(); const o = w.orders.find(x => x.order_id === id); return json({ order: { order_id: id, status: 'canceled', fill_count_fp: '0.00', yes_price_dollars: o ? o.price : '0' } }); }
    }
    return json({ error: { code: 'not_found', message: p } }, 404);
  };
}

export function env(extra) {
  return Object.assign({ ODDS_API_KEY: 'odds-test', KALSHI_KEY_ID: 'kid-test', KALSHI_PRIVATE_KEY: edPem, DESK_PASSWORD: 'pw', KALSHI_BASE_OVERRIDE: 'http://kalshi.test/trade-api/v2', ODDS_BASE_OVERRIDE: 'http://odds.test', MAX_ORDER_DOLLARS: '100' }, extra || {});
}

// A clock the tests can move; the engine reads Date.now().
export function clock(start) {
  const realNow = Date.now; let t = start;
  Date.now = () => t;
  return { get: () => t, add: (ms) => { t += ms; }, set: (v) => { t = v; }, restore: () => { Date.now = realNow; } };
}
