// Relay routes: upstream shape, caching, key and same-origin rules. Fetch is faked; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worker } from './_load.mjs';

let last = null; let failFirst = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  last = { url: String(url), init: init || {} }; const u = new URL(url);
  if (failFirst && u.host === 'external-api.kalshi.com') return new Response('blocked', { status: 403 });
  if (u.pathname.endsWith('/markets')) return new Response(JSON.stringify({ markets: [{ ticker: 'A', yes_bid_dollars: '0.40', rules_primary: 'long rules', price_ranges: [1], volume_fp: '3.00' }], cursor: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ exchange_active: true, trading_active: true }), { status: 200 });
};
const ctx = { waitUntil() {} };
const req = (path, init) => worker.fetch(new Request('https://w.test' + path, init), {}, ctx);

test('serves the app at /', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(await r.text(), /<title>Edge Desk<\/title>/);
});
test('relays public market data with CORS, browser UA, no Origin, edge cache', async () => {
  const r = await req('/trade-api/v2/markets?limit=5&slim=1&k=abc', { headers: { Origin: 'https://w.test' } });
  const body = await r.json();
  assert.equal(r.status, 200); assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(last.url, 'https://external-api.kalshi.com/trade-api/v2/markets?limit=5');
  assert.ok(!('Origin' in last.init.headers) && /Mozilla/.test(last.init.headers['User-Agent']));
  assert.equal(body.markets[0].yes_bid_dollars, '0.40'); assert.ok('rules_primary' in body.markets[0]);
  assert.equal(last.init.cf.cacheEverything, true); assert.equal(last.init.cf.cacheTtl, 20);
});
test('falls back to the alternate host on 403', async () => {
  failFirst = true; const r = await req('/trade-api/v2/exchange/status'); failFirst = false;
  assert.equal(r.status, 200); assert.ok(last.url.startsWith('https://api.elections.kalshi.com/'));
});
test('demo prefix, refused paths and methods', async () => {
  await req('/demo/trade-api/v2/exchange/status');
  assert.ok(last.url.startsWith('https://external-api.demo.kalshi.co/trade-api/v2/exchange/status'));
  assert.equal((await req('/trade-api/v2/portfolio/balance')).status, 404);
  assert.equal((await req('/trade-api/v2/markets', { method: 'POST' })).status, 405);
  assert.equal((await req('/trade-api/v2/markets/KXFOO-1/orderbook?depth=30')).status, 200);
  assert.equal((await req('/trade-api/v2/markets/candlesticks?market_tickers=A&period_interval=60')).status, 200);
  assert.equal((await req('/trade-api/v2/series/KXFOO/markets/KXFOO-1/candlesticks?period_interval=60')).status, 200);
  const o = await req('/trade-api/v2/markets', { method: 'OPTIONS', headers: { Origin: 'https://x' } });
  assert.equal(o.status, 204); assert.ok(o.headers.get('Access-Control-Allow-Methods'));
});
test('relay key: enforced only for cross-origin callers; blank key means unset', async () => {
  const env = { RELAY_KEY: 'secret' };
  const call = (path, headers, e) => worker.fetch(new Request('https://w.test' + path, { headers }), e || env, ctx);
  assert.equal((await call('/trade-api/v2/markets?limit=1', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://other.example' })).status, 401);
  assert.equal((await call('/trade-api/v2/markets?limit=1&k=secret', {})).status, 200);
  assert.equal((await call('/trade-api/v2/exchange/status', { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await call('/trade-api/v2/exchange/status', { Referer: 'https://w.test/' })).status, 200);
  assert.equal((await call('/trade-api/v2/exchange/status', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://other.example' }, { RELAY_KEY: '   ' })).status, 200);
  const r = await call('/trade-api/v2/markets?limit=1', { Origin: 'https://evil' }, { ALLOWED_ORIGIN: 'https://good' });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'null');
});
test.after(() => { globalThis.fetch = realFetch; });
