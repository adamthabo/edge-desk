/* Edge Desk lessons: the knowledge core, written in three layers (simple → why → the math). */
(function () {
  'use strict';
  const LESSONS = [
    {
      id: 'price', title: 'A price is a probability',
      simple: 'A YES price of 42¢ means the crowd thinks there is about a 42% chance the thing happens. NO is always the mirror: 58¢.',
      why: 'Every contract pays $1 if you are right and $0 if not, so paying 42¢ only makes sense if you think the chance is better than 42%. That turns every market into a simple question: is the real chance higher or lower than the price? Everything else on this desk is a way of answering that question carefully.',
      deep: 'Price ≈ probability holds because a contract is a bet with a $1 payout: fair price = P(YES) × $1. The last cent or two of a price is noise from the spread and from fees, so treat "the price" as the midpoint between the best bid and the best ask. A NO contract at (1 − price) is the same claim from the other side; buying NO at 58¢ is identical to selling YES at 42¢.'
    },
    {
      id: 'yesno', title: 'YES or NO? Neither is smarter',
      simple: 'Think in probabilities, not sides. Whichever side is cheaper than your estimate is the right side; if neither beats the fee, do nothing.',
      why: 'YES and NO are the same bet seen from opposite ends, so neither is "the smart side." Take a market at 42¢ with a 1.7¢ fee. If you believe 50%, YES is cheap by 8¢: buy YES. If you believe 35%, YES is overpriced by 7¢, which means NO at 58¢ is cheap by 7¢: buy NO. If you believe 40–44%, neither side beats the fee, and the right move is nothing. Most of the time that is the answer.',
      deep: 'EV(YES) = p − (ask_yes + fee); EV(NO) = (1 − p) − (ask_no + fee), and since ask_no ≈ 1 − bid_yes, the two are mirror images separated by the spread. Buying both at the asks always loses the spread: 43¢ + 59¢ = $1.02 for a sure $1.00. The two honest versions of "both" are market making (rest bids under both asks, e.g. 41¢ + 57¢ = 98¢, earned only when both fill) and hedging later (bought YES at 30¢, price now 60¢: buying NO at 40¢ locks 30¢, the same as selling at 60¢).'
    },
    {
      id: 'spread', title: 'Two prices, one spread',
      simple: 'There is a bid (most anyone will pay) and an ask (least anyone will sell for). Trade now and you pay the gap plus a fee; wait with your own order and you can be paid instead.',
      why: 'Crossing the spread is the quiet cost that eats small edges. In a market quoted 40 / 44, buying at 44 and selling at 40 a minute later loses 4¢ before fees. Resting your own bid at 41 means you only trade when someone comes to you, and most Kalshi markets charge no fee for that. The catch: a resting order may never fill, or fill only when the price is moving against you.',
      deep: 'Kalshi\'s taker fee is ceil(0.07 × contracts × P × (1 − P)), largest at 50¢ (1.75¢ per contract) and tiny near 1¢ or 99¢; makers pay 0 on most series and 0.0175 × P × (1 − P) on a few (sports among them). A 4¢ spread at 50¢ therefore costs a taker about 5.75¢ round trip, which is why the Scanner flags wide spreads as something to quote inside, not something to cross.'
    },
    {
      id: 'edge', title: 'Edge, in one line',
      simple: 'Edge = your probability − what you pay (price plus fee). Positive edge means the price is in your favor; it says nothing about any single outcome.',
      why: 'A bet with 5¢ of edge still loses often. Edge is an average that shows up over many bets, which is why the desk sizes small and keeps a journal: one result tells you nothing, a hundred tell you whether your probabilities are better than the market\'s. The breakeven belief is the probability at which the bet neither makes nor loses on average; if your honest estimate is below it, pass.',
      deep: 'Per contract: EV = p − c where c = price + fee. Return on capital = EV / c. Breakeven belief = c. Variance per contract ≈ p(1 − p), so the standard deviation of the average over n bets shrinks as 1/√n: with 3¢ of true edge at 50¢ you need on the order of 300 bets before the result is distinguishable from luck. That is why the calibration tile, not the P&L, is the thing to watch early.'
    },
    {
      id: 'kelly', title: 'How much to bet',
      simple: 'Bet a fraction of your bankroll that grows with your edge and shrinks with the price. The desk uses a quarter of the Kelly size, which is what careful bettors do.',
      why: 'Betting too much is the fastest way to lose with a winning strategy: a few bad results in a row wipe out the bankroll before the edge can show. Kelly is the size that grows a bankroll fastest if your probability is exactly right; since it never is, a quarter of it gives up a little growth for far smaller swings. The per-game and total caps exist because correlated bets (two buckets of the same event, two legs of one game) behave like one big bet.',
      deep: 'Kelly fraction f* = (p − c) / (1 − c) with c = price + fee. Example: p = 0.50, c = 0.44 → f* = 0.107 of bankroll; quarter Kelly = 2.7%, so $13 on a $500 bankroll, about 30 contracts at 44¢. Full Kelly has roughly a 50% chance of halving the bankroll at some point; quarter Kelly cuts the drawdown about fourfold while keeping about three quarters of the growth rate.'
    },
    {
      id: 'arb', title: 'Locked profits (arbitrage)',
      simple: 'When one event has several outcomes but only one can win, the YES prices should add up to about $1. When they don\'t, a set of trades can lock in a profit whichever outcome happens.',
      why: 'If the YES bids on all four outcomes of "which number will the jobs report show" add up to 107¢, buying NO on every outcome costs $2.93 per set and pays back at least $3.00 no matter what. That is the closest thing to free money here. It is rare, small, limited to the size resting on the book, and it disappears quickly. The Scanner also checks the other direction (asks summing under $1) but only calls it a lock when the list of outcomes covers every possibility.',
      deep: 'Sell-the-book: Σ bid_i > 1 + Σ fees ⇒ buy NO on all legs; payout ≥ (n − 1) dollars if at most one leg settles YES, n dollars if none does. Buy-the-book: Σ ask_i < 1 − Σ fees ⇒ buy YES on all legs; payout exactly $1 only if the legs are exhaustive (a catch-all leg, or numeric buckets with open ends). Margin per set is tiny, so the desk also annualizes it over the time to settlement: 0.7¢ on $2.93 settling in 10 days is 8.7% annualized; the same margin over three years is noise.'
    },
    {
      id: 'sharp', title: 'Why sharp sportsbooks are the yardstick',
      simple: 'Pinnacle and a few other books take huge bets from professionals and move their lines fast. Their devigged odds are the best public estimate of a game\'s outcome.',
      why: 'Kalshi\'s sports prices are set by its own traders, who are often slower than the sharp books after injury news or sharp money. When Kalshi\'s price is a few cents off the books, the books are usually right. The engine does not pretend to know football; it borrows the books\' probability and acts only on the gap. The gap is usually small, so the engine is patient and stops before kickoff, when pre-game lines stop describing the market.',
      deep: 'Devig: convert decimal odds to implied probabilities (1/odds) and normalize so they sum to 1 (multiplicative method; Shin or power methods differ by a fraction of a cent at these margins). Books are combined by weight (Pinnacle 3, Lowvig and BetOnline 2, US books 1). The engine then shrinks toward Kalshi\'s mid: p* = 0.8 × p_books + 0.2 × mid, so Kalshi\'s own information is not ignored. Ties are rare in these sports and are ignored by the two-way devig; that is a small, known bias.'
    },
    {
      id: 'engine', title: 'What the engine does, step by step',
      simple: 'Every minute it matches Kalshi games to sharp lines, buys when Kalshi is clearly wrong, otherwise rests bids below fair value, pulls everything before kickoff, holds to settlement, and writes down what it believed.',
      why: 'The rules are deliberately boring. It never chases a price, never bets on a game it cannot match to a line, never exceeds the caps you set, and stops itself for the day after a set loss. Boring is what lets a small edge survive contact with real markets; most people lose not because their ideas are wrong but because they size badly or bet when there is nothing to do.',
      deep: 'Take when ask + fee + margin ≤ p* (margin default 2¢), fill-or-cancel, size by quarter Kelly capped by room under the per-game and total limits and by the size on offer. Otherwise quote a post-only bid at floor(p* − 3¢ − maker fee), re-quoted when p* moves a cent, never crossing the ask. Quotes are cancelled when kickoff is within 2 minutes or the match is lost. Resting orders are reconciled against the exchange each tick; filled positions are settled from Kalshi\'s result and the P&L, fees and Brier terms are journaled by strategy kind.'
    },
    {
      id: 'clv', title: 'The closing line: the fastest honest scorecard',
      simple: 'Sportsbook prices are sharpest a few minutes before a game starts. If you bought at 35¢ and the fair price at kickoff was 40¢, you beat the closing line by 5¢, whatever happened in the game. Do that on average over a few dozen bets and you have a real edge. Fail to and you do not, even if you have been winning.',
      why: 'Results need hundreds of bets to separate luck from skill. The closing line needs tens, because it is a price, not a coin flip: the final pre-game price absorbs every bettor\'s information and is the most accurate forecast available. Beating it consistently is what professional bettors measure themselves by, and it is the first thing the engine looks at. A sport where the engine keeps landing on the wrong side of the close gets paused automatically.',
      deep: 'CLV = p_close − price paid (in probability points, fee not included), where p_close is the devigged consensus of the sharp books in the last minutes before kickoff; the desk also records Kalshi\'s own last mid for comparison. With a 2¢ taker fee and 2¢ margin, the engine needs about +4¢ of CLV to profit; average CLV above zero across 30+ fills in a sport is the condition for leaving that sport on. The brake fires at mean CLV below −0.5¢ over 20+ fills in 30 days and lasts 7 days; both thresholds are settings.'
    },
    {
      id: 'calibration', title: 'Am I actually good at this?',
      simple: 'The calibration tile compares the probabilities you (or the engine) believed with what actually happened, and does the same for the market\'s prices. If your number is not lower than the market\'s, you have no edge, whatever the P&L says.',
      why: 'P&L is noisy; a lucky week looks exactly like skill. Calibration asks a sharper question: when you said 60%, did it happen about 60% of the time, and did you do that better than the price did? It needs volume to mean anything, roughly a hundred settled bets before the comparison is worth trusting, which is another reason to start small.',
      deep: 'Brier score = mean of (p − outcome)² over settled bets, where outcome is 1 or 0; lower is better, 0.25 is a coin flip. The desk computes it for p* and for the market mid at the time of the bet. A difference of 0.01–0.02 in your favor over a few hundred bets is a real edge in these markets; anything smaller is inside the noise. ROI by strategy kind (taker vs maker) shows where the edge actually comes from.'
    },
    {
      id: 'risk', title: 'Risk rules that keep you in the game',
      simple: 'Small bets, hard caps, a daily stop, and never averaging down. The goal of the first months is to still be playing, not to be rich.',
      why: 'Every rule here exists because of a common way people blow up: betting bigger after losses, stacking correlated bets, trading in-play with a pre-game model, or trusting a hot streak. The daily stop turns a bad day into a small number instead of a story. The per-game cap keeps one upset from mattering. The kickoff rule keeps the engine out of markets its model does not describe.',
      deep: 'With quarter Kelly on true 3¢ edges, a 20% drawdown is ordinary and a 35% drawdown is possible in a bad quarter; the daily stop ($50 on $500) bounds the per-day damage at 10%. Caps are additive across both legs of a game because the engine\'s bids on both teams can fill together. The Worker\'s MAX_ORDER_* limits sit underneath everything as a hard floor that no setting on the page can lift.'
    },
    {
      id: 'firstweeks', title: 'Your first two weeks',
      simple: 'Week one: paper only, read every "Why." Week two: engine on at the default caps, dry run first, check the calibration tile daily, change nothing else.',
      why: 'The desk gets more useful once you have watched it be wrong a few times. Paper trading at live prices with real fees shows you how often "obvious" bets lose and how much the spread costs. The engine\'s dry run shows what it would do and why before it risks a dollar. Resist raising caps on a good week; raise them when the calibration tile has earned it.',
      deep: 'A reasonable escalation rule: after 100 settled engine bets with Brier(p*) < Brier(market) and ROI > 0, double the per-game cap once; repeat the test before each further increase. If Brier(p*) ≥ Brier(market) after 200 bets, the books are not sharper than Kalshi on those games; turn the taker side off and keep only the maker side, or switch sports. Keep the daily stop at 10% of bankroll throughout.'
    }
  ];
  // decision guide shown in Learn
  const DECIDE = [
    { q: 'Do I have a reason my probability should differ from the price?', yes: 'Go on.', no: 'Pass. The price is already a good forecast.' },
    { q: 'Is the gap bigger than the fee plus a margin (about 3¢)?', yes: 'Go on.', no: 'Pass; the edge is inside the noise and the spread.' },
    { q: 'Can I get filled near the quote (tight spread, size on the book)?', yes: 'Go on.', no: 'Rest a limit order inside the spread instead of crossing it.' },
    { q: 'Is the size a quarter of Kelly or less, and inside my caps?', yes: 'Place it, on paper first if you are new.', no: 'Cut the size. The edge does not get bigger because you bet more.' }
  ];
  window.EDLessons = { LESSONS, DECIDE };
})();
