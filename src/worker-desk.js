/*
 * Edge Desk — account routes (real trading) for the Cloudflare Worker.
 *
 * Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
 *   DESK_PASSWORD           required to use any /desk route; the page asks for it once per device
 *   KALSHI_KEY_ID           Kalshi API key id (production)
 *   KALSHI_PRIVATE_KEY      the private key PEM Kalshi gave you (Ed25519 "BEGIN PRIVATE KEY" or RSA "BEGIN RSA PRIVATE KEY")
 *   KALSHI_DEMO_KEY_ID / KALSHI_DEMO_PRIVATE_KEY   optional, for the demo exchange
 *   MAX_ORDER_CONTRACTS     optional per-order cap (default 100)
 *   MAX_ORDER_DOLLARS       optional per-order cap on money at risk (default 100)
 *
 * The key never leaves the Worker: it signs each request to Kalshi here. Only same-origin requests
 * (the page this Worker serves) carrying the desk password are accepted.
 */

const DESK_ALLOW_GET = {
  balance: '/portfolio/balance',
  positions: '/portfolio/positions',
  orders: '/portfolio/orders',
  fills: '/portfolio/fills',
  settlements: '/portfolio/settlements'
};
const DESK_QUERY = {
  balance: {},
  positions: { settlement_status: 'unsettled', count_filter: 'position', limit: '200' },
  orders: { status: 'resting', limit: '200' },
  fills: { limit: '100' },
  settlements: { limit: '50' }
};

const keyCache = {};
const enc = new TextEncoder();

