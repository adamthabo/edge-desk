/* Edge Desk app, part 5: Money — small, mostly locked-in plays (book locks and spreads), checked live, with paper and real
   one-tap execution. Locks buy every leg through the Worker's /desk/book (fresh books, all legs at once, extras sold back);
   spreads rest a bid and an offer inside the gap, both post-only. */
(function () {
  'use strict';
  const { U, F } = window.ED;
  const { S, DS, Desk } = window.EDApp;
  const UI = window.UI, Acct = window.EDAcct, P = window.EDPlain, M = window.EDMoney;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;

  const MS = window.EDMoneyState = { checks: new Map(), busy: new Set(), real: new Map(), at: 0 };
  const keyOf = (o) => UI.opKey(o);
  const findOp = (k) => S.scanner.ops.find(o => keyOf(o) === k) || null;
  const canReal = () => Acct.available() && Acct.st.unlocked && Acct.envOk();
  const bank = () => { const b = Math.max(50, S.settings.bankroll || 500); const cash = Acct.st.unlocked && Acct.st.balance ? Acct.st.balance.cash : null; return cash !== null && cash > 0 ? Math.min(b, cash) : b; };
  const caps = () => Acct.st.limits || { contracts: 100, dollars: 100 };
  const sset = () => Object.assign({}, S.settings, { bankroll: bank() }); // spreads are sized on the same money as locks
  const LOCK_SHARE = 0.10, MIN_EDGE = 0.005;
  const horizon = (d) => d === null || d === undefined ? 'at settlement' : d < 1 ? 'in ' + Math.max(1, Math.round(d * 24)) + ' hours' : d < 60 ? 'in ' + Math.round(d) + ' days' : d < 365 ? 'in ' + Math.round(d / 30.4) + ' months' : 'in ' + (d / 365).toFixed(1) + ' years';
  const sideOf = (o) => (o.sub === 'no' ? 'no' : 'yes');
  const payoutOf = (o) => (o.sub === 'no' ? o.tickers.length - 1 : 1);

  /* ---------- the plays ---------- */
  function scanSets(o) { return Math.max(0, Math.min(Math.floor(o.size || 0), Math.floor(bank() * LOCK_SHARE / Math.max(0.01, o.cost)))); }
  // What a lock is worth now: the live check when there is one, else the scan's top-of-book numbers.
  function lockNow(o) {
    const c = MS.checks.get(keyOf(o));
    if (c && c.plan && c.plan.sets) return { live: true, at: c.at, sets: c.plan.sets, profit: c.plan.profit, cost: c.plan.cost + c.plan.fees, payout: c.plan.payout, plan: c.plan };
    if (c && c.plan && !c.plan.sets) return { live: true, gone: true, at: c.at, reason: c.plan.reason, sets: 0, profit: 0, cost: 0, payout: 0 };
    const sets = scanSets(o);
    return { live: false, sets, profit: sets * o.margin, cost: sets * o.cost, payout: sets * payoutOf(o) };
  }
  function locks() {
    return S.scanner.ops.filter(o => o.kind === 'arb').map(o => ({ o, n: lockNow(o) }))
      .sort((a, b) => (a.n.gone === b.n.gone ? 0 : a.n.gone ? 1 : -1) || b.n.profit - a.n.profit).map(x => x.o);
  }
  function spreads() {
    const rank = { do: 0, maybe: 1, skip: 2 };
    return S.scanner.ops.filter(o => o.kind === 'spread').map(o => ({ o, p: P.spreadPlan(o, sset()), v: P.verdict(o, sset()) }))
      .filter(x => x.p.n >= 1).sort((a, b) => (rank[a.v.stance] - rank[b.v.stance]) || b.p.rank - a.p.rank).map(x => x.o);
  }
  function lockVerdict(o, now) {
    const isNo = o.sub === 'no', n = o.tickers.length, side = isNo ? 'NO' : 'YES';
    if (now.gone) return { stance: 'skip', label: 'Gone for now', text: 'The live order books no longer lock a profit (' + now.reason + '). Locks like this come and go; this tab re-checks every 20 seconds while it is open.' };
    if (now.sets < 1) return { stance: 'skip', label: 'Skip', text: 'Not enough on the book for one full set at a profit.' };
    if (now.profit < 0.25) return { stance: 'skip', label: 'Skip', text: 'The whole lock is about ' + U.money(now.profit) + '. Not worth the fees on a leg that fails to fill.' };
    const ann = now.cost > 0 && o.days >= 14 ? (now.profit / now.cost) * (365 / o.days) : null; // a yearly rate means little for a short lock
    const text = 'Buy ' + side + ' on all ' + n + ' outcomes, ' + now.sets + ' set' + (now.sets > 1 ? 's' : '') + ' for about ' + U.money(now.cost) + '. That locks ' + U.money(now.profit) + ' (' + U.cents(now.profit / now.sets) + ' a set), paid ' + horizon(o.days) + (ann !== null ? ', ' + U.pct(ann, 0) + ' a year' : '') + '. ' + (isNo ? 'Kalshi marks this event one-winner, so at most one of your NOs can lose.' : 'Exactly one outcome pays $1 a set because ' + (o.why || 'one of them must happen') + '.') + (now.live ? '' : ' Checking the live books before you act.');
    if (ann !== null && ann < 0.08 && o.days > 45) return { stance: 'maybe', label: 'Maybe', text: text + ' The money is tied up a long time for that; do it only if the cash would sit idle anyway.' };
    return { stance: 'do', label: 'Do it', text };
  }

  /* ---------- live checks ---------- */
  async function check(o) {
    const k = keyOf(o); if (MS.busy.has(k)) return; MS.busy.add(k); soon();
    try {
      const books = await Promise.all(o.tickers.map(t => DS.book(t)));
      const legs = o.tickers.map((t, i) => ({ ticker: t, levels: (books[i] && (o.sub === 'no' ? books[i].noAsks : books[i].yesAsks)) || [] }));
      const m0 = S.universe.markets.get(o.tickers[0]);
      const rate = F.rate('taker', m0 ? Desk.feeInfo(m0) : {});
      const plan = M.bookPlan(legs, { payout: payoutOf(o), feeRate: rate, minEdge: MIN_EDGE, maxSets: caps().contracts, maxCost: bank() * LOCK_SHARE, perOrder: caps() });
      MS.checks.set(k, { at: Date.now(), plan });
    } catch (e) { MS.checks.set(k, { at: Date.now(), error: (e && e.message) || 'could not read the order books' }); }
    finally { MS.busy.delete(k); soon(); }
  }
  function autoCheck() {
    if (S.view !== 'money' || document.hidden) return;
    for (const o of locks().slice(0, 3)) { const c = MS.checks.get(keyOf(o)); if (!MS.busy.has(keyOf(o)) && (!c || Date.now() - c.at > 25000)) check(o); }
  }
  setInterval(autoCheck, 20000);
  let soonT = null;
  function soon() { clearTimeout(soonT); soonT = setTimeout(() => { if (S.view === 'money') UI.renderMoney(); }, 60); }

  /* ---------- paper ---------- */
  function paperLock(o) {
    const now = lockNow(o); const n = Math.max(1, Math.min(now.sets || 1, 50));
    let placed = 0;
    for (const t of o.tickers) { const m = S.universe.markets.get(t); if (!m) continue; const r = Desk.buy(m, sideOf(o), n, 'market', null, null); if (r.ok) placed++; else { UI.toast(r.msg); break; } }
    if (placed) UI.toast('Paper: bought ' + sideOf(o).toUpperCase() + ' on ' + placed + ' of ' + o.tickers.length + ' legs, ' + n + ' each');
    UI.onDesk();
  }
  function paperQuote(o) {
    const m = S.universe.markets.get(o.tickers[0]); if (!m) return;
    const p = P.spreadPlan(o, sset()); if (p.n < 1) { UI.toast('Too small to quote at your bankroll'); return; }
    const a = Desk.buy(m, 'yes', p.n, 'limit', p.bid), b = Desk.buy(m, 'no', p.n, 'limit', U.round(1 - p.ask, 2));
    UI.toast(a.ok && b.ok ? 'Paper: resting a bid for ' + p.n + ' YES at ' + U.cents(p.bid) + ' and an offer at ' + U.cents(p.ask) : (a.ok ? b.msg : a.msg));
    UI.onDesk();
  }

  /* ---------- real ---------- */
  async function openConfirm(o) {
    const k = keyOf(o);
    if (o.kind === 'arb') { MS.real.set(k, { stage: 'checking' }); render(); await check(o); MS.real.set(k, { stage: 'confirm' }); }
    else MS.real.set(k, { stage: 'confirm' });
    render();
  }
  async function sendLock(o) {
    const k = keyOf(o), now = lockNow(o);
    MS.real.set(k, { stage: 'sending' }); render();
    try {
      const r = await Acct.book({ event: o.event, side: sideOf(o), tickers: o.tickers, maxSets: Math.max(1, now.sets), maxCost: Math.max(1, bank() * LOCK_SHARE), minEdge: MIN_EDGE });
      MS.real.set(k, { stage: 'done', book: r });
    } catch (e) { MS.real.set(k, { stage: 'error', error: e.message, gone: !!(e.data && e.data.gone) }); if (e.data && e.data.plan) MS.checks.set(k, { at: Date.now(), plan: e.data.plan }); }
    render();
  }
  async function sendQuote(o) {
    const k = keyOf(o), m = S.universe.markets.get(o.tickers[0]), p = P.spreadPlan(o, sset());
    if (!m) return;
    MS.real.set(k, { stage: 'sending' }); render();
    let bidRes = null, askRes = null, bidErr = '', askErr = '';
    try { bidRes = await Acct.place(m, { side: 'yes', action: 'buy', count: p.n, limit: p.bid, tif: 'gtc', postOnly: true }); } catch (e) { bidErr = e.message; }
    if (!bidErr) { try { askRes = await Acct.place(m, { side: 'no', action: 'buy', count: p.n, limit: U.round(1 - p.ask, 2), tif: 'gtc', postOnly: true }); } catch (e) { askErr = e.message; } }
    MS.real.set(k, bidErr ? { stage: 'error', error: 'The bid was refused: ' + bidErr + '. Nothing was placed.' } : { stage: 'done', quote: { p, bidRes, askRes, askErr } });
    render();
  }
  function realPanel(o) {
    const k = keyOf(o), st = MS.real.get(k); if (!st) return '';
    const back = '<button class="btn sm" data-act="mback" data-k="' + esc(k) + '">Close</button>';
    if (st.stage === 'checking') return '<div class="confirm"><p class="think">Reading every leg\'s order book…</p></div>';
    if (st.stage === 'sending') return '<div class="confirm"><p class="think">Sending to Kalshi…</p></div>';
    if (st.stage === 'error') return '<div class="confirm"><p><b>' + (st.gone ? 'Not sent.' : 'Did not go through.') + '</b> ' + esc(st.error) + '</p><div class="actions">' + back + '</div></div>';
    if (o.kind === 'arb') {
      if (st.stage === 'confirm') {
        const now = lockNow(o);
        if (!now.sets) return '<div class="confirm"><p><b>Nothing to buy right now.</b> ' + esc(now.reason || 'The lock is gone on the live books.') + '</p><div class="actions">' + back + '</div></div>';
        return '<div class="confirm"><p><b>Real money.</b> Buys ' + sideOf(o).toUpperCase() + ' on all ' + o.tickers.length + ' legs: up to <b>' + now.sets + ' sets</b> for about <b>' + U.money(now.cost) + '</b>, locking about <b>' + U.money(now.profit) + '</b>, paid ' + horizon(o.days) + '. The Worker re-reads every order book and sends only if it still locks at least ' + U.cents(MIN_EDGE) + ' a set, so it may buy fewer. All legs go out at once; if some fill more than others, the extra contracts are sold straight back so you are left with complete sets only.</p><div class="actions"><button class="btn sm danger-fill" data-act="mlockgo" data-k="' + esc(k) + '">Buy the book</button>' + back + '</div></div>';
      }
      if (st.stage === 'done') {
        const r = st.book || {};
        const head = r.sets ? 'Bought ' + r.sets + ' complete set' + (r.sets > 1 ? 's' : '') + ' for about ' + U.money(r.cost + r.fees) + '. Locked about ' + U.money(r.locked, { plus: true }) + '; pays ' + U.money(r.payout) + ' ' + horizon(o.days) + '.' : 'No complete sets: the prices moved before every leg filled' + ((r.legs || []).some(l => l.filled > 0) ? ', so what did fill was sold back.' : '; nothing was bought.');
        const extra = (r.legs || []).filter(l => l.extra > 0);
        const tail = extra.length ? ' Sold back ' + extra.map(l => l.sold + ' extra on ' + esc(legName(l.ticker)) + (l.soldAt !== null && l.soldAt !== undefined ? ' near ' + U.cents(l.soldAt) : '')).join(', ') + ' (' + U.money(r.unwindPnl, { plus: true }) + ').' : '';
        const warn = r.unhedged > 0 ? '<p class="down"><b>' + r.unhedged + ' contract' + (r.unhedged > 1 ? 's' : '') + ' could not be sold back.</b> They are in Desk → Live account; sell them there.</p>' : '';
        return '<div class="confirm"><p>' + esc(head) + tail + '</p>' + warn + '<div class="actions"><button class="btn sm" data-act="nav" data-v="desk">See it in Live account</button>' + back + '</div></div>';
      }
    } else {
      const p = P.spreadPlan(o, sset());
      if (st.stage === 'confirm') return '<div class="confirm"><p><b>Real money.</b> Two resting orders, both post-only (they only ever wait on the book, never take a price): <b>buy ' + p.n + ' YES at ' + U.cents(p.bid) + '</b> and <b>offer ' + p.n + ' YES at ' + U.cents(p.ask) + '</b> (buying NO at ' + U.cents(1 - p.ask) + '). Up to ' + U.money(p.capital) + ' is held while they rest. Both filling keeps ' + U.money(p.keep) + '. If only one fills you hold ' + p.n + ' contracts at that price; cancel the other in Live account or leave it to complete.</p><div class="actions"><button class="btn sm danger-fill" data-act="mquotego" data-k="' + esc(k) + '">Place both orders</button>' + back + '</div></div>';
      if (st.stage === 'done') {
        const q = st.quote;
        return '<div class="confirm"><p>' + (q.askRes ? 'Both orders are resting: bid ' + q.p.n + ' at ' + U.cents(q.p.bid) + ', offer ' + q.p.n + ' at ' + U.cents(q.p.ask) + '. They show under Resting orders in Live account.' : 'The bid is resting at ' + U.cents(q.p.bid) + ', but the offer was refused (' + esc(q.askErr) + '). Cancel the bid in Live account if you only wanted both.') + '</p><div class="actions"><button class="btn sm" data-act="nav" data-v="desk">See it in Live account</button>' + back + '</div></div>';
      }
    }
    return '';
  }
  function legName(t) { const m = S.universe.markets.get(t); return m ? (m.yesSub || m.title || t) : t; }

  /* ---------- rendering ---------- */
  function realButton(o) {
    if (S.mode !== 'live' || !Acct.available()) return '';
    if (!canReal()) return '<button class="btn sm ghost" data-act="nav" data-v="desk" title="Desk → Live account">Unlock to do it for real</button>';
    return '<button class="btn sm primary" data-act="mreal" data-k="' + esc(keyOf(o)) + '">' + (o.kind === 'arb' ? 'Buy it for real' : 'Quote it for real') + '</button>';
  }
  function lockCard(o) {
    const k = keyOf(o), now = lockNow(o), c = MS.checks.get(k), busy = MS.busy.has(k);
    const ev = S.universe.events.get(o.event), cat = ev && ev.category ? ev.category : '';
    const isNo = o.sub === 'no', n = o.tickers.length, v = lockVerdict(o, now);
    const ann = now.cost > 0 && o.days >= 14 ? (now.profit / now.cost) * (365 / o.days) : null;
    const amt = now.gone ? '<div class="money-amt"><b class="muted">$0.00</b> <span class="muted">right now · was ' + U.money(scanSets(o) * o.margin) + ' in the scan</span></div>'
      : '<div class="money-amt"><b class="up">' + U.money(now.profit, { plus: true }) + '</b><span class="muted">locked · ' + now.sets + ' set' + (now.sets === 1 ? '' : 's') + ' × ' + U.cents(now.profit / Math.max(1, now.sets)) + ' · costs ' + U.money(now.cost) + ' · pays ' + U.money(now.payout) + (ann !== null ? ' · ' + U.pct(ann, 0) + ' a year' : '') + '</span></div>';
    const live = busy ? '<div class="money-live">Reading the live order books…</div>'
      : c && c.error ? '<div class="money-live">Could not check the live books: ' + esc(c.error) + '</div>'
      : c ? '<div class="money-live ' + (now.gone ? 'gone' : 'ok') + '">' + (now.gone ? 'Gone on the live books ' : 'Still there on the live books, ' + now.sets + ' sets deep' + (c.plan.limitedBy ? ' (limited by ' + esc(c.plan.limitedBy) + ')' : '') + ', ') + U.ago(c.at) + ' ago</div>'
      : '<div class="money-live">From the market scan ' + (S.scanner.at ? U.ago(S.scanner.at) + ' ago' : '') + '; the live books get checked next.</div>';
    const planLegs = c && c.plan && c.plan.legs ? new Map(c.plan.legs.map(l => [l.ticker, l])) : null;
    const legs = '<details class="layer-d"><summary>The ' + n + ' legs</summary><div class="legs">' + o.tickers.map(t => { const m = S.universe.markets.get(t); const pl = planLegs && planLegs.get(t); const px = pl ? pl.avg : (m ? (isNo ? 1 - m.yb : m.ya) : null); return '<div><span class="truncate" style="max-width:70%"><a href="#" data-act="open" data-t="' + esc(t) + '">' + esc(legName(t)) + '</a></span><span class="' + (isNo ? 'no' : 'yes') + '">' + (isNo ? 'NO ' : 'YES ') + (px !== null ? U.cents(px) : '—') + (pl && Math.abs(pl.limit - pl.avg) > 0.0001 ? ' <span class="faint">(up to ' + U.cents(pl.limit) + ')</span>' : '') + '</span></div>'; }).join('') + '</div></details>';
    const why = isNo
      ? '<p>Kalshi says at most one of these ' + n + ' outcomes can happen. Buy NO on all of them and at most one NO loses, so every set pays at least ' + U.money(n - 1) + ', whatever happens. Right now a set costs less than that.</p>'
      : '<p>One of these ' + n + ' outcomes must happen and only one can (' + esc(o.why || 'they cover every possibility') + '). Buy YES on all of them and every set pays exactly $1, whatever happens. Right now a set costs less than that.</p>';
    const catch_ = '<p>The catch is getting every leg filled. Edge Desk sends them all at once and sells back any leg that fills more than the others, so you end up with complete sets only. Read the rules once: a voided market or an odd settlement rule can break a set.</p>';
    const math = '<p>' + esc(o.math) + '</p>' + (c && c.plan && c.plan.sets ? '<p>Live: ' + c.plan.sets + ' sets cost ' + U.money(c.plan.cost) + ' plus ' + U.money(c.plan.fees) + ' in fees (each fill rounded up to the cent) and pay ' + U.money(c.plan.payout) + '. Best prices sum to ' + U.cents(c.plan.bestSum) + '. Budget ' + Math.round(LOCK_SHARE * 100) + '% of ' + U.money(bank()) + '.</p>' : '');
    return '<div class="card opp money" data-mk="' + esc(k) + '">' +
      '<div class="opp-head"><span class="kind arb">' + (isNo ? 'Sell the book' : 'Buy the book') + '</span><span class="faint small">' + n + ' outcomes' + (cat ? ' · ' + esc(cat) : '') + '</span><span class="faint small" style="margin-left:auto">pays out ' + horizon(o.days) + '</span></div>' +
      '<div class="title">' + esc(o.title) + '</div>' + amt + live +
      (P.on() ? P.layer(P.verdictHtml(v), why + catch_, math, { label: 'My call' }) : '<div class="math">' + esc(o.math) + '</div>') + legs +
      '<div class="actions"><button class="btn sm" data-act="mcheck" data-k="' + esc(k) + '"' + (busy ? ' disabled' : '') + '>Check again</button><button class="btn sm" data-act="mpaperl" data-k="' + esc(k) + '"' + (now.gone ? ' disabled' : '') + '>Paper ' + Math.max(1, Math.min(now.sets || 1, 50)) + ' sets</button>' + (now.gone ? '' : realButton(o)) + '</div>' +
      '<div class="money-real">' + realPanel(o) + '</div></div>';
  }
  function spreadCard(o) {
    const k = keyOf(o), p = P.spreadPlan(o, sset()), v = P.verdict(o, sset()), m = S.universe.markets.get(o.tickers[0]);
    const why = '<p>Buyers will pay ' + U.cents(o.yb) + ' and sellers want ' + U.cents(o.ya) + ': a ' + U.cents(o.spread) + ' gap. Rest a bid just above the best bid and an offer just below the best offer; when both fill, you have bought at ' + U.cents(p.bid) + ' and sold at ' + U.cents(p.ask) + ' and the difference is yours, whatever the market does next.</p><p>Both orders only wait on the book, so they never pay to cross the gap. The risk is that one side fills and the other does not because the price moved for a reason, which leaves you holding a position. That is why the size stays small.</p>';
    const math = '<p>' + esc(o.math) + '</p><p>' + p.n + ' a side at ' + U.cents(p.bid) + ' / ' + U.cents(p.ask) + ': ' + U.money(p.capital) + ' held while resting (' + Math.round(p.share * 100) + '% of ' + U.money(bank()) + '); keeps ' + U.cents(p.keepPer) + ' a pair after maker fees when both fill. 24h volume ' + U.compact(o.vol24) + '.</p>';
    return '<div class="card opp money" data-mk="' + esc(k) + '">' +
      '<div class="opp-head"><span class="kind spread">Spread</span><span class="faint small">' + U.cents(o.spread) + ' gap · ' + U.compact(o.vol24) + ' traded today</span>' + (m && m.close ? '<span class="faint small" style="margin-left:auto">closes in ' + U.countdown(m.close) + '</span>' : '') + '</div>' +
      '<div class="title">' + esc(o.title) + '</div>' +
      '<div class="money-amt"><b class="up">' + U.money(p.keep, { plus: true }) + '</b><span class="muted">if both sides fill · ' + p.n + ' at ' + U.cents(p.bid) + ' / ' + U.cents(p.ask) + '</span></div>' +
      (P.on() ? P.layer(P.verdictHtml(v), why, math, { label: 'My call' }) : '<div class="math">' + esc(o.math) + '</div>') +
      '<div class="actions"><button class="btn sm" data-act="mpaperq" data-k="' + esc(k) + '">Paper: quote both sides</button>' + realButton(o) + '<button class="btn sm ghost" data-act="open" data-t="' + esc(o.tickers[0]) + '">Open</button></div>' +
      '<div class="money-real">' + realPanel(o) + '</div></div>';
  }
  function render() { if (S.view === 'money') UI.renderMoney(); }

  Object.assign(UI, {
    renderMoney() {
      const box = $('view-money'); if (!box) return;
      $('money-banner').innerHTML = UI.sourceBanner();
      const L = locks(), Sp = spreads();
      const liveL = L.map(o => lockNow(o)).filter(x => !x.gone && x.sets > 0);
      const total = liveL.reduce((s, x) => s + x.profit, 0);
      const doSp = Sp.filter(o => P.verdict(o, sset()).stance === 'do');
      const spKeep = Sp.slice(0, 12).reduce((s, o) => s + P.spreadPlan(o, sset()).keep, 0);
      $('money-sub').textContent = S.universe.markets.size ? S.universe.markets.size.toLocaleString() + ' open markets scanned ' + (S.scanner.at ? U.ago(S.scanner.at) + ' ago' : '') : 'Loading the market universe';
      $('money-hint').innerHTML = P.on() ? 'Two ways to make small, steady money <b>without predicting anything</b>: buy every outcome of an event for less than the set must pay (a lock), or stand in a wide gap between buyers and sellers and keep the difference. Each is worth cents to a few dollars; they add up by repetition, not by size.' : '';
      $('money-tiles').innerHTML =
        '<div class="tile"><div class="label">Locks now</div><div class="v ' + (liveL.length ? 'up' : '') + '">' + liveL.length + '</div><div class="s">' + (liveL.length ? 'about ' + U.money(total) + ' locked at the shown size' : 'none right now; they are rare and brief') + '</div></div>' +
        '<div class="tile"><div class="label">Spreads to quote</div><div class="v">' + doSp.length + '<span class="faint small"> / ' + Sp.length + '</span></div><div class="s">' + (Sp.length ? 'good ones / all; about ' + U.money(spKeep) + ' if the top 12 fill both ways' : 'no wide gaps with volume right now') + '</div></div>' +
        '<div class="tile"><div class="label">Sized on</div><div class="v">' + U.money(bank()) + '</div><div class="s">' + (Acct.st.unlocked && Acct.st.balance ? 'your Kalshi cash or the bankroll setting, whichever is less' : 'the bankroll setting (Setup); locks use up to 10%, each spread 2%') + '</div></div>';
      $('money-locks-hint').innerHTML = P.on() ? 'Buy one contract of every outcome for less than the set must pay. Nothing to predict: the risks are a leg not filling (Edge Desk sells back any extra) and the rules (a voided market). They are rare and short-lived, so the top three are re-checked against the live order books every 20 seconds while this tab is open.' : '';
      $('money-locks').innerHTML = L.length ? L.slice(0, 12).map(lockCard).join('') : '<div class="empty">' + (S.universe.markets.size ? 'No locks in the scanned markets right now. The scan runs every ' + Math.max(2, S.settings.universeRefreshMin || 15) + ' minutes; widen it with more pages in Setup.' : 'Markets are loading.') + '</div>';
      $('money-spreads-hint').innerHTML = P.on() ? 'Rest a bid just above the best bid and an offer just below the best offer. When both fill you keep the gap. Both orders only wait on the book, so they never pay to cross; the risk is one side filling without the other, so each stays at 2% of your bankroll.' : '';
      $('money-spreads').innerHTML = Sp.length ? Sp.slice(0, 12).map(spreadCard).join('') : '<div class="empty">' + (S.universe.markets.size ? 'No wide spreads with enough trading right now.' : 'Markets are loading.') + '</div>';
      autoCheck();
    },
    // A line on the Scanner when locks exist, pointing at Money.
    moneyBanner() {
      const L = S.scanner.ops.filter(o => o.kind === 'arb').map(o => lockNow(o)).filter(x => !x.gone && x.sets > 0);
      if (!L.length) return '';
      const total = L.reduce((s, x) => s + x.profit, 0);
      return '<div class="banner good"><div><p><b>' + L.length + ' lock' + (L.length > 1 ? 's' : '') + ' right now</b>, about ' + U.money(total) + ' at the shown size: buy every outcome for less than it must pay.</p><div class="actions"><button class="btn sm primary" data-act="nav" data-v="money">Open Money</button></div></div></div>';
    }
  });

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act; if (!/^m(check|paperl|paperq|real|back|lockgo|quotego)$/.test(act)) return;
    const o = findOp(el.dataset.k); if (!o) { UI.toast('That play is no longer in the scan'); render(); return; }
    if (act === 'mcheck') { check(o); return; }
    if (act === 'mpaperl') { paperLock(o); return; }
    if (act === 'mpaperq') { paperQuote(o); return; }
    if (act === 'mreal') { openConfirm(o); return; }
    if (act === 'mback') { MS.real.delete(keyOf(o)); render(); return; }
    if (act === 'mlockgo') { el.disabled = true; sendLock(o); return; }
    if (act === 'mquotego') { el.disabled = true; sendQuote(o); return; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoCheck(); });
})();
