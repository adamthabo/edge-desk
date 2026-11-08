# Edge Desk

A Kalshi market scanner, live trade tape, order books, fee-aware edge/Kelly math and a paper-trading desk, served from a single Cloudflare Worker. The Worker also relays Kalshi's public, read-only market-data API (Kalshi refuses browser requests directly), so the page works on any phone or desktop with no backend of your own.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/adamthabo/edge-desk)

## Deploy

**One click:** press the button above, sign in to Cloudflare (free plan is fine), accept the defaults and deploy. Your copy lives at `https://edge-desk.<your-subdomain>.workers.dev`.

**Dashboard:** Workers & Pages → Create → Start with Hello World → replace the editor contents with `edge-desk.worker.js` → Deploy.

**Terminal:** `npx wrangler deploy` in this folder.

## Optional settings (Worker variables)

- `RELAY_KEY` — when set, the relay only answers requests carrying `?k=<key>`; the app's Setup view has a field for it.
- `ALLOWED_ORIGIN` — lock CORS to one origin instead of `*`.

## Real trading (optional)

Add three secrets to the Worker (Settings → Variables and Secrets) and the Desk view gains your real Kalshi account: balance, positions, resting orders, and a real-money ticket with a confirmation step.

- `KALSHI_KEY_ID` and `KALSHI_PRIVATE_KEY`: an API key from Kalshi → account settings → API Keys (Ed25519 or RSA; paste the whole PEM).
- `DESK_PASSWORD`: a password you choose; the page asks for it once per device.
- Optional `MAX_ORDER_CONTRACTS` (default 100) and `MAX_ORDER_DOLLARS` (default 100) cap any single order; `KALSHI_DEMO_KEY_ID` / `KALSHI_DEMO_PRIVATE_KEY` enable the demo exchange.

The private key never leaves the Worker: it signs each request there, and the account routes answer only the page served by this Worker, with the password. Orders are sent as price-capped limit orders (fill-or-cancel by default) through Kalshi's V2 order endpoint.

## What the relay does and does not do

It forwards `GET` requests for a short allowlist of public endpoints (`/markets`, `/events`, `/series`, `/markets/trades`, orderbooks, candlesticks, exchange status) to `external-api.kalshi.com`, caches responses for a few seconds and adds CORS headers. It holds no API key and cannot place orders or read an account. Real trading happens on Kalshi.

Not affiliated with Kalshi. Not investment advice; event contracts can lose the entire amount risked.