function b64ToBytes(b64) { const bin = atob(b64.replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function bytesToB64(bytes) { let s = ''; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
function derLen(n) { if (n < 0x80) return [n]; const bytes = []; while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; } return [0x80 | bytes.length].concat(bytes); }
function derSeq(tag, content) { return new Uint8Array([tag].concat(derLen(content.length), Array.from(content))); }
// Wrap a PKCS#1 RSAPrivateKey into PKCS#8 PrivateKeyInfo so WebCrypto can import it
function pkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const octet = derSeq(0x04, pkcs1);
  const body = new Uint8Array(version.length + algId.length + octet.length);
  body.set(version, 0); body.set(algId, version.length); body.set(octet, version.length + algId.length);
  return derSeq(0x30, body);
}
function parsePem(pem) {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(String(pem || '').replace(/\\n/g, '\n'));
  if (!m) throw new Error('private key is not a PEM block');
  return { label: m[1].trim(), der: b64ToBytes(m[2]) };
}
async function importSigningKey(pem) {
  const { label, der } = parsePem(pem);
  if (label === 'RSA PRIVATE KEY') {
    const key = await crypto.subtle.importKey('pkcs8', pkcs1ToPkcs8(der), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
    return { key, type: 'rsa' };
  }
  if (label === 'PRIVATE KEY') {
    if (der.length < 200) {
      try { const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']); return { key, type: 'ed25519' }; } catch (e) { /* fall through */ }
    }
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
    return { key, type: 'rsa' };
  }
  throw new Error('unsupported key type "' + label + '"; expected an Ed25519 or RSA private key');
}
async function signer(env, which) {
  const idVar = which === 'demo' ? 'KALSHI_DEMO_KEY_ID' : 'KALSHI_KEY_ID';
  const pemVar = which === 'demo' ? 'KALSHI_DEMO_PRIVATE_KEY' : 'KALSHI_PRIVATE_KEY';
  const keyId = (env[idVar] || '').trim(), pem = env[pemVar] || '';
  if (!keyId || !pem) return null;
  if (!keyCache[which] || keyCache[which].pem !== pem) keyCache[which] = { pem, promise: importSigningKey(pem) };
  const k = await keyCache[which].promise;
  return {
    keyId,
    async headers(method, path) {
      const ts = Date.now().toString();
      const msg = enc.encode(ts + method.toUpperCase() + path);
      const sig = k.type === 'ed25519' ? await crypto.subtle.sign('Ed25519', k.key, msg) : await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, k.key, msg);
      return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': bytesToB64(sig) };
    }
  };
}

async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 && String(a).length > 0;
}
function bearer(request) { const h = request.headers.get('Authorization') || ''; const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1].trim() : ''; }
function money(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function limits(env) {
  const c = parseInt(env.MAX_ORDER_CONTRACTS, 10), d = parseFloat(env.MAX_ORDER_DOLLARS);
  return { contracts: Number.isFinite(c) && c > 0 ? c : 100, dollars: Number.isFinite(d) && d > 0 ? d : 100 };
}
async function readJson(res) { const t = await res.text(); try { return t ? JSON.parse(t) : {}; } catch (e) { return { raw: t }; } }
function kalshiError(status, data) {
  const e = data && (data.error || data);
  const msg = e && (e.message || e.details || e.code) ? [e.code, e.message || e.details].filter(Boolean).join(': ') : ('HTTP ' + status);
  return msg;
}

// Translate an Edge Desk order into Kalshi's V2 single-book order (bid/ask on the YES book, dollar prices).
function toV2Order(o, lim) {
  const side = o.side === 'no' ? 'no' : 'yes';
  const action = o.action === 'sell' ? 'sell' : 'buy';
  const count = Math.floor(Number(o.count));
  const limit = money(o.limit);
  if (!o.ticker || typeof o.ticker !== 'string' || o.ticker.length > 80) return { error: 'ticker missing' };
  if (!Number.isFinite(count) || count < 1) return { error: 'count must be a whole number of contracts (1 or more)' };
  if (count > lim.contracts) return { error: 'order exceeds the per-order cap of ' + lim.contracts + ' contracts (MAX_ORDER_CONTRACTS)' };
  if (limit === null || limit <= 0 || limit >= 1) return { error: 'limit price must be between 1¢ and 99¢' };
  const risk = action === 'buy' ? count * limit : count * (1 - limit); // money that can be lost on this order
  if (risk > lim.dollars + 1e-9) return { error: 'order risks $' + risk.toFixed(2) + ', above the per-order cap of $' + lim.dollars.toFixed(2) + ' (MAX_ORDER_DOLLARS)' };
  // YES-book translation
  let bookSide, price;
  if (side === 'yes' && action === 'buy') { bookSide = 'bid'; price = limit; }
  else if (side === 'yes' && action === 'sell') { bookSide = 'ask'; price = limit; }
  else if (side === 'no' && action === 'buy') { bookSide = 'ask'; price = 1 - limit; }
  else { bookSide = 'bid'; price = 1 - limit; }
  const tif = o.tif === 'gtc' ? 'good_till_canceled' : 'immediate_or_cancel';
  const body = {
    ticker: o.ticker, client_order_id: crypto.randomUUID(), side: bookSide, count: String(count), price: price.toFixed(2),
    time_in_force: tif, self_trade_prevention_type: 'taker_at_cross', exchange_index: -1, cancel_order_on_pause: true
  };
  if (action === 'sell') body.reduce_only = true; // selling only ever closes what is held, never opens the other side
  if (o.postOnly && tif === 'good_till_canceled') body.post_only = true;
  return { body, risk, side, action, count, limit };
}

async function deskRoute(request, env, url, bases, cors, isSameOrigin) {
  const sub = url.pathname.replace(/^\/desk\/?/, '').replace(/\/+$/, '');
  const noStore = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, cors);
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: noStore });
  const pw = (env.DESK_PASSWORD || '').trim();
  if (sub === 'status') return json({ passwordSet: !!pw, configured: { prod: !!(env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY), demo: !!(env.KALSHI_DEMO_KEY_ID && env.KALSHI_DEMO_PRIVATE_KEY) } });
  if (!isSameOrigin(request, url)) return json({ error: 'account routes answer only the page served by this Worker' }, 403);
  if (!pw) return json({ error: 'DESK_PASSWORD is not set on the Worker' }, 503);
  if (!(await sameSecret(bearer(request), pw))) return json({ error: 'wrong desk password' }, 401);
  const which = url.searchParams.get('env') === 'demo' ? 'demo' : 'prod';
  const base = (which === 'demo' ? bases.demo : bases.prod)[0];
  const basePath = new URL(base).pathname; // /trade-api/v2
  const lim = limits(env);
  if (sub === 'unlock') return json({ ok: true, configured: { prod: !!(env.KALSHI_KEY_ID && env.KALSHI_PRIVATE_KEY), demo: !!(env.KALSHI_DEMO_KEY_ID && env.KALSHI_DEMO_PRIVATE_KEY) }, limits: lim });
  let s;
  try { s = await signer(env, which); } catch (e) { return json({ error: 'could not read the ' + which + ' private key: ' + e.message }, 500); }
  if (!s) return json({ error: 'no Kalshi API key configured for the ' + which + ' exchange' }, 503);

  const call = async (method, path, query, body) => {
    const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
    const headers = Object.assign({ 'Accept': 'application/json', 'User-Agent': 'EdgeDesk/1.0' }, await s.headers(method, basePath + path));
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await readJson(res);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
  };

  try {
    if (request.method === 'GET' && DESK_ALLOW_GET[sub]) {
      const q = Object.assign({}, DESK_QUERY[sub]);
      for (const k of ['ticker', 'cursor', 'limit', 'status', 'settlement_status']) { const v = url.searchParams.get(k); if (v) q[k] = v; }
      const r = await call('GET', DESK_ALLOW_GET[sub], q);
      return json(r.ok ? r.data : { error: kalshiError(r.status, r.data) }, r.ok ? 200 : (r.status >= 400 && r.status < 600 ? r.status : 502));
    }
    if (request.method === 'POST' && sub === 'order') {
      let o; try { o = await request.json(); } catch (e) { return json({ error: 'bad JSON' }, 400); }
      const t = toV2Order(o, lim);
      if (t.error) return json({ error: t.error }, 400);
      const r = await call('POST', '/portfolio/events/orders', null, t.body);
      if (!r.ok) return json({ error: kalshiError(r.status, r.data) }, r.status >= 400 && r.status < 600 ? r.status : 502);
      return json({ ok: true, sent: { ticker: o.ticker, side: t.side, action: t.action, count: t.count, limit: t.limit, tif: t.body.time_in_force, risk: Number(t.risk.toFixed(2)) }, result: r.data });
    }
    if (request.method === 'DELETE' && /^order\/[A-Za-z0-9_-]+$/.test(sub)) {
      const id = sub.slice(6);
      const q = { exchange_index: '-1' };
      const ticker = url.searchParams.get('ticker'); if (ticker) q.market_ticker = ticker;
      const r = await call('DELETE', '/portfolio/events/orders/' + encodeURIComponent(id), q);
      if (!r.ok) return json({ error: kalshiError(r.status, r.data) }, r.status >= 400 && r.status < 600 ? r.status : 502);
      return json({ ok: true, result: r.data });
    }
    return json({ error: 'unknown account route' }, 404);
  } catch (e) {
    return json({ error: 'Kalshi unreachable: ' + (e && e.message) }, 502);
  }
}

const EdgeDeskAccount = { deskRoute, _internal: { toV2Order, pkcs1ToPkcs8, parsePem, importSigningKey, signer, sameSecret, limits } };
