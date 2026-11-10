// Shared money plays: order-book parsing, lock sizing against depth with per-fill fees, outcome coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from './_load.mjs';

const { parseBook, takerFee, bookPlan, covers } = Money;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('parseBook: dollar and cent formats; YES asks come from NO bids', () => {
  const b = parseBook({ orderbook_fp: { yes_dollars: [['0.40', '10.00'], ['0.42', '5.00']], no_dollars: [['0.55', '7.00']] } });
  assert.deepEqual(b.yesBids, [[0.42, 5], [0.40, 10]], 'best bid first');
  assert.deepEqual(b.yesAsks, [[0.45, 7]], 'YES ask = 1 − NO bid');
  assert.deepEqual(b.noAsks, [[0.58, 5], [0.6, 10]], 'NO asks from YES bids, cheapest first');
  const c = parseBook({ orderbook: { yes: [[40, 10]], no: [[55, 7], [50, 0]] } });
  assert.deepEqual(c.yesAsks, [[0.45, 7]], 'cents format; empty levels dropped');
});

test('takerFee: 7% × C × P × (1 − P), rounded up to the cent', () => {
  assert.equal(takerFee(1, 0.5, 0.07), 0.02);
  assert.equal(takerFee(10, 0.5, 0.07), 0.18);
  assert.equal(takerFee(100, 0.5, 0.07), 1.75);
  assert.equal(takerFee(10, 0.3, 0), 0);
});

const yesBook = () => [
  { ticker: 'LOW', levels: [[0.28, 20], [0.31, 50]] },
  { ticker: 'MID', levels: [[0.33, 25]] },
  { ticker: 'HIGH', levels: [[0.30, 30]] }
];

test('bookPlan: most profitable size through the depth, worst price per leg as its limit', () => {
  const p = bookPlan(yesBook(), { payout: 1, feeRate: 0.07, minEdge: 0.005, maxSets: 100, maxCost: 50 });
  assert.equal(p.sets, 25, 'depth on MID caps it at 25');
  assert.equal(p.legs.find(l => l.ticker === 'LOW').limit, 0.31, 'LOW walks into its second level');
  assert.equal(p.legs.find(l => l.ticker === 'MID').limit, 0.33);
  assert.ok(near(p.cost, 20 * 0.28 + 5 * 0.31 + 25 * 0.33 + 25 * 0.30, 1e-9), 'cost walks the levels');
  assert.ok(near(p.fees, 0.29 + 0.08 + 0.39 + 0.37, 1e-9), 'fees per fill, each rounded up');
  assert.ok(near(p.profit, 25 - p.cost - p.fees, 1e-9) && p.profit > 0.9, 'profit ' + p.profit.toFixed(2));
  assert.equal(p.bestSum, 0.91);
  assert.match(p.limitedBy, /not enough offered/);
});

test('bookPlan: budget and per-order caps bind; a dear book is refused with the reason', () => {
  assert.equal(bookPlan(yesBook(), { payout: 1, feeRate: 0.07, maxSets: 100, maxCost: 10 }).sets, 10, 'budget');
  const capped = bookPlan(yesBook(), { payout: 1, feeRate: 0.07, maxSets: 100, maxCost: 50, perOrder: { contracts: 100, dollars: 5 } });
  assert.equal(capped.sets, 15, 'MID at 33¢: 15 contracts is the most under a $5 order'); assert.match(capped.limitedBy, /per-order cap of \$5\.00/);
  assert.equal(bookPlan(yesBook(), { payout: 1, feeRate: 0.07, maxSets: 12, maxCost: 50 }).sets, 12, 'maxSets');
  const dear = bookPlan([{ ticker: 'A', levels: [[0.34, 50]] }, { ticker: 'B', levels: [[0.34, 50]] }, { ticker: 'C', levels: [[0.34, 50]] }], { payout: 1, feeRate: 0.07, maxSets: 50, maxCost: 50 });
  assert.equal(dear.sets, 0); assert.match(dear.reason, /one set costs 10[0-9]\.\d¢ with fees and pays 100¢/);
  assert.equal(bookPlan([{ ticker: 'A', levels: [] }, { ticker: 'B', levels: [[0.3, 5]] }], { payout: 1, maxSets: 5, maxCost: 5 }).reason, 'a leg has nothing offered');
});

test('bookPlan: fee rounding can make one set lose and ten win; it looks past the miss', () => {
  // two legs at 49¢: one set pays 100¢ and costs 98¢ + 2 × 2¢ fees; ten cost 9.80 + 2 × 18¢
  const legs = [{ ticker: 'A', levels: [[0.49, 100]] }, { ticker: 'B', levels: [[0.49, 100]] }];
  const p = bookPlan(legs, { payout: 1, feeRate: 0.035, minEdge: 0.002, maxSets: 60, maxCost: 100 });
  assert.ok(p.sets > 1, 'more than one set (' + p.sets + ')');
  assert.ok(p.perSet >= 0.002);
});

test('bookPlan: a NO book pays legs − 1 a set', () => {
  const legs = [0.68, 0.70, 0.72, 0.75].map((p, i) => ({ ticker: 'N' + i, levels: [[p, 40]] }));
  const p = bookPlan(legs, { payout: 3, feeRate: 0.07, maxSets: 100, maxCost: 200 });
  assert.equal(p.sets, 40); assert.equal(p.payout, 120); assert.ok(p.perSet > 0.08 && p.perSet < 0.1, 'about 9¢ a set (' + p.perSet.toFixed(4) + ')');
});

test('covers: catch-alls and open-ended buckets cover everything; a candidate list does not', () => {
  assert.ok(covers(['Smith', 'Jones', 'Someone else']).ok);
  assert.ok(covers(['48° or below', '49° to 52°', '53° or above']).ok);
  assert.ok(covers(['a', 'b', 'c'], ['less', 'between', 'greater']).ok);
  assert.ok(!covers(['Smith', 'Jones', 'Lee']).ok);
});
