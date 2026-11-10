// Real-account plumbing: Kalshi request signing (RSA-PSS and Ed25519), order translation, route guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { worker, Desk as D } from './_load.mjs';

const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = nodeCrypto.generateKeyPairSync('ed25519');
const edPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });

test('RSA-PSS signatures verify for PKCS#1 and PKCS#8 PEMs', async () => {
  for (const type of ['pkcs1', 'pkcs8']) {
    const pem = rsa.privateKey.export({ type, format: 'pem' });
    const s = await D.signer({ KALSHI_KEY_ID: 'kid-123', KALSHI_PRIVATE_KEY: pem }, 'prod');
    const h = await s.headers('GET', '/trade-api/v2/portfolio/balance');
    const msg = h['KALSHI-ACCESS-TIMESTAMP'] + 'GET' + '/trade-api/v2/portfolio/balance';
    const ok = nodeCrypto.verify('sha256', Buffer.from(msg), { key: rsa.publicKey, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
    assert.ok(ok, type + ' signature verifies'); assert.equal(h['KALSHI-ACCESS-KEY'], 'kid-123'); assert.match(h['KALSHI-ACCESS-TIMESTAMP'], /^\d{13}$/);
  }
});
test('Ed25519 signatures verify; PEM with escaped newlines is accepted', async () => {
  const s = await D.signer({ KALSHI_KEY_ID: 'kid-ed', KALSHI_PRIVATE_KEY: edPem }, 'prod');
  const h = await s.headers('POST', '/trade-api/v2/portfolio/events/orders');
  assert.ok(nodeCrypto.verify(null, Buffer.from(h['KALSHI-ACCESS-TIMESTAMP'] + 'POST' + '/trade-api/v2/portfolio/events/orders'), ed.publicKey, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  const flat = await D.signer({ KALSHI_KEY_ID: 'k', KALSHI_PRIVATE_KEY: edPem.replace(/\n/g, '\\n') }, 'prod');
  assert.ok((await flat.headers('GET', '/x'))['KALSHI-ACCESS-SIGNATURE']);
});
test('order translation to the V2 single-book shape and caps', () => {
  const lim = { contracts: 100, dollars: 100 };
  let t = D.toV2Order({ ticker: 'KXT-1', side: 'yes', action: 'buy', count: 10, limit: 0.42, tif: 'ioc' }, lim);
  assert.ok(t.body.side === 'bid' && t.body.price === '0.42' && t.body.count === '10' && t.body.time_in_force === 'immediate_or_cancel' && t.body.exchange_index === -1 && !t.body.reduce_only && Math.abs(t.risk - 4.2) < 1e-9);
  t = D.toV2Order({ ticker: 'KXT-1', side: 'no', action: 'buy', count: 10, limit: 0.58, tif: 'gtc' }, lim);
  assert.ok(t.body.side === 'ask' && t.body.price === '0.42' && t.body.time_in_force === 'good_till_canceled' && Math.abs(t.risk - 5.8) < 1e-9);
  t = D.toV2Order({ ticker: 'KXT-1', side: 'yes', action: 'sell', count: 5, limit: 0.40, tif: 'ioc' }, lim);
  assert.ok(t.body.side === 'ask' && t.body.price === '0.40' && t.body.reduce_only === true);
  t = D.toV2Order({ ticker: 'KXT-1', side: 'no', action: 'sell', count: 5, limit: 0.60, tif: 'ioc' }, lim);
  assert.ok(t.body.side === 'bid' && t.body.price === '0.40' && t.body.reduce_only === true);
  assert.match(D.toV2Order({ ticker: 'K', side: 'yes', action: 'buy', count: 101, limit: 0.5 }, lim).error, /cap/);
  assert.match(D.toV2Order({ ticker: 'K', side: 'yes', action: 'buy', count: 100, limit: 0.99 }, { contracts: 100, dollars: 50 }).error, /\$99\.00/);
  assert.equal(D.toV2Order({ ticker: 'K', side: 'yes', action: 'buy', count: 2.5, limit: 0.5 }, lim).body.count, '2');
  assert.ok(D.toV2Order({ ticker: 'K', side: 'yes', action: 'buy', count: 1, limit: 1.2 }, lim).error);
});
test('account routes: password, same-origin, signed upstream, caps, demo', async () => {
  let last = null; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { last = { url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null }; const u = new URL(url);
    if (u.pathname.endsWith('/portfolio/balance')) return new Response(JSON.stringify({ balance: 12345, balance_dollars: '123.45', portfolio_value: 15000, updated_ts: 1 }), { status: 200 });
    if (u.pathname.endsWith('/portfolio/events/orders') && init.method === 'POST') return new Response(JSON.stringify({ order_id: 'o1', client_order_id: 'c', fill_count: '10.00', remaining_count: '0.00', average_fill_price: '0.41', average_fee_paid: '0.01', ts_ms: 1 }), { status: 201 });
    if (u.pathname.includes('/portfolio/events/orders/') && init.method === 'DELETE') return new Response(JSON.stringify({ order_id: 'o1', reduced_by: '3.00', ts_ms: 1 }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'x', message: 'nope' } }), { status: 400 }); };
  try {
    const env = { DESK_PASSWORD: 'hunter2', KALSHI_KEY_ID: 'kid', KALSHI_PRIVATE_KEY: edPem, MAX_ORDER_DOLLARS: '25' };
    const same = { 'Sec-Fetch-Site': 'same-origin' };
    const call = (path, init, e) => worker.fetch(new Request('https://w.test' + path, init), e || env, {});
    let r = await call('/desk/status'); let j = await r.json();
    assert.ok(r.status === 200 && j.passwordSet === true && j.configured.prod === true && j.configured.demo === false);
    r = await call('/desk/balance', { headers: Object.assign({ Authorization: 'Bearer hunter2' }, same) }); j = await r.json();
    assert.ok(r.status === 200 && j.balance_dollars === '123.45');
    assert.ok(last.url === 'https://external-api.kalshi.com/trade-api/v2/portfolio/balance' && last.init.headers['KALSHI-ACCESS-KEY'] === 'kid' && last.init.headers['KALSHI-ACCESS-SIGNATURE']);
    assert.equal((await call('/desk/balance', { headers: Object.assign({ Authorization: 'Bearer wrong' }, same) })).status, 401);
    assert.equal((await call('/desk/balance', { headers: { Authorization: 'Bearer hunter2', 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/desk/balance', { headers: Object.assign({ Authorization: 'Bearer hunter2' }, same) }, { KALSHI_KEY_ID: 'kid', KALSHI_PRIVATE_KEY: edPem })).status, 503);
    r = await call('/desk/order', { method: 'POST', headers: Object.assign({ Authorization: 'Bearer hunter2', 'Content-Type': 'application/json' }, same), body: JSON.stringify({ ticker: 'KXT-1', side: 'yes', action: 'buy', count: 10, limit: 0.42, tif: 'ioc' }) }); j = await r.json();
    assert.ok(r.status === 200 && j.ok && j.result.order_id === 'o1' && j.sent.risk === 4.2);
    assert.ok(last.url.endsWith('/portfolio/events/orders') && last.body.side === 'bid' && last.body.price === '0.42' && last.body.count === '10' && /^[0-9a-f-]{36}$/.test(last.body.client_order_id));
    r = await call('/desk/order', { method: 'POST', headers: Object.assign({ Authorization: 'Bearer hunter2' }, same), body: JSON.stringify({ ticker: 'KXT-1', side: 'yes', action: 'buy', count: 60, limit: 0.5, tif: 'ioc' }) }); j = await r.json();
    assert.ok(r.status === 400 && /cap of \$25\.00/.test(j.error));
    r = await call('/desk/order/o1?ticker=KXT-1', { method: 'DELETE', headers: Object.assign({ Authorization: 'Bearer hunter2' }, same) }); j = await r.json();
    assert.ok(r.status === 200 && j.ok && last.url.includes('/portfolio/events/orders/o1?') && last.url.includes('market_ticker=KXT-1') && last.init.method === 'DELETE');
    assert.equal((await call('/desk/balance?env=demo', { headers: Object.assign({ Authorization: 'Bearer hunter2' }, same) })).status, 503);
  } finally { globalThis.fetch = realFetch; }
});
