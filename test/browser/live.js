// Exercises the LIVE code path against a fake same-origin Kalshi relay that speaks the current API format.
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.EDGE_DESK_ROOT || path.resolve(__dirname, '..', '..');
const ED = require(path.join(ROOT, 'src', 'core.js'));
const html = fs.readFileSync(path.join(ROOT, 'edge-desk.html'), 'utf8');
const sim = ED.SIM.create(11);
const ORIGIN = 'https://edge-desk.test.workers.dev';
const iso = (t) => new Date(t).toISOString();
const d4 = (v) => v.toFixed(4);
const f2 = (v) => v.toFixed(2);
function rawMarket(m, full) {
  const o = { ticker: m.ticker, event_ticker: m.event, market_type: 'binary', title: m.title, yes_sub_title: m.yesSub, no_sub_title: '', status: 'active', open_time: iso(m.open), close_time: iso(m.close), latest_expiration_time: iso(m.exp),
    yes_bid_dollars: d4(m.yb), yes_ask_dollars: d4(m.ya), no_bid_dollars: d4(m.nb), no_ask_dollars: d4(m.na), yes_bid_size_fp: f2(m.ybSize), yes_ask_size_fp: f2(m.yaSize), last_price_dollars: d4(m.last), previous_price_dollars: d4(m.prev), previous_yes_bid_dollars: d4(m.prev - 0.01), previous_yes_ask_dollars: d4(m.prev + 0.01),
    volume_fp: f2(m.vol), volume_24h_fp: f2(m.vol24), open_interest_fp: f2(m.oi), result: m._result || '', can_close_early: false, price_level_structure: 'cent', price_ranges: [{ start: '0.01', end: '0.99', step: '0.01' }] };
  if (full) { o.rules_primary = m.rules; o.rules_secondary = m.rules2; }
  return o;
}
const events = Array.from(sim.events.values());
const pageSize = Math.ceil(events.length / 2);
let calls = [];
let lastInit = null;
const DESK = { positions: [], orders: [{ order_id: 'o-77', ticker: 'T0', side: 'yes', action: 'buy', yes_price_dollars: '0.3000', remaining_count_fp: '5.00', initial_count_fp: '5.00', status: 'resting', created_time: new Date().toISOString() }], lastOrder: null, cancelled: null };
const BLOCK = { candles: false, book: false };
const ENG = { settings: { enabled: false, env: 'prod', bankroll: 500, kelly: 0.25, maxPerGame: 25, maxExposure: 150, dailyLoss: 50, maxOpenGames: 12, takerMargin: 0.02, makerMargin: 0.03, sharpWeight: 0.8, maxHoursAhead: 36, takerEnabled: true, makerEnabled: true, sports: { NFL: true, NBA: true, NHL: true, NCAAF: false, NCAAB: false, MLB: false }, bookmakers: 'pinnacle', ntfyTopic: '' }, lastTick: { ts: Date.now() - 30000, reason: 'alarm', matched: 1, unmatched: 1, taker: 1, maker: 1, cancels: 0, errors: [], exposure: 17.2, odds: { NFL: 'cached 40s ago (12 events)' } }, saved: null, toggled: null, previewed: false, brakes: { NBA: { at: Date.now() - 86400000, until: Date.now() + 6 * 86400000, reason: 'closing-line value -0.9¢ over 23 fills in 30 days', n: 23, clv: -0.009 } }, unbraked: null };
function respond(url) {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  if (u.origin !== ORIGIN) return null; // direct calls are blocked
  if (u.pathname.startsWith('/engine/')) {
    const sub = u.pathname.slice(8); const auth = (lastInit && lastInit.headers && lastInit.headers['Authorization']) || '';
    if (auth !== 'Bearer pw123') return { __status: 401, error: 'wrong desk password' };
    if (sub === 'status') return { settings: ENG.settings, lastTick: ENG.lastTick, stats: { settled: [{ kind: 'taker', n: 4, pnl: 12.5, wins: 3, brier_sum: 0.8, brier_mkt: 0.95, staked: 60 }], methods: { n: 12, b_mult: 2.46, b_pow: 2.40 }, open: { n: 1, staked: 8 }, resting: { n: 2 }, days: [{ day: '2026-11-09', realized: 3.2, bets: 5 }], clv: [{ sport: 'NFL', kind: 'taker', n: 12, clv: 0.021, clv_mkt: 0.004, beat: 8 }, { sport: 'NBA', kind: 'maker', n: 6, clv: -0.003, clv_mkt: 0.001, beat: 2 }], oddsRemaining: 18800, oddsUsedToday: 40, oddsBudget: 606, runwayDays: 44, brakes: ENG.brakes, trim: { trim: 1, n: 4 } }, oddsKey: true, kalshiKey: true, ntfy: false, alarm: null, health: { oddsKey: true, kalshiKey: true, ntfy: false, alarm: null, odds: { NFL: { at: Date.now() - 40000, events: 12 } }, subMax: 45, errStreak: ENG.errStreak || null } };
    if (sub === 'unbrake' && lastInit.method === 'POST') { ENG.unbraked = JSON.parse(lastInit.body).sport; delete ENG.brakes[ENG.unbraked]; return { ok: true, brakes: ENG.brakes }; }
    if (sub === 'games') return { games: [{ id: 'KXNFLGAME-26NOV09NEBUF', sport: 'NFL', event_ticker: 'KXNFLGAME-26NOV09NEBUF', home: 'Buffalo Bills', away: 'New England Patriots', commence_ts: Date.now() + 3600000, p_home: 0.61, p_away: 0.39, books: 3, k_home_ask: 0.63, k_away_ask: 0.35, status: 'active', note: '', plan: JSON.stringify([{ team: 'Buffalo Bills', text: 'resting bid 16 at 0.57 (fair 0.61)' }, { team: 'New England Patriots', text: 'took the ask: 23 at 0.35 (edge 5.5¢)' }]) }, { id: 'X', sport: 'NFL', event_ticker: 'KXNFLGAME-26NOV09XXXYYY', home: 'XXX', away: 'YYY', status: 'unmatched', note: 'no sportsbook line matched these team names', plan: null }] };
    if (sub === 'bets') return { bets: [{ id: 'b1', ts: Date.now() - 60000, ticker: 'KXNFLGAME-26NOV09NEBUF-NE', team: 'New England Patriots', kind: 'taker', count: 23, price: 0.35, fee: 0.37, p_star: 0.42, edge: 0.055, status: 'filled', fill_count: 23, result: null, pnl: null }] };
    if (sub === 'log') return { log: [{ ts: Date.now(), level: 'info', msg: 'Took 23 YES ...' }] };
    if (sub === 'settings' && lastInit.method === 'POST') { ENG.saved = JSON.parse(lastInit.body); Object.assign(ENG.settings, ENG.saved); return { ok: true, settings: ENG.settings }; }
    if (sub === 'toggle' && lastInit.method === 'POST') { ENG.toggled = JSON.parse(lastInit.body); ENG.settings.enabled = !!ENG.toggled.enabled; return { ok: true, settings: ENG.settings }; }
    if (sub === 'preview' && lastInit.method === 'POST') { ENG.previewed = true; ENG.lastTick = { ts: Date.now(), reason: 'preview', dry: true, matched: 2, unmatched: 0, taker: 1, maker: 3, cancels: 0, errors: [], notes: [] }; return { ok: true, summary: ENG.lastTick }; }
    return { __status: 404, error: 'nope' };
  }
  if (u.pathname.startsWith('/desk/')) {
    const sub = u.pathname.slice(6); const auth = (lastInit && lastInit.headers && lastInit.headers['Authorization']) || '';
    if (sub === 'status') return { passwordSet: true, configured: { prod: true, demo: false } };
    if (auth !== 'Bearer pw123') return { __status: 401, error: 'wrong desk password' };
    if (sub === 'unlock') return { ok: true, configured: { prod: true, demo: false }, limits: { contracts: 50, dollars: 40 } };
    if (sub === 'balance') return { balance: 25000, balance_dollars: '250.00', portfolio_value: 31000, updated_ts: 1 };
    if (sub === 'positions') return { market_positions: DESK.positions, event_positions: [] };
    if (sub === 'orders') return { orders: DESK.orders };
    if (sub === 'fills') return { fills: [] };
    if (sub === 'book' && lastInit.method === 'POST') {
      const b = DESK.lastBook = JSON.parse(lastInit.body);
      if (DESK.bookGone) return { __status: 409, error: 'the lock is gone: one set costs 101.2¢ with fees and pays 100¢', gone: true, plan: { sets: 0, reason: 'one set costs 101.2¢ with fees and pays 100¢' } };
      const per = b.side === 'no' ? b.tickers.length - 1 : 1;
      return { ok: true, side: b.side, sets: 9, planned: 10, payout: 9 * per, cost: 8.4, fees: 0.3, locked: 9 * per - 8.7, unwindPnl: -0.04, unhedged: 0, legs: b.tickers.map((t, i) => ({ ticker: t, limit: 0.2, avg: 0.2, filled: i === 0 ? 11 : 9, extra: i === 0 ? 2 : 0, sold: i === 0 ? 2 : 0, soldAt: i === 0 ? 0.18 : null, error: '', unwindError: '' })) };
    }
    if (sub === 'order' && lastInit.method === 'POST') { DESK.lastOrder = JSON.parse(lastInit.body); (DESK.sentOrders = DESK.sentOrders || []).push(DESK.lastOrder); return { ok: true, sent: DESK.lastOrder, result: { order_id: 'ord-1', fill_count: String(DESK.lastOrder.count) + '.00', remaining_count: '0.00', average_fill_price: String(DESK.lastOrder.limit), ts_ms: 1 } }; }
    if (sub.startsWith('order/') && lastInit.method === 'DELETE') { DESK.cancelled = sub.slice(6); DESK.orders = []; return { ok: true, result: { order_id: sub.slice(6), reduced_by: '5.00' } }; }
    return { __status: 404, error: 'nope' };
  }
  const p = u.pathname.replace('/trade-api/v2', '');
  const q = u.searchParams;
  if (p === '/exchange/status') return { exchange_active: true, trading_active: true };
  if (p === '/events') { const page = q.get('cursor') === 'p2' ? 1 : 0; const slice = events.slice(page * pageSize, (page + 1) * pageSize); return { events: slice.map(e => ({ event_ticker: e.ticker, series_ticker: e.series, title: e.title, sub_title: '', category: e.category, mutually_exclusive: e.mutEx, markets: e.markets.map(t => rawMarket(sim.markets.get(t))) })), cursor: page === 0 ? 'p2' : '' }; }
  if (p === '/markets') { const ts = (q.get('tickers') || '').split(',').filter(Boolean); return { markets: ts.map(t => sim.markets.get(t)).filter(Boolean).map(m => rawMarket(m)), cursor: '' }; }
  if (p === '/markets/trades') { const ticker = q.get('ticker'); const trades = ticker ? sim.marketTrades(ticker, 20) : sim.trades(12); return { trades: trades.map(t => ({ trade_id: t.id, ticker: t.ticker, count_fp: f2(t.qty), yes_price_dollars: d4(t.yes), no_price_dollars: d4(t.no), taker_side: t.taker, created_time: iso(t.t), is_block_trade: false })), cursor: '' }; }
  if (p === '/markets/candlesticks' || /\/candlesticks$/.test(p)) { if (BLOCK.candles) return { __status: 401, message: 'missing authentication' }; }
  if (p === '/markets/candlesticks') { const t = q.get('market_tickers'); const per = Number(q.get('period_interval')); const cs = sim.candles(t, per, Number(q.get('start_ts')) * 1000); return { markets: [{ market_ticker: t, candlesticks: cs.map(c => ({ end_period_ts: Math.floor(c.t / 1000), price: { open_dollars: d4(c.o), high_dollars: d4(c.h), low_dollars: d4(c.l), close_dollars: d4(c.c) }, yes_bid: { open_dollars: d4(c.c - 0.01), low_dollars: d4(c.c - 0.01), high_dollars: d4(c.c - 0.01), close_dollars: d4(c.c - 0.01) }, yes_ask: { open_dollars: d4(c.c + 0.01), low_dollars: d4(c.c + 0.01), high_dollars: d4(c.c + 0.01), close_dollars: d4(c.c + 0.01) }, volume_fp: f2(c.vol), open_interest_fp: '0.00' })) }] }; }
  let m;
  if ((m = /^\/markets\/([^/]+)\/orderbook$/.exec(p))) { if (BLOCK.book) return { __status: 401, message: 'missing authentication' }; const b = sim.book(decodeURIComponent(m[1])); if (!b) return { __status: 404 }; return { orderbook_fp: { yes_dollars: b.yesBids.map(x => [d4(x[0]), f2(x[1])]), no_dollars: b.noBids.map(x => [d4(x[0]), f2(x[1])]) } }; }
  if ((m = /^\/markets\/([^/]+)$/.exec(p))) { const mk = sim.markets.get(decodeURIComponent(m[1])); if (!mk) return { __status: 404 }; return { market: rawMarket(mk, true) }; }
  if ((m = /^\/series\/([^/]+)$/.exec(p))) { const s = sim.seriesFees[m[1]] || { fee_type: 'quadratic', fee_multiplier: 1 }; return { series: Object.assign({ ticker: m[1], title: 'Series ' + m[1], category: 'Test' }, s) }; }
  if ((m = /^\/events\/([^/]+)$/.exec(p))) { const e = sim.events.get(m[1]); if (!e) return { __status: 404 }; return { event: { event_ticker: e.ticker, series_ticker: e.series, title: e.title, category: e.category, mutually_exclusive: e.mutEx }, markets: e.markets.map(t => rawMarket(sim.markets.get(t))) }; }
  return { __status: 404 };
}
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => { const msg = String(e && e.message || e); if (!/Not implemented: HTMLCanvasElement|Could not load link|Could not parse CSS stylesheet/.test(msg)) errors.push('jsdomError: ' + msg); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: ORIGIN + '/', virtualConsole: vc,
  beforeParse(window) {
    window.fetch = (url, init) => { lastInit = init || {}; const data = respond(url); if (data === null) return Promise.reject(new TypeError('Failed to fetch')); const status = data.__status || 200; return Promise.resolve({ ok: status < 300, status: status, json: async () => data }); };
    window.scrollTo = () => {};
  }
});
const { window } = dom;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const $ = (id) => window.document.getElementById(id);
const assert = (cond, msg) => { if (!cond) { errors.push('ASSERT: ' + msg); console.log('FAIL', msg); } else console.log('ok  ', msg); };
(async () => {
  await sleep(2500);
  const S = window.EDS, App = window.EDApp, UI = window.UI;
  assert(S.ctx === 'hosted', 'ctx hosted');
  assert(S.mode === 'live' && S.source === 'relay' && S.sameOrigin, 'live through same-origin relay (mode=' + S.mode + ', source=' + S.source + ')');
  assert(S.universe.pages === 2, 'both event pages loaded (' + S.universe.pages + ')');
  assert(S.universe.markets.size === sim.markets.size, 'all markets normalized (' + S.universe.markets.size + '/' + sim.markets.size + ')');
  const anyM = S.universe.markets.values().next().value;
  assert(anyM.yb > 0 && anyM.ya < 1 && anyM.vol24 > 0 && anyM.close > Date.now(), 'market fields parsed from *_dollars/*_fp');
  assert(calls.some(c => c.includes('/events?') && !c.includes('slim=1')), 'events requested through the relay without slim');
  assert(S.scanner.ops.length > 0 && S.scanner.ops.some(o => o.kind === 'arb'), 'scanner found signals incl. arb (' + S.scanner.ops.length + ')');
  assert(/Live/.test($('st-source').textContent) && /Exchange open/.test($('st-exchange').textContent), 'status strip shows live relay + exchange open');
  // tape
  await App.Engine.pollTape(); await sleep(50);
  assert(S.tape.trades.length > 0, 'tape trades parsed (' + S.tape.trades.length + ')');
  assert(calls.some(c => c.startsWith('/trade-api/v2/markets/trades?limit=100')), 'tape endpoint called');
  await App.Engine.pollTape();
  assert(calls.some(c => /\/markets\/trades\?limit=100&min_ts=\d+/.test(c)), 'second tape poll uses min_ts');
  // tracked refresh
  S.watch.add(anyM.ticker);
  await App.Engine.refreshTracked();
  assert(calls.some(c => c.includes('/markets?tickers=')), 'tracked refresh batches tickers');
  // open a market (live detail, book, trades, candles, series)
  const t = S.scanner.ops.find(o => o.kind === 'arb' && o.sub === 'no').tickers[1];
  await App.Engine.openMarket(t); await sleep(400);
  assert(S.sel === t && !$('sheet').hidden, 'sheet opened live');
  assert(S.sheet.book && S.sheet.book.yesBids.length > 3 && S.sheet.book.yesAsks.length > 3, 'book parsed (fp format)');
  assert(S.sheet.candles.length > 10, 'candles parsed (' + S.sheet.candles.length + ')');
  assert(S.universe.markets.get(t).rules.length > 20, 'full market record (rules) loaded');
  assert($('sh-ai').textContent.includes('Copy a prompt'), 'AI fallback shown when sample() unavailable');
  assert(S.seriesCache[S.universe.markets.get(t).series] && S.seriesCache[S.universe.markets.get(t).series].fee_type, 'series fee info cached');
  const sheetText = $('sh-body').textContent;
  assert(/One-winner book/.test(sheetText), 'one-winner book section rendered for mutually exclusive event');
  // paper trade then settle via a refresh carrying a result
  window.document.querySelector('[data-act="place"]').click(); await sleep(20);
  assert(Object.keys(S.desk.positions).length === 1, 'paper position opened live');
  sim.markets.get(t)._result = 'yes';
  await App.Engine.refreshTracked(); await sleep(20);
  assert(Object.keys(S.desk.positions).length === 0 && S.desk.fills.some(f => f.action === 'settle'), 'settlement applied from refreshed market result');
  // range change triggers candles reload
  const before = calls.length;
  window.document.querySelector('[data-act="range"][data-r="1D"]').click(); await sleep(200);
  assert(calls.slice(before).some(c => c.includes('period_interval=1&')), '1D range requests 1-minute candles');
  // sheet poll cycle
  await App.Engine.pollSheet(); await App.Engine.pollSheet(); await sleep(50);
  assert(true, 'pollSheet ran twice');
  // setup render in hosted ctx
  UI.nav('setup'); await sleep(50);
  assert(/built-in relay/.test($('setup-conn').textContent), 'setup explains same-origin relay');
  // --- auth-blocked endpoints: candles 401 -> chart from trades; orderbook 401 -> depth hidden
  BLOCK.candles = true; BLOCK.book = true;
  S.blocked = {};
  const t2 = Array.from(S.universe.markets.keys())[5];
  await App.Engine.openMarket(t2);
  for (let i = 0; i < 40 && !S.sheet.candleSource; i++) await sleep(250);
  assert(S.blocked.candles === true, 'candles 401 marks endpoint blocked');
  assert(S.sheet.candleSource === 'trades' && S.sheet.candles.length > 0, 'chart built from trade history (' + S.sheet.candles.length + ' buckets)');
  assert($('sh-chart-note').textContent.includes('trade prints'), 'chart note explains the fallback');
  await App.Engine.pollSheet(); await sleep(50);
  assert(S.blocked.book === true && S.sheet.book === null, 'orderbook 401 marks endpoint blocked');
  UI.renderSheet(); await sleep(20);
  assert($('sh-body').textContent.includes('asked for authentication'), 'sheet explains hidden depth');
  assert(S.health.status === 'live', 'auth blocks do not flip status to stale (' + S.health.status + ')');
  // --- real account flow
  const Acct = window.EDAcct;
  DESK.orders[0].ticker = Array.from(S.universe.markets.keys())[3];
  const held = S.universe.markets.get(Array.from(S.universe.markets.keys())[4]);
  DESK.positions = [{ ticker: held.ticker, position_fp: '8.00', market_exposure_dollars: (8 * held.yb).toFixed(2), realized_pnl_dollars: '0.00', fees_paid_dollars: '0.10', total_traded_dollars: '4.00' }];
  await Acct.probe();
  assert(Acct.st.known && Acct.st.passwordSet && !Acct.st.unlocked, 'account probe: password set, locked');
  UI.deskTab = 'live'; UI.nav('desk'); await sleep(50);
  assert(!!$('acct-pw'), 'live tab shows password form');
  $('acct-pw').value = 'wrong'; window.document.querySelector('[data-act="unlock"]').click(); await sleep(100);
  assert(!Acct.st.unlocked && /Wrong password/.test($('desk-live').textContent), 'wrong password rejected with message');
  $('acct-pw').value = 'pw123'; window.document.querySelector('[data-act="unlock"]').click(); await sleep(300);
  assert(Acct.st.unlocked && Acct.st.limits.contracts === 50, 'unlock succeeds and stores limits');
  assert(window.localStorage.getItem('edgedesk.deskpw') === 'pw123', 'password remembered on device');
  // --- Money: a real lock through /desk/book and a real two-sided quote through /desk/order
  UI.nav('money'); await sleep(200);
  assert($('money-locks').querySelectorAll('.card.money').length >= 1 && /Locks now/.test($('money-tiles').textContent), 'Money lists locks on live data');
  await sleep(600);
  assert(calls.some(c => /\/trade-api\/v2\/markets\/[^/]+\/orderbook/.test(c)), 'live check reads the order books through the relay');
  const realBtn = $('money-locks').querySelector('[data-act="mreal"]');
  assert(!!realBtn, 'unlocked account shows "Buy it for real"');
  const lockKey = realBtn.dataset.k, lockCard = () => Array.from($('money-locks').querySelectorAll('.card.money')).find(c => c.dataset.mk === lockKey);
  realBtn.click(); await sleep(500);
  assert(/Real money/.test(lockCard().textContent) && !!lockCard().querySelector('[data-act="mlockgo"]'), 'confirm panel explains the real buy (' + lockCard().querySelector('.money-real').textContent.slice(0, 80) + ')');
  lockCard().querySelector('[data-act="mlockgo"]').click(); await sleep(400);
  const lb = DESK.lastBook;
  assert(lb && lb.event && lb.tickers.length >= 2 && lb.maxSets >= 1 && lb.maxCost > 0 && lb.maxCost <= 25.0001 && (lb.side === 'yes' || lb.side === 'no'), 'book request carries event, legs, side and a budget of 10% of the $250 cash (' + (lb && lb.maxCost) + ')');
  assert(/Bought 9 complete sets for about/.test(lockCard().textContent) && /Sold back 2 extra on .* near 18¢/.test(lockCard().textContent), 'result reports the sets and the sell-back');
  lockCard().querySelector('[data-act="mback"]').click(); await sleep(50);
  DESK.bookGone = true; lockCard().querySelector('[data-act="mreal"]').click(); await sleep(500);
  const go = lockCard().querySelector('[data-act="mlockgo"]'); if (go) { go.click(); await sleep(400); }
  assert(/Not sent\.|Nothing to buy right now/.test(lockCard().textContent), 'a lock that vanished is reported, not bought');
  DESK.bookGone = false;
  const qBtn = $('money-spreads').querySelector('[data-act="mreal"]');
  assert(!!qBtn, 'spreads offer "Quote it for real"');
  const qKey = qBtn.dataset.k, qCard = () => Array.from($('money-spreads').querySelectorAll('.card.money')).find(c => c.dataset.mk === qKey);
  qBtn.click(); await sleep(100);
  assert(/post-only/.test(qCard().textContent) && !!qCard().querySelector('[data-act="mquotego"]'), 'spread confirm explains both resting orders');
  DESK.sentOrders = [];
  qCard().querySelector('[data-act="mquotego"]').click(); await sleep(500);
  const so = DESK.sentOrders, sop = S.scanner.ops.find(x => UI.opKey(x) === qKey);
  assert(so.length === 2 && so[0].side === 'yes' && so[0].action === 'buy' && so[0].tif === 'gtc' && so[0].postOnly === true && so[1].side === 'no' && so[1].action === 'buy' && so[1].tif === 'gtc' && so[1].postOnly === true, 'two post-only resting orders: a YES bid and a NO bid for the offer');
  assert(Math.abs(so[0].limit - (sop.yb + 0.01)) < 1e-6 && Math.abs((1 - so[1].limit) - (sop.ya - 0.01)) < 1e-6 && so[0].count === so[1].count && so[0].count >= 1, 'each 1¢ inside its side of the spread, same size (' + so[0].limit + ' / ' + (1 - so[1].limit).toFixed(2) + ' × ' + so[0].count + ')');
  assert(/Both orders are resting/.test(qCard().textContent), 'spread result panel');
  UI.nav('scanner'); await sleep(100);
  assert(/lock(s)? right now/.test($('scanner-banner').textContent) && !!$('scanner-banner').querySelector('[data-v="money"]'), 'the Scanner points at Money when locks exist');
  await sleep(100);
  assert($('desk-live').textContent.includes('$250.00') && $('desk-live').textContent.includes('Resting orders'), 'live panel shows balance (' + ($('desk-live').textContent.includes('$250.00')) + ')');
  assert(Acct.st.positions.length === 1 && Acct.st.positions[0].qty === 8 && Acct.st.positions[0].side === 'yes', 'positions parsed from fp fields');
  assert($('st-acct') && !$('st-acct').hidden && /Account/.test($('st-acct').textContent), 'header chip shows account');
  // cancel a resting order (two-step)
  window.document.querySelector('[data-act="realcancel1"]').click(); await sleep(20);
  window.document.querySelector('[data-act="realcancel2"]').click(); await sleep(200);
  assert(DESK.cancelled === 'o-77', 'cancel sent to Worker for the right order');
  // real ticket on a market
  const tk = held.ticker;
  await App.Engine.openMarket(tk); await sleep(300);
  assert(window.document.querySelector('[data-act="tmode"][data-s="real"]'), 'ticket offers Real money mode when unlocked');
  window.document.querySelector('[data-act="tmode"][data-s="real"]').click(); await sleep(50);
  assert(!!$('rk-qty') && $('sh-ticket').textContent.includes('You hold 8 YES'), 'real ticket renders with position note');
  $('rk-qty').value = '10'; $('rk-qty').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('rk-limit').value = String(Math.round(held.ya * 100)); $('rk-limit').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(20);
  assert($('rk-preview').textContent.includes('fills now') && !window.document.querySelector('[data-act="rreview"]').disabled, 'preview: crosses and review enabled');
  // cap enforcement client-side
  $('rk-qty').value = '60'; $('rk-qty').dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(20);
  assert(window.document.querySelector('[data-act="rreview"]').disabled && /cap of 50 contracts/.test($('rk-preview').textContent), 'per-order contract cap blocks review');
  $('rk-qty').value = '10'; $('rk-qty').dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(20);
  window.document.querySelector('[data-act="rreview"]').click(); await sleep(20);
  assert(/Real money/.test($('rk-confirm').textContent) && window.document.querySelector('[data-act="rsend"]'), 'confirmation step shown');
  window.document.querySelector('[data-act="rsend"]').click(); await sleep(300);
  assert(DESK.lastOrder && DESK.lastOrder.ticker === tk && DESK.lastOrder.side === 'yes' && DESK.lastOrder.action === 'buy' && DESK.lastOrder.count === 10 && Math.abs(DESK.lastOrder.limit - held.ya) < 1e-9 && DESK.lastOrder.tif === 'ioc', 'order posted to Worker with the confirmed terms');
  assert(/accepted/.test($('rk-confirm').textContent) && /Filled 10/.test($('rk-confirm').textContent), 'result shown after send');
  // sell more than held is blocked
  window.document.querySelector('[data-act="rnew"]').click(); await sleep(20);
  window.document.querySelector('[data-act="raction"][data-s="sell"]').click(); await sleep(20);
  $('rk-qty').value = '9'; $('rk-qty').dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(20);
  assert(/You hold 8 YES contracts/.test($('rk-preview').textContent) && window.document.querySelector('[data-act="rreview"]').disabled, 'selling more than held is blocked');
  // --- engine tab
  UI.deskTab = 'engine'; UI.nav('desk'); await sleep(400);
  assert($('desk-engine') && !$('desk-engine').hidden && /Engine off/.test($('desk-engine').textContent), 'engine tab renders status');
  assert(/took the ask: 23 at 0.35/.test($('desk-engine').textContent) && /without a matching sportsbook line/.test($('desk-engine').textContent), 'engine games table shows plans and unmatched games');
  { const t = $('desk-engine').textContent; assert(/My call/.test(t) && /Let it run/.test(t) && /18 of 30 bets scored/.test(t) && /\+1\.3¢ against the closing line after fees/.test(t), 'engine verdict: let it run, with the count and the net closing-line value'); assert(/How it works/.test(t), 'how-it-works layer'); }
  window.document.querySelector('[data-act="engpreview"]').click(); await sleep(400);
  assert(ENG.previewed && /dry run/.test($('desk-engine').textContent) && /would take 1 · would quote 3/.test($('desk-engine').textContent), 'dry run shows what it would do');
  assert(/Brier vs market 0.237/.test($('desk-engine').textContent) && /\+\$12\.50/.test($('desk-engine').textContent), 'engine stats tiles computed');
  assert(/Ready\?/.test($('desk-engine').textContent) && /ODDS_API_KEY is set/.test($('desk-engine').textContent) && /NFL: 12 events/.test($('desk-engine').textContent) && /606 a day/.test($('desk-engine').textContent) && /~44 days/.test($('desk-engine').textContent), 'readiness checklist shows keys, lines and credit runway');
  const eng = $('desk-engine').textContent;
  assert(/Closing line/.test(eng) && /\+1\.3¢/.test(eng) && /18 fills/.test(eng) && /beat the close 56%/.test(eng), 'closing-line tile aggregates CLV across sports (' + (eng.match(/[+−]\d\.\d¢/g) || []).slice(0, 2).join(',') + ')');
  assert(/power 0\.200 vs mult 0\.205/.test(eng), 'calibration tile compares devig methods');
  assert(/NBA paused by the engine/.test(eng) && window.document.querySelector('[data-act="engunbrake"][data-s="NBA"]'), 'brake banner with resume button');
  assert(/NBA \(paused\)/.test(eng), 'sport chip marks the paused sport');
  window.document.querySelector('[data-act="engunbrake"]').click(); await sleep(200);
  assert(ENG.unbraked === 'NBA' && !/NBA paused by the engine/.test($('desk-engine').textContent), 'resume posts unbrake and clears the banner');
  $('eng-maxPerGame').value = '30'; window.document.querySelector('[data-eng-sport="NHL"]').click();
  $('eng-devig').value = 'mult'; $('eng-maxOddsAgeMin').value = '12'; $('eng-moveGuard').value = '4';
  window.document.querySelector('[data-act="engsave"]').click(); await sleep(200);
  assert(ENG.saved && ENG.saved.maxPerGame === 30 && ENG.saved.sports.NHL === false && Math.abs(ENG.saved.takerMargin - 0.02) < 1e-9, 'engine settings saved with converted units');
  assert(ENG.saved.devig === 'mult' && ENG.saved.maxOddsAgeMin === 12 && Math.abs(ENG.saved.moveGuard - 0.04) < 1e-9 && ENG.saved.timezone === 'America/New_York' && ENG.saved.digestHour === 9, 'v2 settings saved (devig, line age, move guard, digest)');
  window.document.querySelector('[data-act="engstart"]').click(); await sleep(50);
  assert(/Real money/.test($('eng-confirm').textContent) && window.document.querySelector('[data-act="engstart2"]'), 'engine start asks for confirmation');
  window.document.querySelector('[data-act="engstart2"]').click(); await sleep(300);
  assert(ENG.toggled && ENG.toggled.enabled === true && /Engine running/.test($('desk-engine').textContent), 'engine started after confirmation');
  window.document.querySelector('[data-act="engstop"]').click(); await sleep(300);
  assert(ENG.toggled && ENG.toggled.enabled === false && ENG.toggled.flatten === true && /Engine off/.test($('desk-engine').textContent), 'engine stop cancels quotes and shows off');
  // shadow mode: start without the real-money confirmation; the mode select switches modes through settings
  ENG.settings.shadow = true; ENG.toggled = null; await window.EDEngine.refresh(true); await sleep(100);
  assert(/Shadow mode/.test($('desk-engine').textContent) && /Start shadow run/.test($('desk-engine').textContent) && /paper only/.test($('desk-engine').textContent), 'shadow mode shown with its own start button');
  assert(/Keep it on paper/.test($('desk-engine').textContent) && /18 of 30 bets scored so far/.test($('desk-engine').textContent), 'shadow verdict: keep it on paper until 30 bets are scored');
  window.document.querySelector('[data-act="engstart"]').click(); await sleep(300);
  assert(ENG.toggled && ENG.toggled.enabled === true && /running on paper/.test($('desk-engine').textContent) && !/Real money/.test($('eng-confirm') ? $('eng-confirm').textContent : ''), 'shadow run starts directly');
  window.document.querySelector('[data-act="engstop"]').click(); await sleep(300);
  assert(ENG.toggled.enabled === false, 'shadow run stops');
  const modeSel = window.document.querySelector('[data-eng-mode]'); modeSel.value = 'live'; modeSel.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(300);
  assert(ENG.saved && ENG.saved.shadow === false && /Live mode/.test($('desk-engine').textContent), 'mode select posts the switch and the tab shows live');
  ENG.settings.shadow = false;
  // a stalled engine and a failure streak are both called out
  ENG.settings.enabled = true; ENG.lastTick = { ts: Date.now() - 10 * 60000, reason: 'alarm', matched: 1, unmatched: 0, taker: 0, maker: 0, cancels: 0, errors: [], notes: [] }; ENG.errStreak = { n: 4, last: 'Kalshi 500 /portfolio/balance: down' };
  await window.EDEngine.refresh(true); await sleep(100);
  { const t = $('desk-engine').textContent; assert(/No tick has finished for 10 minutes/.test(t) && /exceeded CPU/.test(t) && /The last 4 ticks failed/.test(t) && /stops itself after 30 failures/.test(t), 'stall and failure banners'); }
  ENG.settings.enabled = false; ENG.errStreak = null;
  await App.Engine.openMarket(tk); await sleep(200);
  // lock
  window.document.querySelector('[data-act="tmode"][data-s="paper"]').click(); await sleep(20);
  UI.nav('desk'); await sleep(30); window.document.querySelector('[data-act="lock"]').click(); await sleep(30);
  assert(!Acct.st.unlocked && window.localStorage.getItem('edgedesk.deskpw') === null && !!$('acct-pw'), 'lock clears password and shows form');
  console.log('\nERRORS:', errors.length); errors.forEach(e => console.log(' -', e.slice(0, 300)));
  window.close(); process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
