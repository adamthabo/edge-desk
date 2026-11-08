# Edge Desk

A Kalshi market scanner, live trade tape, order books, fee-aware edge/Kelly math and a paper-trading desk, served from a single Cloudflare Worker. The Worker also relays Kalshi's public, read-only market-data API (Kalshi refuses browser requests directly), so the page works on any phone or desktop with no backend of your own.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/adamthabo/hello/tree/main/edge-desk)

## Deploy

**One click:** press the button above, sign in to Cloudflare (free plan is fine), accept the defaults and deploy. Your copy lives at `https://edge-desk.<your-subdomain>.workers.dev`.

**Dashboard:** Workers & Pages → Create → Start with Hello World → replace the editor contents with `edge-desk.worker.js` → Deploy.

**Terminal:** `npx wrangler deploy` in this folder.

## Optional settings (Worker variables)

None are required. The page this Worker serves always talks to its own relay.

- `RELAY_KEY` — when set, other sites (a copy of the page opened as a file, say) must send `?k=<key>`; the app's Setup view has a field for it. Requests from the page served by this Worker never need it.
- `ALLOWED_ORIGIN` — lock CORS to one origin instead of `*`.

## What the relay does and does not do

It forwards `GET` requests for a short allowlist of public endpoints (`/markets`, `/events`, `/series`, `/markets/trades`, orderbooks, candlesticks, exchange status) to `external-api.kalshi.com`, caches responses for a few seconds and adds CORS headers. It holds no API key and cannot place orders or read an account. Real trading happens on Kalshi.

Not affiliated with Kalshi. Not investment advice; event contracts can lose the entire amount risked.
