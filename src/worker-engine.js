/*
 * Edge Desk — trading engine (Durable Object with SQLite journal).
 *
 * Strategy "line anchor": for every Kalshi game market it can match to a sharp sportsbook line, it devigs
 * the line into a fair probability p*, takes Kalshi's price when it is wrong by more than fees plus a margin
 * (fill-or-cancel), otherwise rests its own bid below fair value to earn the spread, stops quoting before
 * kickoff, holds to settlement, and journals every bet with the probabilities it believed.
 *
 * v2 additions: per-book staleness filter and disagreement measure, power-method devig (multiplicative kept
 * for comparison), confidence-scaled sizing, a move guard (Kalshi moved since the lines were fetched → pull
 * quotes, refresh lines, act next minute), closing-line value per bet with automatic per-sport brakes, a
 * sharp-lines credit scheduler, a per-tick subrequest budget, and a daily digest.
 *
 * Extra secrets: ODDS_API_KEY (the-odds-api.com). Optional: NTFY_TOPIC (push alerts via ntfy.sh), SUBREQ_BUDGET.
 * Test hooks: KALSHI_BASE_OVERRIDE, ODDS_BASE_OVERRIDE (local mocks only).
 */

const ENGINE_DEFAULTS = {
  enabled: false, env: 'prod', bankroll: 500, kelly: 0.25,
  maxPerGame: 25, maxExposure: 150, dailyLoss: 50, maxOpenGames: 12,
  takerMargin: 0.02, makerMargin: 0.03, sharpWeight: 0.8, minBooks: 1, maxSpread: 0.08,
  makerEnabled: true, takerEnabled: true, preKickoffSec: 120, maxHoursAhead: 36,
  sports: { NFL: true, NBA: true, NHL: true, NCAAF: false, NCAAB: false, MLB: false },
  bookmakers: 'pinnacle,lowvig,betonlineag,betfair_ex_eu,draftkings,fanduel,betmgm',
  oddsIntervalSec: 300, oddsIntervalNearSec: 120, ntfyTopic: '',
  // v2
  devig: 'power', maxOddsAgeMin: 15, maxDisagree: 0.05, moveGuard: 0.03, staleBookMin: 20,
  brakeMinBets: 20, brakeDays: 7, brakeClv: -0.005, trimMinBets: 30, digestHour: 9, timezone: 'America/New_York'
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
const DAY = 86400000;

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
// Multiplicative devig: scale implied probabilities to sum to one (loads the margin evenly).
function devig2(pA, pB) { const s = pA + pB; return s > 0 ? [pA / s, pB / s] : [null, null]; }
// Power devig: find k so that Σ q_i^k = 1. Loads more of the margin onto the longshot, which is where
// sharp books put it (favourite–longshot bias); for near-even games it equals the multiplicative answer.
function devigPower(qs) {
  if (!qs.every(q => q > 0 && q < 1)) return devig2(qs[0], qs[1]);
  const f = (k) => qs.reduce((s, q) => s + Math.pow(q, k), 0) - 1;
  let lo = 0.5, hi = 4;
  if (f(lo) < 0 || f(hi) > 0) return devig2(qs[0], qs[1]); // no root in range (degenerate quotes)
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
  const k = (lo + hi) / 2;
  return qs.map(q => Math.pow(q, k));
}
function todayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
function hourIn(tz, ts) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour: 'numeric', hour12: false }).format(new Date(ts))) % 24; } catch (e) { return new Date(ts).getUTCHours(); }
}
function dayIn(tz, ts) {
  try { const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)); return p.slice(0, 10); } catch (e) { return todayKey(ts); }
}
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
const tsOf = (v) => v === undefined || v === null ? null : (typeof v === 'number' ? (v > 1e11 ? v : v * 1000) : Date.parse(v));
const wstd = (xs, ws) => { const W = ws.reduce((a, b) => a + b, 0); if (!(W > 0) || xs.length < 2) return 0; const m = xs.reduce((a, x, i) => a + x * ws[i], 0) / W; return Math.sqrt(xs.reduce((a, x, i) => a + ws[i] * (x - m) * (x - m), 0) / W); };

