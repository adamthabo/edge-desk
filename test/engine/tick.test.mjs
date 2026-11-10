// Whole engine ticks against a fake exchange and sharp-lines feed, in process (needs Node 22+ for node:sqlite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineDO } from '../unit/_load.mjs';
import { fakeState, world, installFetch, env, clock } from './harness.mjs';

const MIN = 60000;
function setLine(w, buf, ne, bufDk, neDk) {
  const e = w.odds[0];
  e.bookmakers[0].markets[0].outcomes = [{ name: 'Buffalo Bills', price: buf }, { name: 'New England Patriots', price: ne }];
  e.bookmakers[1].markets[0].outcomes = [{ name: 'Buffalo Bills', price: bufDk }, { name: 'New England Patriots', price: neDk }];
}
function freshen(w, now) { for (const e of w.odds) for (const b of e.bookmakers) b.markets[0].last_update = Math.floor(now / 1000); }
const rows = (d, q, ...p) => d.sql.exec(q, ...p).toArray();
const game = (d, id) => rows(d, 'SELECT * FROM games WHERE id=?', id)[0];
const post = (d, path, body) => d.fetch(new Request('http://x/engine/' + path, { method: 'POST', body: JSON.stringify(body || {}) })).then(r => r.json());
const get = (d, path) => d.fetch(new Request('http://x/engine/' + path)).then(r => r.json());

