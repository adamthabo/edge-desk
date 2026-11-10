/* Edge Desk core: pure functions (no DOM). Exposed as window.ED for the page and module.exports for tests. */
(function (root) {
  'use strict';

  /* ---------- utilities ---------- */
  const U = {};
  U.num = function (x, fallback) {
    if (x === null || x === undefined || x === '') return fallback === undefined ? null : fallback;
    const n = typeof x === 'number' ? x : parseFloat(x);
    return Number.isFinite(n) ? n : (fallback === undefined ? null : fallback);
  };
  U.dollars = function (dstr, cents) {
    const d = U.num(dstr);
    if (d !== null) return d;
    const c = U.num(cents);
    return c !== null ? c / 100 : null;
  };
  U.fp = function (fpstr, legacy) {
    const a = U.num(fpstr);
    if (a !== null) return a;
    const b = U.num(legacy);
    return b !== null ? b : 0;
  };
  U.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  U.round = (v, d) => { const m = Math.pow(10, d || 0); return Math.round(v * m) / m; };
  U.esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  U.cents = function (p, opts) {
    if (p === null || p === undefined || !Number.isFinite(p)) return '—';
    const c = p * 100;
    const r = Math.abs(c - Math.round(c)) < 0.005 ? Math.round(c).toString() : c.toFixed(1);
    return r + ((opts && opts.bare) ? '' : '¢');
  };
  U.money = function (v, opts) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const sign = v < 0 ? '−' : ((opts && opts.plus && v > 0) ? '+' : '');
    const a = Math.abs(v);
    const dec = (opts && opts.dec !== undefined) ? opts.dec : (a >= 1000 ? 0 : 2);
    return sign + '$' + a.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };
  U.compact = function (n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(n).toLocaleString('en-US');
  };
  U.pct = function (v, d) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return (v * 100).toFixed(d === undefined ? 1 : d) + '%';
  };
  U.signed = function (v, d) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const s = v > 0 ? '+' : (v < 0 ? '−' : '');
    return s + Math.abs(v).toFixed(d === undefined ? 1 : d);
  };
  U.ago = function (t, now) {
    if (!t) return '—';
    const s = Math.max(0, ((now || Date.now()) - t) / 1000);
    if (s < 5) return 'now';
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  };
  U.countdown = function (t, now) {
    if (!t) return '—';
    let s = (t - (now || Date.now())) / 1000;
    if (s <= 0) return 'closed';
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d >= 365) return (d / 365).toFixed(d >= 3650 ? 0 : 1) + 'y';
    if (d >= 30) return Math.round(d / 30.4) + 'mo';
    if (d >= 2) return d + 'd ' + h + 'h';
    if (d === 1) return '1d ' + h + 'h';
    if (h >= 1) return h + 'h ' + m + 'm';
    return m + 'm';
  };
  U.dateShort = function (t) {
    if (!t) return '—';
    const d = new Date(t);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  U.timeOnly = (t) => t ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
  U.days = (t, now) => t ? Math.max(0, (t - (now || Date.now())) / 86400000) : null;
  U.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  U.debounce = function (fn, ms) { let h = null; return function () { const a = arguments, c = this; clearTimeout(h); h = setTimeout(() => fn.apply(c, a), ms); }; };
  U.niceTicks = function (lo, hi, n) {
    if (!(hi > lo)) return [lo];
    const span = hi - lo, raw = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(U.round(v, 6));
    return out;
  };

  /* ---------- normalization of Kalshi objects ---------- */
  const N = {};
  N.market = function (m, ev) {
    if (!m || !m.ticker) return null;
    const yb = U.dollars(m.yes_bid_dollars, m.yes_bid);
    const ya = U.dollars(m.yes_ask_dollars, m.yes_ask);
    let nb = U.dollars(m.no_bid_dollars, m.no_bid);
    let na = U.dollars(m.no_ask_dollars, m.no_ask);
    if (nb === null && ya !== null) nb = U.round(1 - ya, 4);
    if (na === null && yb !== null) na = U.round(1 - yb, 4);
    const hasBid = yb !== null && yb > 0;
    const hasAsk = ya !== null && ya < 1;
    const last = U.dollars(m.last_price_dollars, m.last_price);
    const prevRaw = U.dollars(m.previous_price_dollars, m.previous_price);
    const prev = prevRaw !== null && prevRaw > 0 ? prevRaw : null;
    const series = m.series_ticker || (ev && ev.series) || String(m.event_ticker || '').split('-')[0];
    const closeT = m.close_time ? Date.parse(m.close_time) : null;
    const expT = (m.latest_expiration_time || m.expiration_time) ? Date.parse(m.latest_expiration_time || m.expiration_time) : null;
    const mid = (hasBid && hasAsk) ? (yb + ya) / 2 : (last !== null && last > 0 ? last : (hasAsk ? ya : (hasBid ? yb : null)));
    return {
      ticker: m.ticker,
      event: m.event_ticker || '',
      series: series,
      type: m.market_type || 'binary',
      title: m.title || '',
      sub: m.subtitle || '',
      yesSub: m.yes_sub_title || '',
      noSub: m.no_sub_title || '',
      status: m.status || '',
      open: m.open_time ? Date.parse(m.open_time) : null,
      close: Number.isFinite(closeT) ? closeT : null,
      exp: Number.isFinite(expT) ? expT : null,
      yb: yb, ya: ya, nb: nb, na: na, hasBid: hasBid, hasAsk: hasAsk,
      ybSize: U.fp(m.yes_bid_size_fp), yaSize: U.fp(m.yes_ask_size_fp),
      last: last !== null && last > 0 ? last : null,
      prev: prev,
      mid: mid,
      vol: U.fp(m.volume_fp, m.volume),
      vol24: U.fp(m.volume_24h_fp, m.volume_24h),
      oi: U.fp(m.open_interest_fp, m.open_interest),
      result: m.result || '',
      feeWaiverUntil: m.fee_waiver_expiration_time ? Date.parse(m.fee_waiver_expiration_time) : null,
      canCloseEarly: !!m.can_close_early,
      provisional: !!m.is_provisional,
      strikeType: m.strike_type || '',
      floor: m.floor_strike === undefined ? null : m.floor_strike,
      cap: m.cap_strike === undefined ? null : m.cap_strike,
      rules: m.rules_primary || '',
      rules2: m.rules_secondary || '',
      updated: Date.now()
    };
  };
  N.event = function (e) {
    if (!e || !e.event_ticker) return null;
    return {
      ticker: e.event_ticker,
      series: e.series_ticker || String(e.event_ticker).split('-')[0],
      title: e.title || '',
      sub: e.sub_title || '',
      category: e.category || '',
      mutEx: !!e.mutually_exclusive,
      feeType: e.fee_type_override || null,
      feeMult: (e.fee_multiplier_override === undefined || e.fee_multiplier_override === null) ? null : U.num(e.fee_multiplier_override),
      markets: (e.markets || []).map(m => m.ticker).filter(Boolean)
    };
  };
  N.book = function (res) {
    const ob = (res && (res.orderbook_fp || res.orderbook)) || {};
    const parse = (arr, scale) => (arr || []).map(x => [U.num(x[0]), U.num(x[1])])
      .filter(x => x[0] !== null && x[1] !== null)
      .map(x => [scale ? x[0] / scale : x[0], x[1]]);
    let yesBids, noBids;
    if (ob.yes_dollars || ob.no_dollars) { yesBids = parse(ob.yes_dollars); noBids = parse(ob.no_dollars); }
    else { yesBids = parse(ob.yes, 100); noBids = parse(ob.no, 100); }
    yesBids.sort((a, b) => b[0] - a[0]);
    noBids.sort((a, b) => b[0] - a[0]);
    const yesAsks = noBids.map(x => [U.round(1 - x[0], 4), x[1]]).sort((a, b) => a[0] - b[0]);
    const noAsks = yesBids.map(x => [U.round(1 - x[0], 4), x[1]]).sort((a, b) => a[0] - b[0]);
    return {
      yesBids: yesBids, noBids: noBids, yesAsks: yesAsks, noAsks: noAsks,
      bestBid: yesBids.length ? yesBids[0][0] : null,
      bestAsk: yesAsks.length ? yesAsks[0][0] : null,
      bidDepth: yesBids.reduce((s, x) => s + x[1], 0),
      askDepth: yesAsks.reduce((s, x) => s + x[1], 0),
      t: Date.now()
    };
  };
  N.trade = function (t) {
    if (!t || !t.ticker) return null;
    const yes = U.dollars(t.yes_price_dollars, t.yes_price);
    const no = U.dollars(t.no_price_dollars, t.no_price);
    return {
      id: t.trade_id || (t.ticker + ':' + t.created_time + ':' + yes),
      ticker: t.ticker,
      qty: U.fp(t.count_fp, t.count),
      yes: yes, no: no === null && yes !== null ? U.round(1 - yes, 4) : no,
      taker: t.taker_side || t.taker_outcome_side || '',
      t: t.created_time ? Date.parse(t.created_time) : Date.now(),
      block: !!t.is_block_trade
    };
  };
  N.candles = function (arr) {
    const pd = (o, k) => {
      if (!o) return null;
      const d = U.num(o[k + '_dollars']);
      if (d !== null) return d;
      const c = U.num(o[k]);
      return c !== null ? c / 100 : null;
    };
    const out = [];
    let lastClose = null;
    for (const c of (arr || [])) {
      const t = (U.num(c.end_period_ts) || 0) * 1000;
      if (!t) continue;
      const pr = c.price || {}, yb = c.yes_bid || {}, ya = c.yes_ask || {};
      const ybc = pd(yb, 'close'), yac = pd(ya, 'close');
      let close = pd(pr, 'close');
      const prevP = pd(pr, 'previous');
      if (close === null || close <= 0) {
        if (ybc !== null && yac !== null && ybc > 0 && yac < 1) close = (ybc + yac) / 2;
        else if (prevP !== null && prevP > 0) close = prevP;
        else close = lastClose;
      }
      if (close === null) continue;
      const open = pd(pr, 'open'), high = pd(pr, 'high'), low = pd(pr, 'low');
      out.push({
        t: t,
        o: open !== null && open > 0 ? open : (lastClose !== null ? lastClose : close),
        h: high !== null && high > 0 ? high : close,
        l: low !== null && low > 0 ? low : close,
        c: close,
        yb: ybc, ya: yac,
        vol: U.fp(c.volume_fp, c.volume),
        oi: U.fp(c.open_interest_fp, c.open_interest)
      });
      lastClose = close;
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  };

  /* ---------- fees (Kalshi schedule: taker = ceil(M × 0.07 × C × P × (1−P)); maker 0.0175 only on flagged series) ---------- */
  const F = {
    TAKER: 0.07,
    MAKER: 0.0175,
    rate: function (kind, info) {
      info = info || {};
      const M = (info.mult === null || info.mult === undefined) ? 1 : info.mult;
      const type = info.type || 'quadratic';
      if (info.waived) return 0;
      if (kind === 'maker') {
        if (type === 'quadratic_with_maker_fees') return F.MAKER * M;
        if (type === 'quadratic_with_combo_maker_fees') return F.TAKER * 0.5 * M;
        return 0;
      }
      return (info.takerRate || F.TAKER) * M;
    },
    // returns fee in dollars for an order of `qty` contracts at `price` (dollars)
    calc: function (qty, price, kind, info, rounding) {
      if (!(qty > 0) || price === null || price === undefined) return 0;
      const r = F.rate(kind, info);
      if (r <= 0) return 0;
      const raw = r * qty * price * (1 - price);
      if (rounding === 'cent') return Math.ceil(raw * 100 - 1e-9) / 100;
      return Math.ceil(raw * 10000 - 1e-9) / 10000;
    },
    perContract: function (price, kind, info, rounding) {
      return F.calc(1, price, kind, info, rounding);
    }
  };

  /* ---------- analytics ---------- */
  const A = {};
  // EV / Kelly for buying one side at `price` with belief `q` = P(YES). feePer in dollars per contract.
  A.edge = function (q, side, price, feePer) {
    if (price === null || price === undefined || !(price > 0) || !(price < 1)) return null;
    const p = side === 'yes' ? q : 1 - q;
    const cost = price + (feePer || 0);
    const ev = p - cost;
    const kelly = cost < 1 ? Math.max(0, (p - cost) / (1 - cost)) : 0;
    return { side: side, p: p, price: price, fee: feePer || 0, cost: cost, ev: ev, roi: cost > 0 ? ev / cost : 0, breakeven: cost, kelly: kelly };
  };
  A.sizeFor = function (bankroll, kellyFraction, edge) {
    if (!edge || edge.kelly <= 0 || !(bankroll > 0)) return { stake: 0, contracts: 0, fraction: 0 };
    const frac = edge.kelly * (kellyFraction || 0.25);
    const stake = bankroll * frac;
    const contracts = Math.floor(stake / edge.cost);
    return { stake: stake, contracts: contracts, fraction: frac };
  };
  A.annualized = function (cost, days) {
    if (!(cost > 0) || !(cost < 1) || !(days > 0)) return null;
    const ret = (1 - cost) / cost;
    return ret * (365 / days);
  };
  A.fillFromBook = function (levels, qty) {
    // levels: [[price, size]] sorted best-first (ascending for asks). Returns {filled, cost, avg}
    let left = qty, cost = 0, filled = 0;
    for (const [p, s] of (levels || [])) {
      if (left <= 0) break;
      const take = Math.min(left, s);
      cost += take * p; filled += take; left -= take;
    }
    return { filled: filled, cost: cost, avg: filled > 0 ? cost / filled : null, unfilled: left };
  };
  A.feeInfoFor = function (m, ev, seriesInfo, settings, now) {
    const info = { type: 'quadratic', mult: 1, waived: false, takerRate: (settings && settings.takerRate) || F.TAKER };
    if (seriesInfo) {
      if (seriesInfo.fee_type) info.type = seriesInfo.fee_type;
      if (seriesInfo.fee_multiplier !== undefined && seriesInfo.fee_multiplier !== null) info.mult = U.num(seriesInfo.fee_multiplier, 1);
    }
    if (ev) {
      if (ev.feeType) info.type = ev.feeType;
      if (ev.feeMult !== null && ev.feeMult !== undefined) info.mult = ev.feeMult;
    }
    if (m && m.feeWaiverUntil && m.feeWaiverUntil > (now || Date.now())) info.waived = true;
    return info;
  };

  // Does a set of one-winner legs cover every possible outcome? True when a catch-all leg exists
  // ("Other", "Someone else", "None of the above") or when the legs are numeric buckets with both
  // open ends ("48° or below" … "57° or above"). Candidate lists without a catch-all are NOT exhaustive.
  const CATCHALL_RE = /\b(other|another|someone else|anyone else|none of|no one|nobody|neither|the field|any other|not listed)\b/i;
  const LOW_RE = /\b(or below|or lower|or less|or fewer|or under|below|under|less than|at most)\b/i;
  const HIGH_RE = /\b(or above|or higher|or more|or over|above|over|more than|greater than|at least)\b/i;
  A.exhaustive = function (legs) {
    const names = legs.map(m => m.yesSub || m.title || '');
    if (names.some(n => CATCHALL_RE.test(n))) return { ok: true, why: 'a catch-all leg covers every other outcome' };
    const st = legs.map(m => m.strikeType || '');
    const lowStrike = st.some(s => s === 'less' || s === 'less_or_equal'), highStrike = st.some(s => s === 'greater' || s === 'greater_or_equal');
    if (lowStrike && highStrike) return { ok: true, why: 'the buckets run from an open low end to an open high end' };
    if (names.some(n => LOW_RE.test(n)) && names.some(n => HIGH_RE.test(n))) return { ok: true, why: 'the buckets run from an open low end to an open high end' };
    return { ok: false, why: 'the listed outcomes are not exhaustive; an unlisted outcome can win' };
  };

  // Scan the universe. universe = {events: Map, markets: Map}; returns array of opportunities sorted by priority.
  A.scan = function (universe, settings, seriesCache, now) {
    now = now || Date.now();
    settings = settings || {};
    const rounding = settings.rounding || 'centicent';
    const minSpread = settings.minSpread || 0.04;
    const minArbAnn = settings.minArbAnn === undefined ? 0.08 : settings.minArbAnn; // annualized return floor for locked arbs
    const out = [];
    const mkts = universe.markets, evs = universe.events;
    const feeInfo = (m, ev) => A.feeInfoFor(m, ev, seriesCache && seriesCache[m.series], settings, now);
    const takerFee = (m, ev, price) => F.perContract(price, 'taker', feeInfo(m, ev), rounding);
    const horizonDays = (legs) => { let t = 0; for (const m of legs) { const x = m.exp || m.close; if (x && x > t) t = x; } return t ? Math.max(0.05, (t - now) / 86400000) : null; };
    const horizonText = (d) => d === null ? 'an unknown settlement date' : d < 1 ? Math.round(d * 24) + ' hours' : d < 60 ? Math.round(d) + ' days' : d < 365 ? Math.round(d / 30.4) + ' months' : (d / 365).toFixed(1) + ' years';

    // 1) One-winner books (mutually exclusive events)
    for (const ev of evs.values()) {
      if (!ev.mutEx || ev.markets.length < 2) continue;
      const legs = ev.markets.map(t => mkts.get(t)).filter(m => m && m.status === 'active' && m.type === 'binary');
      if (legs.length < 2) continue;
      const days = horizonDays(legs);
      // Buy NO on every leg: profit when Σ yes_bid > 1 + fees. Safe under mutual exclusivity (at most one YES).
      const noLegs = legs.filter(m => m.hasBid);
      if (noLegs.length === legs.length) {
        const sumBid = noLegs.reduce((s, m) => s + m.yb, 0);
        const fees = noLegs.reduce((s, m) => s + takerFee(m, ev, 1 - m.yb), 0);
        const margin = sumBid - 1 - fees;
        const cost = noLegs.length - sumBid + fees;
        const size = Math.min.apply(null, noLegs.map(m => m.ybSize || 0));
        const ann = days !== null && cost > 0 ? (margin / cost) * (365 / days) : null;
        if (margin > 0.0005 && size >= 1 && (ann === null || ann >= minArbAnn || days <= 45)) {
          out.push({
            kind: 'arb', sub: 'no', score: 100 + Math.min(ann || 0, 10) * 5 + margin * 100 + Math.log10(1 + size),
            event: ev.ticker, tickers: noLegs.map(m => m.ticker), title: ev.title || noLegs[0].title,
            margin: margin, sumBid: sumBid, fees: fees, size: size, legs: noLegs.length, cost: cost, ann: ann, days: days,
            headline: 'Sell the whole book: YES bids sum to ' + U.cents(sumBid),
            math: 'Buy NO on all ' + noLegs.length + ' legs. Cost ' + U.cents(cost) + ' per set (fees in) for a ' + U.cents(noLegs.length - 1) + ' minimum payout. Margin ' + U.cents(margin) + '/set = ' + U.pct(margin / cost, 1) + ' on capital' + (ann !== null ? ', ' + U.pct(ann, 0) + ' annualized over ' + horizonText(days) : '') + '. Top-of-book size ' + U.compact(size) + ' sets.',
            note: 'Locked if at most one leg settles YES (Kalshi flags this event as mutually exclusive); if none does, every NO pays and you do better. Fills at the quoted bids only up to the shown size.'
          });
        }
      }
      // Buy YES on every leg: profit when Σ yes_ask < 1 − fees. Only a lock when the legs are exhaustive.
      const yesLegs = legs.filter(m => m.hasAsk);
      if (yesLegs.length === legs.length) {
        const sumAsk = yesLegs.reduce((s, m) => s + m.ya, 0);
        const fees = yesLegs.reduce((s, m) => s + takerFee(m, ev, m.ya), 0);
        const margin = 1 - sumAsk - fees;
        const cost = sumAsk + fees;
        const size = Math.min.apply(null, yesLegs.map(m => m.yaSize || 0));
        const ex = A.exhaustive(yesLegs);
        const ann = days !== null && cost > 0 ? (margin / cost) * (365 / days) : null;
        if (margin > 0.0005 && size >= 1 && ex.ok && (ann === null || ann >= minArbAnn || days <= 45)) {
          out.push({
            kind: 'arb', sub: 'yes', score: 95 + Math.min(ann || 0, 10) * 5 + margin * 100 + Math.log10(1 + size),
            event: ev.ticker, tickers: yesLegs.map(m => m.ticker), title: ev.title || yesLegs[0].title,
            margin: margin, sumAsk: sumAsk, fees: fees, size: size, legs: yesLegs.length, cost: cost, ann: ann, days: days, why: ex.why,
            headline: 'Buy the whole book: YES asks sum to ' + U.cents(sumAsk),
            math: 'Buy YES on all ' + yesLegs.length + ' legs for ' + U.cents(cost) + ' per set (fees in); exactly one pays $1. Margin ' + U.cents(margin) + '/set = ' + U.pct(margin / cost, 1) + ' on capital' + (ann !== null ? ', ' + U.pct(ann, 0) + ' annualized over ' + horizonText(days) : '') + '. Top-of-book size ' + U.compact(size) + ' sets.',
            note: 'Treated as a lock because ' + ex.why + '. Still read the rules: a void or an unexpected settlement convention breaks the set.'
          });
        }
      }
    }

    // 2) Per-market signals
    for (const m of mkts.values()) {
      if (m.status !== 'active' || m.type !== 'binary') continue;
      const ev = evs.get(m.event);
      const days = U.days(m.close, now);
      const label = m.title || ((ev ? ev.title + ' · ' : '') + m.yesSub);

      // Wide spread: quote inside it and earn the spread (maker)
      if (m.hasBid && m.hasAsk) {
        const spread = m.ya - m.yb;
        if (spread >= minSpread && m.vol24 >= 20 && m.yb >= 0.03 && m.ya <= 0.97) {
          const info = feeInfo(m, ev);
          const makerRate = F.rate('maker', info);
          const score = spread * 100 * Math.log10(10 + m.vol24);
          out.push({
            kind: 'spread', score: score, tickers: [m.ticker], event: m.event, title: label,
            spread: spread, yb: m.yb, ya: m.ya, vol24: m.vol24, makerRate: makerRate, days: days,
            headline: 'Spread ' + U.cents(spread) + ' wide (' + U.cents(m.yb) + ' / ' + U.cents(m.ya) + ')',
            math: 'A resting bid at ' + U.cents(m.yb + 0.01) + ' and an offer at ' + U.cents(m.ya - 0.01) + ' still improve both sides by 1¢ and keep ' + U.cents(spread - 0.02) + ' between them. 24h volume ' + U.compact(m.vol24) + '. ' + (makerRate > 0 ? 'This series charges maker fees (' + (makerRate * 100).toFixed(2) + '% × P × (1−P)).' : 'Resting orders pay no fee on this series.'),
            note: 'You only earn the spread if both sides fill; a one-sided fill leaves you with a position. Adverse selection is the real cost here.'
          });
        }
      }

      // Movers
      if (m.last !== null && m.prev !== null && m.vol24 >= 20) {
        const d = m.last - m.prev;
        if (Math.abs(d) >= 0.05) {
          out.push({
            kind: 'mover', score: Math.abs(d) * 100 * Math.log10(10 + m.vol24), tickers: [m.ticker], event: m.event, title: label,
            delta: d, last: m.last, prev: m.prev, vol24: m.vol24,
            headline: (d > 0 ? '▲ ' : '▼ ') + U.cents(Math.abs(d)) + ' move to ' + U.cents(m.last),
            math: 'Last trade ' + U.cents(m.last) + ' vs ' + U.cents(m.prev) + ' a day ago on ' + U.compact(m.vol24) + ' contracts. Open interest ' + U.compact(m.oi) + '.',
            note: 'Momentum in event markets often means news. Read the rules and the news before fading or following.'
          });
        }
      }

      // Near-certain yield (cash-like returns with tail risk)
      if (days !== null && days >= 0.05 && days <= 60) {
        const info = feeInfo(m, ev);
        let side = null, price = null;
        if (m.hasAsk && m.ya >= 0.90 && m.ya <= 0.985) { side = 'yes'; price = m.ya; }
        else if (m.hasBid && (1 - m.yb) >= 0.90 && (1 - m.yb) <= 0.985) { side = 'no'; price = 1 - m.yb; }
        if (side && m.vol >= 100) {
          const fee = F.perContract(price, 'taker', info, rounding);
          const cost = price + fee;
          const ann = A.annualized(cost, days);
          if (ann !== null && ann >= 0.10) {
            out.push({
              kind: 'yield', score: Math.log10(1 + ann * 100) * 25 + Math.log10(10 + m.vol24), tickers: [m.ticker], event: m.event, title: label,
              side: side, price: price, fee: fee, cost: cost, ann: ann, days: days,
              headline: side.toUpperCase() + ' at ' + U.cents(price) + ' pays ' + U.pct((1 - cost) / cost, 1) + ' in ' + (days < 1 ? Math.round(days * 24) + 'h' : Math.round(days) + 'd'),
              math: 'Buy ' + side.toUpperCase() + ' at ' + U.cents(price) + ' (+' + U.cents(fee) + ' fee) → $1 at settlement if right. That is ' + U.pct(ann, 0) + ' annualized over ' + (days < 1 ? Math.round(days * 24) + ' hours' : days.toFixed(1) + ' days') + '.',
              note: 'The market thinks the other side is a ' + U.pct(1 - price, 0) + ' chance. Be right about why it is small: a single miss costs ' + U.cents(cost) + ' per contract.'
            });
          }
        }
      }

      // Volume surge
      if (m.vol24 >= 300 && m.oi > 0 && m.vol24 / m.oi >= 0.5) {
        out.push({
          kind: 'volume', score: Math.log10(10 + m.vol24) * 10 + (m.vol24 / m.oi), tickers: [m.ticker], event: m.event, title: label,
          vol24: m.vol24, oi: m.oi,
          headline: U.compact(m.vol24) + ' contracts in 24h (' + U.round(m.vol24 / m.oi, 1) + '× open interest)',
          math: 'Price ' + U.cents(m.mid) + '. Spread ' + (m.hasBid && m.hasAsk ? U.cents(m.ya - m.yb) : '—') + '. Closes in ' + U.countdown(m.close, now) + '.',
          note: 'High turnover means attention and liquidity: tighter fills, but also informed flow.'
        });
      }

      // Longshot zone (favorite–longshot bias is a well-documented tendency, not a guarantee)
      if (m.hasAsk && m.ya <= 0.06 && m.ya >= 0.02 && m.vol24 >= 50 && days !== null && days <= 30) {
        const info = feeInfo(m, ev);
        const noPrice = 1 - m.yb;
        if (m.hasBid && noPrice < 1) {
          const fee = F.perContract(noPrice, 'taker', info, rounding);
          out.push({
            kind: 'longshot', score: (0.06 - m.ya) * 100 + Math.log10(10 + m.vol24), tickers: [m.ticker], event: m.event, title: label,
            ya: m.ya, noPrice: noPrice, fee: fee,
            headline: 'YES priced at ' + U.cents(m.ya) + ' with ' + U.compact(m.vol24) + ' traded today',
            math: 'Longshots in prediction markets have historically traded above their realized frequency. NO at ' + U.cents(noPrice) + ' (+' + U.cents(fee) + ' fee) pays ' + U.pct((1 - noPrice - fee) / (noPrice + fee), 1) + ' if the longshot misses.',
            note: 'A tendency across many markets, not a rule for this one. Small payout, full-stake downside.'
          });
        }
      }
    }

    const prio = { arb: 0, yield: 1, spread: 2, mover: 3, volume: 4, longshot: 5 };
    out.sort((a, b) => (prio[a.kind] - prio[b.kind]) || (b.score - a.score));
    return out;
  };

  // Build OHLC candles from a list of trades (any order) with the given bucket size in ms
  A.candlesFromTrades = function (trades, bucketMs) {
    const sorted = (trades || []).filter(t => t.yes !== null && t.t).slice().sort((a, b) => a.t - b.t);
    const out = [];
    let cur = null;
    for (const t of sorted) {
      const b = Math.floor(t.t / bucketMs) * bucketMs + bucketMs;
      if (!cur || cur.t !== b) { cur = { t: b, o: t.yes, h: t.yes, l: t.yes, c: t.yes, vol: 0, oi: 0 }; out.push(cur); }
      cur.h = Math.max(cur.h, t.yes); cur.l = Math.min(cur.l, t.yes); cur.c = t.yes; cur.vol += t.qty || 0;
    }
    return out;
  };

  // Tape statistics over a window (ms)
  A.tapeStats = function (trades, windowMs, now) {
    now = now || Date.now();
    const since = now - windowMs;
    let n = 0, yesQty = 0, noQty = 0, notional = 0, big = 0;
    const byTicker = new Map();
    for (const t of trades) {
      if (t.t < since) continue;
      n++;
      const price = t.taker === 'no' ? t.no : t.yes;
      notional += t.qty * (price || 0);
      if (t.taker === 'no') noQty += t.qty; else yesQty += t.qty;
      if (t.qty >= 500) big++;
      const e = byTicker.get(t.ticker) || { ticker: t.ticker, n: 0, qty: 0, yesQty: 0, noQty: 0, last: null };
      e.n++; e.qty += t.qty; if (t.taker === 'no') e.noQty += t.qty; else e.yesQty += t.qty; e.last = t.yes;
      byTicker.set(t.ticker, e);
    }
    const top = Array.from(byTicker.values()).sort((a, b) => b.qty - a.qty).slice(0, 8);
    return { n: n, yesQty: yesQty, noQty: noQty, notional: notional, big: big, top: top, perMin: n / Math.max(1, windowMs / 60000) };
  };

  /* ---------- simulated exchange (for demo mode; clearly labeled in the UI) ---------- */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const SIM = {};
  SIM.create = function (seed) {
    const rnd = mulberry32(seed || 7);
    const now = Date.now();
    const H = 3600000, D = 86400000;
    const events = [];
    const E = (ticker, series, category, title, mutEx, legs, opts) => {
      events.push({ ticker: ticker, series: series, category: category, title: title, sub: (opts && opts.sub) || '', mutEx: mutEx, markets: [], feeType: null, feeMult: null, _legs: legs, _opts: opts || {} });
    };
    E('KXFEDDEC-26DEC', 'KXFEDDEC', 'Economics', 'Fed decision at the December meeting', true,
      [['Cut 50 bps', 0.04], ['Cut 25 bps', 0.61], ['Hold', 0.33], ['Hike', 0.02]], { close: now + 38 * D });
    E('KXCPIYOY-26OCT', 'KXCPIYOY', 'Economics', 'October CPI year-over-year', true,
      [['2.8% or below', 0.11], ['2.9%', 0.24], ['3.0%', 0.31], ['3.1%', 0.21], ['3.2% or above', 0.14]], { close: now + 4 * D });
    E('KXUNEMP-26NOV', 'KXUNEMP', 'Economics', 'November unemployment rate', true,
      [['4.1% or below', 0.20], ['4.2%', 0.37], ['4.3%', 0.31], ['4.4% or above', 0.21]], { close: now + 26 * D, arbNo: true });
    E('KXHIGHNY-26NOV09', 'KXHIGHNY', 'Climate and Weather', 'Highest temperature in NYC on Nov 9', true,
      [['48° or below', 0.03], ['49° to 50°', 0.08], ['51° to 52°', 0.20], ['53° to 54°', 0.31], ['55° to 56°', 0.19], ['57° or above', 0.10]], { close: now + 20 * H, arbYes: true });
    E('KXBTCRANGE-26DEC31', 'KXBTCRANGE', 'Crypto', 'Bitcoin price on Dec 31', true,
      [['Below $80k', 0.14], ['$80k to $90k', 0.22], ['$90k to $100k', 0.27], ['$100k to $110k', 0.21], ['Above $110k', 0.17]], { close: now + 53 * D });
    E('KXSHUTDOWN-26NOV30', 'KXSHUTDOWN', 'Politics', 'Federal government shutdown by Nov 30?', false,
      [['Yes', 0.07]], { close: now + 22 * D, wide: true });
    E('KXFARMBILL-26', 'KXFARMBILL', 'Politics', 'Farm bill signed into law in 2026?', false,
      [['Yes', 0.31]], { close: now + 53 * D, wide: true });
    E('KXNFLGAME-26NOV09NEBUF', 'KXNFLGAME', 'Sports', 'Patriots at Bills', true,
      [['Patriots win', 0.42], ['Bills win', 0.58]], { close: now + 30 * H, hot: true });
    E('KXNBAWINS-26BOS', 'KXNBAWINS', 'Sports', 'Celtics regular-season wins', true,
      [['54 or fewer', 0.46], ['55 or more', 0.54]], { close: now + 150 * D });
    E('KXOSCARPIC-27', 'KXOSCARPIC', 'Entertainment', 'Best Picture at the 2027 Oscars', true,
      [['Frontrunner A', 0.29], ['Frontrunner B', 0.24], ['Frontrunner C', 0.15], ['Frontrunner D', 0.09], ['Another film', 0.23]], { close: now + 120 * D });
    E('KXSTARSHIP-26DEC31', 'KXSTARSHIP', 'Science and Technology', 'Starship reaches orbit by Dec 31?', false,
      [['Yes', 0.77]], { close: now + 53 * D, hot: true });
    E('KXMCAP-26DEC31', 'KXMCAP', 'Companies', 'Largest company by market cap on Dec 31', true,
      [['Nvidia', 0.63], ['Microsoft', 0.17], ['Apple', 0.16], ['Another company', 0.04]], { close: now + 53 * D });
    E('KXRAINNYC-26NOV09', 'KXRAINNYC', 'Climate and Weather', 'Measurable rain in NYC on Nov 9?', false,
      [['Yes', 0.06]], { close: now + 22 * H, yieldy: true });
    E('KXGDPQ3-26', 'KXGDPQ3', 'Economics', 'Q3 GDP growth above 2.0% (second estimate)?', false,
      [['Yes', 0.93]], { close: now + 17 * D, yieldy: true });
    E('KXSNOWBOS-26NOV', 'KXSNOWBOS', 'Climate and Weather', 'Snow in Boston before Nov 30?', false,
      [['Yes', 0.38]], { close: now + 22 * D, hot: true });

    const markets = new Map();
    const books = new Map();
    const hist = new Map();
    const feeSeries = { KXFEDDEC: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 }, KXCPIYOY: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 }, KXNFLGAME: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } };

    for (const ev of events) {
      const legs = ev._legs, o = ev._opts;
      let i = 0;
      for (const [name, p0] of legs) {
        i++;
        const ticker = ev.ticker + (legs.length > 1 ? '-' + String(i).padStart(2, '0') : '');
        let p = p0;
        let half = o.wide ? 0.035 : (o.hot ? 0.005 : 0.012);
        if (o.arbNo) half = -0.003; // bids sum above 100
        if (o.arbYes) half = -0.004; // asks sum below 100
        half = Math.max(half, -0.004);
        const yb = U.clamp(U.round(p - half, 2), 0.01, 0.98), ya = U.clamp(U.round(p + half, 2), yb + (half < 0 ? 0 : 0.01), 0.99);
        const vol24 = Math.round((o.hot ? 4000 : 600) * (0.3 + rnd() * 1.4));
        const m = {
          ticker: ticker, event: ev.ticker, series: ev.series, type: 'binary',
          title: legs.length > 1 ? ev.title + ': ' + name : ev.title,
          sub: '', yesSub: name, noSub: '', status: 'active',
          open: now - 20 * D, close: o.close, exp: o.close + D,
          yb: yb, ya: ya, nb: U.round(1 - ya, 4), na: U.round(1 - yb, 4), hasBid: true, hasAsk: true,
          ybSize: Math.round(80 + rnd() * 900), yaSize: Math.round(80 + rnd() * 900),
          last: U.round(p, 2), prev: U.clamp(U.round(p + (rnd() - 0.5) * (o.hot ? 0.18 : 0.06), 2), 0.01, 0.99),
          mid: p, vol: vol24 * Math.round(5 + rnd() * 30), vol24: vol24, oi: Math.round(vol24 * (1 + rnd() * 6)),
          result: '', feeWaiverUntil: null, canCloseEarly: false, provisional: false,
          strikeType: '', floor: null, cap: null,
          rules: 'Simulated market. If the stated outcome occurs by the close time, the market resolves YES; otherwise it resolves NO. Settlement follows the primary source named in the full rules.',
          rules2: 'This is demonstration data generated inside Edge Desk; nothing here is a real Kalshi market.',
          updated: now
        };
        if (o.yieldy && p0 > 0.9) { m.ya = 0.95; m.yb = 0.93; m.nb = 0.05; m.na = 0.07; m.last = 0.94; m.mid = 0.94; }
        markets.set(ticker, m);
        ev.markets.push(ticker);
        // history: random walk ending at p
        const pts = [];
        let v = U.clamp(p + (rnd() - 0.5) * 0.3, 0.03, 0.97);
        const n = 24 * 30;
        for (let k = 0; k < n; k++) {
          const drift = (p - v) * 0.02;
          v = U.clamp(v + drift + (rnd() - 0.5) * 0.03, 0.01, 0.99);
          pts.push({ t: now - (n - k) * H, c: U.round(v, 3), vol: Math.round(rnd() * (o.hot ? 400 : 60)) });
        }
        pts[pts.length - 1].c = m.last;
        hist.set(ticker, pts);
      }
      delete ev._legs; delete ev._opts;
    }

    const evMap = new Map(events.map(e => [e.ticker, e]));
    let tradeSeq = 1;
    const tickers = Array.from(markets.keys());

    function synthBook(m) {
      const yesBids = [], noBids = [];
      let p = m.yb, size = m.ybSize;
      for (let k = 0; k < 12 && p >= 0.01; k++) { yesBids.push([U.round(p, 2), Math.round(size)]); p -= 0.01 * (1 + Math.floor(rnd() * 2)); size *= 0.75 + rnd() * 0.6; }
      p = m.nb; size = m.yaSize;
      for (let k = 0; k < 12 && p >= 0.01; k++) { noBids.push([U.round(p, 2), Math.round(size)]); p -= 0.01 * (1 + Math.floor(rnd() * 2)); size *= 0.75 + rnd() * 0.6; }
      return N.book({ orderbook_fp: { yes_dollars: yesBids.map(x => [x[0].toFixed(4), x[1].toFixed(2)]), no_dollars: noBids.map(x => [x[0].toFixed(4), x[1].toFixed(2)]) } });
    }

    return {
      label: 'Simulated',
      events: evMap,
      markets: markets,
      seriesFees: feeSeries,
      status: { exchange_active: true, trading_active: true },
      tick: function () {
        const t = Date.now();
        for (const m of markets.values()) {
          if (rnd() < 0.35) {
            const dv = (rnd() - 0.5) * 0.02;
            let mid = U.clamp(m.mid + dv, 0.02, 0.98);
            const half = Math.max(0.005, (m.ya - m.yb) / 2);
            m.yb = U.clamp(U.round(mid - half, 2), 0.01, 0.98);
            m.ya = U.clamp(U.round(mid + half, 2), m.yb + 0.01, 0.99);
            m.nb = U.round(1 - m.ya, 4); m.na = U.round(1 - m.yb, 4);
            m.mid = (m.yb + m.ya) / 2; m.updated = t;
          }
        }
      },
      trades: function (n) {
        const out = [];
        const t0 = Date.now();
        for (let k = 0; k < n; k++) {
          const m = markets.get(tickers[Math.floor(rnd() * tickers.length)]);
          const takerYes = rnd() < 0.5;
          const price = takerYes ? m.ya : m.yb;
          const qty = Math.round(rnd() < 0.08 ? 400 + rnd() * 2500 : 1 + rnd() * 120);
          m.last = price; m.vol += qty; m.vol24 += qty; m.updated = t0;
          out.push({ id: 'sim-' + (tradeSeq++), ticker: m.ticker, qty: qty, yes: price, no: U.round(1 - price, 4), taker: takerYes ? 'yes' : 'no', t: t0 - Math.floor(rnd() * 3000), block: qty > 2000 });
        }
        return out.sort((a, b) => b.t - a.t);
      },
      book: function (ticker) { const m = markets.get(ticker); return m ? synthBook(m) : null; },
      marketTrades: function (ticker, n) {
        const m = markets.get(ticker); if (!m) return [];
        const out = []; const t0 = Date.now();
        for (let k = 0; k < n; k++) {
          const takerYes = rnd() < 0.5; const price = U.clamp(U.round((takerYes ? m.ya : m.yb) + (rnd() - 0.5) * 0.02, 2), 0.01, 0.99);
          out.push({ id: 'simt-' + ticker + '-' + k, ticker: ticker, qty: Math.round(1 + rnd() * 200), yes: price, no: U.round(1 - price, 4), taker: takerYes ? 'yes' : 'no', t: t0 - k * 240000 - Math.floor(rnd() * 60000), block: false });
        }
        return out;
      },
      candles: function (ticker, period, startMs) {
        const pts = hist.get(ticker) || [];
        const sel = pts.filter(p => p.t >= startMs);
        if (period >= 1440) {
          const byDay = new Map();
          for (const p of sel) { const d = Math.floor(p.t / D); const e = byDay.get(d) || { t: (d + 1) * D, o: p.c, h: p.c, l: p.c, c: p.c, vol: 0 }; e.c = p.c; e.h = Math.max(e.h, p.c); e.l = Math.min(e.l, p.c); e.vol += p.vol; byDay.set(d, e); }
          return Array.from(byDay.values());
        }
        return sel.map(p => ({ t: p.t, o: p.c, h: p.c + 0.005, l: p.c - 0.005, c: p.c, vol: p.vol, oi: 0 }));
      },
      resolveRandom: function () { return null; }
    };
  };

  const ED = { U: U, N: N, F: F, A: A, SIM: SIM };
  root.ED = ED;
  if (typeof module !== 'undefined' && module.exports) module.exports = ED;
})(typeof window !== 'undefined' ? window : globalThis);
