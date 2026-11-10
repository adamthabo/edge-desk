/* Edge Desk plain-language layer: glossary, guide, and "in plain terms" translations of signals and markets. */
(function () {
  'use strict';
  const { U, A, F } = window.ED;
  const esc = U.esc;

  // Glossary: term key -> {t: label, d: definition}. Written for someone who has never traded anything.
  const GLOSSARY = {
    clv: { t: 'closing-line value', d: 'How much better than the final pre-game fair price you bought. Bought at 35¢ with a fair close of 40¢ is +5¢ of CLV. Positive on average over a few dozen bets is the earliest reliable sign of real edge; results take hundreds of bets to say the same thing.' },
    confidence: { t: 'confidence', d: 'How much the engine trusts a line right now: full size needs a sharp book, two or more books in agreement, and a fresh update. Disagreement or age trims the size; a lot of either blocks the game until the lines refresh.' },
    contract: { t: 'contract', d: 'One yes-or-no bet on a real-world event. If you hold YES and the event happens, Kalshi pays you $1 per contract. If it does not happen, the contract is worth $0. NO works the other way around.' },
    price: { t: 'price', d: 'What one contract costs right now, from 1¢ to 99¢. It doubles as the crowd\'s estimate of the odds: a YES price of 42¢ means traders collectively think there is about a 42% chance the event happens.' },
    yes: { t: 'YES', d: 'The side that pays $1 if the event happens. Buying YES at 42¢ risks 42¢ to make 58¢.' },
    no: { t: 'NO', d: 'The side that pays $1 if the event does not happen. A NO price is always 100¢ minus the YES price: if YES is 42¢, NO is 58¢.' },
    bid: { t: 'bid', d: 'The highest price someone is currently willing to pay. If you want to sell right now, this is what you get.' },
    ask: { t: 'ask', d: 'The lowest price someone is currently willing to sell at (also called the offer). If you want to buy right now, this is what you pay.' },
    spread: { t: 'spread', d: 'The gap between the best bid and the best ask. A wide spread means buyers and sellers are far apart; crossing it costs you money, while sitting inside it with your own order can earn it.' },
    last: { t: 'last', d: 'The price of the most recent trade.' },
    change24: { t: '24h change', d: 'How far the last trade price moved compared with a day ago.' },
    volume: { t: 'volume', d: 'How many contracts have changed hands in total since the market opened. Busy markets have tighter prices and are easier to get in and out of.' },
    volume24: { t: '24h volume', d: 'Contracts traded in the last 24 hours. A sudden jump usually means news.' },
    oi: { t: 'open interest', d: 'How many contracts people currently hold. It measures how much money is actually committed to this question.' },
    closes: { t: 'closes', d: 'When trading stops. After this, no one can buy or sell; you wait for the result.' },
    expires: { t: 'expires', d: 'The latest moment the market settles and pays out. Some markets settle sooner if the answer becomes known.' },
    fee: { t: 'fee', d: 'Kalshi charges a small fee when your order trades immediately (a "taker"). It is largest near 50¢, about 1.75¢ per contract, and tiny near 1¢ or 99¢. Orders that wait in line (a "maker") usually pay nothing.' },
    taker: { t: 'taker', d: 'An order that trades immediately against what is already on the book. Convenient, and it pays the fee.' },
    maker: { t: 'maker', d: 'An order that waits on the book until someone else trades with it. On most markets makers pay no fee, but the order may never fill.' },
    book: { t: 'order book', d: 'The list of every waiting buy order (bids) and sell order (asks) at each price, with how many contracts sit at each level. It shows how much you could actually buy before the price moves.' },
    depth: { t: 'depth', d: 'How many contracts can be bought or sold before running out of orders near the current price.' },
    onewinner: { t: 'one-winner book', d: 'An event with several outcomes where exactly one can win, like "which number will the inflation report show." Kalshi lists a separate YES/NO market for each outcome, so their prices should add up to about $1.' },
    exhaustive: { t: 'exhaustive', d: 'The listed outcomes cover every possibility, so one of them must win. A list of five named candidates is not exhaustive unless there is a "someone else" outcome; a list of temperature ranges from "or below" to "or above" is.' },
    arb: { t: 'arbitrage', d: 'A set of trades that locks in a profit whatever happens, because prices are inconsistent with each other. Rare, small, and quickly corrected, but real.' },
    ev: { t: 'expected value (EV)', d: 'Your average profit per contract if you could make this same bet many times, given the probability you believe. Positive EV means the price is in your favor; it says nothing about any single outcome.' },
    breakeven: { t: 'breakeven', d: 'The probability at which this bet neither makes nor loses money on average. If you think the real chance is higher than the breakeven, buying has an edge.' },
    kelly: { t: 'Kelly size', d: 'A formula for how much of your bankroll to risk when you have an edge: more edge, bigger bet. Full Kelly is aggressive; most people use a quarter of it because probabilities are never known exactly.' },
    bankroll: { t: 'bankroll', d: 'The total amount of money you have set aside for trading. Sizing bets as a fraction of it keeps one bad result from ending the game.' },
    annualized: { t: 'annualized', d: 'The return restated as if the money were earning at the same rate for a full year. A 2% gain in one month is about 27% annualized; the same 2% over ten years is nearly nothing.' },
    longshot: { t: 'longshot', d: 'An outcome priced at a few cents. Research on betting markets shows people tend to overpay for longshots, which is why betting against them has had a slight edge on average.' },
    paper: { t: 'paper trading', d: 'Practicing with pretend money at real prices. Edge Desk fills your paper orders against the live order book and charges the real fee, but nothing is sent to Kalshi.' },
    tape: { t: 'tape', d: 'The running list of trades as they happen across the exchange, newest first, like a ticker. Each line is one trade, called a print.' },
    print: { t: 'print', d: 'One completed trade: who was buying (YES or NO), at what price, how many contracts.' },
    flow: { t: 'taker flow', d: 'Of the contracts traded recently, how many were bought by people who wanted YES versus people who wanted NO. It shows which way the eager money is leaning.' },
    notional: { t: 'notional', d: 'The dollar value of contracts traded: contracts times price.' },
    equity: { t: 'equity', d: 'What your paper account is worth right now: cash plus what your open positions would sell for.' },
    position: { t: 'position', d: 'Contracts you currently hold. Open P&L is what you would make or lose if you sold them now; realized P&L is what you have already locked in.' },
    marked: { t: 'marked at the bid', d: 'Positions are valued at the price you could actually sell for right now (the bid), not the last trade. It is the honest number.' },
    limit: { t: 'limit order', d: 'An order that waits for your price. It only fills if the market comes to you, so it can earn the spread, or never fill at all.' },
    market_order: { t: 'market order', d: 'Buy now at the best available price. Certain to fill (up to the size on offer), and it pays the taker fee.' },
    mover: { t: 'mover', d: 'A market whose price moved a lot in a day. Prediction-market prices move on news, so a big move is a hint that something happened.' },
    settle: { t: 'settles', d: 'The moment Kalshi decides the outcome and pays $1 to the winning side. Your contracts turn into cash (or into nothing).' }
  };

  const KIND_PLAIN = {
    arb: { what: 'Prices across the outcomes of one event disagree with each other, so a set of trades can lock in a small profit whichever outcome wins.', win: 'The payout is fixed in advance, regardless of the result.', lose: 'The profit per set is small, fills are limited to the size shown, and an unusual settlement (a voided market, an unlisted outcome) breaks the lock.' },
    yield: { what: 'The crowd is almost certain of the answer. Buying the near-certain side turns, say, 95¢ into $1 when it settles.', win: 'A few percent in days or weeks, if the market is right.', lose: 'If the unlikely thing happens, you lose nearly everything you put in. Small gains, rare but large losses.' },
    spread: { what: 'Buyers and sellers are far apart. You can place your own orders between them and let others come to you.', win: 'You earn the gap, and pay little or no fee, when both your buy and your sell get filled.', lose: 'Often only one side fills, leaving you holding a position you did not want, and the people trading with you may know something.' },
    mover: { what: 'The price jumped in the last day, which in these markets usually means news.', win: 'If you understand the news before the price fully reflects it.', lose: 'Big moves also reverse. Following a move without knowing its cause is a coin flip with fees.' },
    volume: { what: 'Far more contracts are trading today than people already hold. Attention and money are flowing into this question.', win: 'Busy markets have tight prices and are easy to trade in and out of.', lose: 'Heavy trading often means informed traders are active; the easy money has usually been taken.' },
    longshot: { what: 'An outcome priced at a few cents. People tend to overpay for longshots, so betting against them has, on average, had a slight edge.', win: 'A small, frequent profit when the longshot misses, as it usually does.', lose: 'When it hits, you lose the full stake. One miss wipes out many wins.' }
  };

  const KIND_DO = {
    arb: (o) => o.sub === 'no' ? 'Buy NO on every outcome, ' + U.compact(Math.max(1, Math.floor(o.size))) + ' set' + (o.size >= 2 ? 's' : '') + ' at most, with fill-or-cancel orders at the quoted bids.' : 'Buy YES on every outcome with fill-or-cancel orders at the quoted asks; no more than the size shown.',
    yield: (o) => 'Only if you can say why the other side is this unlikely: buy ' + o.side.toUpperCase() + ' at ' + U.cents(o.price) + ', sized so a miss would not hurt.',
    spread: (o) => 'Do not cross this spread. If you want the market, rest a bid at ' + U.cents(o.yb + 0.01) + ' and let others come to you.',
    mover: () => 'Find out why it moved before doing anything. No news you can name, no trade.',
    volume: () => 'Nothing to do by itself. Heavy trading means prices here are probably fair; use it to pick markets to watch.',
    longshot: (o) => 'A small NO bet at ' + U.cents(o.noPrice) + ' is defensible as part of many such bets, never as a single large one.'
  };
  // My call: an opinionated verdict per signal, sized to the user's bankroll.
  function verdictFor(o, settings) {
    const B = Math.max(50, (settings && settings.bankroll) || 500);
    const c = U.cents, m = U.money, pc = (v) => U.pct(v, 0);
    const skip = (why) => ({ stance: 'skip', label: 'Skip', text: why });
    const maybe = (text) => ({ stance: 'maybe', label: 'Maybe, small', text });
    const doit = (text) => ({ stance: 'do', label: 'Do it', text });
    if (o.kind === 'arb') {
      const capDollars = B * 0.10;
      const sets = Math.max(0, Math.min(Math.floor(o.size || 0), Math.floor(capDollars / Math.max(0.01, o.cost))));
      const profit = sets * o.margin;
      if (sets < 1) return skip('There is not enough size on the book for even one full set at these prices. Watch it; locks like this come and go.');
      if (profit < 0.5) return skip('The whole lock is worth about ' + m(profit) + ' (' + sets + ' set' + (sets > 1 ? 's' : '') + ' × ' + c(o.margin) + '). That does not pay for the clicks, or for the risk that one leg fills and another does not.');
      const side = o.sub === 'no' ? 'NO' : 'YES';
      const text = 'Buy ' + side + ' on all ' + o.legs + ' outcomes, ' + sets + ' set' + (sets > 1 ? 's' : '') + ' (' + m(sets * o.cost) + '), fill-or-cancel, every leg within a few seconds. Locks about ' + m(profit) + (o.ann !== null ? ' (' + pc(o.ann) + ' annualized)' : '') + '.' + (o.sub === 'yes' ? ' Only because ' + (o.why || 'the list covers every possibility') + '; read the rules once before you do.' : ' If a leg does not fill, sell what did fill rather than hold a naked position.');
      if (o.ann !== null && o.ann < 0.08) return maybe(text + ' The money is tied up a long time for that; do it only if you have nothing better for the cash.');
      return doit(text);
    }
    if (o.kind === 'yield') {
      const stake = B * 0.02;
      const n = Math.floor(stake / o.cost);
      const other = o.side === 'yes' ? 'NO' : 'YES';
      if (o.ann < 0.15) return skip(pc(o.ann) + ' annualized is not enough pay for a ' + pc(1 - o.price) + ' chance of losing everything you put in.');
      if (n < 1) return skip('At your bankroll even a 2% stake is less than one contract.');
      return maybe('Only if you can say, in one sentence, why ' + other + ' is really a ' + pc(1 - o.price) + ' shot. If you can: buy ' + n + ' ' + o.side.toUpperCase() + ' at ' + c(o.price) + ' (' + m(n * o.cost) + ', 2% of bankroll). A miss costs all of it, so never more than that.');
    }
    if (o.kind === 'spread') {
      const bid = o.yb + 0.01; const n = Math.floor((B * 0.01) / bid);
      if (n < 1) return skip('Too small to matter at your bankroll. Do not cross a ' + c(o.spread) + ' spread for any reason.');
      return maybe('Do not cross it. If you want this market, rest a bid for ' + n + ' YES at ' + c(bid) + ' (' + m(n * bid) + ', 1% of bankroll) and let the market come to you; cancel it if it has not filled by the close. Earn the spread, never pay it.');
    }
    if (o.kind === 'mover') return skip('A ' + c(Math.abs(o.delta)) + ' jump in a day means news, and the people who moved it already know it. Unless you can name the news and judge it better than they did, there is nothing here for you.');
    if (o.kind === 'volume') return skip('Nothing to do. Heavy trading means this price is probably fair. Useful for picking markets to watch, not for betting.');
    if (o.kind === 'longshot') {
      const cost = o.noPrice + (o.fee || 0); const n = Math.floor((B * 0.005) / cost);
      if (n < 1) return skip('Too small to matter at your bankroll; the edge on longshots is real on average but a few cents a contract.');
      return maybe('Only as one of many such bets, never alone: NO at ' + c(o.noPrice) + ' for ' + n + ' contracts (' + m(n * cost) + ', half a percent of bankroll). You win ' + c(1 - cost) + ' per contract most of the time and lose ' + c(cost) + ' when the longshot hits, which wipes out many wins at once.');
    }
    return skip('No rule for this signal yet.');
  }
  const P = {
    GLOSSARY: GLOSSARY,
    KIND_PLAIN: KIND_PLAIN,
    KIND_DO: KIND_DO,
    verdict(o, settings) { return verdictFor(o, settings); },
    verdictHtml(v) { return '<span class="verdict ' + v.stance + '">' + esc(v.label) + '</span> ' + esc(v.text); },
    boardRead(ops, settings) {
      if (!this.on() || !ops.length) return '';
      let d = 0, mb = 0, sk = 0;
      for (const o of ops) { const v = verdictFor(o, settings); if (v.stance === 'do') d++; else if (v.stance === 'maybe') mb++; else sk++; }
      const parts = [];
      parts.push(d ? '<b>' + d + '</b> worth doing' : 'nothing worth doing outright');
      parts.push(mb ? '<b>' + mb + '</b> maybe, small' : '');
      parts.push(sk ? '<b>' + sk + '</b> to skip' : '');
      const line = 'My read of the board: ' + parts.filter(Boolean).join(', ') + '.' + (d ? ' The ones worth doing are at the top.' : ' Passing is a fine outcome; most days look like this.');
      return '<div class="boardread">' + line + '</div>';
    },
    // three-layer block: simple line, then "Why" and "The math" as expanders
    layer(simple, why, deep, opts) {
      opts = opts || {};
      if (!this.on()) return '';
      return '<div class="layer' + (opts.cls ? ' ' + opts.cls : '') + '">' +
        '<div class="layer-do"><span class="layer-l">' + esc(opts.label || 'Do this') + '</span>' + simple + '</div>' +
        (why ? '<details class="layer-d"><summary>Why</summary><div class="layer-body">' + why + '</div></details>' : '') +
        (deep ? '<details class="layer-d"><summary>' + esc(opts.deepLabel || 'The math') + '</summary><div class="layer-body">' + deep + '</div></details>' : '') + '</div>';
    },
    opDo(o) { const f = KIND_DO[o.kind]; return f ? f(o) : ''; },
    lessonsHtml() {
      const L = window.EDLessons; if (!L) return '';
      const start = '<section><h3>Start here</h3><p>Three habits make the difference: read prices as probabilities, bet only when your reason beats the fee, and keep score honestly. Each lesson below has a one-line answer, the reasoning, and the math; read the first layer of all of them, then come back for the rest.</p>' +
        '<div class="decide">' + L.DECIDE.map((d, i) => '<div class="decide-row"><div class="decide-q"><span class="decide-n">' + (i + 1) + '</span>' + esc(d.q) + '</div><div class="decide-a"><span class="up">Yes:</span> ' + esc(d.yes) + ' <span class="down">No:</span> ' + esc(d.no) + '</div></div>').join('') + '</div></section>';
      const lessons = L.LESSONS.map(l => '<section id="lesson-' + l.id + '"><h3>' + esc(l.title) + '</h3><p class="lesson-simple">' + esc(l.simple) + '</p><details class="layer-d"><summary>Why</summary><div class="layer-body"><p>' + esc(l.why) + '</p></div></details><details class="layer-d"><summary>The math</summary><div class="layer-body"><p>' + esc(l.deep) + '</p></div></details></section>').join('');
      return '<div class="guide">' + start + lessons + '<section><h3>Before you trade for real</h3><p>Edge Desk places real orders only when you unlock your account and ask it to, or when you start the engine inside caps you set. Event contracts can lose the entire amount risked. This is a tool, not advice.</p></section></div>';
    },
    // market panel decision at the user's belief
    decision(m, q, info, rounding, bankroll, kellyFrac) {
      if (!this.on()) return '';
      const F = window.ED.F, A = window.ED.A;
      const yesPx = m.hasAsk ? m.ya : null, noPx = m.hasBid ? U.round(1 - m.yb, 4) : null;
      const ey = yesPx !== null ? A.edge(q, 'yes', yesPx, F.perContract(yesPx, 'taker', info, rounding)) : null;
      const en = noPx !== null ? A.edge(q, 'no', noPx, F.perContract(noPx, 'taker', info, rounding)) : null;
      const margin = 0.015;
      let simple, why, deep;
      const pick = (ey && ey.ev > margin) ? ey : (en && en.ev > margin) ? en : null;
      if (!pick) {
        const gap = Math.max(ey ? ey.ev : -1, en ? en.ev : -1);
        simple = '<b>Nothing to do</b> at a ' + Math.round(q * 100) + '% belief. The market and you agree within fees' + (gap > 0 ? ' (best edge ' + U.cents(gap) + ', under the 1.5¢ margin)' : '') + '.';
        why = '<p>A bet needs to clear the fee and a margin for being wrong about the probability. Here the better side would make ' + (gap > 0 ? U.cents(gap) : 'nothing') + ' per contract on average, which is inside the noise. Passing is the right answer most of the time; it costs nothing.</p>';
        deep = '<p>EV(YES) = ' + (ey ? U.signed(ey.ev * 100, 1) + '¢' : '—') + ' at ' + U.cents(yesPx) + '; EV(NO) = ' + (en ? U.signed(en.ev * 100, 1) + '¢' : '—') + ' at ' + U.cents(noPx) + '. Breakeven beliefs: YES ' + (ey ? U.pct(ey.breakeven, 1) : '—') + ', NO ' + (en ? U.pct(1 - en.breakeven, 1) : '—') + ' (as P(YES)). Move the slider to see where a side turns positive.</p>';
      } else {
        const side = pick.side.toUpperCase();
        const sz = A.sizeFor(bankroll, kellyFrac, pick);
        simple = '<b>Buy ' + side + '</b> at ' + U.cents(pick.price) + ' or better, up to <b>' + sz.contracts + ' contracts</b> (' + U.money(sz.stake) + ') at your ' + Math.round(q * 100) + '% belief. If you cannot get that price, rest a bid instead of chasing.';
        why = '<p>At ' + Math.round(q * 100) + '% you believe ' + side + ' is worth ' + U.cents(pick.p) + ' and it costs ' + U.cents(pick.cost) + ' with the fee, so each contract makes about ' + U.cents(pick.ev) + ' on average. That is only an average: this single bet still loses ' + U.pct(1 - pick.p, 0) + ' of the time, which is why the size is a quarter of the Kelly amount.</p>';
        deep = '<p>EV = p − (price + fee) = ' + U.cents(pick.p) + ' − (' + U.cents(pick.price) + ' + ' + U.cents(pick.fee) + ') = ' + U.cents(pick.ev) + '. Return on cost ' + U.signed(pick.roi * 100, 1) + '%. Kelly f* = (p − c)/(1 − c) = ' + U.pct(pick.kelly, 1) + ' of bankroll; × ' + kellyFrac + ' = ' + U.pct(pick.kelly * kellyFrac, 1) + ' → ' + U.money(sz.stake) + ' → ' + sz.contracts + ' contracts. The other side: ' + (pick === ey ? (en ? 'NO at ' + U.cents(noPx) + ' has EV ' + U.signed(en.ev * 100, 1) + '¢' : 'no NO offer') : (ey ? 'YES at ' + U.cents(yesPx) + ' has EV ' + U.signed(ey.ev * 100, 1) + '¢' : 'no YES offer')) + '.</p>';
      }
      return this.layer(simple, why, deep, { label: 'What to do' });
    },
    on() { return !(window.EDS && window.EDS.settings && window.EDS.settings.explain === false); },
    // inline tappable term
    term(key, text) {
      const g = GLOSSARY[key];
      if (!g) return esc(text || key);
      return '<button type="button" class="term" data-term="' + key + '">' + esc(text || g.t) + '</button>';
    },
    hint(html) { return this.on() ? '<div class="plain"><span class="plain-l">In plain terms</span>' + html + '</div>' : ''; },
    // per-signal translation using the op's numbers
    opPlain(o, mkts) {
      if (!this.on()) return '';
      const c = (v) => U.cents(v);
      let s = '';
      if (o.kind === 'arb' && o.sub === 'no') {
        s = 'Only one of these ' + o.legs + ' outcomes can happen, but what buyers are offering for YES on each one adds up to ' + c(o.sumBid) + ', more than the $1 the single winner will pay. If you bet NO on every outcome, a full set costs ' + c(o.cost) + ' and pays back at least $' + (o.legs - 1).toFixed(2) + ' no matter which outcome wins, so about ' + c(o.margin) + ' per set is yours either way. You can do that ' + U.compact(o.size) + ' times at today\'s prices.';
      } else if (o.kind === 'arb' && o.sub === 'yes') {
        s = 'One of these ' + o.legs + ' outcomes has to happen, because ' + (o.why || 'the list covers every possibility') + '. Buying YES on all of them costs ' + c(o.cost) + ' per set, and whichever one wins pays $1, leaving about ' + c(o.margin) + ' per set regardless of the result.';
      } else if (o.kind === 'yield') {
        const prob = o.side === 'yes' ? o.price : o.price; // price of the side bought ≈ its probability
        s = 'The market is about ' + U.pct(prob, 0) + ' sure this will ' + (o.side === 'yes' ? 'happen' : 'not happen') + '. Buying ' + o.side.toUpperCase() + ' at ' + c(o.price) + ' turns into $1 when it settles in ' + (o.days < 1 ? Math.round(o.days * 24) + ' hours' : Math.round(o.days) + ' days') + ' if the market is right, a ' + U.pct((1 - o.cost) / o.cost, 1) + ' gain. If the unlikely thing happens instead, you lose the whole ' + c(o.cost) + '.';
      } else if (o.kind === 'spread') {
        s = 'The most anyone will pay for YES right now is ' + c(o.yb) + ', and the least anyone will sell for is ' + c(o.ya) + ': a ' + c(o.spread) + ' gap. Placing your own buy order just above ' + c(o.yb) + ' and your own sell order just below ' + c(o.ya) + ' lets you earn most of that gap, but only if other traders come to you on both sides.';
      } else if (o.kind === 'mover') {
        s = 'The last trade was ' + c(o.last) + ', ' + (o.delta > 0 ? 'up' : 'down') + ' from ' + c(o.prev) + ' a day ago, on ' + U.compact(o.vol24) + ' contracts traded. In these markets a move this size usually means news; knowing what the news was matters more than the move itself.';
      } else if (o.kind === 'volume') {
        s = U.compact(o.vol24) + ' contracts traded in the last day, ' + U.round(o.vol24 / o.oi, 1) + ' times more than the ' + U.compact(o.oi) + ' contracts people currently hold. That much attention usually means sharper prices and easier trading, and also that well-informed traders are already here.';
      } else if (o.kind === 'longshot') {
        s = 'The crowd gives this about a ' + U.pct(o.ya, 0) + ' chance. People tend to overpay for longshots, so betting NO at ' + c(o.noPrice) + ' has, on average, carried a slight edge. You risk ' + c(o.noPrice + o.fee) + ' to make ' + c(1 - o.noPrice - o.fee) + '; a single hit costs you many wins.';
      }
      if (!s) return '';
      return this.hint('<p>' + esc(s) + '</p>');
    },
    // market panel: reading the quote
    marketPlain(m, ev) {
      if (!this.on()) return '';
      const yes = m.hasAsk ? m.ya : (m.mid !== null ? m.mid : m.last);
      if (yes === null || yes === undefined) return '';
      const no = m.hasBid ? U.round(1 - m.yb, 4) : U.round(1 - yes, 4);
      const q = (ev && ev.mutEx && ev.markets.length > 1) ? ('this outcome (' + (m.yesSub || m.title) + ')') : 'this';
      const lines = [
        'Traders currently put the odds of ' + q + ' at about <b>' + U.pct(yes, 0) + '</b>. That is what the YES price of ' + U.cents(yes) + ' means.',
        'Buy <b>YES</b> at ' + U.cents(yes) + ': if it happens, each contract pays $1 (you make ' + U.cents(1 - yes) + '); if not, you lose the ' + U.cents(yes) + '.',
        'Buy <b>NO</b> at ' + U.cents(no) + ': if it does not happen, each contract pays $1 (you make ' + U.cents(1 - no) + '); if it does, you lose the ' + U.cents(no) + '.',
        'Trading stops ' + U.dateShort(m.close) + ' (' + U.countdown(m.close) + ' from now). ' + (m.hasBid && m.hasAsk && m.ya - m.yb > 0.0001 ? 'The ' + U.cents(m.ya - m.yb) + ' gap between the best bid and the best ask is what it costs to get in and straight back out.' : '')
      ];
      return this.hint('<ul>' + lines.map(l => '<li>' + l + '</li>').join('') + '</ul>');
    },
    calcPlain() {
      if (!this.on()) return '';
      return this.hint('<p>Slide to the chance <i>you</i> believe. If your number is higher than the YES price, buying YES has an edge; if lower, NO does. The boxes show the average profit per contract at your belief (' + this.term('ev', 'expected value') + '), the belief at which you would merely ' + this.term('breakeven', 'break even') + ', and a ' + this.term('kelly', 'Kelly') + ' bet size. Edges only pay off over many bets; any single one can lose.</p>');
    },
    ticketPlain() {
      if (!this.on()) return '';
      return this.hint('<p>This is practice money. A ' + this.term('market_order', 'market order') + ' buys at the best price on the book right now and pays the fee; a ' + this.term('limit', 'limit order') + ' waits for the price you name and may never fill. Positions pay $1 each if you are right and $0 if not, exactly as on Kalshi.</p>');
    },
    tapePlain() {
      if (!this.on()) return '';
      return this.hint('<p>Every line is one trade somewhere on Kalshi, newest first. <b>YES 42¢</b> means someone just bought YES at 42¢; the number on the right is how many contracts. Big prints are highlighted because large, sudden bets often mean someone knows something. <b>Taker flow</b> shows whether the eager money has been buying YES or NO lately.</p>');
    },
    deskPlain() {
      if (!this.on()) return '';
      return this.hint('<p>A pretend account that trades at real prices with real fees. <b>Equity</b> is cash plus what your positions would sell for right now (valued at the bid, the honest number). <b>Open P&amp;L</b> is what you would make or lose selling everything now; <b>Realized</b> is what past trades already locked in. Positions settle automatically when Kalshi announces the result.</p>');
    },
    scannerPlain() {
      if (!this.on()) return '';
      return this.hint('<p>Edge Desk watches the public prices of a few thousand Kalshi markets and flags six kinds of situations that experienced traders look for. Each card opens with <b>My call</b>: Do it, Maybe small, or Skip, with the exact action sized to your bankroll and the one reason that decides it. Open <i>Why</i> for the reasoning and <i>The math</i> for the numbers. The scanner reads prices, not news, so a call is a starting point for your judgment, not an order.</p>');
    },
    guideHtml() {
      if (window.EDLessons) return this.lessonsHtml();
      const T = (k, t) => this.term(k, t);
      return '<div class="guide">' +
        '<section><h3>What Kalshi is</h3><p>A regulated exchange where people trade yes-or-no questions about the real world: will the Fed cut rates, will it rain in New York tomorrow, who wins the game. Each question is a ' + T('contract') + '. If you hold <b>YES</b> and the thing happens, Kalshi pays you $1 per contract; if it does not, the contract is worth nothing. <b>NO</b> is the mirror image.</p><p>The ' + T('price') + ' is the crowd\'s estimate of the odds. YES at 42¢ means traders collectively think there is about a 42% chance. Buy YES at 42¢ and you risk 42¢ to make 58¢. Buy NO at 58¢ and you risk 58¢ to make 42¢.</p></section>' +
        '<section><h3>Two prices, not one</h3><p>At any moment there is a ' + T('bid') + ' (the most anyone will pay) and an ' + T('ask') + ' (the least anyone will sell for). The gap is the ' + T('spread') + '. If you want to trade right now you pay the ask or receive the bid, and Kalshi charges a small ' + T('fee') + ' for the convenience, biggest around 50¢ (about 1.75¢ a contract) and tiny near the ends. If you are willing to wait, a ' + T('limit', 'limit order') + ' sits on the ' + T('book', 'order book') + ' and usually pays no fee, but it may never fill.</p></section>' +
        '<section><h3>How anyone makes money here</h3><p>There are only a few honest ways:</p><ul>' +
        '<li><b>Know better than the crowd.</b> If you believe the real chance is 60% and YES costs 42¢, buying YES has a positive ' + T('ev', 'expected value') + '. The Edge calculator on every market does this arithmetic for you, fees included.</li>' +
        '<li><b>Catch prices that disagree with each other.</b> When one event has several outcomes but only one can win (a ' + T('onewinner', 'one-winner book') + '), the YES prices should add up to about $1. When they don\'t, a set of trades can lock in a profit whatever happens. That is ' + T('arb', 'arbitrage') + '; it is small and rare, and the Scanner flags it only when the math really closes.</li>' +
        '<li><b>Get paid to wait.</b> Near-certain outcomes trade at 95¢ or so; buying them is like a short-term bond with a tail risk. Wide spreads pay patient traders who place orders in the gap.</li>' +
        '<li><b>Lean on known tendencies.</b> People overpay for ' + T('longshot', 'longshots') + ', so betting against them has had a slight average edge. Tendencies are not guarantees.</li></ul></section>' +
        '<section><h3>How anyone loses</h3><p>Fees eat small edges. Near-certain bets lose everything on the rare miss. "Locked" profits break when a market is voided or an outcome nobody listed wins. Prices move on news you have not seen yet. Sizing too big turns a good bet into a ruined bankroll, which is why the calculator suggests a fraction of the ' + T('kelly', 'Kelly') + ' size.</p></section>' +
        '<section><h3>What Edge Desk does</h3><ul><li><b>Scanner</b> watches a few thousand markets and flags six kinds of situations, each with the math and a plain-language translation.</li><li><b>Markets</b> lets you search and open any market: price history, the order book, recent trades, the rules, and the edge calculator.</li><li><b>Tape</b> streams every trade on the exchange as it happens.</li><li><b>Desk</b> is a ' + T('paper', 'paper-trading') + ' account: pretend money, real prices, real fees, so you can test ideas without risking anything.</li><li><b>Claude\'s read</b> asks Claude for a calibrated opinion on a market or a ranking of the scan, when you want a second pair of eyes.</li></ul></section>' +
        '<section><h3>Before you trade for real</h3><p>Edge Desk never places real orders; it links to Kalshi, where the decision is yours. Event contracts can lose the entire amount you put in. Start on paper, bet small, and read the rules of a market before trusting its price. This is a tool, not advice.</p></section>' +
        '</div>';
    }
  };
  window.EDPlain = P;
})();
