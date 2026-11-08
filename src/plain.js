/* Edge Desk plain-language layer: glossary, guide, and "in plain terms" translations of signals and markets. */
(function () {
  'use strict';
  const { U, A, F } = window.ED;
  const esc = U.esc;

  // Glossary: term key -> {t: label, d: definition}. Written for someone who has never traded anything.
  const GLOSSARY = {
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

  const P = {
    GLOSSARY: GLOSSARY,
    KIND_PLAIN: KIND_PLAIN,
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
      return this.hint('<p>Edge Desk watches the public prices of a few thousand Kalshi markets and flags six kinds of situations that experienced traders look for. Each card says what the numbers show, what has to be true for it to make money, and how it loses. None of it is a recommendation: the scanner reads prices, not news.</p>');
    },
    guideHtml() {
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