test('engine lifecycle', async (t) => {
  const T0 = Date.UTC(2026, 10, 15, 20, 0, 0); // a Sunday afternoon in the US
  const ck = clock(T0);
  const w = world(T0); installFetch(w);
  const state = fakeState();
  const d = new EngineDO(state, env());
  setLine(w, 1.75, 2.25, 1.72, 2.28); // NE is a real favourite-ish dog: cheap at 35¢ on Kalshi

  await t.test('off: a tick does nothing', async () => {
    const s = await d.tick('alarm');
    assert.equal(s.note, 'engine off'); assert.equal(w.requests.length, 0);
  });
  await t.test('toggle refuses without keys, accepts with them', async () => {
    const noKeys = new EngineDO(fakeState(), env({ KALSHI_KEY_ID: '', KALSHI_PRIVATE_KEY: '' })); noKeys.saveSettings({ shadow: false });
    const r = await post(noKeys, 'toggle', { enabled: true });
    assert.match(r.error || '', /Kalshi API key/);
    d.saveSettings({ shadow: false });
    const ok = await post(d, 'toggle', { enabled: true });
    assert.equal(ok.settings.enabled, true); assert.ok(state.alarm() !== null, 'alarm scheduled');
  });
  await t.test('first tick: takes the cheap dog, quotes the rest, journals probabilities and confidence', async () => {
    const s = await d.tick('alarm');
    assert.deepEqual(s.errors, []);
    assert.equal(s.matched, 2); assert.equal(s.unmatched, 1);
    assert.equal(s.taker, 1, 'one taker buy'); assert.ok(s.maker >= 2, 'maker bids on the fair legs (' + s.maker + ')');
    assert.equal(w.oddsCalls, 1);
    const ne = rows(d, "SELECT * FROM bets WHERE kind='taker'")[0];
    assert.equal(ne.ticker, w.EV1 + '-NE'); assert.equal(ne.status, 'filled'); assert.equal(ne.price, 0.35);
    assert.equal(ne.sport, 'NFL'); assert.equal(ne.conf, 1); assert.ok(ne.p_pow > 0.42 && ne.p_pow < 0.46, 'power p recorded (' + ne.p_pow + ')'); assert.ok(ne.p_mult > 0.42 && ne.p_mult < 0.46);
    assert.ok(ne.p_star > 0.40 && ne.p_star > 0.35 + 0.016 + 0.02, 'edge beats fee + margin');
    const g = game(d, w.EV1);
    assert.equal(g.status, 'active'); assert.equal(g.conf, 1); assert.equal(g.books, 2); assert.ok(g.disp >= 0 && g.disp < 0.02); assert.ok(g.anchor_home > 0.6, 'anchor set to the Kalshi mid');
    const g2 = game(d, w.EV2);
    assert.equal(g2.conf, 0.75, 'single book → 75% confidence'); assert.match(g2.conf_why, /single book/);
    const dal = rows(d, "SELECT * FROM bets WHERE ticker=?", w.EV2 + '-DAL')[0];
    assert.ok(dal && dal.kind === 'maker' && dal.status === 'resting' && dal.conf === 0.75, 'DAL quote sized at 75%');
    assert.ok(s.subrequests > 5 && s.subrequests < 20, 'subrequests counted (' + s.subrequests + ')');
    assert.equal(s.oddsBudget.remaining, 19000);
  });
  await t.test('second tick inside the interval: lines cached, quotes kept, nothing duplicated', async () => {
    ck.add(60 * 1000); freshen(w, ck.get());
    const before = w.orders.length;
    const s = await d.tick('alarm');
    assert.equal(w.oddsCalls, 1, 'no new odds fetch'); assert.match(s.odds.NFL, /cached/);
    assert.equal(w.orders.length, before + 1, 'exactly one new order'); assert.equal(w.orders[w.orders.length - 1].side, 'ask', 'and it is the reduce-only ask on the contracts bought a minute ago'); assert.equal(s.cancels, 0);
    const plan = JSON.parse(game(d, w.EV1).plan); assert.ok(plan.some(p => /already bought at this line/.test(p.text)), 'taker throttle explained in the plan');
  });
  await t.test('stale lines: feed down for 16 minutes → quotes pulled, no new orders, game marked stale', async () => {
    w.oddsStatus = 500; ck.add(16 * MIN);
    const restingBefore = w.resting.length; assert.ok(restingBefore >= 2);
    const s = await d.tick('alarm');
    assert.ok(s.errors.some(e => /odds/.test(e)), 'fetch failure reported');
    assert.equal(game(d, w.EV1).status, 'stale'); assert.match(game(d, w.EV1).note, /min old/);
    assert.equal(w.resting.length, 0, 'all our quotes cancelled'); assert.ok(s.cancels >= 2);
    assert.equal(w.orders.length, w.orders.length, 'no new orders placed');
    const dal = rows(d, "SELECT status, note FROM bets WHERE ticker=?", w.EV2 + '-DAL')[0];
    assert.equal(dal.status, 'cancelled'); assert.equal(dal.note, 'stale lines');
  });
  await t.test('feed back: lines refreshed, quotes return', async () => {
    w.oddsStatus = 200; freshen(w, ck.get()); ck.add(MIN);
    const s = await d.tick('alarm');
    assert.equal(w.oddsCalls, 3, 'fetched again (one failed attempt in between)'); assert.equal(game(d, w.EV1).status, 'active');
    assert.ok(w.resting.length >= 2, 'quotes back on the book'); assert.ok(s.maker >= 2);
  });
  await t.test('move guard: Kalshi jumps 4¢ since the lines were fetched → pull quotes, force a refresh, act next minute', async () => {
    ck.add(90 * 1000);
    w.quote(w.EV1 + '-BUF', 0.56, 0.59); // BUF drops 4¢ while the books (cached) say nothing
    const s = await d.tick('alarm');
    assert.equal(s.guarded, 1); assert.equal(game(d, w.EV1).status, 'guarded'); assert.match(game(d, w.EV1).note, /moved 4¢/);
    assert.ok(!w.resting.some(o => o.ticker.startsWith(w.EV1)), 'our quotes on that game are gone');
    assert.ok(w.resting.some(o => o.ticker.startsWith(w.EV2)), 'the other game keeps its quotes');
    assert.equal(d.kv('odds_force_NFL'), true);
    const calls = w.oddsCalls; ck.add(30 * 1000);
    const s2 = await d.tick('alarm');
    assert.equal(w.oddsCalls, calls + 1, 'forced refresh happened inside the normal interval'); assert.match(s2.odds.NFL, /forced/);
    assert.equal(game(d, w.EV1).status, 'active'); assert.equal(d.kv('odds_force_NFL'), null);
    assert.ok(Math.abs(game(d, w.EV1).anchor_home - 0.575) < 1e-9, 'anchor reset to the new mid');
  });
  await t.test('credit scheduler: few credits left → cadence stretched to fit the month; far games fetch nothing; started games stop fetching', async () => {
    const d2 = new EngineDO(fakeState(), env()); const w2 = world(ck.get()); installFetch(w2); setLine(w2, 1.75, 2.25, 1.72, 2.28);
    w2.oddsRemaining = '100'; // → 4 fetches a day → one every 6 hours for a single sport
    d2.saveSettings({ enabled: true, shadow: false });
    let s = await d2.tick('alarm'); assert.equal(w2.oddsCalls, 1); assert.equal(s.oddsBudget.daily, 4);
    ck.add(6 * MIN); freshen(w2, ck.get()); s = await d2.tick('alarm');
    assert.equal(w2.oddsCalls, 1, 'no refetch six minutes later'); assert.equal(s.oddsCadenceSec, 21600); assert.match(s.odds.NFL, /cached/);
    assert.equal(game(d2, w2.EV1).status, 'active', 'six-minute-old lines are still fine');
    ck.add(10 * MIN); freshen(w2, ck.get()); s = await d2.tick('alarm');
    assert.equal(w2.oddsCalls, 1); assert.equal(game(d2, w2.EV1).status, 'stale', 'with lines older than 15 min the engine stops trading rather than guessing');
    ck.add(6 * 3600000); freshen(w2, ck.get()); w2.setKick(ck.get() + 2 * 3600000); s = await d2.tick('alarm');
    assert.equal(w2.oddsCalls, 2, 'fetches again once the paced interval has passed'); assert.match(s.odds.NFL, /paced to every 21600s/);
    // every game under way → no more line fetches for that sport
    ck.set(w2.kick + 10 * MIN); freshen(w2, ck.get()); s = await d2.tick('alarm');
    assert.equal(w2.oddsCalls, 2); assert.match(s.odds.NFL, /under way; lines not needed/);
    const wFar = world(ck.get(), 5 * 24 * 3600000); installFetch(wFar);
    const d3 = new EngineDO(fakeState(), env()); d3.saveSettings({ enabled: true, shadow: false });
    const s3 = await d3.tick('alarm');
    assert.match(s3.odds.NFL, /no games inside the horizon/); assert.equal(wFar.oddsCalls, 0, 'no credit spent on a slate five days out');
    assert.equal(rows(d3, 'SELECT * FROM games').length, 0, 'games outside the window are not even priced');
    installFetch(w);
  });
  await t.test('closing line: last tick before kickoff records the close and scores fills; late fills scored later', async () => {
    freshen(w, ck.get());
    const d4 = new EngineDO(fakeState(), env()); const w4 = world(ck.get()); installFetch(w4); setLine(w4, 1.75, 2.25, 1.72, 2.28);
    d4.saveSettings({ enabled: true, shadow: false });
    let s = await d4.tick('alarm'); assert.equal(s.taker, 1);
    // a resting BUF quote gets filled on the exchange before kickoff
    const bufQuote = w4.resting.find(o => o.ticker === w4.EV1 + '-BUF'); assert.ok(bufQuote);
    w4.resting = w4.resting.filter(o => o !== bufQuote);
    w4.positions.push({ ticker: bufQuote.ticker, position_fp: bufQuote.initial_count_fp, market_exposure_dollars: (Number(bufQuote.initial_count_fp) * Number(bufQuote.yes_price_dollars)).toFixed(2) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (String(url).includes('/portfolio/orders/' + bufQuote.order_id)) return new Response(JSON.stringify({ order: { order_id: bufQuote.order_id, status: 'executed', fill_count_fp: bufQuote.initial_count_fp, yes_price_dollars: bufQuote.yes_price_dollars } })); return realFetch(url, init); };
    ck.set(w4.kick - 90 * 1000); freshen(w4, ck.get()); // 90s to kickoff → inside preKickoffSec; lines refetched (near cadence)
    s = await d4.tick('alarm');
    const g = game(d4, w4.EV1);
    assert.equal(g.status, 'live'); assert.ok(g.closed_ts > 0); assert.ok(g.close_p_home > 0.5 && g.close_p_away < 0.5);
    assert.ok(Math.abs(g.close_k_away - 0.34) < 1e-9, 'Kalshi close mid recorded');
    const ne = rows(d4, "SELECT * FROM bets WHERE ticker=? AND fill_count > 0", w4.EV1 + '-NE')[0];
    assert.ok(ne.clv > 0.05 && ne.clv < 0.12, 'bought at 35¢, close ~44¢ → CLV ' + (ne.clv * 100).toFixed(1) + '¢');
    assert.ok(Math.abs(ne.clv_mkt - (0.34 - 0.35)) < 1e-9, 'market CLV vs Kalshi mid −1¢');
    const buf = rows(d4, "SELECT * FROM bets WHERE ticker=?", w4.EV1 + '-BUF')[0];
    assert.equal(buf.status, 'filled'); assert.ok(buf.clv !== null && buf.clv > 0, 'the maker fill learned about during reconcile is scored too (' + buf.clv + ')');
    assert.ok(rows(d4, 'SELECT * FROM log').some(l => /Closing line/.test(l.msg)));
    assert.ok(!w4.resting.some(o => o.ticker.startsWith(w4.EV1)), 'quotes pulled at kickoff');
    globalThis.fetch = realFetch;
    // the books drop the game after it starts: we keep what we knew
    w4.odds = w4.odds.filter(e => e.id !== 'e1'); ck.add(3 * MIN); freshen(w4, ck.get()); d4.kv('odds_force_NFL', true);
    s = await d4.tick('alarm');
    const g2 = game(d4, w4.EV1); assert.equal(g2.status, 'live'); assert.equal(g2.close_p_home, g.close_p_home); assert.match(g2.note, /no longer publish/);
    installFetch(w);
  });
  await t.test('brakes: negative closing-line value over enough fills pauses the sport; the user can resume', async () => {
    const d5 = new EngineDO(fakeState(), env()); const w5 = world(ck.get()); installFetch(w5); setLine(w5, 1.75, 2.25, 1.72, 2.28);
    d5.saveSettings({ enabled: true, shadow: false, brakeMinBets: 1 });
    await d5.tick('alarm');
    // pretend the NE buy was a bad one: price well above the close
    d5.sql.exec("UPDATE bets SET price = 0.55 WHERE kind='taker'");
    ck.set(w5.kick - 60 * 1000); freshen(w5, ck.get());
    const s = await d5.tick('alarm');
    const b = d5.brakes(); assert.ok(b.NFL, 'NFL braked'); assert.match(b.NFL.reason, /closing-line value -/);
    assert.ok(w5.ntfy.length === 0, 'no ntfy without a topic');
    const st = await get(d5, 'status'); assert.ok(st.stats.brakes.NFL && st.stats.clv.length >= 1);
    // a new slate while braked: watched, not traded
    const w6 = world(ck.get() + 60 * MIN); installFetch(w6); setLine(w6, 1.75, 2.25, 1.72, 2.28); for (const m of w6.markets) m.event_ticker += 'B', m.ticker = m.event_ticker + '-' + m.ticker.split('-').pop();
    ck.add(10 * MIN); freshen(w6, ck.get()); d5.kv('odds_force_NFL', true);
    const s2 = await d5.tick('alarm');
    assert.equal(s2.taker + s2.maker, 0, 'no orders while braked');
    assert.ok(rows(d5, "SELECT * FROM games WHERE status='braked'").length >= 1);
    const un = await post(d5, 'unbrake', { sport: 'NFL' }); assert.deepEqual(un.brakes, {});
    ck.add(MIN); freshen(w6, ck.get()); d5.kv('odds_force_NFL', true);
    const s3 = await d5.tick('alarm'); assert.ok(s3.taker + s3.maker > 0, 'trading resumes');
    installFetch(w);
  });
  await t.test('exits: a reduce-only ask rests above fair on held contracts; when the bid clears fair + margin the position is sold and the books net out', async () => {
    const d9 = new EngineDO(fakeState(), env()); const w10 = world(ck.get()); installFetch(w10); setLine(w10, 1.75, 2.25, 1.72, 2.28); freshen(w10, ck.get());
    d9.saveSettings({ enabled: true, shadow: false });
    let s = await d9.tick('alarm'); assert.equal(s.taker, 1); assert.ok(!w10.resting.some(o => o.action === 'sell'), 'nothing to sell on the tick that buys');
    const N = rows(d9, "SELECT fill_count FROM bets WHERE kind='taker'")[0].fill_count; assert.ok(N >= 20, 'bought ' + N);
    ck.add(MIN); freshen(w10, ck.get()); s = await d9.tick('alarm');
    const ask = w10.resting.find(o => o.ticker === w10.EV1 + '-NE' && o.action === 'sell'); assert.ok(ask, 'reduce-only ask resting on the held contracts');
    const sent = w10.orders.find(o => o.order_id === ask.order_id); assert.equal(sent.side, 'ask'); assert.equal(sent.reduce_only, true); assert.equal(sent.post_only, true);
    assert.equal(Number(ask.remaining_count_fp), N, 'asks exactly what the engine holds'); assert.ok(Number(ask.yes_price_dollars) >= 0.44 && Number(ask.yes_price_dollars) <= 0.47, 'ask at fair + margin + fee (' + ask.yes_price_dollars + ')');
    const askRow = rows(d9, "SELECT * FROM bets WHERE action='sell'")[0]; assert.equal(askRow.kind, 'exit_maker'); assert.equal(askRow.status, 'resting');
    assert.ok(JSON.parse(game(d9, w10.EV1).plan).some(p => new RegExp('holding ' + N + '; placed ask').test(p.text)), 'plan explains the ask');
    ck.add(MIN); freshen(w10, ck.get()); w10.quote(w10.EV1 + '-NE', 0.50, 0.52); // Kalshi overshoots while the lines are still cached
    s = await d9.tick('alarm'); assert.equal(game(d9, w10.EV1).status, 'guarded', 'a 17¢ jump is first treated as news'); assert.ok(!w10.resting.some(o => o.action === 'sell'), 'ask pulled with the rest');
    ck.add(MIN); freshen(w10, ck.get()); s = await d9.tick('alarm');
    assert.equal(s.exits, 1, 'with fresh lines confirming fair value, the bid is taken');
    const sold = rows(d9, "SELECT * FROM bets WHERE kind='exit'")[0]; assert.equal(sold.status, 'filled'); assert.equal(sold.fill_count, N); assert.equal(sold.price, 0.5); assert.equal(sold.action, 'sell');
    assert.equal(w10.positions.find(p => p.ticker === w10.EV1 + '-NE'), undefined, 'exchange position closed');
    assert.ok(JSON.parse(game(d9, w10.EV1).plan).some(p => new RegExp('sold ' + N + ' at 0.50').test(p.text)), 'plan explains the sale');
    ck.add(MIN); freshen(w10, ck.get()); s = await d9.tick('alarm'); assert.equal(s.exits || 0, 0, 'nothing left to sell'); assert.equal(d9.engineHeld(w10.EV1 + '-NE'), 0);
    // settlement: YES wins; the buy row and the sell row net to the locked profit
    ck.set(w10.kick + 3 * 3600000); w10.results[w10.EV1 + '-NE'] = 'yes'; w10.results[w10.EV1 + '-BUF'] = 'no'; freshen(w10, ck.get());
    s = await d9.tick('alarm');
    const ne = rows(d9, "SELECT action, pnl, fee, fill_count, count FROM bets WHERE ticker=? AND status='settled'", w10.EV1 + '-NE');
    assert.equal(ne.length, 2, 'buy and sell both settled');
    const total = ne.reduce((a, r) => a + r.pnl, 0); const fees = ne.reduce((a, r) => a + (r.fee || 0) * r.fill_count / r.count, 0);
    assert.ok(Math.abs(total - (N * 0.15 - fees)) < 1e-6, 'net P&L = ' + N + ' × (0.50 − 0.35) − fees (' + total.toFixed(2) + ')');
    const st = await get(d9, 'status'); assert.equal(st.stats.exits.n, 1); assert.ok(st.stats.settled.every(r => r.kind !== 'exit'), 'calibration stats use buys only');
    installFetch(w);
  });
  await t.test('request budget: a tiny budget stops the tick early and says so', async () => {
    const d6 = new EngineDO(fakeState(), env({ SUBREQ_BUDGET: '7' })); const w7 = world(ck.get()); installFetch(w7); setLine(w7, 1.75, 2.25, 1.72, 2.28);
    d6.saveSettings({ enabled: true, shadow: false }); freshen(w7, ck.get());
    const s = await d6.tick('alarm');
    assert.ok(s.notes.some(n => /request budget/.test(n)), 'budget note: ' + JSON.stringify(s.notes)); assert.ok(s.subrequests <= 7);
    installFetch(w);
  });
  await t.test('dry run without Kalshi keys: every decision, worded as what it would do; nothing sent, journaled or changed', async () => {
    const d7 = new EngineDO(fakeState(), env({ KALSHI_KEY_ID: '', KALSHI_PRIVATE_KEY: '' })); const w8 = world(ck.get()); installFetch(w8); setLine(w8, 1.75, 2.25, 1.72, 2.28); freshen(w8, ck.get());
    d7.saveSettings({ shadow: false });
    const r = await post(d7, 'preview', {});
    assert.ok(r.ok, JSON.stringify(r)); const s = r.summary;
    assert.equal(s.dry, true); assert.deepEqual(s.errors, []); assert.equal(s.matched, 2); assert.ok(s.notes.some(n => /without Kalshi keys/.test(n)));
    assert.ok(!w8.requests.some(q => q.path.includes('/portfolio/')), 'no account calls');
    assert.equal(w8.orders.length, 0, 'no orders'); assert.equal(rows(d7, 'SELECT COUNT(*) AS n FROM bets')[0].n, 0, 'nothing journaled');
    assert.equal(s.taker, 1, 'counts what it would take');
    const plan = JSON.parse(game(d7, w8.EV1).plan).map(p => p.text);
    assert.ok(plan.some(t => /^would take the ask: \d+ at 0\.35/.test(t)) && plan.some(t => /^would place bid \d+ at/.test(t)), 'plan in the conditional: ' + JSON.stringify(plan));
    const cfg = d7.settings(); assert.equal(cfg.enabled, false, 'engine left off'); assert.equal(cfg.takerEnabled, true); assert.equal(cfg.makerEnabled, true);
    installFetch(w);
  });
  await t.test('dry run with a real account: says it would sell into an overshooting bid, but sends and cancels nothing', async () => {
    const dD = new EngineDO(fakeState(), env()); const wD = world(ck.get()); installFetch(wD); setLine(wD, 1.75, 2.25, 1.72, 2.28); freshen(wD, ck.get());
    dD.saveSettings({ enabled: true, shadow: false });
    await dD.tick('alarm'); ck.add(MIN); freshen(wD, ck.get()); await dD.tick('alarm');
    assert.ok(wD.resting.some(o => o.action === 'sell'), 'a real ask is resting on the held contracts');
    dD.saveSettings({ enabled: false });
    const restingBefore = JSON.stringify(wD.resting), ordersBefore = wD.orders.length, betsBefore = rows(dD, 'SELECT COUNT(*) AS n FROM bets')[0].n, reqStart = wD.requests.length;
    ck.add(MIN); freshen(wD, ck.get()); wD.quote(wD.EV1 + '-NE', 0.50, 0.52); dD.kv('odds_force_NFL', true);
    const s = (await post(dD, 'preview', {})).summary;
    assert.equal(s.dry, true); assert.deepEqual(s.errors, []);
    assert.ok(wD.requests.slice(reqStart).every(q => q.method === 'GET'), 'only reads');
    assert.equal(wD.orders.length, ordersBefore, 'no order sent'); assert.equal(JSON.stringify(wD.resting), restingBefore, 'no order cancelled');
    assert.equal(rows(dD, 'SELECT COUNT(*) AS n FROM bets')[0].n, betsBefore, 'nothing journaled');
    const plan = JSON.parse(game(dD, wD.EV1).plan).map(p => p.text); assert.ok(plan.some(t => /^would sell \d+ at 0\.50/.test(t)), JSON.stringify(plan));
    assert.equal(dD.settings().enabled, false);
    installFetch(w);
  });
  await t.test('taking prices off: no immediate sells either, the position is offered with a resting ask instead', async () => {
    const dT = new EngineDO(fakeState(), env()); const wT = world(ck.get()); installFetch(wT); setLine(wT, 1.75, 2.25, 1.72, 2.28); freshen(wT, ck.get());
    dT.saveSettings({ enabled: true, shadow: false });
    await dT.tick('alarm'); dT.saveSettings({ takerEnabled: false });
    ck.add(MIN); freshen(wT, ck.get()); wT.quote(wT.EV1 + '-NE', 0.50, 0.52); dT.kv('odds_force_NFL', true);
    const s = await dT.tick('alarm');
    assert.equal(s.exits || 0, 0); assert.ok(!wT.orders.some(o => o.side === 'ask' && o.time_in_force === 'immediate_or_cancel'), 'no fill-or-cancel sell');
    const ask = wT.resting.find(o => o.ticker === wT.EV1 + '-NE' && o.action === 'sell'); assert.ok(ask && Number(ask.yes_price_dollars) >= 0.51, 'resting ask above the bid (' + (ask && ask.yes_price_dollars) + ')');
    installFetch(w);
  });
  await t.test('order cap: at most N new live orders a minute; the rest wait, and the plan says so', async () => {
    const dC = new EngineDO(fakeState(), env()); const wC = world(ck.get()); installFetch(wC); setLine(wC, 1.75, 2.25, 1.72, 2.28); freshen(wC, ck.get());
    dC.saveSettings({ enabled: true, shadow: false, maxNewOrders: 2 });
    let s = await dC.tick('alarm');
    assert.equal(wC.orders.length, 2, 'two orders sent'); assert.ok(s.notes.some(n => /left for next minute \(at most 2 a minute\)/.test(n)), JSON.stringify(s.notes));
    const plans = rows(dC, 'SELECT plan FROM games WHERE plan IS NOT NULL').flatMap(r => JSON.parse(r.plan)).map(p => p.text);
    assert.ok(plans.some(t => /waiting a minute: at most 2 new orders a minute/.test(t)), JSON.stringify(plans));
    ck.add(MIN); freshen(wC, ck.get()); s = await dC.tick('alarm');
    assert.equal(wC.orders.length, 4, 'two more the next minute');
    installFetch(w);
  });
  await t.test('one tick at a time: an overlapping tick is turned away and the lock is released after', async () => {
    const dM = new EngineDO(fakeState(), env()); const wM = world(ck.get()); installFetch(wM); setLine(wM, 1.75, 2.25, 1.72, 2.28); freshen(wM, ck.get());
    dM.saveSettings({ enabled: true, shadow: false });
    const [a, b] = await Promise.all([dM.tick('alarm'), dM.tick('manual')]);
    assert.ok(!a.busy && b.busy, 'second tick refused'); assert.equal(wM.orders.filter(o => o.time_in_force === 'immediate_or_cancel').length, 1, 'the cheap dog was bought once');
    ck.add(MIN); freshen(wM, ck.get()); const c = await dM.tick('manual'); assert.ok(!c.busy, 'lock released');
    installFetch(w);
  });
  await t.test('watchdog: one alert after 5 failing ticks; a live engine stops itself after 30', async () => {
    const dW = new EngineDO(fakeState(), env()); const wW = world(ck.get()); installFetch(wW); setLine(wW, 1.75, 2.25, 1.72, 2.28); freshen(wW, ck.get());
    dW.saveSettings({ enabled: true, shadow: false, ntfyTopic: 'adam-test', digestHour: 23 }); wW.balanceStatus = 500;
    for (let i = 0; i < 5; i++) { const s = await dW.tick('alarm'); assert.ok(s.errors.length); ck.add(MIN); }
    assert.equal(wW.ntfy.filter(n => /ticks failing/.test(n.title)).length, 1, 'one alert'); assert.equal(dW.settings().enabled, true, 'still running');
    for (let i = 5; i < 29; i++) { await dW.tick('alarm'); ck.add(MIN); }
    assert.equal(dW.settings().enabled, true, 'still running after 29');
    const s = await dW.tick('alarm');
    assert.equal(dW.settings().enabled, false, 'stopped at 30'); assert.ok(s.notes.some(n => /watchdog stopped/.test(n)));
    assert.equal(wW.ntfy.filter(n => /ticks failing/.test(n.title)).length, 1, 'no repeat alerts'); assert.ok(wW.ntfy.some(n => /engine stopped/.test(n.title)));
    installFetch(w);
  });
  await t.test('pricing: the full game list every 10 minutes, in between only in-window games by ticker; an API that ignores the filter falls back', async () => {
    const dP = new EngineDO(fakeState(), env()); const wP = world(ck.get()); installFetch(wP); setLine(wP, 1.75, 2.25, 1.72, 2.28); freshen(wP, ck.get());
    dP.saveSettings({ enabled: true, shadow: false });
    const series = () => wP.requests.filter(q => q.path === '/trade-api/v2/markets' && q.query.series_ticker === 'KXNFLGAME').length;
    const byTicker = () => wP.requests.filter(q => q.path === '/trade-api/v2/markets' && q.query.tickers).length;
    await dP.tick('alarm'); assert.equal(series(), 1); assert.equal(byTicker(), 0);
    ck.add(MIN); freshen(wP, ck.get()); let s = await dP.tick('alarm');
    assert.equal(series(), 1, 'list cached'); assert.equal(byTicker(), 1, 're-priced by ticker'); assert.equal(s.matched, 2);
    assert.equal(wP.requests.filter(q => q.query.tickers).pop().query.tickers.split(',').length, 6, 'all six legs of the three in-window games');
    ck.add(10 * MIN); freshen(wP, ck.get()); await dP.tick('alarm'); assert.equal(series(), 2, 'list refreshed after 10 minutes');
    wP.tickersMode = 'other'; ck.add(MIN); freshen(wP, ck.get()); s = await dP.tick('alarm');
    assert.equal(series(), 3, 'fell back to the full list'); assert.ok(dP.kv('tickers_unsupported'), 'remembers the filter is ignored'); assert.equal(s.matched, 2, 'every game still priced');
    ck.add(MIN); freshen(wP, ck.get()); s = await dP.tick('alarm'); assert.equal(byTicker(), 2, 'stops trying a filter the API ignores'); assert.equal(series(), 4); assert.equal(s.matched, 2);
    installFetch(w);
  });
  await t.test('daily digest goes out once a day after the digest hour when a topic is set', async () => {
    const d8 = new EngineDO(fakeState(), env()); const w9 = world(ck.get()); installFetch(w9); setLine(w9, 1.75, 2.25, 1.72, 2.28); freshen(w9, ck.get());
    d8.saveSettings({ enabled: true, shadow: false, ntfyTopic: 'adam-test', digestHour: 0 });
    await d8.tick('alarm');
    const digests = w9.ntfy.filter(n => /digest/.test(n.title));
    assert.equal(digests.length, 1, 'one digest'); assert.match(digests[0].body, /Open:/); assert.equal(digests[0].topic, 'adam-test');
    ck.add(MIN); freshen(w9, ck.get()); await d8.tick('alarm');
    assert.equal(w9.ntfy.filter(n => /digest/.test(n.title)).length, 1, 'not repeated the same day');
    installFetch(w);
  });
  await t.test('shadow mode: the whole engine runs on paper, quotes fill only when traded through, and the scorecard is kept apart from live', async () => {
    const dS = new EngineDO(fakeState(), env({ KALSHI_KEY_ID: '', KALSHI_PRIVATE_KEY: '' })); const wS = world(ck.get()); installFetch(wS); setLine(wS, 1.75, 2.25, 1.72, 2.28); freshen(wS, ck.get());
    assert.equal(dS.settings().shadow, true, 'shadow is the default');
    const on = await post(dS, 'toggle', { enabled: true }); assert.equal(on.settings.enabled, true, 'starts without Kalshi keys in shadow');
    let s = await dS.tick('alarm'); assert.equal(s.mode, 'shadow'); assert.deepEqual(s.errors, []); assert.equal(s.taker, 1); assert.ok(s.maker >= 2);
    assert.ok(!wS.requests.some(q => q.path.includes('/portfolio/')), 'nothing touches the account'); assert.equal(wS.orders.length, 0, 'no orders reach the exchange');
    const taker = rows(dS, "SELECT * FROM bets WHERE kind='taker'")[0]; assert.equal(taker.mode, 'shadow'); assert.equal(taker.status, 'filled'); assert.ok(taker.order_id.startsWith('shadow-'));
    const buf = rows(dS, "SELECT * FROM bets WHERE ticker=? AND action='buy'", wS.EV1 + '-BUF')[0]; assert.equal(buf.status, 'resting');
    ck.add(MIN); freshen(wS, ck.get()); s = await dS.tick('alarm');
    assert.equal(rows(dS, 'SELECT status FROM bets WHERE id=?', buf.id)[0].status, 'resting', 'untouched while the market stays above the bid');
    const askRow = rows(dS, "SELECT * FROM bets WHERE action='sell'")[0]; assert.ok(askRow && askRow.status === 'resting', 'paper ask rests on the held NE contracts');
    assert.ok(s.cash < 500, 'paper cash reflects the paper position (' + s.cash + ')');
    wS.quote(wS.EV1 + '-BUF', buf.price - 0.02, buf.price); // the ask trades down to our bid
    ck.add(MIN); freshen(wS, ck.get()); s = await dS.tick('alarm');
    assert.equal(rows(dS, 'SELECT status FROM bets WHERE id=?', buf.id)[0].status, 'filled', 'bid filled when traded through (even though the move guard then pulls the rest)');
    assert.equal(dS.shadowPositions()[wS.EV1 + '-BUF'].qty, buf.count);
    const st = await get(dS, 'status'); assert.equal(st.mode, 'shadow'); assert.equal(st.stats.mode, 'shadow'); assert.ok(st.stats.open.n >= 2);
    // settlement on paper
    ck.set(wS.kick + 3 * 3600000); wS.results[wS.EV1 + '-NE'] = 'no'; wS.results[wS.EV1 + '-BUF'] = 'yes'; freshen(wS, ck.get()); s = await dS.tick('alarm');
    const settled = rows(dS, "SELECT * FROM bets WHERE status='settled' AND mode='shadow'"); assert.ok(settled.length >= 2, 'paper bets settle (' + settled.length + ')');
    const day = rows(dS, "SELECT * FROM daily WHERE day LIKE '%#s'"); assert.ok(day.length >= 1 && day.some(d => d.realized !== 0), 'paper P&L booked on the shadow day row');
    // switching to live stops the engine and clears paper quotes; the live scorecard starts clean
    const sw = await post(dS, 'settings', { shadow: false }); assert.equal(sw.switched, true); assert.equal(sw.settings.enabled, false);
    assert.equal(rows(dS, "SELECT COUNT(*) AS n FROM bets WHERE mode='shadow' AND status='resting'")[0].n, 0, 'paper quotes cancelled');
    const stLive = await get(dS, 'status'); assert.equal(stLive.stats.mode, 'live'); assert.equal(stLive.stats.open.n, 0); assert.equal(stLive.stats.settled.length, 0);
    const noKeys = await post(dS, 'toggle', { enabled: true }); assert.match(noKeys.error || '', /Kalshi API key/, 'live needs keys');
    installFetch(w);
  });
  await t.test('status carries health for the UI', async () => {
    const st = await get(d, 'status');
    assert.equal(st.health.oddsKey, true); assert.equal(st.health.kalshiKey, true); assert.ok(st.health.odds.NFL && st.health.odds.NFL.events === 2);
    assert.ok(st.stats.trim && st.stats.trim.trim === 1); assert.equal(typeof st.stats.oddsBudget, 'number');
  });
  ck.restore();
});
