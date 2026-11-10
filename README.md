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

## Money tab: locks and spreads

The landing view lists the small, mostly locked-in plays, sized on your bankroll (or your Kalshi cash, whichever is less):

- **Locks (buy or sell the whole book).** On a one-winner event, buy YES on every outcome when the set costs less than the $1 it must pay (only when the outcomes cover every possibility), or buy NO on every outcome when the set costs less than the legs − 1 dollars it must pay (Kalshi's mutually-exclusive flag). The top three are re-checked against the live order books every 20 seconds while the tab is open, sized through the depth with each fill's fee rounded up to the cent. **Buy it for real** posts to `/desk/book`: the Worker re-reads the event and every order book, refuses if the lock is gone, signs every order before sending any, sends all legs at once (fill-or-cancel at the worst price each leg needs), then sells straight back (reduce-only) any contracts a short leg left unmatched, so what remains is complete sets. Budget: 10% of the bankroll per lock, within the Worker's per-order caps.
- **Spreads (quote both sides).** Where the gap between the best bid and offer is wide and the market trades, rest a bid 1¢ above the bid and an offer 1¢ below the offer, both post-only. When both fill you keep the gap; if one fills alone you hold that position, so each quote is sized at 2% of the bankroll.

Every play also has a paper button. Not financial advice: locks depend on every leg filling and on Kalshi's settlement rules; spread quotes are not locks until both sides fill.

## Trading engine (optional, real money)

Desk → Engine runs a "line anchor" strategy inside the Worker (a Durable Object with its own SQLite journal, woken every minute by a cron trigger): it matches Kalshi game markets to sharp sportsbook lines from the-odds-api.com, devigs them into fair probabilities, takes Kalshi's price when it is off by more than fees plus a margin, otherwise rests bids below fair value, pulls quotes before kickoff, holds to settlement, and journals every bet with the probability it believed (Brier score vs the market).

- Add the secret `ODDS_API_KEY` (the-odds-api.com; the 20k-credit plan covers continuous NFL + NBA + NHL polling, the free tier only a slow trial). Optional `NTFY_TOPIC` for push alerts and the daily digest via ntfy.sh.
- Limits live in the Engine tab: bankroll, per-game and total exposure, daily loss stop (auto-off + cancel), margins, sports. The Worker's `MAX_ORDER_*` caps still apply to every order.
- `wrangler.toml` declares the Durable Object binding, its SQLite migration and the cron trigger; deploying once with it is required before the Engine tab works.
- **Shadow mode is the default.** The engine runs end to end on paper: same decisions, same caps, quotes that fill only when the market trades through them, settlement and closing-line scoring, with nothing sent to Kalshi. It needs only `DESK_PASSWORD` and `ODDS_API_KEY`. The Engine tab's "My call" says when the paper record justifies going live (30+ scored bets, beating the closing line by 1¢+ a bet after fees) and which sports to leave off. Switching modes stops the engine; live and paper keep separate scorecards.
- **Dry run** runs one tick's worth of decisions against the live slate and your account (or an empty one without keys) and reports what it would take, quote and sell. It sends, cancels and journals nothing and changes no setting.

### How it decides

1. **Fair price.** Every bookmaker's two-way line is devigged with the power method (the margin lands mostly on the longshot, which is where sharp books put it; the multiplicative answer is kept alongside for comparison). Books are combined with weights (Pinnacle 3, other sharp books 2, retail 1). Within three hours of kickoff, a book whose line is much older than the freshest one is dropped. Fair value p* = 80% books + 20% Kalshi mid by default; Kalshi's share shrinks as its spread widens (full at 2¢, none at 8¢), because the midpoint of a wide spread says little.
2. **Confidence.** Full size needs a sharp book, at least two books, agreement within a couple of cents and a fresh line. No sharp book halves the size; books disagreeing by 2.5¢+ halves it; 5¢+ blocks the game; a sharp line older than 15 minutes near kickoff halves, 45 minutes blocks. Lines older than 15 minutes overall (feed down, credits out) stop all trading until refreshed and pull resting quotes.
3. **Move guard.** If Kalshi has moved 3¢+ since the lines were fetched, the engine pulls its quotes on that game, forces a line refresh, and only acts on the next minute with fresh lines. A cheap price that appeared while the lines were stale is usually news, not an edge.
4. **Sizing.** Quarter-Kelly on the configured bankroll, scaled by confidence, capped per game and in total; a taker position is only added to after the lines have been refreshed since the last buy; sizing is halved automatically while the engine's Brier score trails the market's over 30+ settled bets.
5. **Exits.** What the engine holds it offers back: a reduce-only ask rests at fair + margin + fee, and when Kalshi's bid clears fair value by the exit margin (2¢ after fees by default) the contracts are sold outright, fill-or-cancel. A coin flip held to settlement becomes a few locked cents and the money goes back to work. Sells are journaled alongside buys so settlement nets correctly; calibration and closing-line stats use buys only.
6. **Closing-line value.** In the last minutes before kickoff the engine records the books' final fair value and Kalshi's last mid, then scores every fill: CLV = close − price paid. Positive CLV is the earliest honest sign of real edge; P&L needs hundreds of bets to mean anything. A sport whose trailing-30-day CLV is negative over 20+ fills is paused for a week (you can resume it from the Engine tab).
7. **Matching.** Each Kalshi leg is tied to a side of a sportsbook game by its label, and by the team code at the end of its ticker when the label is only a city. Two teams from one city (Lakers and Clippers, Jets and Giants, Rangers and Islanders) share a city but never a nickname, so they cannot be crossed; a leg that cannot be placed is left unmatched, never guessed.
8. **Budgets.** Sharp-lines credits are paced so the month's quota lasts: the fetch cadence stretches to spend the daily share (remaining ÷ 31) evenly across the sports that need lines today, soonest games first, nothing fetched for slates outside the trading horizon or once every game of a slate is under way; each tick stays within a subrequest budget (`SUBREQ_BUDGET`, default 45) so a busy night cannot exceed the Worker's per-request limits. With an ntfy topic set, a daily digest goes out after 9am (your timezone, configurable).
9. **Staying inside the free plan.** The full list of open games (often two weeks of them, ~500 KB per league) is fetched every 10 minutes; in between, only the games inside the trading window are re-priced by ticker. Team-name matching and cached lines are memoised in memory. A busy slate (30+ games across three leagues) costs about 5 ms of CPU a minute plus ~0.6 ms per signed Kalshi request, and live mode places at most 8 new orders a minute (cancels are never held back). If the Engine tab reports ticks not finishing and the Worker's logs say the CPU limit was exceeded, the Workers Paid plan ($5 a month) lifts it.
10. **Safety.** One tick runs at a time (the alarm, the cron safety net and a manual tick cannot overlap and double-place). Every outbound call times out after 15 s. Five failing ticks in a row push one alert; in live mode, thirty in a row that are not just the lines feed stop the engine and cancel its quotes.

### Tests and the deploy gate

`build.sh` rebuilds everything from `src/` and runs the dependency-free unit suite (`test/unit/`); `wrangler.toml` points its `[build]` hook at that script, so every Cloudflare deploy runs the tests first and a failure leaves the last good version live. `test/engine/` runs whole engine ticks in process against a fake exchange and lines feed (Node 22+), and `test/browser/` drives the page in jsdom; GitHub Actions runs all three on every push.

## What the relay does and does not do

It forwards `GET` requests for a short allowlist of public endpoints (`/markets`, `/events`, `/series`, `/markets/trades`, orderbooks, candlesticks, exchange status) to `external-api.kalshi.com`, caches responses for a few seconds and adds CORS headers. It holds no API key and cannot place orders or read an account. Real trading happens on Kalshi.

Not affiliated with Kalshi. Not investment advice; event contracts can lose the entire amount risked.
