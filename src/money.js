/*
 * Edge Desk — small-money plays, shared by the page and the Worker.
 *
 * A book lock buys one contract on every leg of a one-winner event for less than the set is guaranteed to pay:
 *   YES on every leg pays exactly $1 when one leg must win (the outcomes cover everything);
 *   NO on every leg pays at least $(legs − 1) when at most one leg can win (Kalshi's mutually-exclusive flag).
 * bookPlan sizes it against real order-book depth with per-fill fees, so the page's preview and the Worker's execution
 * agree on how many sets are worth buying and at what prices.
 */
const EDMoney = (function () {
  'use strict';
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  const r4 = (v) => Math.round(v * 10000) / 10000;

  // Kalshi order book → levels in dollars, best first. Buying YES at p meets a NO bid at 1 − p, so YES asks come from NO bids.
  function parseBook(res) {
    const ob = (res && (res.orderbook_fp || res.orderbook)) || {};
    const parse = (arr, scale) => (arr || []).map(x => [num(x[0]), num(x[1])]).filter(x => x[0] !== null && x[1] !== null && x[1] > 0).map(x => [scale ? x[0] / scale : x[0], x[1]]);
    let yesBids, noBids;
    if (ob.yes_dollars || ob.no_dollars) { yesBids = parse(ob.yes_dollars); noBids = parse(ob.no_dollars); }
    else { yesBids = parse(ob.yes, 100); noBids = parse(ob.no, 100); }
    yesBids.sort((a, b) => b[0] - a[0]); noBids.sort((a, b) => b[0] - a[0]);
    return {
      yesBids, noBids,
      yesAsks: noBids.map(x => [r4(1 - x[0]), x[1]]).sort((a, b) => a[0] - b[0]),
      noAsks: yesBids.map(x => [r4(1 - x[0]), x[1]]).sort((a, b) => a[0] - b[0])
    };
  }

  // Kalshi's taker fee on one fill: rate × C × P × (1 − P), rounded up to the cent (the conservative end of the rounding).
  function takerFee(count, price, rate) {
    if (!(count > 0) || !(rate > 0)) return 0;
    return Math.ceil(rate * count * price * (1 - price) * 100 - 1e-9) / 100;
  }

  // The most profitable number of complete sets. legs: [{ ticker, levels: [[price, size], …] cheapest first }].
  // opts: payout (dollars one set is guaranteed), feeRate, minEdge (dollars a set must clear), maxSets, maxCost (dollars),
  // perOrder ({ contracts, dollars }: the Worker's per-order caps). Returns sets = 0 with a reason when nothing locks.
  function bookPlan(legs, opts) {
    const o = opts || {};
    const payout = o.payout, rate = o.feeRate === undefined ? 0.07 : o.feeRate, minEdge = o.minEdge === undefined ? 0.005 : o.minEdge;
    const maxSets = Math.max(0, Math.min(5000, Math.floor(o.maxSets || 0))), maxCost = o.maxCost === undefined ? Infinity : o.maxCost;
    const per = o.perOrder || { contracts: Infinity, dollars: Infinity };
    const best = legs.map(l => (l.levels && l.levels.length ? l.levels[0][0] : null));
    const bestSum = best.every(p => p !== null) ? r4(best.reduce((s, p) => s + p, 0)) : null;
    const walk = (levels, qty) => {
      let left = qty, cost = 0, fee = 0, worst = null;
      for (const [p, s] of levels) { if (left <= 0) break; const q = Math.min(left, s); cost += q * p; fee += takerFee(q, p, rate); worst = p; left -= q; }
      return left > 0 ? null : { cost, fee, worst };
    };
    let plan = null, stop = '';
    if (bestSum === null) stop = 'a leg has nothing offered';
    for (let S = 1; S <= maxSets && bestSum !== null; S++) {
      const fills = legs.map(l => walk(l.levels, S));
      if (fills.some(f => f === null)) { stop = 'not enough offered on every leg for more'; break; }
      if (S > per.contracts) { stop = 'the per-order cap of ' + per.contracts + ' contracts'; break; }
      if (fills.some(f => S * f.worst > per.dollars + 1e-9)) { stop = 'the per-order cap of $' + Number(per.dollars).toFixed(2); break; }
      const cost = fills.reduce((s, f) => s + f.cost, 0), fees = fills.reduce((s, f) => s + f.fee, 0);
      if (cost + fees > maxCost + 1e-9) { stop = 'the budget of $' + Number(maxCost).toFixed(2); break; }
      const profit = S * payout - cost - fees;
      // fees round up per fill, so a few sets can lock less per set than more of them: keep looking past a miss
      if (profit >= minEdge * S - 1e-9 && (!plan || profit > plan.profit + 1e-9)) plan = { sets: S, cost, fees, profit, fills };
    }
    if (!plan) {
      let reason = stop || 'nothing to buy';
      if (bestSum !== null) {
        const one = legs.map(l => walk(l.levels, 1));
        if (one.every(Boolean)) {
          const c1 = one.reduce((s, f) => s + f.cost + f.fee, 0);
          reason = 'one set costs ' + (c1 * 100).toFixed(1) + '¢ with fees and pays ' + (payout * 100).toFixed(0) + '¢' + (c1 < payout ? ', under the ' + (minEdge * 100).toFixed(1) + '¢ a set worth sending' : '');
        }
      }
      return { sets: 0, reason, bestSum, payoutPerSet: payout };
    }
    return {
      sets: plan.sets, cost: plan.cost, fees: plan.fees, payout: plan.sets * payout, payoutPerSet: payout, profit: plan.profit, perSet: plan.profit / plan.sets,
      bestSum, limitedBy: stop,
      legs: legs.map((l, i) => ({ ticker: l.ticker, limit: plan.fills[i].worst, cost: plan.fills[i].cost, fee: plan.fills[i].fee, avg: plan.fills[i].cost / plan.sets }))
    };
  }

  // Do one-winner legs cover every possible outcome? A catch-all leg ("Other", "None of the above") or numeric buckets with
  // both open ends ("48° or below" … "57° or above"). A list of candidates without a catch-all is not a lock for YES.
  const CATCHALL_RE = /\b(other|another|someone else|anyone else|none of|no one|nobody|neither|the field|any other|not listed)\b/i;
  const LOW_RE = /\b(or below|or lower|or less|or fewer|or under|below|under|less than|at most)\b/i;
  const HIGH_RE = /\b(or above|or higher|or more|or over|above|over|more than|greater than|at least)\b/i;
  function covers(names, strikeTypes) {
    const st = strikeTypes || [];
    if (names.some(n => CATCHALL_RE.test(n || ''))) return { ok: true, why: 'a catch-all leg covers every other outcome' };
    if (st.some(s => s === 'less' || s === 'less_or_equal') && st.some(s => s === 'greater' || s === 'greater_or_equal')) return { ok: true, why: 'the buckets run from an open low end to an open high end' };
    if (names.some(n => LOW_RE.test(n || '')) && names.some(n => HIGH_RE.test(n || ''))) return { ok: true, why: 'the buckets run from an open low end to an open high end' };
    return { ok: false, why: 'the listed outcomes are not exhaustive; an unlisted outcome can win' };
  }

  return { parseBook, takerFee, bookPlan, covers, num };
})();
if (typeof window !== 'undefined') window.EDMoney = EDMoney;