// Weighted devigged consensus per event. Books whose line is much older than the freshest one are dropped
// when the game is close (a book that stopped updating after news is the classic trap). Returns per event:
// pHome/pAway (chosen method), pMult/pPow (both methods), books, sharp, disp (weighted std dev of the books'
// home probabilities), age (ms since the freshest sharp line, or freshest line when no sharp book).
function consensus(events, now, cfg) {
  const method = (cfg && cfg.devig) || 'power'; const staleMs = ((cfg && cfg.staleBookMin) || 20) * 60000;
  const out = [];
  for (const ev of events || []) {
    const commence = tsOf(ev.commence_time);
    if (commence === null || isNaN(commence)) continue; // cannot manage kickoff without a start time
    const rows = [];
    for (const bk of ev.bookmakers || []) {
      const mk = (bk.markets || []).find(m => m.key === 'h2h'); if (!mk) continue;
      const oh = (mk.outcomes || []).find(o => o.name === ev.home_team), oa = (mk.outcomes || []).find(o => o.name === ev.away_team);
      if (!oh || !oa || !(oh.price > 1) || !(oa.price > 1)) continue;
      const q = [1 / oh.price, 1 / oa.price];
      const [mh] = devig2(q[0], q[1]); const [ph] = devigPower(q);
      if (mh === null) continue;
      const upd = tsOf(mk.last_update !== undefined ? mk.last_update : bk.last_update);
      rows.push({ key: bk.key, w: SHARP_WEIGHT[bk.key] || 1, sharp: SHARP_SET.has(bk.key), pMult: mh, pPow: ph, upd: upd === null || isNaN(upd) ? now : upd });
    }
    if (!rows.length) continue;
    const freshest = Math.max(...rows.map(r => r.upd));
    const near = commence !== null && !isNaN(commence) && commence - now < 3 * 3600000;
    let use = near ? rows.filter(r => freshest - r.upd <= staleMs) : rows;
    if (!use.length) use = rows;
    const dropped = rows.length - use.length;
    let W = 0, sm = 0, sp = 0, sharp = 0;
    for (const r of use) { W += r.w; sm += r.pMult * r.w; sp += r.pPow * r.w; if (r.sharp) sharp++; }
    const pMult = sm / W, pPow = sp / W;
    const pHome = method === 'mult' ? pMult : pPow;
    const sharpRows = use.filter(r => r.sharp);
    const age = Math.max(0, now - Math.max(...(sharpRows.length ? sharpRows : use).map(r => r.upd)));
    out.push({ id: ev.id, home: ev.home_team, away: ev.away_team, commence, pHome, pAway: 1 - pHome, pMult, pPow, books: use.length, sharp, disp: wstd(use.map(r => method === 'mult' ? r.pMult : r.pPow), use.map(r => r.w)), age, dropped, keys: use.map(r => r.key) });
  }
  return out;
}
// How much to trust a consensus line right now: 1 = full size, 0 = do not trade. `cacheAge` is how long ago
// the odds were fetched; the book's own age is added on top.
function confidence(c, cfg, secsToKick, cacheAge) {
  let conf = 1; const why = [];
  const maxDis = (cfg && cfg.maxDisagree) || 0.05;
  const cents = (v) => Math.round(v * 100) + '¢';
  if (c.sharp === 0) { conf *= 0.5; why.push('no sharp book in the line'); }
  else if (c.books < 2) { conf *= 0.75; why.push('a single book sets the line'); }
  if (c.books >= 2) {
    if (c.disp >= maxDis) return { conf: 0, why: ['books disagree by ' + cents(c.disp)] };
    if (c.disp >= maxDis / 2) { conf *= 0.5; why.push('books disagree by ' + cents(c.disp)); }
  }
  const ageMin = ((c.age || 0) + (cacheAge || 0)) / 60000;
  const near = secsToKick < 3 * 3600;
  if (near && ageMin > 45) return { conf: 0, why: ['sharp line is ' + Math.round(ageMin) + ' min old this close to kickoff'] };
  if (near && ageMin > 15) { conf *= 0.5; why.push('sharp line ' + Math.round(ageMin) + ' min old'); }
  return { conf, why };
}
// Sharp-lines credit scheduler: spread the remaining monthly credits so the engine never goes dark mid-month.
function oddsBudget(remaining, usedToday) {
  if (remaining === null || remaining === undefined) return { daily: Infinity, left: Infinity };
  const daily = Math.max(4, Math.floor(remaining / 31));
  return { daily, left: Math.max(0, daily - (usedToday || 0)) };
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
    const add = (t, def) => { try { this.sql.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + def); } catch (e) { /* exists */ } };
    add('games', 'plan TEXT');
    for (const d of ['conf REAL', 'disp REAL', 'line_age INTEGER', 'p_mult REAL', 'p_pow REAL', 'anchor_ts INTEGER', 'anchor_home REAL', 'anchor_away REAL', 'close_p_home REAL', 'close_p_away REAL', 'close_k_home REAL', 'close_k_away REAL', 'closed_ts INTEGER', 'conf_why TEXT']) add('games', d);
    for (const d of ['sport TEXT', 'conf REAL', 'p_mult REAL', 'p_pow REAL', 'clv REAL', 'clv_mkt REAL']) add('bets', d);
    this.sub = 0; this.subMax = Number(env.SUBREQ_BUDGET) || 45;
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
    if (value === null) { this.sql.exec('DELETE FROM settings WHERE key=?', key); return; }
    this.sql.exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }
  log(level, msg, data) {
    this.sql.exec('INSERT INTO log (ts, level, msg, data) VALUES (?, ?, ?, ?)', Date.now(), level, String(msg).slice(0, 500), data === undefined ? null : JSON.stringify(data).slice(0, 2000));
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM log').toArray()[0].n;
    if (n > 600) this.sql.exec('DELETE FROM log WHERE ts IN (SELECT ts FROM log ORDER BY ts ASC LIMIT ?)', n - 500);
  }
  async notify(title, body, tags) {
    const cfg = this.settings(); const topic = (cfg.ntfyTopic || this.env.NTFY_TOPIC || '').trim();
    if (!topic) return;
    try { this.sub++; await fetch('https://ntfy.sh/' + encodeURIComponent(topic), { method: 'POST', headers: { 'Title': title, 'Tags': tags || 'chart_with_upwards_trend' }, body: body }); } catch (e) { /* best effort */ }
  }
  /* ---------- Kalshi + odds I/O ---------- */
  kalshiBase(cfg) {
    if (this.env.KALSHI_BASE_OVERRIDE) return this.env.KALSHI_BASE_OVERRIDE.replace(/\/+$/, '');
    return cfg.env === 'demo' ? 'https://external-api.demo.kalshi.co/trade-api/v2' : 'https://external-api.kalshi.com/trade-api/v2';
  }
  budgetLeft() { return this.subMax - this.sub; }
  async kalshi(cfg, method, path, query, body, signed) {
    const base = this.kalshiBase(cfg);
    const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
    const headers = { 'Accept': 'application/json', 'User-Agent': 'EdgeDesk-Engine/2.0' };
    if (signed) {
      const s = await EdgeDeskAccount._internal.signer(this.env, cfg.env === 'demo' ? 'demo' : 'prod');
      if (!s) throw new Error('no Kalshi API key configured for ' + cfg.env);
      Object.assign(headers, await s.headers(method, new URL(base).pathname + path));
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    this.sub++;
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
    this.sub++;
    const res = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
    const remaining = res.headers.get('x-requests-remaining'); if (remaining !== null) this.kv('odds_remaining', Number(remaining));
    const used = this.kv('odds_used') || { day: '', n: 0 }; const day = todayKey(Date.now());
    this.kv('odds_used', { day, n: (used.day === day ? used.n : 0) + 1, at: Date.now() });
    if (!res.ok) throw new Error('Odds API ' + res.status + ': ' + (await res.text()).slice(0, 160));
    return res.json();
  }
  oddsUsedToday() { const u = this.kv('odds_used'); return u && u.day === todayKey(Date.now()) ? u.n : 0; }
  async seriesFee(cfg, series) {
    const c = this.kv('series_' + series); if (c && Date.now() - c.at < 6 * 3600000) return c.info;
    let info = { fee_type: 'quadratic', fee_multiplier: 1 };
    try { const r = await this.kalshi(cfg, 'GET', '/series/' + series, null); const s = r.series || r; info = { fee_type: s.fee_type || 'quadratic', fee_multiplier: Number(s.fee_multiplier || 1) || 1 }; } catch (e) { /* default */ }
    this.kv('series_' + series, { at: Date.now(), info }); return info;
  }
  brakes() { const b = this.kv('brakes') || {}; const now = Date.now(); let changed = false; for (const k in b) if (b[k].until <= now) { delete b[k]; changed = true; } if (changed) this.kv('brakes', b); return b; }
  // Sizing trim when the model has been worse calibrated than the market over enough settled bets.
  modelTrim(cfg) {
    const r = this.sql.exec("SELECT COUNT(*) AS n, SUM((p_star - w) * (p_star - w)) AS bs, SUM((p_market - w) * (p_market - w)) AS bm FROM (SELECT p_star, p_market, CASE WHEN result = side THEN 1.0 ELSE 0.0 END AS w FROM bets WHERE status='settled' AND p_market IS NOT NULL)").toArray()[0];
    if (!r || r.n < (cfg.trimMinBets || 30)) return { trim: 1, n: r ? r.n : 0 };
    const model = r.bs / r.n, market = r.bm / r.n;
    return { trim: model > market + 0.005 ? 0.5 : 1, n: r.n, model, market };
  }
  /* ---------- the tick ---------- */
  async tick(reason) {
    const cfg = this.settings();
    const now = Date.now();
    this.sub = 0;
    const summary = { ts: now, reason, enabled: cfg.enabled, matched: 0, unmatched: 0, taker: 0, maker: 0, cancels: 0, guarded: 0, errors: [], notes: [] };
    if (!cfg.enabled) { this.kv('last_tick', Object.assign(summary, { note: 'engine off' })); return summary; }
    try {
      const st = await this.kalshi(cfg, 'GET', '/exchange/status', null);
      if (!st.trading_active) { this.kv('last_tick', Object.assign(summary, { note: 'exchange closed' })); return summary; }
      // account + daily stop (a dry run without Kalshi keys assumes an empty account)
      const signer = await EdgeDeskAccount._internal.signer(this.env, cfg.env === 'demo' ? 'demo' : 'prod');
      let cash, positions = {}, resting = [];
      if (!signer) {
        if (reason !== 'preview') throw new Error('no Kalshi API key configured for ' + cfg.env);
        cash = cfg.bankroll; summary.notes.push('dry run without Kalshi keys: account assumed empty');
      } else {
        const bal = await this.kalshi(cfg, 'GET', '/portfolio/balance', null, undefined, true);
        cash = Number(bal.balance_dollars) || (Number(bal.balance) || 0) / 100;
        const day = this.sql.exec('SELECT * FROM daily WHERE day=?', todayKey(now)).toArray()[0] || { realized: 0, fees: 0, bets: 0 };
        if (day.realized <= -Math.abs(cfg.dailyLoss)) { this.saveSettings({ enabled: false }); await this.state.storage.deleteAlarm(); this.log('warn', 'Daily loss stop hit; engine disabled', { realized: day.realized }); await this.notify('Edge Desk engine stopped', 'Daily loss stop hit: ' + day.realized.toFixed(2), 'octagonal_sign'); try { await this.flatten(Object.assign({}, cfg, { enabled: false })); } catch (e) { /* best effort */ } this.kv('last_tick', Object.assign(summary, { note: 'daily stop' })); return summary; }
        const posRes = await this.kalshi(cfg, 'GET', '/portfolio/positions', { settlement_status: 'unsettled', count_filter: 'position', limit: '200' }, undefined, true);
        for (const p of posRes.market_positions || []) { const q = Number(p.position_fp !== undefined ? p.position_fp : (p.position || 0)); positions[p.ticker] = { qty: q, exposure: Number(p.market_exposure_dollars) || (Number(p.market_exposure) || 0) / 100 }; }
        const ordRes = await this.kalshi(cfg, 'GET', '/portfolio/orders', { status: 'resting', limit: '200' }, undefined, true);
        resting = (ordRes.orders || []).map(o => ({ id: o.order_id, ticker: o.ticker, side: o.side, action: o.action, yes: Number(o.yes_price_dollars !== undefined ? o.yes_price_dollars : (o.yes_price || 0) / 100), remaining: Number(o.remaining_count_fp !== undefined ? o.remaining_count_fp : (o.remaining_count || 0)), client: o.client_order_id }));
      }
      const ourOrderIds = new Set(this.sql.exec("SELECT order_id FROM bets WHERE status IN ('resting','partial') AND order_id IS NOT NULL").toArray().map(r => r.order_id));
      // exposure across all unsettled positions (engine + manual): conservative
      let exposure = 0; for (const t in positions) exposure += positions[t].exposure;
      for (const o of resting) exposure += o.remaining * (o.side === 'yes' ? o.yes : 1 - o.yes);
      summary.cash = cash; summary.exposure = exposure;
      const brakes = this.brakes(); const trim = this.modelTrim(cfg); summary.trim = trim.trim;
      if (trim.trim < 1) summary.notes.push('sizing halved: the market has been better calibrated than the model over ' + trim.n + ' settled bets');
      const pull = async (legTickers, why) => { for (const o of resting) if (legTickers.includes(o.ticker) && ourOrderIds.has(o.id) && !o.pulled) { await this.cancel(cfg, o, why); o.pulled = true; summary.cancels++; exposure -= o.remaining * (o.side === 'yes' ? o.yes : 1 - o.yes); } };

      // discover game markets per enabled sport; sports with the soonest games go first so the credit budget favours them
      const sportsOn = Object.keys(SPORTS).filter(s => cfg.sports[s]);
      const discovered = [];
      for (const sport of sportsOn) {
        if (this.budgetLeft() < 6) { summary.notes.push('request budget reached before ' + sport + '; next minute'); break; }
        const spec = SPORTS[sport];
        let markets = [];
        try { let cursor = ''; for (let p = 0; p < 5; p++) { const r = await this.kalshi(cfg, 'GET', '/markets', { series_ticker: spec.series, status: 'open', limit: '200', cursor: cursor || undefined }); markets = markets.concat(r.markets || []); cursor = r.cursor || ''; if (!cursor) break; } }
        catch (e) { summary.errors.push(sport + ': ' + e.message); continue; }
        const byEvent = {};
        for (const m of markets) { if (!m.event_ticker) continue; (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m); }
        const eventDates = Object.keys(byEvent).map(k => parseEventDate(k)).filter(Boolean);
        const soonest = eventDates.length ? Math.min(...eventDates) : null;
        if (!Object.keys(byEvent).length) continue;
        discovered.push({ sport, spec, byEvent, soonest });
      }
      discovered.sort((a, b) => (a.soonest === null ? Infinity : a.soonest) - (b.soonest === null ? Infinity : b.soonest));
      summary.odds = summary.odds || {};
      const budget = oddsBudget(this.kv('odds_remaining'), this.oddsUsedToday()); let fetchesLeft = budget.left;
      summary.oddsBudget = { daily: budget.daily === Infinity ? null : budget.daily, usedToday: this.oddsUsedToday(), remaining: this.kv('odds_remaining') };
      for (const { sport, spec, byEvent, soonest } of discovered) {
        if (this.budgetLeft() < 6) { summary.notes.push('request budget reached before ' + sport + ' games; next minute'); break; }
        // odds: fetch only when a game is inside the horizon, at the near/far cadence, within the credit budget; a move guard forces a refresh
        const oc = this.kv('odds_' + sport) || { at: 0, list: [] };
        const inHorizon = soonest !== null && soonest - now < (cfg.maxHoursAhead + 12) * 3600000; // event tickers carry a date, not a time: allow a half-day of slack
        const near = soonest !== null && soonest - now < 3 * 3600000;
        const interval = (near ? cfg.oddsIntervalNearSec : cfg.oddsIntervalSec) * 1000;
        const force = !!this.kv('odds_force_' + sport);
        if (!inHorizon) summary.odds[sport] = 'no games inside the horizon; lines not fetched';
        else if (force || now - oc.at > interval) {
          if (fetchesLeft <= 0 && !force) summary.odds[sport] = 'credit budget for today used (' + budget.daily + '); lines ' + Math.round((now - oc.at) / 60000) + ' min old';
          else {
            try { const raw = await this.fetchOdds(cfg, spec.odds); oc.list = consensus(raw, now, cfg); oc.at = now; oc.raw = raw.length; this.kv('odds_' + sport, oc); this.kv('odds_force_' + sport, null); fetchesLeft--; summary.odds[sport] = 'fetched ' + oc.list.length + ' events' + (force ? ' (forced by a move guard)' : ''); }
            catch (e) { summary.errors.push(sport + ' odds: ' + e.message); summary.odds[sport] = 'fetch failed; lines ' + (oc.at ? Math.round((now - oc.at) / 60000) + ' min old' : 'never loaded'); }
          }
        } else summary.odds[sport] = 'cached ' + Math.round((now - oc.at) / 1000) + 's ago (' + oc.list.length + ' events)';
        const oddsAge = oc.at ? now - oc.at : Infinity;
        const linesStale = oddsAge > cfg.maxOddsAgeMin * 60000;
        const braked = brakes[sport];
        const feeInfo = await this.seriesFee(cfg, spec.series);
        for (const eventTicker in byEvent) {
          if (this.budgetLeft() < 4) { summary.notes.push('request budget reached inside ' + sport + '; rest next minute'); break; }
          const legs = byEvent[eventTicker].filter(m => (m.market_type || 'binary') === 'binary');
          if (legs.length !== 2) continue; // moneyline events have exactly two team legs
          const evDate = parseEventDate(eventTicker);
          const label = (m) => m.yes_sub_title || m.title || m.ticker;
          // match to a consensus event by teams and date
          let match = null;
          for (const c of oc.list) {
            if (evDate !== null && c.commence !== null && Math.abs(c.commence - evDate) > 40 * 3600000) continue;
            const l0h = teamMatch(label(legs[0]), c.home), l0a = teamMatch(label(legs[0]), c.away), l1h = teamMatch(label(legs[1]), c.home), l1a = teamMatch(label(legs[1]), c.away);
            if ((l0h && l1a) || (l0a && l1h)) { match = { c, homeLeg: l0h ? legs[0] : legs[1], awayLeg: l0h ? legs[1] : legs[0] }; break; }
          }
          const g = { id: eventTicker, sport, event_ticker: eventTicker, updated_ts: now };
          const prev = this.sql.exec('SELECT status, p_home, commence_ts, anchor_ts, anchor_home, anchor_away, closed_ts FROM games WHERE id=?', g.id).toArray()[0] || {};
          if (!match) {
            summary.unmatched++;
            if (prev.p_home !== null && prev.p_home !== undefined && prev.commence_ts && prev.commence_ts <= now) {
              // a game we had a line for has started and the books stopped publishing it: keep what we knew, pull any quotes
              this.sql.exec("UPDATE games SET status='live', note='in play; the books no longer publish a line', plan='[]', updated_ts=? WHERE id=?", now, g.id);
              await pull([legs[0].ticker, legs[1].ticker], 'kickoff');
              continue;
            }
            this.sql.exec('INSERT OR REPLACE INTO games (id, sport, event_ticker, home, away, commence_ts, home_ticker, away_ticker, status, note, updated_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)', g.id, sport, eventTicker, label(legs[0]), label(legs[1]), evDate, legs[0].ticker, legs[1].ticker, 'unmatched', oc.list.length ? 'no sportsbook line matched these team names' : (inHorizon ? 'no lines loaded yet' : 'outside the trading horizon'), now);
            continue;
          }
          summary.matched++;
          const { c, homeLeg, awayLeg } = match;
          const px = (m) => ({ bid: Number(m.yes_bid_dollars !== undefined ? m.yes_bid_dollars : (m.yes_bid || 0) / 100), ask: Number(m.yes_ask_dollars !== undefined ? m.yes_ask_dollars : (m.yes_ask || 100) / 100), askSize: Number(m.yes_ask_size_fp || 0), bidSize: Number(m.yes_bid_size_fp || 0) });
          const H = px(homeLeg), A = px(awayLeg);
          const midOf = (P) => P.bid > 0 && P.ask < 1 ? (P.bid + P.ask) / 2 : null;
          const secsToKick = (c.commence - now) / 1000;
          const cf = confidence(c, cfg, secsToKick, oddsAge);
          let status = secsToKick <= cfg.preKickoffSec ? 'live' : (secsToKick > cfg.maxHoursAhead * 3600 ? 'far' : 'active');
          let note = status === 'live' ? 'kickoff passed; not quoting' : status === 'far' ? 'beyond horizon' : '';
          if (status === 'active' && (c.books < cfg.minBooks || (cfg.minBooks <= 1 && c.sharp === 0 && c.books < 3))) { status = 'thin'; note = 'not enough sharp books'; }
          if (status === 'active' && linesStale) { status = 'stale'; note = 'lines are ' + Math.round(oddsAge / 60000) + ' min old; not trading until refreshed'; }
          if (status === 'active' && cf.conf === 0) { status = 'disputed'; note = cf.why.join('; '); }
          if (status === 'active' && braked) { status = 'braked'; note = 'sport paused by the engine: ' + braked.reason; }
          // move guard: Kalshi moved since these lines were fetched → pull quotes, refresh lines, decide next minute
          let anchorHome = prev.anchor_home, anchorAway = prev.anchor_away, anchorTs = prev.anchor_ts;
          const hm = midOf(H), am = midOf(A);
          if (anchorTs !== oc.at || anchorHome === null || anchorHome === undefined) { anchorTs = oc.at; anchorHome = hm; anchorAway = am; }
          let moved = 0;
          if (status === 'active' && hm !== null && anchorHome !== null && anchorHome !== undefined) moved = Math.max(moved, Math.abs(hm - anchorHome));
          if (status === 'active' && am !== null && anchorAway !== null && anchorAway !== undefined) moved = Math.max(moved, Math.abs(am - anchorAway));
          if (status === 'active' && moved >= cfg.moveGuard - 1e-9) { status = 'guarded'; note = 'Kalshi moved ' + Math.round(moved * 100) + '¢ since the lines were fetched; refreshing lines before acting'; if (now - oc.at > 60000) this.kv('odds_force_' + sport, true); summary.guarded++; }
          this.sql.exec('INSERT INTO games (id, sport, event_ticker, home, away, commence_ts, home_ticker, away_ticker, p_home, p_away, books, sharp_ts, k_home_bid, k_home_ask, k_away_bid, k_away_ask, k_ts, status, note, updated_ts, conf, disp, line_age, p_mult, p_pow, anchor_ts, anchor_home, anchor_away, conf_why) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sport=excluded.sport, event_ticker=excluded.event_ticker, home=excluded.home, away=excluded.away, commence_ts=excluded.commence_ts, home_ticker=excluded.home_ticker, away_ticker=excluded.away_ticker, p_home=excluded.p_home, p_away=excluded.p_away, books=excluded.books, sharp_ts=excluded.sharp_ts, k_home_bid=excluded.k_home_bid, k_home_ask=excluded.k_home_ask, k_away_bid=excluded.k_away_bid, k_away_ask=excluded.k_away_ask, k_ts=excluded.k_ts, status=excluded.status, note=excluded.note, updated_ts=excluded.updated_ts, conf=excluded.conf, disp=excluded.disp, line_age=excluded.line_age, p_mult=excluded.p_mult, p_pow=excluded.p_pow, anchor_ts=excluded.anchor_ts, anchor_home=excluded.anchor_home, anchor_away=excluded.anchor_away, conf_why=excluded.conf_why',
            g.id, sport, eventTicker, c.home, c.away, c.commence, homeLeg.ticker, awayLeg.ticker, c.pHome, c.pAway, c.books, oc.at, H.bid, H.ask, A.bid, A.ask, now, status, note, now, cf.conf, c.disp, Math.round(c.age + oddsAge), c.pMult, c.pPow, anchorTs, anchorHome, anchorAway, cf.why.join('; '));
          const legTickers = [homeLeg.ticker, awayLeg.ticker];
          // closing line: the last tick before kickoff (lines at most a couple of minutes old) records the books' final fair value and Kalshi's last mid
          if (status === 'live' && !prev.closed_ts) {
            this.sql.exec('UPDATE games SET close_p_home=?, close_p_away=?, close_k_home=?, close_k_away=?, closed_ts=? WHERE id=?', c.pHome, c.pAway, hm, am, now, g.id);
            const n = this.scoreClosed(g.id);
            if (n) { const scored = this.sql.exec('SELECT COUNT(*) AS n, AVG(clv) AS clv FROM bets WHERE game_id=? AND clv IS NOT NULL', g.id).toArray()[0]; this.log('info', 'Closing line ' + c.away + ' at ' + c.home + ': ' + scored.n + ' fill' + (scored.n > 1 ? 's' : '') + ', CLV ' + (scored.clv >= 0 ? '+' : '') + (scored.clv * 100).toFixed(1) + '¢'); }
          }
          // cancel our resting orders on games we must not be quoting
          if (status !== 'active') { await pull(legTickers, status === 'guarded' ? 'move guard' : status === 'stale' ? 'stale lines' : status === 'disputed' ? 'books disagree' : status === 'braked' ? 'sport braked' : 'kickoff or horizon'); this.sql.exec("UPDATE games SET plan='[]' WHERE id=?", g.id); continue; }
          // per-game inventory
          const gameExposure = legTickers.reduce((s, t) => s + ((positions[t] && positions[t].exposure) || 0), 0) + resting.filter(o => legTickers.includes(o.ticker) && !o.pulled).reduce((s, o) => s + o.remaining * (o.side === 'yes' ? o.yes : 1 - o.yes), 0);
          const openGames = new Set(Object.keys(positions).map(t => t.replace(/-[A-Z0-9]+$/, ''))).size;
          const plan = [];
          const pnote = (team, text, extra) => plan.push(Object.assign({ team, text }, extra || {}));
          let liveExposure = gameExposure;
          const sizeBank = cfg.bankroll * cf.conf * trim.trim;
          for (const [leg, pSharp, team, pM, pP] of [[homeLeg, c.pHome, c.home, c.pMult, c.pPow], [awayLeg, c.pAway, c.away, 1 - c.pMult, 1 - c.pPow]]) {
            const P = px(leg); if (!(P.bid >= 0) || !(P.ask <= 1)) { pnote(team, 'no quote on Kalshi'); continue; }
            const mid = midOf(P) !== null ? midOf(P) : pSharp;
            const pStar = cfg.sharpWeight * pSharp + (1 - cfg.sharpWeight) * mid;
            const spread = P.ask - P.bid;
            const room = Math.max(0, Math.min(cfg.maxPerGame - liveExposure, cfg.maxExposure - exposure, cash - 1));
            const base = { pSharp: +pSharp.toFixed(4), pStar: +pStar.toFixed(4), bid: P.bid, ask: P.ask, conf: cf.conf, confWhy: cf.why.join('; '), trim: trim.trim, books: c.books, disp: +c.disp.toFixed(4) };
            if (room < 1) { pnote(team, 'no room under the per-game or total exposure cap', base); continue; }
            if (openGames >= cfg.maxOpenGames && !positions[leg.ticker]) { pnote(team, 'max open games reached', base); continue; }
            if (this.budgetLeft() < 3) { pnote(team, 'request budget for this minute used; next minute', base); continue; }
            // taker: buy YES on this leg when the ask is cheap vs p*; add to a position only once the lines have been refreshed since the last buy
            if (cfg.takerEnabled && P.ask < 1 && P.ask > 0.02 && spread <= cfg.maxSpread + 1e-6) {
              const fee1 = feeFor(1, P.ask, 'taker', feeInfo);
              if (P.ask + fee1 + cfg.takerMargin <= pStar + 1e-9) {
                const lastTake = this.sql.exec("SELECT MAX(ts) AS ts FROM bets WHERE ticker=? AND kind='taker' AND fill_count > 0", leg.ticker).toArray()[0];
                if (lastTake && lastTake.ts !== null && oc.at <= lastTake.ts) { pnote(team, 'still cheap, but already bought at this line; waiting for fresh lines before adding', base); continue; }
                {
                  let count = kellyCount(pStar, P.ask, fee1, sizeBank, cfg.kelly, room);
                  count = Math.min(count, Math.floor(P.askSize || count));
                  if (count >= 1) {
                    const r = await this.place(cfg, { ticker: leg.ticker, team, side: 'yes', action: 'buy', count, limit: P.ask, tif: 'ioc', kind: 'taker', pSharp, pMarket: mid, pStar, edge: pStar - P.ask - fee1, gameId: g.id, fee: feeFor(count, P.ask, 'taker', feeInfo), sport, conf: cf.conf, pMult: pM, pPow: pP });
                    if (r) { summary.taker++; exposure += count * P.ask; liveExposure += count * P.ask; }
                    pnote(team, 'took the ask: ' + count + ' at ' + P.ask.toFixed(2) + ' (edge ' + ((pStar - P.ask - fee1) * 100).toFixed(1) + '¢' + (cf.conf < 1 ? ', sized at ' + Math.round(cf.conf * trim.trim * 100) + '%' : '') + ')', base);
                    continue; // one action per leg per tick
                  } else if (cf.conf < 1) { pnote(team, 'cheap vs fair, but confidence ' + Math.round(cf.conf * 100) + '% (' + cf.why.join('; ') + ') sizes it below one contract', base); continue; }
                }
              }
            }
            // maker: rest a bid below fair value (post-only, GTC)
            if (cfg.makerEnabled) {
              if (spread < 0.02 - 1e-6) { pnote(team, 'spread too tight to quote inside (' + (spread * 100).toFixed(0) + '¢)', base); continue; }
              const makerFee1 = feeFor(1, Math.max(0.01, pStar - cfg.makerMargin), 'maker', feeInfo);
              let want = Math.round(Math.floor((pStar - cfg.makerMargin - makerFee1) * 100 + 1e-9)) / 100;
              if (want >= P.ask - 1e-9) want = Math.round((P.ask - 0.01) * 100) / 100; // never cross as a maker
              if (want < 0.02) { pnote(team, 'fair value too low to quote', base); continue; }
              const mine = resting.filter(o => o.ticker === leg.ticker && o.side === 'yes' && o.action === 'buy' && ourOrderIds.has(o.id) && !o.pulled);
              const keep = mine.find(o => Math.abs(o.yes - want) < 0.005);
              for (const o of mine) if (o !== keep) { await this.cancel(cfg, o, 'requote'); o.pulled = true; summary.cancels++; exposure -= o.remaining * o.yes; liveExposure -= o.remaining * o.yes; }
              if (keep) { pnote(team, 'resting bid ' + keep.remaining + ' at ' + want.toFixed(2) + ' (fair ' + pStar.toFixed(2) + ')', base); continue; }
              const roomNow = Math.max(0, Math.min(cfg.maxPerGame - liveExposure, cfg.maxExposure - exposure, cash - 1));
              const count = kellyCount(pStar, want, makerFee1, sizeBank, cfg.kelly, roomNow);
              if (count < 1) { pnote(team, 'edge too small to size a bid at ' + want.toFixed(2) + (cf.conf < 1 ? ' at ' + Math.round(cf.conf * trim.trim * 100) + '% confidence' : ''), base); continue; }
              const r = await this.place(cfg, { ticker: leg.ticker, team, side: 'yes', action: 'buy', count, limit: want, tif: 'gtc', postOnly: true, kind: 'maker', pSharp, pMarket: mid, pStar, edge: pStar - want - makerFee1, gameId: g.id, fee: feeFor(count, want, 'maker', feeInfo), sport, conf: cf.conf, pMult: pM, pPow: pP });
              if (r) { summary.maker++; exposure += count * want; liveExposure += count * want; pnote(team, 'placed bid ' + count + ' at ' + want.toFixed(2) + ' (fair ' + pStar.toFixed(2) + (cf.conf < 1 ? ', sized at ' + Math.round(cf.conf * trim.trim * 100) + '%' : '') + ')', base); }
              else pnote(team, 'bid rejected; see log', base);
            } else pnote(team, 'maker quoting off', base);
          }
          this.sql.exec('UPDATE games SET plan=? WHERE id=?', JSON.stringify(plan), g.id);
        }
      }
      summary.exposure = Math.round(exposure * 100) / 100;
      summary.oddsBudget = { daily: oddsBudget(this.kv('odds_remaining'), 0).daily === Infinity ? null : oddsBudget(this.kv('odds_remaining'), 0).daily, usedToday: this.oddsUsedToday(), remaining: this.kv('odds_remaining') };
      if (signer) {
        await this.reconcile(cfg, resting, now);
        this.scoreClosed(); // fills that reconcile just learned about on games already past their closing line
        await this.settle(cfg);
        this.evaluateBrakes(cfg);
        await this.maybeDigest(cfg, now);
      }
    } catch (e) {
      summary.errors.push(e.message);
      this.log('error', 'tick failed', { error: e.message });
    }
    summary.subrequests = this.sub;
    this.kv('last_tick', summary);
    return summary;
  }
  async place(cfg, o) {
    const lim = EdgeDeskAccount._internal.limits(this.env);
    const t = EdgeDeskAccount._internal.toV2Order({ ticker: o.ticker, side: o.side, action: o.action, count: o.count, limit: o.limit, tif: o.tif, postOnly: o.postOnly }, lim);
    if (t.error) { this.log('warn', 'order blocked by Worker caps', { ticker: o.ticker, error: t.error }); return null; }
    if (this.budgetLeft() < 2) { this.log('warn', 'order skipped: request budget for this minute used', { ticker: o.ticker }); return null; }
    const id = crypto.randomUUID();
    try {
      const r = await this.kalshi(cfg, 'POST', '/portfolio/events/orders', null, t.body, true);
      const filled = Number(r.fill_count || 0), remaining = Number(r.remaining_count || 0);
      const status = o.tif === 'gtc' ? (filled > 0 && remaining > 0 ? 'partial' : (filled > 0 ? 'filled' : 'resting')) : (filled > 0 ? 'filled' : 'cancelled');
      const avg = r.average_fill_price !== undefined && filled > 0 ? Number(r.average_fill_price) : o.limit;
      this.sql.exec('INSERT INTO bets (id, ts, game_id, ticker, team, side, kind, count, price, fee, p_sharp, p_market, p_star, edge, order_id, status, fill_count, note, sport, conf, p_mult, p_pow) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, Date.now(), o.gameId, o.ticker, o.team, o.side, o.kind, o.count, avg, o.fee, o.pSharp, o.pMarket, o.pStar, o.edge, r.order_id || null, status, filled, o.tif, o.sport || null, o.conf === undefined ? null : o.conf, o.pMult === undefined ? null : o.pMult, o.pPow === undefined ? null : o.pPow);
      this.sql.exec('INSERT INTO daily (day, bets, taker_bets) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET bets = bets + 1, taker_bets = taker_bets + ?', todayKey(Date.now()), o.kind === 'taker' ? 1 : 0, o.kind === 'taker' ? 1 : 0);
      this.log('info', (o.kind === 'taker' ? 'Took ' : 'Quoted ') + o.count + ' YES ' + o.ticker + ' @ ' + o.limit.toFixed(2) + ' (p*=' + o.pStar.toFixed(3) + ', sharp=' + o.pSharp.toFixed(3) + (o.conf !== undefined && o.conf < 1 ? ', conf ' + Math.round(o.conf * 100) + '%' : '') + ') → ' + status, { filled, remaining });
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
  // Sync resting-order state with the exchange. `resting` is the snapshot taken at `snapshotTs`; orders placed after it are left alone.
  async reconcile(cfg, resting, snapshotTs) {
    const open = this.sql.exec("SELECT * FROM bets WHERE status IN ('resting','partial') AND order_id IS NOT NULL AND ts < ?", snapshotTs - 500).toArray();
    for (const b of open) {
      const o = resting.find(x => x.id === b.order_id);
      if (o) { const filled = Math.max(0, b.count - o.remaining); if (Math.abs(filled - (b.fill_count || 0)) > 1e-9) { this.sql.exec("UPDATE bets SET fill_count=?, status=? WHERE id=?", filled, filled > 0 ? 'partial' : 'resting', b.id); } continue; }
      if (this.budgetLeft() < 3) break; // finish next minute
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
    const rows = this.sql.exec("SELECT b.*, g.commence_ts FROM bets b LEFT JOIN games g ON g.id = b.game_id WHERE b.status IN ('filled','partial') AND b.fill_count > 0 AND (g.commence_ts IS NULL OR g.commence_ts < ?) ORDER BY g.commence_ts ASC", Date.now() - 2 * 3600000).toArray();
    const seen = {}; let lookups = 0;
    for (const b of rows) {
      if (!(b.ticker in seen)) { if (lookups >= 8 || this.budgetLeft() < 3) continue; lookups++; try { const r = await this.kalshi(cfg, 'GET', '/markets/' + encodeURIComponent(b.ticker), null); seen[b.ticker] = (r.market || r).result || ''; } catch (e) { seen[b.ticker] = ''; } }
      const result = seen[b.ticker];
      if (result !== 'yes' && result !== 'no') continue;
      const won = result === b.side;
      const pnl = b.fill_count * (won ? (1 - b.price) : -b.price) - (b.fee || 0) * (b.fill_count / Math.max(1, b.count));
      this.sql.exec("UPDATE bets SET status='settled', result=?, pnl=?, settled_ts=? WHERE id=?", result, pnl, Date.now(), b.id);
      this.sql.exec('INSERT INTO daily (day, realized, fees, bets) VALUES (?, ?, ?, 0) ON CONFLICT(day) DO UPDATE SET realized = realized + ?, fees = fees + ?', todayKey(Date.now()), pnl, b.fee || 0, pnl, b.fee || 0);
      this.log('info', 'Settled ' + b.ticker + ' ' + result.toUpperCase() + ' → ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2));
    }
  }
  // Closing-line value for every fill on a game whose closing line is recorded: fair close minus the price paid
  // (books), and Kalshi's last pre-kickoff mid minus the price paid (market). Positive means we beat the close.
  scoreClosed(gameId) {
    const rows = this.sql.exec('SELECT b.id, b.ticker, b.price, g.home_ticker, g.close_p_home, g.close_p_away, g.close_k_home, g.close_k_away FROM bets b JOIN games g ON g.id = b.game_id WHERE g.closed_ts IS NOT NULL AND b.fill_count > 0 AND b.clv IS NULL' + (gameId ? ' AND b.game_id = ?' : ''), ...(gameId ? [gameId] : [])).toArray();
    for (const r of rows) {
      const isHome = r.ticker === r.home_ticker;
      const pc = isHome ? r.close_p_home : r.close_p_away, km = isHome ? r.close_k_home : r.close_k_away;
      if (pc === null || pc === undefined) continue;
      this.sql.exec('UPDATE bets SET clv=?, clv_mkt=? WHERE id=?', pc - r.price, km === null || km === undefined ? null : km - r.price, r.id);
    }
    return rows.length;
  }
  // Per-sport brake: enough scored fills with negative closing-line value → pause that sport for a while.
  evaluateBrakes(cfg) {
    const brakes = this.brakes(); const since = Date.now() - 30 * DAY; let changed = false;
    const rows = this.sql.exec('SELECT sport, COUNT(*) AS n, AVG(clv) AS clv FROM bets WHERE clv IS NOT NULL AND fill_count > 0 AND sport IS NOT NULL AND ts > ? GROUP BY sport', since).toArray();
    for (const r of rows) {
      if (brakes[r.sport]) continue;
      if (r.n >= (cfg.brakeMinBets || 20) && r.clv < (cfg.brakeClv === undefined ? -0.005 : cfg.brakeClv)) {
        const reason = 'closing-line value ' + (r.clv * 100).toFixed(1) + '¢ over ' + r.n + ' fills in 30 days';
        brakes[r.sport] = { at: Date.now(), until: Date.now() + (cfg.brakeDays || 7) * DAY, reason, n: r.n, clv: r.clv }; changed = true;
        this.log('warn', 'Brake: paused ' + r.sport + ' (' + reason + ')');
        this.notify('Edge Desk paused ' + r.sport, 'The engine has been behind the closing line in ' + r.sport + ' (' + reason + '). It stops trading that sport for ' + (cfg.brakeDays || 7) + ' days unless you resume it.', 'warning');
      }
    }
    if (changed) this.kv('brakes', brakes);
  }
  async maybeDigest(cfg, now) {
    const topic = (cfg.ntfyTopic || this.env.NTFY_TOPIC || '').trim(); if (!topic) return;
    const tz = cfg.timezone || 'America/New_York'; const today = dayIn(tz, now);
    if (hourIn(tz, now) < (cfg.digestHour === undefined ? 9 : cfg.digestHour) || this.kv('digest_day') === today) return;
    this.kv('digest_day', today);
    const st = this.stats(); const y = (st.days || []).find(d => d.day !== todayKey(now)) || { realized: 0, bets: 0 };
    const clv = (st.clv || []).reduce((a, r) => ({ n: a.n + r.n, s: a.s + r.clv * r.n }), { n: 0, s: 0 });
    const lines = ['Yesterday: ' + (y.realized >= 0 ? '+' : '') + Number(y.realized || 0).toFixed(2) + ' settled, ' + (y.bets || 0) + ' orders',
      'Open: ' + ((st.open && st.open.n) || 0) + ' positions, ' + ((st.resting && st.resting.n) || 0) + ' resting quotes',
      clv.n ? 'Closing line (30d): ' + (clv.s / clv.n >= 0 ? '+' : '') + (clv.s / clv.n * 100).toFixed(1) + '¢ over ' + clv.n + ' fills' : 'Closing line: no scored fills yet',
      st.oddsRemaining !== null && st.oddsRemaining !== undefined ? 'Sharp-lines credits left: ' + st.oddsRemaining + (st.runwayDays !== null && st.runwayDays !== undefined ? ' (~' + st.runwayDays + ' days at this pace)' : '') : ''];
    const b = this.brakes(); for (const k in b) lines.push('Paused: ' + k + ' (' + b[k].reason + ')');
    await this.notify('Edge Desk daily digest', lines.filter(Boolean).join('\n'), 'newspaper');
  }
  async flatten(cfg) {
    const ordRes = await this.kalshi(cfg, 'GET', '/portfolio/orders', { status: 'resting', limit: '200' }, undefined, true);
    const ours = new Set(this.sql.exec("SELECT order_id FROM bets WHERE status IN ('resting','partial') AND order_id IS NOT NULL").toArray().map(r => r.order_id));
    let n = 0; for (const o of ordRes.orders || []) if (ours.has(o.order_id)) { await this.cancel(cfg, { id: o.order_id, ticker: o.ticker, yes: Number(o.yes_price_dollars || 0) }, 'flatten'); n++; }
    return n;
  }
  stats() {
    const settled = this.sql.exec("SELECT kind, COUNT(*) AS n, SUM(pnl) AS pnl, SUM(CASE WHEN result = side THEN 1 ELSE 0 END) AS wins, SUM((p_star - CASE WHEN result = side THEN 1 ELSE 0 END) * (p_star - CASE WHEN result = side THEN 1 ELSE 0 END)) AS brier_sum, SUM((p_market - CASE WHEN result = side THEN 1 ELSE 0 END) * (p_market - CASE WHEN result = side THEN 1 ELSE 0 END)) AS brier_mkt, SUM(fill_count * price) AS staked FROM bets WHERE status='settled' GROUP BY kind").toArray();
    const methods = this.sql.exec("SELECT COUNT(*) AS n, SUM((p_mult - w) * (p_mult - w)) AS b_mult, SUM((p_pow - w) * (p_pow - w)) AS b_pow FROM (SELECT p_mult, p_pow, CASE WHEN result = side THEN 1.0 ELSE 0.0 END AS w FROM bets WHERE status='settled' AND p_mult IS NOT NULL AND p_pow IS NOT NULL)").toArray()[0];
    const open = this.sql.exec("SELECT COUNT(*) AS n, SUM(fill_count * price) AS staked FROM bets WHERE status IN ('filled','partial')").toArray()[0];
    const resting = this.sql.exec("SELECT COUNT(*) AS n FROM bets WHERE status IN ('resting','partial')").toArray()[0];
    const days = this.sql.exec('SELECT * FROM daily ORDER BY day DESC LIMIT 30').toArray();
    const clv = this.sql.exec('SELECT sport, kind, COUNT(*) AS n, AVG(clv) AS clv, AVG(clv_mkt) AS clv_mkt, SUM(CASE WHEN clv > 0 THEN 1 ELSE 0 END) AS beat FROM bets WHERE clv IS NOT NULL AND fill_count > 0 AND ts > ? GROUP BY sport, kind', Date.now() - 30 * DAY).toArray();
    const used = this.kv('odds_used'); const remaining = this.kv('odds_remaining');
    let runwayDays = null;
    if (remaining !== null && used && used.day === todayKey(Date.now()) && used.n > 0) { const hours = Math.max(1, (Date.now() - Date.parse(used.day + 'T00:00:00Z')) / 3600000); const perDay = used.n / hours * 24; runwayDays = perDay > 0 ? Math.round(remaining / perDay) : null; }
    return { settled, methods, open, resting, days, clv, oddsRemaining: remaining, oddsUsedToday: this.oddsUsedToday(), oddsBudget: oddsBudget(remaining, this.oddsUsedToday()).daily, runwayDays, brakes: this.brakes(), trim: this.modelTrim(this.settings()) };
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
  async health() {
    const cfg = this.settings(); const env = this.env;
    const has = (k) => !!(env[k] || '').trim();
    const kalshi = cfg.env === 'demo' ? (has('KALSHI_DEMO_KEY_ID') && has('KALSHI_DEMO_PRIVATE_KEY')) : (has('KALSHI_KEY_ID') && has('KALSHI_PRIVATE_KEY'));
    const odds = {}; for (const s in SPORTS) { const oc = this.kv('odds_' + s); if (oc && oc.at) odds[s] = { at: oc.at, events: oc.list.length }; }
    return { oddsKey: has('ODDS_API_KEY'), kalshiKey: kalshi, ntfy: !!((cfg.ntfyTopic || env.NTFY_TOPIC || '').trim()), alarm: await this.state.storage.getAlarm(), lastTick: this.kv('last_tick'), odds, oddsUsed: this.kv('odds_used'), subMax: this.subMax };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const sub = url.pathname.replace(/^\/engine\/?/, '').replace(/\/+$/, '');
    const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    try {
      if (sub === 'cron') { await this.ensureAlarm(); const cfg = this.settings(); const last = this.kv('last_tick'); if (cfg.enabled && (!last || Date.now() - last.ts > 90000)) await this.tick('cron'); return json({ ok: true }); }
      if (sub === 'status') { const h = await this.health(); return json({ settings: this.settings(), lastTick: h.lastTick, stats: this.stats(), oddsKey: h.oddsKey, kalshiKey: h.kalshiKey, ntfy: h.ntfy, alarm: h.alarm, health: h }); }
      if (sub === 'settings' && request.method === 'POST') { const patch = await request.json(); delete patch.enabled; const next = this.saveSettings(patch); this.log('info', 'settings changed', patch); return json({ ok: true, settings: next }); }
      if (sub === 'toggle' && request.method === 'POST') {
        const b = await request.json(); const on = !!b.enabled;
        if (on && !(this.env.ODDS_API_KEY || '').trim()) return json({ error: 'ODDS_API_KEY is not set on the Worker' }, 400);
        if (on) { const h = await this.health(); if (!h.kalshiKey) return json({ error: 'Kalshi API key is not set on the Worker (' + (this.settings().env === 'demo' ? 'KALSHI_DEMO_KEY_ID / KALSHI_DEMO_PRIVATE_KEY' : 'KALSHI_KEY_ID / KALSHI_PRIVATE_KEY') + ')' }, 400); }
        const next = this.saveSettings({ enabled: on }); this.log('info', on ? 'Engine enabled' : 'Engine disabled');
        if (on) { await this.state.storage.setAlarm(Date.now() + 1000); } else { await this.state.storage.deleteAlarm(); if (b.flatten) await this.flatten(next); }
        return json({ ok: true, settings: next });
      }
      if (sub === 'tick' && request.method === 'POST') { const cfg = this.settings(); if (!cfg.enabled) return json({ error: 'engine is off' }, 400); const s = await this.tick('manual'); return json({ ok: true, summary: s }); }
      if (sub === 'preview' && request.method === 'POST') { const cfg = this.settings(); const was = cfg.enabled; this.saveSettings({ enabled: true, takerEnabled: false, makerEnabled: false }); let s; try { s = await this.tick('preview'); } finally { this.saveSettings({ enabled: was, takerEnabled: cfg.takerEnabled, makerEnabled: cfg.makerEnabled }); } return json({ ok: true, summary: s }); }
      if (sub === 'flatten' && request.method === 'POST') { const n = await this.flatten(this.settings()); return json({ ok: true, cancelled: n }); }
      if (sub === 'unbrake' && request.method === 'POST') { const b = await request.json(); const brakes = this.brakes(); if (b.sport && brakes[b.sport]) { delete brakes[b.sport]; this.kv('brakes', brakes); this.log('info', 'Brake released on ' + b.sport + ' by the user'); } return json({ ok: true, brakes }); }
      if (sub === 'games') return json({ games: this.sql.exec('SELECT * FROM games WHERE updated_ts > ? ORDER BY commence_ts ASC', Date.now() - 6 * 3600000).toArray() });
      if (sub === 'bets') return json({ bets: this.sql.exec('SELECT * FROM bets ORDER BY ts DESC LIMIT 200').toArray() });
      if (sub === 'log') return json({ log: this.sql.exec('SELECT * FROM log ORDER BY ts DESC LIMIT 120').toArray() });
      return json({ error: 'unknown engine route' }, 404);
    } catch (e) { return json({ error: e.message }, 500); }
  }
}

const EdgeDeskEngine = { EngineDO, _internal: { teamMatch, parseEventDate, devig2, devigPower, consensus, confidence, oddsBudget, feeFor, kellyCount, normName, hourIn, dayIn, ENGINE_DEFAULTS, SPORTS } };
