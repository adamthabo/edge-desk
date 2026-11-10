// Pure engine math: devig, consensus, confidence, budgets, sizing. No network, no runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Eng } from './_load.mjs';

const { devig2, devigPower, consensus, confidence, oddsBudget, feeFor, kellyCount, teamMatch, legSide, TEAM_ALIASES, parseEventDate, hourIn, dayIn, ENGINE_DEFAULTS } = Eng;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('devig: multiplicative and power both sum to one; power favours the favourite', () => {
  const q = [1 / 1.25, 1 / 4.3]; // −400 / +330 style line, 3.3% overround
  const [m0, m1] = devig2(q[0], q[1]);
  const [p0, p1] = devigPower(q);
  assert.ok(near(m0 + m1, 1) && near(p0 + p1, 1), 'both methods normalise');
  assert.ok(p0 > m0, 'power gives the favourite more than multiplicative (' + p0.toFixed(4) + ' vs ' + m0.toFixed(4) + ')');
  assert.ok(p0 - m0 < 0.03, 'but not absurdly more');
  const even = devigPower([0.515, 0.515]);
  assert.ok(near(even[0], 0.5) && near(even[1], 0.5), 'even line → 50/50');
  const bad = devigPower([1.2, 0.3]);
  assert.ok(near(bad[0] + bad[1], 1), 'degenerate quotes fall back to multiplicative');
});

function ev(opts) {
  const now = opts.now;
  const books = opts.books.map(b => ({ key: b.key, markets: [{ key: 'h2h', last_update: Math.floor((now - (b.ageMin || 0) * 60000) / 1000), outcomes: [{ name: 'Home', price: b.home }, { name: 'Away', price: b.away }] }] }));
  return { id: 'e', home_team: 'Home', away_team: 'Away', commence_time: Math.floor((now + opts.kickMin * 60000) / 1000), bookmakers: books };
}

test('consensus: weights sharp books, reports both methods, measures disagreement', () => {
  const now = Date.now();
  const [c] = consensus([ev({ now, kickMin: 600, books: [{ key: 'pinnacle', home: 1.62, away: 2.45 }, { key: 'draftkings', home: 1.57, away: 2.50 }] })], now, ENGINE_DEFAULTS);
  assert.ok(c.books === 2 && c.sharp === 1, 'two books, one sharp');
  assert.ok(c.pHome > 0.59 && c.pHome < 0.63, 'home around 61% (' + c.pHome.toFixed(4) + ')');
  assert.ok(near(c.pHome + c.pAway, 1), 'sums to one');
  assert.ok(typeof c.pMult === 'number' && typeof c.pPow === 'number' && c.pHome === c.pPow, 'power is the default and both are kept');
  assert.ok(c.disp > 0 && c.disp < 0.02, 'small disagreement (' + c.disp.toFixed(4) + ')');
  const [m] = consensus([ev({ now, kickMin: 600, books: [{ key: 'pinnacle', home: 1.62, away: 2.45 }] })], now, Object.assign({}, ENGINE_DEFAULTS, { devig: 'mult' }));
  assert.ok(m.pHome === m.pMult, 'mult can be selected');
});

test('consensus: a book that stopped updating is dropped near kickoff, kept for far games', () => {
  const now = Date.now();
  const books = [{ key: 'pinnacle', home: 1.50, away: 2.70, ageMin: 1 }, { key: 'fanduel', home: 2.10, away: 1.78, ageMin: 90 }];
  const [nearGame] = consensus([ev({ now, kickMin: 60, books })], now, ENGINE_DEFAULTS);
  assert.equal(nearGame.books, 1, 'stale book dropped 1h before kickoff');
  assert.equal(nearGame.dropped, 1);
  assert.ok(nearGame.pHome > 0.6, 'line follows the fresh sharp book');
  const [farGame] = consensus([ev({ now, kickMin: 24 * 60, books })], now, ENGINE_DEFAULTS);
  assert.equal(farGame.books, 2, 'both kept a day out (books update rarely that far ahead)');
  assert.ok(farGame.disp > 0.05, 'big disagreement measured (' + farGame.disp.toFixed(3) + ')');
  assert.ok(nearGame.age >= 60000 - 2000 && nearGame.age < 3 * 60000, 'age is the sharp line\'s age');
});

