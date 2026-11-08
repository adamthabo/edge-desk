/*
 * Edge Desk — Cloudflare Worker
 * Serves the Edge Desk app at "/" and relays Kalshi's public, read-only market-data API
 * under "/trade-api/v2/*" (production) and "/demo/trade-api/v2/*" (demo exchange).
 *
 * Why a relay: Kalshi's API answers servers but refuses browser requests (no CORS headers,
 * HTTP 403 when an Origin header is present). This worker forwards GET requests for a short
 * allowlist of public endpoints, adds CORS headers and caches responses at Cloudflare's edge for
 * a few seconds. Bodies stream straight through (no parsing), so it stays well inside the free
 * plan's CPU budget. It never holds or forwards any API key, so it cannot trade or read an account.
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → Create → paste this file → Deploy,
 *         or `npx wrangler deploy` next to wrangler.toml.
 *         Optional variable RELAY_KEY: when set, requests must carry ?k=<RELAY_KEY>.
 *         Optional variable ALLOWED_ORIGIN: lock CORS to one origin instead of "*".
 */

const PAGE = __PAGE__;

const UPSTREAM = {
  prod: ['https://external-api.kalshi.com/trade-api/v2', 'https://api.elections.kalshi.com/trade-api/v2'],
  demo: ['https://external-api.demo.kalshi.co/trade-api/v2', 'https://demo-api.kalshi.co/trade-api/v2']
};

const ALLOW = /^\/(markets|markets\/trades|markets\/candlesticks|markets\/orderbooks|markets\/[^/]+|markets\/[^/]+\/orderbook|events|events\/[^/]+|series|series\/[^/]+|series\/[^/]+\/markets\/[^/]+\/candlesticks|exchange\/status|exchange\/schedule)$/;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 EdgeDesk/1.0';

function ttlFor(path) {
  if (path === '/markets/trades' || /\/orderbook$/.test(path) || path === '/markets/orderbooks') return 2;
  if (path === '/exchange/status') return 10;
  if (path.startsWith('/series/') && !path.includes('/candlesticks')) return 3600;
  if (path === '/series') return 600;
  if (path.includes('candlesticks')) return 30;
  if (/^\/markets\/[^/]+$/.test(path) || /^\/events\/[^/]+$/.test(path)) return 5;
  if (path === '/markets' || path === '/events') return 20;
  return 10;
}

function corsHeaders(env, origin) {
  const allowed = env && env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? '*' : (origin === allowed ? allowed : 'null'),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}) });
}

async function upstreamFetch(bases, pathAndQuery, ttl) {
  let lastErr = null, lastRes = null;
  for (let i = 0; i < bases.length; i++) {
    try {
      const res = await fetch(bases[i] + pathAndQuery, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': UA },
        cf: { cacheTtl: ttl, cacheEverything: true }
      });
      // 5xx / 403 (edge block) → try the alternate host once; 4xx client errors are final
      if (res.status >= 500 || res.status === 403) { lastRes = res; continue; }
      return res;
    } catch (e) { lastErr = e; }
  }
  if (lastRes) return lastRes;
  throw lastErr || new Error('upstream unreachable');
}

async function relay(request, env, path, bases, cors) {
  const url = new URL(request.url);
  url.searchParams.delete('slim'); url.searchParams.delete('k'); url.searchParams.delete('_');
  if (!ALLOW.test(path)) return json({ error: 'endpoint not allowed by relay' }, 404, cors);
  if (url.search.length > 4000) return json({ error: 'query too long' }, 414, cors);
  const ttl = ttlFor(path);
  let res;
  try { res = await upstreamFetch(bases, path + url.search, ttl); }
  catch (e) { return json({ error: 'upstream unreachable: ' + (e && e.message) }, 502, cors); }
  const ok = res.status >= 200 && res.status < 300;
  const headers = new Headers(cors);
  headers.set('content-type', res.headers.get('content-type') || 'application/json; charset=utf-8');
  headers.set('cache-control', ok ? 'public, max-age=' + ttl : 'no-store');
  const cfc = res.headers.get('cf-cache-status'); if (cfc) headers.set('x-relay-cache', cfc);
  // stream the body through untouched
  return new Response(res.body, { status: res.status, headers: headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'GET only' }, 405, cors);

    let path = url.pathname;
    if (path === '/' || path === '/index.html' || path === '/edge-desk.html') {
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
    }
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/health') return json({ ok: true, relay: 'edge-desk', time: new Date().toISOString() }, 200, cors);

    let bases = UPSTREAM.prod;
    if (path.startsWith('/demo/')) { bases = UPSTREAM.demo; path = path.slice(5); }
    if (!path.startsWith('/trade-api/v2/')) return json({ error: 'not found' }, 404, cors);
    if (env && env.RELAY_KEY && url.searchParams.get('k') !== env.RELAY_KEY) return json({ error: 'relay key required' }, 401, cors);
    path = path.slice('/trade-api/v2'.length).replace(/\/+$/, '');
    return relay(request, env, path, bases, cors);
  }
};
