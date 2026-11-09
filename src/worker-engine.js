/*
 * Edge Desk — trading engine (Durable Object with SQLite journal).
 *
 * Strategy "line anchor": for every Kalshi game market it can match to a sharp sportsbook line, it devigs
 * the line into a fair probability p*, takes Kalshi's price when it is wrong by more than fees plus a margin
 * (fill-or-cancel), otherwise rests its own bid below fair value to earn the spread, stops quoting before
 * kickoff, holds to settlement, and journals every bet with the probabilities it believed.
 *
 * Extra secrets: ODDS_API_KEY (the-odds-api.com). Optional: NTFY_TOPIC (push alerts via ntfy.sh).
 * Test hooks: KALSHI_BASE_OVERRIDE, ODDS_BASE_OVERRIDE (local mocks only).
 */

const ENGINE_DEFAULTS = {
  enabled: false, env: 'prod', bankroll: 500, kelly: 0.25,
  maxPerGame: 25, maxExposure: 150, dailyLoss: 50, maxOpenGames: 12,
  takerMargin: 0.02, makerMargin: 0.03, sharpWeight: 0.8, minBooks: 1, maxSpread: 0.08,
  makerEnabled: true, takerEnabled: true, preKickoffSec: 120, maxHoursAhead: 36,
  sports: { NFL: true, NBA: true, NHL: true, NCAAF: false, NCAAB: false, MLB: false },
  bookmakers: 'pinnacle,lowvig,betonlineag,betfair_ex_eu,draftkings,fanduel,betmgm',
  oddsIntervalSec: 300, oddsIntervalNearSec: 120, ntfyTopic: ''
};
const SPORTS = {
  NFL: { odds: 'americanfootball_nfl', series: 'KXNFLGAME' },
  NBA: { odds: 'basketball_nba', series: 'KXNBAGAME' },
  NHL: { odds: 'icehockey_nhl', series: 'KXNHLGAME' },
  NCAAF: { odds: 'americanfootball_ncaaf', series: 'KXNCAAFGAME' },
  NCAAB: { odds: 'basketball_ncaab', series: 'KXNCAAMBGAME' },
  MLB: { odds: 'baseball_mlb', series: 'KXMLBGAME' }
};
const SHARP_WEIGHT = { pinnacle: 3, lowvig: 2, betonlineag: 2, betfair_ex_eu: 2, circa: 2, draftkings: 1, fanduel: 1, betmgm: 1, caesars: 1, bovada: 1, betrivers: 1 };
const SHARP_SET = new Set(['pinnacle', 'lowvig', 'betonlineag', 'betfair_ex_eu', 'circa']);
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const normName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|fc|sc|cf|afc)\b/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(normName(s).split(' ').filter(t => t.length > 1));
// does Kalshi's team label (e.g. "SF 49ers", "San Francisco") refer to the sportsbook team ("San Francisco 49ers")?
function teamMatch(kalshiLabel, bookTeam) {
  const a = tokens(kalshiLabel), b = tokens(bookTeam);
  if (!a.size || !b.size) return false;
  let hit = 0; for (const t of a) if (b.has(t)) hit++;
  if (hit === 0) return false;
  const nickA = normName(kalshiLabel).split(' ').pop(), nickB = normName(bookTeam).split(' ').pop();
  return nickA === nickB || hit >= Math.min(2, a.size);
}
function parseEventDate(eventTicker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})/.exec(eventTicker || '');
  if (!m || !(m[2] in MONTHS)) return null;
  return Date.UTC(2000 + parseInt(m[1], 10), MONTHS[m[2]], parseInt(m[3], 10), 12, 0, 0);
}
function devig2(pA, pB) { const s = pA + pB; return s > 0 ? [pA / s, pB / s] : [null, null]; }
function todayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
function feeFor(count, price, kind, feeInfo) {
  const type = (feeInfo && feeInfo.fee_type) || 'quadratic'; const mult = Number((feeInfo && feeInfo.fee_multiplier) || 1) || 1;
  let rate = 0;
  if (kind === 'taker') rate = 0.07 * mult;
  else if (type === 'quadratic_with_maker_fees') rate = 0.0175 * mult;
  else if (type === 'quadratic_with_combo_maker_fees') rate = 0.035 * mult;
  if (rate <= 0 || !(count > 0)) return 0;
  return Math.ceil(rate * count * price * (1 - price) * 10000 - 1e-9) / 10000;
}
function kellyCount(p, price, fee, bankroll, frac, capDollars) {
  const cost = price + fee; if (!(cost > 0) || cost >= 1 || !(p > cost)) return 0;
  const f = (p - cost) / (1 - cost) * frac;
  const dollars = Math.min(bankroll * f, capDollars);
  return Math.max(0, Math.floor(dollars / cost));
}