test('consensus: events without a start time are skipped', () => {
  const now = Date.now();
  const e = ev({ now, kickMin: 60, books: [{ key: 'pinnacle', home: 1.9, away: 1.9 }] }); delete e.commence_time;
  assert.equal(consensus([e], now, ENGINE_DEFAULTS).length, 0);
});

test('confidence: full with a fresh sharp line and agreement; trimmed or zero otherwise', () => {
  const cfg = ENGINE_DEFAULTS;
  const good = { books: 3, sharp: 1, disp: 0.01, age: 60000 };
  assert.equal(confidence(good, cfg, 3600, 0).conf, 1);
  const noSharp = confidence({ books: 3, sharp: 0, disp: 0.01, age: 60000 }, cfg, 3600, 0);
  assert.ok(noSharp.conf === 0.5 && /sharp/.test(noSharp.why.join()), 'no sharp book halves');
  const single = confidence({ books: 1, sharp: 1, disp: 0, age: 60000 }, cfg, 3600, 0);
  assert.equal(single.conf, 0.75, 'single book trims to 75%');
  const dis = confidence({ books: 3, sharp: 1, disp: 0.03, age: 60000 }, cfg, 3600, 0);
  assert.ok(dis.conf === 0.5 && /disagree/.test(dis.why.join()), 'moderate disagreement halves');
  assert.equal(confidence({ books: 3, sharp: 1, disp: 0.06, age: 60000 }, cfg, 3600, 0).conf, 0, 'large disagreement blocks');
  const old = confidence({ books: 3, sharp: 1, disp: 0.01, age: 20 * 60000 }, cfg, 3600, 0);
  assert.equal(old.conf, 0.5, '20 min old line near kickoff halves');
  assert.equal(confidence({ books: 3, sharp: 1, disp: 0.01, age: 50 * 60000 }, cfg, 3600, 0).conf, 0, '50 min old line near kickoff blocks');
  assert.equal(confidence({ books: 3, sharp: 1, disp: 0.01, age: 50 * 60000 }, cfg, 10 * 3600, 0).conf, 1, 'the same age is fine 10h out');
  assert.equal(confidence({ books: 3, sharp: 1, disp: 0.01, age: 10 * 60000 }, cfg, 3600, 10 * 60000).conf, 0.5, 'cache age adds to the line age');
});

test('odds credit budget: spreads the month, never below a few fetches a day', () => {
  assert.equal(oddsBudget(null, 0).daily, Infinity);
  assert.equal(oddsBudget(20000, 0).daily, 645);
  assert.equal(oddsBudget(500, 0).daily, 16);
  assert.equal(oddsBudget(50, 0).daily, 4);
  assert.equal(oddsBudget(500, 16).left, 0);
  assert.equal(oddsBudget(500, 3).left, 13);
});

test('fees and sizing: taker 7% rounded up per contract; confidence scales the bankroll', () => {
  assert.equal(feeFor(1, 0.5, 'taker', null), 0.0175);
  assert.equal(feeFor(10, 0.35, 'taker', null), Math.ceil(0.07 * 10 * 0.35 * 0.65 * 10000 - 1e-9) / 10000);
  assert.equal(feeFor(10, 0.35, 'maker', { fee_type: 'quadratic' }), 0, 'no maker fee on plain quadratic series');
  assert.ok(feeFor(10, 0.35, 'maker', { fee_type: 'quadratic_with_maker_fees' }) > 0, 'maker fee on maker-fee series');
  const full = kellyCount(0.40, 0.35, 0.0159, 500, 0.25, 25);
  const half = kellyCount(0.40, 0.35, 0.0159, 250, 0.25, 25);
  assert.ok(full >= 1 && half <= Math.ceil(full / 2), 'half the bankroll → about half the contracts (' + full + ' vs ' + half + ')');
  assert.equal(kellyCount(0.30, 0.35, 0.01, 500, 0.25, 25), 0, 'no edge → nothing');
});

test('team matching: nicknames, city codes and city-only labels; same-city rivals never cross', () => {
  const yes = [['SF 49ers', 'San Francisco 49ers'], ['NE Patriots', 'New England Patriots'], ['LA Rams', 'Los Angeles Rams'], ['BUF Bills', 'Buffalo Bills'], ['GSW Warriors', 'Golden State Warriors'],
    ['New England', 'New England Patriots'], ['Patriots', 'New England Patriots'], ['Okla City Thunder', 'Oklahoma City Thunder'], ['Montreal', 'Montréal Canadiens'], ['St. Louis Blues', 'St Louis Blues'],
    ['KC Chiefs', 'Kansas City Chiefs'], ['NO Saints', 'New Orleans Saints'], ['Philadelphia 76ers', 'Philadelphia 76ers'], ['Utah', 'Utah Mammoth']];
  for (const [a, b] of yes) assert.ok(teamMatch(a, b), a + ' ~ ' + b);
  const no = [['NY Jets', 'New York Giants'], ['New York Jets', 'New York Giants'], ['Los Angeles Rams', 'Los Angeles Chargers'], ['LA Lakers', 'Los Angeles Clippers'],
    ['NY Rangers', 'New York Islanders'], ['Auburn Tigers', 'LSU Tigers'], ['AUB Tigers', 'LSU Tigers'], ['Boston Celtics', 'Brooklyn Nets']];
  for (const [a, b] of no) assert.ok(!teamMatch(a, b), a + ' !~ ' + b);
});

test('legSide: a city-only label is settled by the ticker abbreviation', () => {
  const c = { home: 'Los Angeles Clippers', away: 'Los Angeles Lakers' };
  assert.equal(legSide({ ticker: 'KXNBAGAME-26NOV10LALLAC-LAL', yes_sub_title: 'Los Angeles' }, c, 'NBA'), 'away');
  assert.equal(legSide({ ticker: 'KXNBAGAME-26NOV10LALLAC-LAC', yes_sub_title: 'Los Angeles C' }, c, 'NBA'), 'home');
  assert.equal(legSide({ ticker: 'KXNBAGAME-26NOV10LALLAC-LAL', yes_sub_title: 'LA Lakers' }, c, 'NBA'), 'away', 'label alone');
  assert.equal(legSide({ ticker: 'KXNBAGAME-26NOV10LALLAC-ZZZ', yes_sub_title: 'Los Angeles' }, c, 'NBA'), null, 'unknown code and a city-only label → no guess');
  const ny = { home: 'New York Rangers', away: 'New York Islanders' };
  assert.equal(legSide({ ticker: 'KXNHLGAME-26NOV12NYINYR-NYI', yes_sub_title: 'New York' }, ny, 'NHL'), 'away');
  assert.equal(legSide({ ticker: 'KXNHLGAME-26NOV12NYINYR-NYR', yes_sub_title: '' }, ny, 'NHL'), 'home', 'no label at all');
  assert.equal(Object.keys(TEAM_ALIASES.NFL).length >= 32 && Object.keys(TEAM_ALIASES.NBA).length >= 30 && Object.keys(TEAM_ALIASES.NHL).length >= 32, true, 'every team has a code');
});

test('team matching and event dates', () => {
  assert.ok(teamMatch('SF 49ers', 'San Francisco 49ers'));
  assert.ok(teamMatch('LA Rams', 'Los Angeles Rams'));
  assert.ok(teamMatch('NE Patriots', 'New England Patriots'));
  assert.ok(!teamMatch('NY Jets', 'New York Giants'));
  const d = parseEventDate('KXNFLGAME-26NOV09NEBUF');
  assert.equal(new Date(d).toISOString().slice(0, 10), '2026-11-09');
  assert.equal(parseEventDate('KXFOO-1'), null);
});

test('timezone helpers', () => {
  const h = hourIn('America/New_York', Date.UTC(2026, 10, 10, 14, 30)); // 09:30 EST
  assert.equal(h, 9);
  assert.equal(dayIn('America/New_York', Date.UTC(2026, 10, 10, 3, 0)), '2026-11-09', 'late UTC evening is still the previous day in New York');
});