class EngineDO {
  constructor(state, env) {
    this.state = state; this.env = env; this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, sport TEXT, event_ticker TEXT, home TEXT, away TEXT, commence_ts INTEGER, home_ticker TEXT, away_ticker TEXT, p_home REAL, p_away REAL, books INTEGER, sharp_ts INTEGER, k_home_bid REAL, k_home_ask REAL, k_away_bid REAL, k_away_ask REAL, k_ts INTEGER, status TEXT, note TEXT, updated_ts INTEGER, plan TEXT);
      CREATE TABLE IF NOT EXISTS bets (id TEXT PRIMARY KEY, ts INTEGER, game_id TEXT, ticker TEXT, team TEXT, side TEXT, kind TEXT, count REAL, price REAL, fee REAL, p_sharp REAL, p_market REAL, p_star REAL, edge REAL, order_id TEXT, status TEXT, fill_count REAL, result TEXT, pnl REAL, settled_ts INTEGER, note TEXT);
      CREATE TABLE IF NOT EXISTS log (ts INTEGER, level TEXT, msg TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, realized REAL DEFAULT 0, fees REAL DEFAULT 0, bets INTEGER DEFAULT 0, taker_bets INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS bets_status ON bets(status); CREATE INDEX IF NOT EXISTS log_ts ON log(ts);`);
    try { this.sql.exec('ALTER TABLE games ADD COLUMN plan TEXT'); } catch (e) { /* column exists */ }
  }
  /* ---------- settings / log ---------- */
  settings() {
    const row = this.sql.exec("SELECT value FROM settings WHERE key='config'").toArray()[0];
    const cfg = Object.assign({}, ENGINE_DEFAULTS, row ? JSON.parse(row.value) : {});
    cfg.sports = Object.assign({}, ENGINE_DEFAULTS.sports, cfg.sports || {});
    return cfg;
  }
  saveSettings(patch) {
    const cur = this.settings(); const next = Object.assign({}, cur, patch || {});
    if (patch && patch.sports) next.sports = Object.assign({}, cur.sports, patch.sports);
    this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('config', ?)", JSON.stringify(next));
    return next;
  }
  kv(key, value) {
    if (value === undefined) { const r = this.sql.exec('SELECT value FROM settings WHERE key=?', key).toArray()[0]; return r ? JSON.parse(r.value) : null; }
    this.sql.exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }
  log(level, msg, data) {
    this.sql.exec('INSERT INTO log (ts, level, msg, data) VALUES (?, ?, ?, ?)', Date.now(), level, String(msg).slice(0, 500), data === undefined ? null : JSON.stringify(data).slice(0, 2000));
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM log').toArray()[0].n;
    if (n > 600) this.sql.exec('DELETE FROM log WHERE ts IN (SELECT ts FROM log ORDER BY ts ASC LIMIT ?)', n - 500);
  }
  async notify(title, body) {
    const cfg = this.settings(); const topic = (cfg.ntfyTopic || this.env.NTFY_TOPIC || '').trim();
    if (!topic) return;
    try { await fetch('https://ntfy.sh/' + encodeURIComponent(topic), { method: 'POST', headers: { 'Title': title, 'Tags': 'chart_with_upwards_trend' }, body: body }); } catch (e) { /* best effort */ }
  }
  /* ---------- Kalshi + odds I/O ---------- */
  kalshiBase(cfg) {
    if (this.env.KALSHI_BASE_OVERRIDE) return this.env.KALSHI_BASE_OVERRIDE.replace(/\/+$/, '');
    return cfg.env === 'demo' ? 'https://external-api.demo.kalshi.co/trade-api/v2' : 'https://external-api.kalshi.com/trade-api/v2';
  }
  async kalshi(cfg, method, path, query, body, signed) {
    const base = this.kalshiBase(cfg);
    const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
    const headers = { 'Accept': 'application/json', 'User-Agent': 'EdgeDesk-Engine/1.0' };
    if (signed) {
      const s = await EdgeDeskAccount._internal.signer(this.env, cfg.env === 'demo' ? 'demo' : 'prod');
      if (!s) throw new Error('no Kalshi API key configured for ' + cfg.env);
      Object.assign(headers, await s.headers(method, new URL(base).pathname + path));
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (!res.ok) { const e = data && (data.error || data); throw new Error('Kalshi ' + res.status + ' ' + path + ': ' + ((e && (e.message || e.code)) || text.slice(0, 120))); }
    return data;
  }
  async fetchOdds(cfg, sportKey) {
    const key = (this.env.ODDS_API_KEY || '').trim(); if (!key) throw new Error('ODDS_API_KEY not set on the Worker');
    const base = (this.env.ODDS_BASE_OVERRIDE || 'https://api.the-odds-api.com').replace(/\/+$/, '');
    const u = new URL(base + '/v4/sports/' + sportKey + '/odds');
    u.searchParams.set('apiKey', key); u.searchParams.set('markets', 'h2h'); u.searchParams.set('oddsFormat', 'decimal'); u.searchParams.set('dateFormat', 'unix');
    u.searchParams.set('bookmakers', cfg.bookmakers || ENGINE_DEFAULTS.bookmakers);
    const res = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
    const remaining = res.headers.get('x-requests-remaining'); if (remaining !== null) this.kv('odds_remaining', Number(remaining));
    if (!res.ok) throw new Error('Odds API ' + res.status + ': ' + (await res.text()).slice(0, 160));
    return res.json();
  }
  // weighted devigged consensus per event → [{home, away, commence, pHome, pAway, books}]
  consensus(events) {
    const out = [];
    for (const ev of events || []) {
      let wsum = 0, ph = 0, books = 0, sharp = 0;
      for (const bk of ev.bookmakers || []) {
        const mk = (bk.markets || []).find(m => m.key === 'h2h'); if (!mk) continue;
        const oh = (mk.outcomes || []).find(o => o.name === ev.home_team), oa = (mk.outcomes || []).find(o => o.name === ev.away_team);
        if (!oh || !oa || !(oh.price > 1) || !(oa.price > 1)) continue;
        const [h] = devig2(1 / oh.price, 1 / oa.price); if (h === null) continue;
        const w = SHARP_WEIGHT[bk.key] || 1; wsum += w; ph += h * w; books++; if (SHARP_SET.has(bk.key)) sharp++;
      }
      if (!books) continue;
      const commence = typeof ev.commence_time === 'number' ? ev.commence_time * 1000 : Date.parse(ev.commence_time);
      out.push({ id: ev.id, home: ev.home_team, away: ev.away_team, commence, pHome: ph / wsum, pAway: 1 - ph / wsum, books, sharp });
    }
    return out;
  }
  async seriesFee(cfg, series) {
    const c = this.kv('series_' + series); if (c && Date.now() - c.at < 6 * 3600000) return c.info;
    let info = { fee_type: 'quadratic', fee_multiplier: 1 };
    try { const r = await this.kalshi(cfg, 'GET', '/series/' + series, null); const s = r.series || r; info = { fee_type: s.fee_type || 'quadratic', fee_multiplier: Number(s.fee_multiplier || 1) || 1 }; } catch (e) { /* default */ }
    this.kv('series_' + series, { at: Date.now(), info }); return info;
  }
  /* ---------- the tick ---------- */
  async tick(reason) {
    const cfg = this.settings();
    const now = Date.now();
    const summary = { ts: now, reason, enabled: cfg.enabled, matched: 0, unmatched: 0, taker: 0, maker: 0, cancels: 0, errors: [] };
    if (!cfg.enabled) { this.kv('last_tick', Object.assign(summary, { note: 'engine off' })); return summary; }
    try {
      const st = await this.kalshi(cfg, 'GET', '/exchange/status', null);
      if (!st.trading_active) { this.kv('last_tick', Object.assign(summary, { note: 'exchange closed' })); return summary; }
      // account + daily stop
      const bal = await this.kalshi(cfg, 'GET', '/portfolio/balance', null, undefined, true);
      const cash = Number(bal.balance_dollars) || (Number(bal.balance) || 0) / 100;
      const day = this.sql.exec('SELECT * FROM daily WHERE day=?', todayKey(now)).toArray()[0] || { realized: 0, fees: 0, bets: 0 };
      if (day.realized <= -Math.abs(cfg.dailyLoss)) { this.saveSettings({ enabled: false }); await this.state.storage.deleteAlarm(); this.log('warn', 'Daily loss stop hit; engine disabled', { realized: day.realized }); await this.notify('Edge Desk engine stopped', 'Daily loss stop hit: ' + day.realized.toFixed(2)); try { await this.flatten(Object.assign({}, cfg, { enabled: false })); } catch (e) { /* best effort */ } this.kv('last_tick', Object.assign(summary, { note: 'daily stop' })); return summary; }
      const posRes = await this.kalshi(cfg, 'GET', '/portfolio/positions', { settlement_status: 'unsettled', count_filter: 'position', limit: '200' }, undefined, true);
      const positions = {}; for (const p of posRes.market_positions || []) { const q = Number(p.position_fp !== undefined ? p.position_fp : (p.position || 0)); positions[p.ticker] = { qty: q, exposure: Number(p.market_exposure_dollars) || (Number(p.market_exposure) || 0) / 100 }; }
      const ordRes = await this.kalshi(cfg, 'GET', '/portfolio/orders', { status: 'resting', limit: '200' }, undefined, true);
      const resting = (ordRes.orders || []).map(o => ({ id: o.order_id, ticker: o.ticker, side: o.side, action: o.action, yes: Number(o.yes_price_dollars !== undefined ? o.yes_price_dollars : (o.yes_price || 0) / 100), remaining: Number(o.remaining_count_fp !== undefined ? o.remaining_count_fp : (o.remaining_count || 0)), client: o.client_order_id }));
      const ourOrderIds = new Set(this.sql.exec("SELECT order_id FROM bets WHERE status IN ('resting','partial') AND order_id IS NOT NULL").toArray().map(r => r.order_id));
      // exposure across all unsettled positions (engine + manual): conservative
      let exposure = 0; for (const t in positions) exposure += positions[t].exposure;
      for (const o of resting) exposure += o.remaining * (o.side === 'yes' ? o.yes : 1 - o.yes);
      summary.cash = cash; summary.exposure = exposure;

      // discover game markets per enabled sport
      for (const sport in SPORTS) {
        if (!cfg.sports[sport]) continue;
        const spec = SPORTS[sport];
        let markets = [];
        try { let cursor = ''; for (let p = 0; p < 5; p++) { const r = await this.kalshi(cfg, 'GET', '/markets', { series_ticker: spec.series, status: 'open', limit: '200', cursor: cursor || undefined }); markets = markets.concat(r.markets || []); cursor = r.cursor || ''; if (!cursor) break; } }
        catch (e) { summary.errors.push(sport + ': ' + e.message); continue; }
        const byEvent = {};
        for (const m of markets) { if (!m.event_ticker) continue; (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m); }
        const eventDates = Object.keys(byEvent).map(k => parseEventDate(k)).filter(Boolean);
        const soonest = eventDates.length ? Math.min(...eventDates) : null;
        if (!Object.keys(byEvent).length) continue;
        // odds (rate-limited)
        const oc = this.kv('odds_' + sport) || { at: 0, list: [] };
        const near = soonest !== null && soonest - now < 3 * 3600000;
        const interval = (near ? cfg.oddsIntervalNearSec : cfg.oddsIntervalSec) * 1000;
        summary.odds = summary.odds || {};
        if (now - oc.at > interval) {
          try { const raw = await this.fetchOdds(cfg, spec.odds); oc.list = this.consensus(raw); oc.at = now; this.kv('odds_' + sport, oc); summary.odds[sport] = 'fetched ' + oc.list.length + ' events'; }
          catch (e) { summary.errors.push(sport + ' odds: ' + e.message); summary.odds[sport] = 'fetch failed'; if (!oc.list.length) continue; }
        } else summary.odds[sport] = 'cached ' + Math.round((now - oc.at) / 1000) + 's ago (' + oc.list.length + ' events)';
        const feeInfo = await this.seriesFee(cfg, spec.series);
        for (const eventTicker in byEvent) {
          const legs = byEvent[eventTicker].filter(m => (m.market_type || 'binary') === 'binary');
          if (legs.length !== 2) continue; // moneyline events have exactly two team legs
          const evDate = parseEventDate(eventTicker);
          const label = (m) => m.yes_sub_title || m.title || m.ticker;
          // match to a consensus event by teams and date
          let match = null;
          for (const c of oc.list) {
            if (evDate !== null && Math.abs(c.commence - evDate) > 40 * 3600000) continue;
            const l0h = teamMatch(label(legs[0]), c.home), l0a = teamMatch(label(legs[0]), c.away), l1h = teamMatch(label(legs[1]), c.home), l1a = teamMatch(label(legs[1]), c.away);
            if ((l0h && l1a) || (l0a && l1h)) { match = { c, homeLeg: l0h ? legs[0] : legs[1], awayLeg: l0h ? legs[1] : legs[0] }; break; }
          }
          const g = { id: eventTicker, sport, event_ticker: eventTicker, updated_ts: now };
          if (!match) {
            summary.unmatched++;
            this.sql.exec('INSERT OR REPLACE INTO games (id, sport, event_ticker, home, away, commence_ts, home_ticker, away_ticker, status, note, updated_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)', g.id, sport, eventTicker, label(legs[0]), label(legs[1]), evDate, legs[0].ticker, legs[1].ticker, 'unmatched', oc.list.length ? 'no sportsbook line matched these team names' : 'no odds loaded', now);
            continue;
          }
          summary.matched++;
          const { c, homeLeg, awayLeg } = match;
          const px = (m) => ({ bid: Number(m.yes_bid_dollars !== undefined ? m.yes_bid_dollars : (m.yes_bid || 0) / 100), ask: Number(m.yes_ask_dollars !== undefined ? m.yes_ask_dollars : (m.yes_ask || 100) / 100), askSize: Number(m.yes_ask_size_fp || 0), bidSize: Number(m.yes_bid_size_fp || 0) });
          const H = px(homeLeg), A = px(awayLeg);
          const secsToKick = (c.commence - now) / 1000;
          let status = secsToKick <= cfg.preKickoffSec ? 'live' : (secsToKick > cfg.maxHoursAhead * 3600 ? 'far' : 'active');
          if (c.books < cfg.minBooks || (cfg.minBooks <= 1 && c.sharp === 0 && c.books < 3)) status = 'thin';
          this.sql.exec('INSERT OR REPLACE INTO games (id, sport, event_ticker, home, away, commence_ts, home_ticker, away_ticker, p_home, p_away, books, sharp_ts, k_home_bid, k_home_ask, k_away_bid, k_away_ask, k_ts, status, note, updated_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            g.id, sport, eventTicker, c.home, c.away, c.commence, homeLeg.ticker, awayLeg.ticker, c.pHome, c.pAway, c.books, oc.at, H.bid, H.ask, A.bid, A.ask, now, status, status === 'live' ? 'kickoff passed; not quoting' : status === 'far' ? 'beyond horizon' : status === 'thin' ? 'not enough sharp books' : '', now);
          // cancel our resting orders on games that are live or lost their match
          const legTickers = [homeLeg.ticker, awayLeg.ticker];
          if (status !== 'active') { for (const o of resting) if (legTickers.includes(o.ticker) && ourOrderIds.has(o.id)) { await this.cancel(cfg, o, 'kickoff or horizon'); summary.cancels++; } continue; }
          // per-game inventory
          const gameExposure = legTickers.reduce((s, t) => s + ((positions[t] && positions[t].exposure) || 0), 0) + resting.filter(o => legTickers.includes(o.ticker)).reduce((s, o) => s + o.remaining * (o.side === 'yes' ? o.yes : 1 - o.yes), 0);
          const openGames = new Set(Object.keys(positions).map(t => t.replace(/-[A-Z0-9]+$/, ''))).size;
          const plan = [];
          const note = (team, text, extra) => plan.push(Object.assign({ team, text }, extra || {}));
          let liveExposure = gameExposure;
          for (const [leg, pSharp, team] of [[homeLeg, c.pHome, c.home], [awayLeg, c.pAway, c.away]]) {
            const P = px(leg); if (!(P.bid >= 0) || !(P.ask <= 1)) { note(team, 'no quote on Kalshi'); continue; }
            const mid = P.bid > 0 && P.ask < 1 ? (P.bid + P.ask) / 2 : pSharp;
            const pStar = cfg.sharpWeight * pSharp + (1 - cfg.sharpWeight) * mid;
            const spread = P.ask - P.bid;
            const room = Math.max(0, Math.min(cfg.maxPerGame - liveExposure, cfg.maxExposure - exposure, cash - 1));
            const base = { pSharp: +pSharp.toFixed(4), pStar: +pStar.toFixed(4), bid: P.bid, ask: P.ask };
            if (room < 1) { note(team, 'no room under the per-game or total exposure cap', base); continue; }
            if (openGames >= cfg.maxOpenGames && !positions[leg.ticker]) { note(team, 'max open games reached', base); continue; }
            // taker: buy YES on this leg when the ask is cheap vs p*
            if (cfg.takerEnabled && P.ask < 1 && P.ask > 0.02 && spread <= cfg.maxSpread + 1e-6) {
              const fee1 = feeFor(1, P.ask, 'taker', feeInfo);
              if (P.ask + fee1 + cfg.takerMargin <= pStar + 1e-9) {
                let count = kellyCount(pStar, P.ask, fee1, cfg.bankroll, cfg.kelly, room);
                count = Math.min(count, Math.floor(P.askSize || count));
                if (count >= 1) {
                  const r = await this.place(cfg, { ticker: leg.ticker, team, side: 'yes', action: 'buy', count, limit: P.ask, tif: 'ioc', kind: 'taker', pSharp, pMarket: mid, pStar, edge: pStar - P.ask - fee1, gameId: g.id, fee: feeFor(count, P.ask, 'taker', feeInfo) });
                  if (r) { summary.taker++; exposure += count * P.ask; liveExposure += count * P.ask; }
                  note(team, 'took the ask: ' + count + ' at ' + P.ask.toFixed(2) + ' (edge ' + ((pStar - P.ask - fee1) * 100).toFixed(1) + '¢)', base);
                  continue; // one action per leg per tick
                }
              }
            }
            // maker: rest a bid below fair value (post-only, GTC)
            if (cfg.makerEnabled) {
              if (spread < 0.02 - 1e-6) { note(team, 'spread too tight to quote inside (' + (spread * 100).toFixed(0) + '¢)', base); continue; }
              const makerFee1 = feeFor(1, Math.max(0.01, pStar - cfg.makerMargin), 'maker', feeInfo);
              let want = Math.round(Math.floor((pStar - cfg.makerMargin - makerFee1) * 100 + 1e-9)) / 100;
              if (want >= P.ask - 1e-9) want = Math.round((P.ask - 0.01) * 100) / 100; // never cross as a maker
              if (want < 0.02) { note(team, 'fair value too low to quote', base); continue; }
              const mine = resting.filter(o => o.ticker === leg.ticker && o.side === 'yes' && o.action === 'buy' && ourOrderIds.has(o.id));
              const keep = mine.find(o => Math.abs(o.yes - want) < 0.005);
              for (const o of mine) if (o !== keep) { await this.cancel(cfg, o, 'requote'); summary.cancels++; exposure -= o.remaining * o.yes; liveExposure -= o.remaining * o.yes; }
              if (keep) { note(team, 'resting bid ' + keep.remaining + ' at ' + want.toFixed(2) + ' (fair ' + pStar.toFixed(2) + ')', base); continue; }
              const roomNow = Math.max(0, Math.min(cfg.maxPerGame - liveExposure, cfg.maxExposure - exposure, cash - 1));
              const count = kellyCount(pStar, want, makerFee1, cfg.bankroll, cfg.kelly, roomNow);
              if (count < 1) { note(team, 'edge too small to size a bid at ' + want.toFixed(2), base); continue; }
              const r = await this.place(cfg, { ticker: leg.ticker, team, side: 'yes', action: 'buy', count, limit: want, tif: 'gtc', postOnly: true, kind: 'maker', pSharp, pMarket: mid, pStar, edge: pStar - want - makerFee1, gameId: g.id, fee: feeFor(count, want, 'maker', feeInfo) });
              if (r) { summary.maker++; exposure += count * want; liveExposure += count * want; note(team, 'placed bid ' + count + ' at ' + want.toFixed(2) + ' (fair ' + pStar.toFixed(2) + ')', base); }
              else note(team, 'bid rejected; see log', base);
            } else note(team, 'maker quoting off', base);
          }
          this.sql.exec('UPDATE games SET plan=? WHERE id=?', JSON.stringify(plan), g.id);
        }
      }
      summary.exposure = Math.round(exposure * 100) / 100;
      await this.reconcile(cfg, resting, now);
      await this.settle(cfg);
    } catch (e) {
      summary.errors.push(e.message);
      this.log('error', 'tick failed', { error: e.message });
    }
    this.kv('last_tick', summary);
    return summary;
  }
  async place(cfg, o) {
    const lim = EdgeDeskAccount._internal.limits(this.env);
    const t = EdgeDeskAccount._internal.toV2Order({ ticker: o.ticker, side: o.side, action: o.action, count: o.count, limit: o.limit, tif: o.tif, postOnly: o.postOnly }, lim);
    if (t.error) { this.log('warn', 'order blocked by Worker caps', { ticker: o.ticker, error: t.error }); return null; }
    const id = crypto.randomUUID();
    try {
      const r = await this.kalshi(cfg, 'POST', '/portfolio/events/orders', null, t.body, true);
      const filled = Number(r.fill_count || 0), remaining = Number(r.remaining_count || 0);
      const status = o.tif === 'gtc' ? (filled > 0 && remaining > 0 ? 'partial' : (filled > 0 ? 'filled' : 'resting')) : (filled > 0 ? 'filled' : 'cancelled');
      const avg = r.average_fill_price !== undefined && filled > 0 ? Number(r.average_fill_price) : o.limit;
      this.sql.exec('INSERT INTO bets (id, ts, game_id, ticker, team, side, kind, count, price, fee, p_sharp, p_market, p_star, edge, order_id, status, fill_count, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, Date.now(), o.gameId, o.ticker, o.team, o.side, o.kind, o.count, avg, o.fee, o.pSharp, o.pMarket, o.pStar, o.edge, r.order_id || null, status, filled, o.tif);
      this.sql.exec('INSERT INTO daily (day, bets, taker_bets) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET bets = bets + 1, taker_bets = taker_bets + ?', todayKey(Date.now()), o.kind === 'taker' ? 1 : 0, o.kind === 'taker' ? 1 : 0);
      this.log('info', (o.kind === 'taker' ? 'Took ' : 'Quoted ') + o.count + ' YES ' + o.ticker + ' @ ' + o.limit.toFixed(2) + ' (p*=' + o.pStar.toFixed(3) + ', sharp=' + o.pSharp.toFixed(3) + ') → ' + status, { filled, remaining });
      if (o.kind === 'taker' && filled > 0) await this.notify('Edge Desk: bought ' + filled + ' YES ' + o.team, o.ticker + ' at ' + avg.toFixed(2) + ' · fair ' + o.pStar.toFixed(2) + ' · edge ' + (o.edge * 100).toFixed(1) + '¢');
      return r;
    } catch (e) { this.log('error', 'order failed ' + o.ticker, { error: e.message }); return null; }
  }
  async cancel(cfg, o, why) {
    try {
      await this.kalshi(cfg, 'DELETE', '/portfolio/events/orders/' + encodeURIComponent(o.id), { exchange_index: '-1', market_ticker: o.ticker }, undefined, true);
      this.sql.exec("UPDATE bets SET status = CASE WHEN fill_count > 0 THEN 'filled' ELSE 'cancelled' END, note = ? WHERE order_id = ?", why, o.id);
      this.log('info', 'Cancelled ' + o.ticker + ' @ ' + o.yes.toFixed(2) + ' (' + why + ')');
    } catch (e) { this.log('error', 'cancel failed ' + o.ticker, { error: e.message }); }
  }
  // sync resting-order fill state from the exchange
  // Sync resting-order state with the exchange. `resting` is the snapshot taken at `snapshotTs`; orders placed after it are left alone.
  async reconcile(cfg, resting, snapshotTs) {
    const open = this.sql.exec("SELECT * FROM bets WHERE status IN ('resting','partial') AND order_id IS NOT NULL AND ts < ?", snapshotTs - 500).toArray();
    for (const b of open) {
      const o = resting.find(x => x.id === b.order_id);
      if (o) { const filled = Math.max(0, b.count - o.remaining); if (Math.abs(filled - (b.fill_count || 0)) > 1e-9) { this.sql.exec("UPDATE bets SET fill_count=?, status=? WHERE id=?", filled, filled > 0 ? 'partial' : 'resting', b.id); } continue; }
      // gone from the snapshot: ask the exchange for its final state
      try {
        const r = await this.kalshi(cfg, 'GET', '/portfolio/orders/' + encodeURIComponent(b.order_id), null, undefined, true); const ord = r.order || r;
        const filled = Number(ord.fill_count_fp !== undefined ? ord.fill_count_fp : (ord.fill_count || 0));
        const stillOpen = ord.status === 'resting' || ord.status === 'pending';
        const status = stillOpen ? (filled > 0 ? 'partial' : 'resting') : (filled > 0 ? 'filled' : 'cancelled');
        this.sql.exec("UPDATE bets SET fill_count=?, status=?, price=? WHERE id=?", filled, status, filled > 0 && ord.yes_price_dollars !== undefined ? Number(ord.yes_price_dollars) : b.price, b.id);
      } catch (e) { this.sql.exec("UPDATE bets SET status='filled', note='assumed filled (order not found)' WHERE id=? AND fill_count > 0", b.id); this.sql.exec("UPDATE bets SET status='cancelled' WHERE id=? AND (fill_count IS NULL OR fill_count = 0)", b.id); }
    }
  }
  async settle(cfg) {
    const rows = this.sql.exec("SELECT b.*, g.commence_ts FROM bets b LEFT JOIN games g ON g.id = b.game_id WHERE b.status IN ('filled','partial') AND b.fill_count > 0 AND (g.commence_ts IS NULL OR g.commence_ts < ?)", Date.now() - 2 * 3600000).toArray();
    const seen = {};
    for (const b of rows) {
      if (!(b.ticker in seen)) { try { const r = await this.kalshi(cfg, 'GET', '/markets/' + encodeURIComponent(b.ticker), null); seen[b.ticker] = (r.market || r).result || ''; } catch (e) { seen[b.ticker] = ''; } }
      const result = seen[b.ticker];
      if (result !== 'yes' && result !== 'no') continue;
      const won = result === b.side;
      const pnl = b.fill_count * (won ? (1 - b.price) : -b.price) - (b.fee || 0) * (b.fill_count / Math.max(1, b.count));
      this.sql.exec("UPDATE bets SET status='settled', result=?, pnl=?, settled_ts=? WHERE id=?", result, pnl, Date.now(), b.id);
      this.sql.exec('INSERT INTO daily (day, realized, fees, bets) VALUES (?, ?, ?, 0) ON CONFLICT(day) DO UPDATE SET realized = realized + ?, fees = fees + ?', todayKey(Date.now()), pnl, b.fee || 0, pnl, b.fee || 0);
      this.log('info', 'Settled ' + b.ticker + ' ' + result.toUpperCase() + ' → ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2));
    }
  }
  async flatten(cfg) {
    const ordRes = await this.kalshi(cfg, 'GET', '/portfolio/orders', { status: 'resting', limit: '200' }, undefined, true);
    const ours = new Set(this.sql.exec("SELECT order_id FROM bets WHERE status IN ('resting','partial') AND order_id IS NOT NULL").toArray().map(r => r.order_id));
    let n = 0; for (const o of ordRes.orders || []) if (ours.has(o.order_id)) { await this.cancel(cfg, { id: o.order_id, ticker: o.ticker, yes: Number(o.yes_price_dollars || 0) }, 'flatten'); n++; }
    return n;
  }
  stats() {
    const settled = this.sql.exec("SELECT kind, COUNT(*) AS n, SUM(pnl) AS pnl, SUM(CASE WHEN result = side THEN 1 ELSE 0 END) AS wins, SUM((p_star - CASE WHEN result = side THEN 1 ELSE 0 END) * (p_star - CASE WHEN result = side THEN 1 ELSE 0 END)) AS brier_sum, SUM((p_market - CASE WHEN result = side THEN 1 ELSE 0 END) * (p_market - CASE WHEN result = side THEN 1 ELSE 0 END)) AS brier_mkt, SUM(fill_count * price) AS staked FROM bets WHERE status='settled' GROUP BY kind").toArray();
    const open = this.sql.exec("SELECT COUNT(*) AS n, SUM(fill_count * price) AS staked FROM bets WHERE status IN ('filled','partial')").toArray()[0];
    const resting = this.sql.exec("SELECT COUNT(*) AS n FROM bets WHERE status IN ('resting','partial')").toArray()[0];
    const days = this.sql.exec('SELECT * FROM daily ORDER BY day DESC LIMIT 30').toArray();
    return { settled, open, resting, days, oddsRemaining: this.kv('odds_remaining') };
  }
  async ensureAlarm() {
    const cfg = this.settings();
    const cur = await this.state.storage.getAlarm();
    if (cfg.enabled && (cur === null || cur < Date.now() - 5000)) await this.state.storage.setAlarm(Date.now() + 5000);
    if (!cfg.enabled && cur !== null) await this.state.storage.deleteAlarm();
  }
  async alarm() {
    const cfg = this.settings();
    if (!cfg.enabled) return;
    try { await this.tick('alarm'); } catch (e) { this.log('error', 'alarm tick failed', { error: e.message }); }
    if (this.settings().enabled) await this.state.storage.setAlarm(Date.now() + 60000);
  }
  async fetch(request) {
    const url = new URL(request.url);
    const sub = url.pathname.replace(/^\/engine\/?/, '').replace(/\/+$/, '');
    const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    try {
      if (sub === 'cron') { await this.ensureAlarm(); const cfg = this.settings(); const last = this.kv('last_tick'); if (cfg.enabled && (!last || Date.now() - last.ts > 90000)) await this.tick('cron'); return json({ ok: true }); }
      if (sub === 'status') return json({ settings: this.settings(), lastTick: this.kv('last_tick'), stats: this.stats(), oddsKey: !!(this.env.ODDS_API_KEY || '').trim(), ntfy: !!((this.settings().ntfyTopic || this.env.NTFY_TOPIC || '').trim()), alarm: await this.state.storage.getAlarm() });
      if (sub === 'settings' && request.method === 'POST') { const patch = await request.json(); delete patch.enabled; const next = this.saveSettings(patch); this.log('info', 'settings changed', patch); return json({ ok: true, settings: next }); }
      if (sub === 'toggle' && request.method === 'POST') {
        const b = await request.json(); const on = !!b.enabled;
        if (on && !(this.env.ODDS_API_KEY || '').trim()) return json({ error: 'ODDS_API_KEY is not set on the Worker' }, 400);
        const next = this.saveSettings({ enabled: on }); this.log('info', on ? 'Engine enabled' : 'Engine disabled');
        if (on) { await this.state.storage.setAlarm(Date.now() + 1000); } else { await this.state.storage.deleteAlarm(); if (b.flatten) await this.flatten(next); }
        return json({ ok: true, settings: next });
      }
      if (sub === 'tick' && request.method === 'POST') { const cfg = this.settings(); if (!cfg.enabled) return json({ error: 'engine is off' }, 400); const s = await this.tick('manual'); return json({ ok: true, summary: s }); }
      if (sub === 'preview' && request.method === 'POST') { const cfg = this.settings(); const was = cfg.enabled; this.saveSettings({ enabled: true, takerEnabled: false, makerEnabled: false }); const s = await this.tick('preview'); this.saveSettings({ enabled: was, takerEnabled: cfg.takerEnabled, makerEnabled: cfg.makerEnabled }); return json({ ok: true, summary: s }); }
      if (sub === 'flatten' && request.method === 'POST') { const n = await this.flatten(this.settings()); return json({ ok: true, cancelled: n }); }
      if (sub === 'games') return json({ games: this.sql.exec('SELECT * FROM games WHERE updated_ts > ? ORDER BY commence_ts ASC', Date.now() - 6 * 3600000).toArray() });
      if (sub === 'bets') return json({ bets: this.sql.exec('SELECT * FROM bets ORDER BY ts DESC LIMIT 200').toArray() });
      if (sub === 'log') return json({ log: this.sql.exec('SELECT * FROM log ORDER BY ts DESC LIMIT 120').toArray() });
      return json({ error: 'unknown engine route' }, 404);
    } catch (e) { return json({ error: e.message }, 500); }
  }
}

const EdgeDeskEngine = { EngineDO, _internal: { teamMatch, parseEventDate, devig2, feeFor, kellyCount, normName, ENGINE_DEFAULTS, SPORTS } };
