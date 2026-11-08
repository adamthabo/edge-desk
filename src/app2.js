/* Edge Desk app, part 2: views, market sheet, paper tickets, AI reads, setup, routing, boot. */
(function () {
  'use strict';
  const { U, N, F, A } = window.ED;
  const { S, Persist, API, DS, Engine, Desk, Chart, Scanner, label, DEFAULTS, setHealth, noteError } = window.EDApp;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const cssEsc = (s) => (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  const KINDS = { arb: 'Book arbitrage', yield: 'Near-certain yield', spread: 'Wide spread', mover: 'Mover', volume: 'Volume surge', longshot: 'Longshot zone' };
  const VIEWS = ['scanner', 'markets', 'tape', 'desk', 'setup'];

  const UI = window.UI = {
    mk: { search: '', sort: 'vol24', cat: 'all', watchOnly: false, limit: 80 },
    tp: { filter: '', min: 0 },
    /* ----- status ----- */
    renderStatus() {
      const h = S.health;
      const dot = $('st-dot'), txt = $('st-text'), src = $('st-source'), ex = $('st-exchange');
      if (!dot) return;
      dot.className = 'dot ' + (h.status === 'live' ? 'live' : h.status === 'stale' ? 'stale' : h.status === 'sim' ? 'sim' : h.status === 'off' ? 'off' : '');
      txt.textContent = h.text || '';
      src.textContent = S.source === 'relay' ? ((S.sameOrigin ? 'Live relay' : 'Relay') + (S.settings.env === 'demo' ? ' · demo' : '')) : S.source === 'direct' ? 'Direct' : S.source === 'sim' ? 'Simulated data' : 'No source';
      src.className = 'chip' + (S.source === 'sim' ? ' warn' : '');
      const e = h.exchange;
      ex.textContent = e ? (e.trading_active ? 'Exchange open' : (e.exchange_active ? 'Trading paused' : 'Exchange closed')) : '';
      this.tickClock();
    },
    tickClock() {
      const el = $('st-updated'); if (!el) return;
      const now = Date.now();
      if (S.mode === 'live') {
        el.textContent = S.health.lastOk ? 'updated ' + U.ago(S.health.lastOk, now) + ' ago' : '';
        const maxAge = Math.max(S.settings.pollTape, S.settings.pollMarkets) * 3000;
        if (S.health.lastOk && now - S.health.lastOk > maxAge && S.health.status === 'live') { S.health.status = 'stale'; S.health.text = 'Stale'; this.renderStatus(); }
        else if (S.health.status === 'stale' && S.health.lastOk && now - S.health.lastOk < maxAge) { S.health.status = 'live'; S.health.text = 'Live'; this.renderStatus(); }
      } else if (S.mode === 'sim') el.textContent = '';
      const cd = $('sh-countdown'); if (cd && S.sel) { const m = S.universe.markets.get(S.sel); if (m) cd.textContent = 'closes in ' + U.countdown(m.close, now); }
    },
    toast(msg) {
      const box = $('toasts'); if (!box) return;
      const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; box.appendChild(t);
      setTimeout(() => { t.remove(); }, 3200);
    },
    /* ----- routing ----- */
    nav(view, push) {
      if (!VIEWS.includes(view)) view = 'scanner';
      S.view = view;
      for (const v of VIEWS) { const el = $('view-' + v); if (el) el.hidden = v !== view; }
      document.querySelectorAll('#nav button[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === view));
      $('main').scrollTop = 0;
      if (push !== false) { try { if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view); } catch (e) { /* ignore */ } }
      this.render(view);
      if (window.innerWidth < 980 && S.sel) this.closeSheet(false);
    },
    render(view) {
      view = view || S.view;
      if (view === 'scanner') this.renderScanner();
      else if (view === 'markets') this.renderMarkets();
      else if (view === 'tape') this.renderTape();
      else if (view === 'desk') this.renderDesk();
      else if (view === 'setup') this.renderSetup();
    },
    onUniverse() { if (S.view === 'markets' || S.view === 'scanner') this.render(); $('markets-sub').textContent = S.universe.markets.size.toLocaleString() + ' open markets · ' + S.universe.events.size.toLocaleString() + ' events'; if (S.sel) this.renderSheet(); },
    onScanner() { if (S.view === 'scanner') this.renderScanner(); },
    onDesk() { if (S.view === 'desk') this.renderDesk(); },
    onPrices(changed) {
      const flash = new Map(changed.map(c => [c.ticker, c.dir]));
      if (S.view === 'markets') {
        for (const [t, dir] of flash) { const row = document.querySelector('.mrow[data-t="' + cssEsc(t) + '"]'); if (row) { const m = S.universe.markets.get(t); if (m) row.outerHTML = this.marketRow(m); const nrow = document.querySelector('.mrow[data-t="' + cssEsc(t) + '"]'); if (nrow && dir) { nrow.classList.add(dir > 0 ? 'flash-up' : 'flash-down'); } } }
      }
      if (S.sel && flash.has(S.sel)) this.renderSheetQuote(flash.get(S.sel));
      if (S.view === 'desk') this.renderDesk();
    },
    onTape(fresh) {
      if (S.view !== 'tape') return;
      if (!fresh.length) { if (S.blocked.trades) this.renderTape(); return; }
      this.renderTapeStats();
      const list = $('tape-list');
      const rows = fresh.filter(t => this.tapeMatch(t)).map(t => this.tapeRow(t, true)).join('');
      if (rows) { list.insertAdjacentHTML('afterbegin', rows); while (list.children.length > 160) list.lastElementChild.remove(); }
    },

    /* ----- scanner ----- */
    renderScanner() {
      const ops = S.scanner.ops, counts = Scanner.counts();
      const banner = $('scanner-banner');
      banner.innerHTML = this.sourceBanner();
      const kinds = ['all', 'arb', 'yield', 'spread', 'mover', 'volume', 'longshot'];
      $('scanner-chips').innerHTML = kinds.map(k => '<button class="chip' + (S.scanner.kind === k ? ' on' : '') + '" data-act="skind" data-k="' + k + '">' + (k === 'all' ? 'All' : KINDS[k]) + ' <b>' + (counts[k] || 0) + '</b></button>').join('');
      const sub = $('scanner-sub');
      sub.textContent = S.universe.markets.size ? (S.universe.markets.size.toLocaleString() + ' open markets scanned ' + (S.scanner.at ? U.ago(S.scanner.at) + ' ago' : '')) : 'Loading the market universe';
      let shown;
      if (S.scanner.kind === 'all') {
        const per = {}; shown = [];
        for (const o of ops) { per[o.kind] = (per[o.kind] || 0) + 1; if (per[o.kind] <= 6) shown.push(o); }
      } else shown = ops.filter(o => o.kind === S.scanner.kind);
      const list = $('scanner-list');
      if (!shown.length) { list.innerHTML = '<div class="empty">' + (S.universe.markets.size ? 'No ' + (S.scanner.kind === 'all' ? 'signals' : KINDS[S.scanner.kind].toLowerCase() + ' signals') + ' in the loaded universe right now. Load more pages in Setup to widen the scan.' : 'Markets are loading. Signals appear here as soon as the first page arrives.') + '</div>'; }
      else list.innerHTML = shown.map(o => this.oppCard(o)).join('');
      this.renderBrief();
    },
    sourceBanner() {
      if (S.mode === 'sim') {
        const why = S.ctx === 'artifact'
          ? 'This copy runs inside Claude, which keeps pages from calling outside APIs, so the markets below are generated for demonstration. The live version is the same app served from your own free Cloudflare Worker; Setup has the two-minute recipe.'
          : esc(S.health.simReason || '') + '. Kalshi\'s API refuses browser requests, so the live version runs through a small relay you deploy once (free). Everything below is generated for demonstration.';
        return '<div class="banner warn"><div><p><b>Simulated data.</b> ' + why + '</p><div class="actions"><button class="btn sm primary" data-act="nav" data-v="setup">Go live</button></div></div></div>';
      }
      if (S.health.status === 'stale') return '<div class="banner danger"><div><p><b>Data is stale.</b> ' + esc(S.health.lastErr || 'The relay stopped answering') + '. Polling continues; prices shown may be old.</p></div></div>';
      if (S.mode === 'live' && S.universe.loading) return '<div class="banner"><div><p><b>Loading the market universe</b> · ' + S.universe.markets.size.toLocaleString() + ' markets so far. Signals refine as more pages arrive.</p></div></div>';
      return '';
    },
    oppCard(o, idx) {
      const ev = S.universe.events.get(o.event);
      const cat = ev && ev.category ? ev.category : '';
      let legs = '';
      if (o.kind === 'arb') {
        legs = '<div class="legs">' + o.tickers.map(t => { const m = S.universe.markets.get(t); if (!m) return ''; const px = o.sub === 'no' ? 'NO ' + U.cents(1 - m.yb) + ' <span class="faint">(' + U.compact(m.ybSize) + ')</span>' : 'YES ' + U.cents(m.ya) + ' <span class="faint">(' + U.compact(m.yaSize) + ')</span>'; return '<div><span class="truncate" style="max-width:70%"><a href="#" data-act="open" data-t="' + esc(t) + '">' + esc(m.yesSub || m.title) + '</a></span><span class="' + (o.sub === 'no' ? 'no' : 'yes') + '">' + px + '</span></div>'; }).join('') + '</div>';
      }
      const t0 = o.tickers[0];
      const m0 = S.universe.markets.get(t0);
      const watchOn = S.watch.has(t0);
      let actions = '<button class="btn sm" data-act="open" data-t="' + esc(t0) + '">' + (o.kind === 'arb' ? 'Open legs' : 'Open') + '</button>';
      if (o.kind === 'arb') { const sets = Math.max(1, Math.min(10, Math.floor(o.size || 1))); actions += '<button class="btn sm primary" data-act="paperset" data-i="' + S.scanner.ops.indexOf(o) + '" data-n="' + sets + '">Paper ' + sets + ' set' + (sets > 1 ? 's' : '') + '</button>'; }
      else if (o.kind === 'yield') actions += '<button class="btn sm ' + o.side + '" data-act="ticket" data-t="' + esc(t0) + '" data-side="' + o.side + '">Paper ' + o.side.toUpperCase() + ' at ' + U.cents(o.price) + '</button>';
      else if (o.kind === 'longshot') actions += '<button class="btn sm no" data-act="ticket" data-t="' + esc(t0) + '" data-side="no">Paper NO at ' + U.cents(o.noPrice) + '</button>';
      else if (o.kind === 'spread') actions += '<button class="btn sm" data-act="ticket" data-t="' + esc(t0) + '" data-side="yes" data-type="limit" data-price="' + (o.yb + 0.01).toFixed(2) + '">Rest a bid at ' + U.cents(o.yb + 0.01) + '</button>';
      if (o.kind !== 'arb') actions += '<button class="btn sm ghost" data-act="watch" data-t="' + esc(t0) + '">' + (watchOn ? 'Unwatch' : 'Watch') + '</button>';
      if (m0) actions += '<a class="btn sm ghost" href="' + this.kalshiUrl(m0) + '" target="_blank" rel="noopener">Kalshi</a>';
      const brief = S.scanner.brief && S.scanner.brief.items ? S.scanner.brief.items.find(b => b.key === this.opKey(o)) : null;
      const briefHtml = brief ? '<div class="small" style="padding:8px 10px;background:var(--bg-sunk);border-radius:var(--radius)"><b>Claude:</b> ' + esc(brief.take) + (brief.caution ? ' <span class="muted">' + esc(brief.caution) + '</span>' : '') + ' <span class="faint">(' + esc(brief.confidence || '') + ' confidence)</span></div>' : '';
      return '<div class="card opp" data-op="' + esc(this.opKey(o)) + '">' +
        '<div class="opp-head"><span class="kind ' + o.kind + '">' + KINDS[o.kind] + '</span>' + (cat ? '<span class="faint small">' + esc(cat) + '</span>' : '') + (m0 && m0.close ? '<span class="faint small" style="margin-left:auto">closes ' + U.countdown(m0.close) + '</span>' : '') + '</div>' +
        '<div class="title">' + esc(o.title) + '</div>' +
        '<div class="headline">' + esc(o.headline) + '</div>' +
        '<div class="math">' + esc(o.math) + '</div>' + legs +
        '<div class="note">' + esc(o.note) + '</div>' + briefHtml +
        '<div class="actions">' + actions + '</div></div>';
    },
    opKey(o) { return o.kind + ':' + (o.sub || '') + ':' + o.tickers.join(','); },
    kalshiUrl(m) { return 'https://kalshi.com/markets/' + encodeURIComponent(String(m.series || '').toLowerCase()); },
    briefOps() { return S.scanner.kind === 'all' ? S.scanner.ops.slice(0, 14) : S.scanner.ops.filter(o => o.kind === S.scanner.kind).slice(0, 14); },
    renderBrief() {
      const box = $('scanner-brief'); if (!box) return;
      if (!S.ai) { box.innerHTML = S.scanner.ops.length ? '<div class="row" style="margin:6px 0 4px"><button class="btn sm" data-act="copybrief">Copy a prompt for Claude</button><span class="faint small">Paste it into a Claude chat for a second opinion on these signals.</span></div>' : ''; return; }
      const b = S.scanner.brief;
      if (S.scanner.briefBusy) { box.innerHTML = '<div class="banner"><div><p class="think">Claude is reading the scan…</p><div class="actions"><button class="btn sm" data-act="briefstop">Stop</button></div></div></div>'; return; }
      if (b && b.summary) { box.innerHTML = '<div class="banner"><div><p><b>Claude\'s desk brief</b> · ' + esc(U.dateShort(b.at)) + '</p><p style="margin-top:6px">' + esc(b.summary) + '</p><p class="faint small" style="margin-top:6px">Reasoning from the numbers shown and general knowledge; no live news. Not advice.</p><div class="actions"><button class="btn sm" data-act="brief">Refresh brief</button></div></div></div>'; return; }
      box.innerHTML = '<div class="row" style="margin:6px 0 4px"><button class="btn sm" data-act="brief">Ask Claude to rank these signals</button><span class="faint small">Uses your Claude account; you confirm the first time.</span></div>';
    },

    /* ----- markets ----- */
    marketRow(m) {
      const ev = S.universe.events.get(m.event);
      const d = (m.last !== null && m.prev !== null) ? m.last - m.prev : null;
      const price = m.mid !== null ? m.mid : m.last;
      return '<div class="mrow" data-act="open" data-t="' + esc(m.ticker) + '">' +
        '<div class="grow"><div class="t">' + esc(label(m)) + (S.watch.has(m.ticker) ? ' <span class="faint">★</span>' : '') + '</div>' +
        '<div class="meta">' + (ev && ev.category ? '<span>' + esc(ev.category) + '</span>' : '') + '<span>' + U.countdown(m.close) + '</span><span>24h ' + U.compact(m.vol24) + '</span><span class="mono">' + esc(m.ticker) + '</span></div></div>' +
        '<div class="px"><div class="p">' + U.cents(price) + '</div><div class="d ' + (d === null ? 'faint' : d > 0 ? 'up' : d < 0 ? 'down' : 'faint') + '">' + (d === null ? '—' : (d > 0 ? '▲' : d < 0 ? '▼' : '') + ' ' + U.cents(Math.abs(d))) + '</div></div>' +
        '<div class="sides"><button class="pxbtn yes" data-act="ticket" data-t="' + esc(m.ticker) + '" data-side="yes">YES ' + (m.hasAsk ? U.cents(m.ya) : '—') + '</button><button class="pxbtn no" data-act="ticket" data-t="' + esc(m.ticker) + '" data-side="no">NO ' + (m.hasBid ? U.cents(1 - m.yb) : '—') + '</button></div></div>';
    },
    marketsFiltered() {
      const q = this.mk.search.trim().toLowerCase();
      const cat = this.mk.cat;
      let arr = Array.from(S.universe.markets.values()).filter(m => m.status === 'active');
      if (this.mk.watchOnly) arr = arr.filter(m => S.watch.has(m.ticker));
      if (cat !== 'all') arr = arr.filter(m => { const ev = S.universe.events.get(m.event); return (ev && ev.category) === cat; });
      if (q) arr = arr.filter(m => (m.ticker + ' ' + label(m) + ' ' + m.event).toLowerCase().includes(q));
      const sort = this.mk.sort;
      const key = (m) => sort === 'vol' ? m.vol : sort === 'oi' ? m.oi : sort === 'close' ? -(m.close || Infinity) : sort === 'move' ? (m.last !== null && m.prev !== null ? Math.abs(m.last - m.prev) : -1) : sort === 'spread' ? (m.hasBid && m.hasAsk ? m.ya - m.yb : -1) : m.vol24;
      arr.sort((a, b) => key(b) - key(a));
      return arr;
    },
    renderMarkets() {
      const cats = new Map();
      for (const ev of S.universe.events.values()) { if (!ev.category) continue; cats.set(ev.category, (cats.get(ev.category) || 0) + ev.markets.length); }
      const catList = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
      $('mk-cats').innerHTML = '<button class="chip' + (this.mk.cat === 'all' ? ' on' : '') + '" data-act="mcat" data-c="all">All</button>' + catList.map(([c, n]) => '<button class="chip' + (this.mk.cat === c ? ' on' : '') + '" data-act="mcat" data-c="' + esc(c) + '">' + esc(c) + ' <b>' + n + '</b></button>').join('');
      const arr = this.marketsFiltered();
      const list = $('mk-list');
      const q = this.mk.search.trim();
      const looksLikeTicker = /^[A-Za-z]{2,}[A-Za-z0-9-]*\d[A-Za-z0-9-]*$/.test(q) && q.length >= 6;
      if (!arr.length) list.innerHTML = '<div class="empty" style="margin-top:10px">' + (S.universe.markets.size ? 'Nothing matches in the loaded universe.' + (looksLikeTicker && S.mode === 'live' ? ' <button class="btn sm" style="margin-left:6px" data-act="open" data-t="' + esc(q.toUpperCase()) + '">Look up ' + esc(q.toUpperCase()) + ' on Kalshi</button>' : ' Clear the search or pick another category.') : 'Markets are loading.') + '</div>';
      else list.innerHTML = arr.slice(0, this.mk.limit).map(m => this.marketRow(m)).join('');
      $('mk-more').innerHTML = arr.length > this.mk.limit ? '<button class="btn block" data-act="mmore">Show more (' + (arr.length - this.mk.limit).toLocaleString() + ' remaining)</button>' : '';
      $('markets-sub').textContent = S.universe.markets.size.toLocaleString() + ' open markets · ' + S.universe.events.size.toLocaleString() + ' events' + (S.mode === 'live' && S.universe.pages ? (S.universe.loading ? ' · loading page ' + (S.universe.pages + 1) : S.universe.complete ? ' · complete' : ' · first ' + S.universe.pages + ' pages; raise Universe pages in Setup for more') : '');
    },

    /* ----- tape ----- */
    tapeMatch(t) {
      if (t.qty < this.tp.min) return false;
      const q = this.tp.filter.trim().toLowerCase();
      if (!q) return true;
      const m = S.universe.markets.get(t.ticker);
      return (t.ticker + ' ' + (m ? label(m) : '')).toLowerCase().includes(q);
    },
    tapeRow(t, isNew) {
      const m = S.universe.markets.get(t.ticker);
      const big = t.qty >= S.settings.bigPrint;
      const side = t.taker === 'no' ? 'no' : 'yes';
      const px = side === 'no' ? t.no : t.yes;
      return '<div class="trow' + (big ? ' big' : '') + (isNew ? ' new' : '') + '" data-act="open" data-t="' + esc(t.ticker) + '">' +
        '<div class="time">' + U.timeOnly(t.t) + '</div>' +
        '<div class="tk"><div class="n">' + esc(m ? label(m) : t.ticker) + '</div><div class="k">' + esc(t.ticker) + (t.block ? ' · block' : '') + '</div></div>' +
        '<div class="side ' + side + '">' + side.toUpperCase() + ' ' + U.cents(px) + '</div>' +
        '<div class="qty">' + U.compact(t.qty) + '</div></div>';
    },
    renderTapeStats() {
      const st = A.tapeStats(S.tape.trades, 600000);
      const tot = st.yesQty + st.noQty;
      const yesPct = tot ? st.yesQty / tot : 0.5;
      $('tape-stats').innerHTML =
        '<div class="stat"><div class="label">Prints · 10 min</div><div class="v">' + st.n + '</div><div class="s">' + st.perMin.toFixed(1) + ' per minute</div></div>' +
        '<div class="stat"><div class="label">Taker flow</div><div class="v"><span class="yes">' + U.pct(yesPct, 0) + ' YES</span></div><div class="flow"><i style="width:' + (yesPct * 100).toFixed(1) + '%"></i></div><div class="s">' + U.compact(st.yesQty) + ' vs ' + U.compact(st.noQty) + ' contracts</div></div>' +
        '<div class="stat"><div class="label">Notional</div><div class="v">' + U.money(st.notional, { dec: 0 }) + '</div><div class="s">' + st.big + ' big print' + (st.big === 1 ? '' : 's') + ' (500+)</div></div>' +
        '<div class="stat"><div class="label">Most active</div><div class="s" style="margin-top:4px">' + (st.top.slice(0, 4).map(x => '<a href="#" data-act="open" data-t="' + esc(x.ticker) + '" class="mono">' + esc(x.ticker.length > 22 ? x.ticker.slice(0, 22) + '…' : x.ticker) + '</a> <span class="faint">' + U.compact(x.qty) + '</span>').join('<br>') || '—') + '</div></div>';
    },
    renderTape() {
      this.renderTapeStats();
      const rows = S.tape.trades.filter(t => this.tapeMatch(t)).slice(0, 150);
      $('tape-list').innerHTML = rows.length ? rows.map(t => this.tapeRow(t, false)).join('') : '<div class="empty">' + (S.blocked.trades ? 'Kalshi\'s trade feed asked for authentication, so the public tape is unavailable on this exchange.' : 'Waiting for prints. The tape fills as trades happen on the exchange.') + '</div>';
    },

    /* ----- desk ----- */
    renderDesk() {
      const d = S.desk; const v = Desk.value();
      const openPnl = v.positions - Object.values(d.positions).reduce((s, p) => s + p.cost, 0);
      const ret = d.start ? (v.equity - d.start) / d.start : 0;
      $('desk-tiles').innerHTML =
        '<div class="tile"><div class="label">Equity</div><div class="v">' + U.money(v.equity) + '</div><div class="s ' + (ret >= 0 ? 'up' : 'down') + '">' + U.signed(ret * 100, 2) + '% since start</div></div>' +
        '<div class="tile"><div class="label">Cash</div><div class="v">' + U.money(d.cash) + '</div><div class="s">' + U.money(v.positions) + ' in positions</div></div>' +
        '<div class="tile"><div class="label">Open P&amp;L</div><div class="v ' + (openPnl >= 0 ? 'up' : 'down') + '">' + U.money(openPnl, { plus: true }) + '</div><div class="s">marked at the bid</div></div>' +
        '<div class="tile"><div class="label">Realized</div><div class="v ' + (d.realized >= 0 ? 'up' : 'down') + '">' + U.money(d.realized, { plus: true }) + '</div><div class="s">' + U.money(d.fees) + ' paid in fees</div></div>';
      Chart.spark($('desk-equity'), $('desk-equity-tip'), d.equity);
      const keys = Object.keys(d.positions);
      $('desk-positions').innerHTML = keys.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>Market</th><th class="r">Qty</th><th class="r">Avg cost</th><th class="r">Bid</th><th class="r">P&amp;L</th><th></th></tr></thead><tbody>' + keys.map(k => {
        const p = d.positions[k]; const m = S.universe.markets.get(p.ticker); const bid = m ? Desk.quote(m, p.side, 'sell') : null;
        const val = p.qty * (bid !== null ? bid : p.cost / p.qty); const pnl = val - p.cost;
        return '<tr><td><a href="#" data-act="open" data-t="' + esc(p.ticker) + '">' + esc(p.title) + '</a><div class="faint small"><span class="' + p.side + '">' + p.side.toUpperCase() + '</span> · <span class="mono">' + esc(p.ticker) + '</span>' + (m && m.close ? ' · closes ' + U.countdown(m.close) : '') + '</div></td><td class="r">' + p.qty + '</td><td class="r">' + U.cents(p.cost / p.qty) + '</td><td class="r">' + U.cents(bid) + '</td><td class="r ' + (pnl >= 0 ? 'up' : 'down') + '">' + U.money(pnl, { plus: true }) + '</td><td class="r"><button class="btn sm" data-act="sell" data-k="' + esc(k) + '">Close</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">No open positions. Use the YES / NO buttons on any market, or the Paper buttons in the Scanner.</div>';
      $('desk-orders').innerHTML = d.orders.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>Market</th><th class="r">Side</th><th class="r">Qty</th><th class="r">Limit</th><th class="r">Now</th><th></th></tr></thead><tbody>' + d.orders.map(o => {
        const m = S.universe.markets.get(o.ticker); const ask = m ? Desk.quote(m, o.side, 'buy') : null;
        return '<tr><td><a href="#" data-act="open" data-t="' + esc(o.ticker) + '">' + esc(o.title) + '</a><div class="faint small mono">' + esc(o.ticker) + '</div></td><td class="r ' + o.side + '">' + o.side.toUpperCase() + '</td><td class="r">' + o.qty + '</td><td class="r">' + U.cents(o.price) + '</td><td class="r">' + U.cents(ask) + '</td><td class="r"><button class="btn sm ghost" data-act="cancel" data-id="' + esc(o.id) + '">Cancel</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">No resting orders. Limit orders rest here and fill when the market trades through your price.</div>';
      $('desk-fills').innerHTML = d.fills.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>When</th><th>Market</th><th class="r">Action</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fee</th><th class="r">P&amp;L</th></tr></thead><tbody>' + d.fills.slice(0, 60).map(f =>
        '<tr><td class="faint">' + U.dateShort(f.t) + '</td><td><a href="#" data-act="open" data-t="' + esc(f.ticker) + '">' + esc(f.title) + '</a></td><td class="r"><span class="' + f.side + '">' + f.side.toUpperCase() + '</span> ' + f.action + (f.maker ? ' (maker)' : '') + '</td><td class="r">' + f.qty + '</td><td class="r">' + U.cents(f.price) + '</td><td class="r">' + (f.fee ? U.money(f.fee) : '—') + '</td><td class="r ' + (f.pnl === undefined ? '' : f.pnl >= 0 ? 'up' : 'down') + '">' + (f.pnl === undefined ? '—' : U.money(f.pnl, { plus: true })) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No fills yet.</div>';
      $('desk-account').innerHTML = '<label class="field" style="flex:1 1 160px"><span>Starting bankroll</span><input class="inp" id="desk-bankroll" type="number" min="10" step="10" value="' + esc(d.start) + '"></label>' +
        '<button class="btn" data-act="reset1">Reset paper account</button><span id="desk-reset-confirm"></span>' +
        '<button class="btn ghost" data-act="export">Export</button>' +
        '<div id="desk-export" style="flex-basis:100%"></div>';
    },

    /* ----- market sheet ----- */
    openSheet() {
      const sheet = $('sheet'); sheet.hidden = false; document.body.classList.add('sheet-open');
      this.renderSheet();
      $('sh-body').scrollTop = 0;
    },
    closeSheet(keep) {
      $('sheet').hidden = true; document.body.classList.remove('sheet-open');
      if (!keep) S.sel = null;
    },
    renderSheet() {
      const m = S.universe.markets.get(S.sel); if (!m) return;
      const ev = S.universe.events.get(m.event);
      $('sh-event').textContent = (ev && ev.category ? ev.category + ' · ' : '') + (ev ? ev.title : m.event);
      $('sh-title').textContent = m.title && !m.yesSub ? m.title : (m.yesSub || m.title || m.ticker);
      $('sh-meta').innerHTML = '<span class="mono">' + esc(m.ticker) + '</span><button class="btn sm ghost" data-act="copy" data-text="' + esc(m.ticker) + '">Copy</button><span id="sh-countdown">closes in ' + U.countdown(m.close) + '</span>' + (m.provisional ? '<span class="chip warn">provisional</span>' : '') + (m.status !== 'active' ? '<span class="chip">' + esc(m.status) + '</span>' : '');
      const fee = Desk.feeInfo(m);
      const feeTxt = fee.waived ? 'Fees waived until ' + U.dateShort(m.feeWaiverUntil) : (fee.type === 'quadratic_with_maker_fees' ? 'Taker ' + (F.rate('taker', fee) * 100).toFixed(1) + '% · maker ' + (F.rate('maker', fee) * 100).toFixed(2) + '%' : fee.type === 'quadratic_with_combo_maker_fees' ? 'Combo: maker pays half the taker fee' : fee.type === 'flat' ? 'Flat fee series' : 'Taker ' + (F.rate('taker', fee) * 100).toFixed(1) + '% · no maker fee') + (S.seriesCache[m.series] && S.seriesCache[m.series].unknown ? ' (series lookup failed; default schedule shown)' : '');
      const siblings = ev && ev.mutEx && ev.markets.length > 1 ? ev.markets.map(t => S.universe.markets.get(t)).filter(Boolean) : [];
      let bookHtml = '';
      if (siblings.length) {
        const sumAsk = siblings.reduce((s, x) => s + (x.hasAsk ? x.ya : 1), 0), sumBid = siblings.reduce((s, x) => s + (x.hasBid ? x.yb : 0), 0);
        bookHtml = '<div class="section" style="margin-top:0"><h3>One-winner book · ' + siblings.length + ' outcomes</h3><div class="legs small" style="display:grid;gap:3px">' + siblings.map(x => '<div style="display:flex;justify-content:space-between;gap:8px"><a href="#" data-act="open" data-t="' + esc(x.ticker) + '" class="truncate" style="max-width:62%">' + (x.ticker === m.ticker ? '<b>' : '') + esc(x.yesSub || x.title) + (x.ticker === m.ticker ? '</b>' : '') + '</a><span><span class="yes">' + (x.hasBid ? U.cents(x.yb) : '—') + '</span> / <span class="no">' + (x.hasAsk ? U.cents(x.ya) : '—') + '</span></span></div>').join('') +
          '</div><div class="small muted" style="margin-top:6px">YES asks sum to <b>' + U.cents(sumAsk) + '</b> · YES bids sum to <b>' + U.cents(sumBid) + '</b>. Below 100¢ on asks (minus fees) means buying every YES locks a profit if one must win; above 100¢ on bids means selling every YES locks one.</div></div>';
      }
      $('sh-body').innerHTML =
        '<div id="sh-quote"></div>' +
        '<div class="facts" id="sh-facts"></div>' +
        '<div><div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="label">Price history</span><div class="seg">' + ['1D', '1W', '1M', 'All'].map(r => '<button data-act="range" data-r="' + r + '"' + (S.sheet.range === r ? ' class="on"' : '') + '>' + r + '</button>').join('') + '</div></div><div class="chart-wrap"><canvas id="sh-chart" height="190"></canvas><div class="chart-tip" id="sh-chart-tip"></div></div><div class="faint small" id="sh-chart-note" style="margin-top:4px"></div></div>' +
        '<div><div class="label" style="margin-bottom:6px">Order book</div>' + (S.blocked.book ? '<div class="empty">Kalshi\'s order book endpoint asked for authentication, so depth is hidden. Top-of-book bid, ask and size still update from the market record.</div>' : '<div class="chart-wrap"><canvas id="sh-depth" height="120"></canvas><div class="chart-tip" id="sh-depth-tip"></div></div><div class="ladder" id="sh-ladder" style="margin-top:8px"></div>') + '</div>' +
        '<div class="section" style="margin-top:0"><h3>Edge calculator</h3><div class="calc" id="sh-calc"></div></div>' +
        '<div class="section" style="margin-top:0"><h3>Paper ticket</h3><div class="ticket" id="sh-ticket"></div></div>' +
        '<div class="section" style="margin-top:0"><h3>Claude\'s read</h3><div class="ai" id="sh-ai"></div></div>' +
        '<div class="section" style="margin-top:0"><h3>Recent trades</h3><div id="sh-trades"></div></div>' +
        bookHtml +
        '<div class="section" style="margin-top:0"><h3>Rules</h3><details class="rules"' + (m.rules && m.rules.length < 400 ? ' open' : '') + '><summary>' + (m.rules ? 'Settlement rules' : 'Rules load when the full market record arrives') + '</summary><p>' + esc(m.rules || '') + (m.rules2 ? '\n\n' + esc(m.rules2) : '') + '</p></details></div>' +
        '<div class="row"><a class="btn" href="' + this.kalshiUrl(m) + '" target="_blank" rel="noopener">Open on Kalshi</a><button class="btn ghost" data-act="watch" data-t="' + esc(m.ticker) + '">' + (S.watch.has(m.ticker) ? 'Unwatch' : 'Watch') + '</button><span class="faint small">' + esc(feeTxt) + '</span></div>';
      this.renderSheetQuote(0);
      this.renderCalc();
      this.renderTicket();
      this.renderAI();
      this.renderSheetLive();
      this.renderChart();
    },
    renderSheetQuote(dir) {
      const m = S.universe.markets.get(S.sel); if (!m || !$('sh-quote')) return;
      const d = (m.last !== null && m.prev !== null) ? m.last - m.prev : null;
      $('sh-quote').innerHTML = '<div class="quote">' +
        '<div class="qbox yes' + (dir > 0 ? ' flash-up' : '') + '"><div class="l">Yes</div><div class="p">' + (m.hasAsk ? U.cents(m.ya) : '—') + '</div><div class="s">bid ' + (m.hasBid ? U.cents(m.yb) : '—') + ' · ' + U.compact(m.yaSize) + ' offered</div><button class="btn sm yes" style="margin-top:8px" data-act="ticket" data-t="' + esc(m.ticker) + '" data-side="yes">Buy YES</button></div>' +
        '<div class="qbox no' + (dir < 0 ? ' flash-down' : '') + '"><div class="l">No</div><div class="p">' + (m.hasBid ? U.cents(1 - m.yb) : '—') + '</div><div class="s">bid ' + (m.hasAsk ? U.cents(1 - m.ya) : '—') + ' · ' + U.compact(m.ybSize) + ' offered</div><button class="btn sm no" style="margin-top:8px" data-act="ticket" data-t="' + esc(m.ticker) + '" data-side="no">Buy NO</button></div></div>';
      const f = (k, v, cls) => '<div><div class="k">' + k + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + v + '</div></div>';
      $('sh-facts').innerHTML = f('Last', U.cents(m.last)) + f('24h change', d === null ? '—' : (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + U.cents(Math.abs(d)), d === null ? '' : d > 0 ? 'up' : d < 0 ? 'down' : '') + f('Spread', m.hasBid && m.hasAsk ? U.cents(m.ya - m.yb) : '—') + f('Volume', U.compact(m.vol)) + f('24h volume', U.compact(m.vol24)) + f('Open interest', U.compact(m.oi)) + f('Closes', U.dateShort(m.close)) + f('Expires', U.dateShort(m.exp));
      const ticketPv = $('sh-ticket'); if (ticketPv) this.renderTicketPreview();
      const calc = $('sh-calc'); if (calc && S.sheet.calcQ === null) this.renderCalc();
      else if (calc) this.renderCalcOut();
    },
    renderSheetLive() {
      const m = S.universe.markets.get(S.sel); if (!m) return;
      const book = S.sheet.book;
      const depth = $('sh-depth'); if (depth) Chart.depth(depth, $('sh-depth-tip'), book);
      const ladder = $('sh-ladder');
      if (ladder) {
        if (!book) ladder.innerHTML = '<div class="faint small">Loading book…</div>';
        else {
          const maxQ = Math.max(1, ...book.yesBids.slice(0, 8).map(x => x[1]), ...book.yesAsks.slice(0, 8).map(x => x[1]));
          const col = (title, cls, rows) => '<div class="col ' + cls + '"><h4>' + title + '</h4>' + (rows.length ? rows.map(([p, q]) => '<div class="lrow"><i class="bar" style="width:' + Math.min(100, q / maxQ * 100).toFixed(0) + '%"></i><span>' + U.cents(p) + '</span><span class="q">' + U.compact(q) + '</span></div>').join('') : '<div class="faint">none</div>') + '</div>';
          ladder.innerHTML = col('YES bids', 'yes', book.yesBids.slice(0, 8)) + col('YES offers', 'no', book.yesAsks.slice(0, 8));
        }
      }
      const tr = $('sh-trades');
      if (tr) tr.innerHTML = S.sheet.trades.length ? S.sheet.trades.slice(0, 12).map(t => { const side = t.taker === 'no' ? 'no' : 'yes'; return '<div class="trow" style="grid-template-columns:62px 1fr 72px;cursor:default"><div class="time">' + U.timeOnly(t.t) + '</div><div class="side ' + side + '">' + side.toUpperCase() + ' ' + U.cents(side === 'no' ? t.no : t.yes) + '</div><div class="qty">' + U.compact(t.qty) + '</div></div>'; }).join('') : '<div class="faint small">' + (S.blocked.trades ? 'Trade history needs authentication on this exchange.' : 'No recent prints.') + '</div>';
      this.renderTicketPreview();
    },
    renderChart() {
      const c = $('sh-chart'); if (c) Chart.price(c, $('sh-chart-tip'), S.sheet.candles);
      const note = $('sh-chart-note');
      if (note) note.textContent = S.sheet.candleSource === 'trades' ? 'Built from public trade prints (candles need an API key).' : S.sheet.candleSource === 'none' ? 'No trades in this range yet.' : '';
    },
    renderCalc() {
      const m = S.universe.markets.get(S.sel); const box = $('sh-calc'); if (!m || !box) return;
      if (S.sheet.calcQ === null) S.sheet.calcQ = m.mid !== null ? Math.round(m.mid * 100) : 50;
      box.innerHTML = '<div class="slider"><div class="row" style="justify-content:space-between"><span class="small muted">Your probability of YES</span><b id="calc-q-label">' + S.sheet.calcQ + '%</b></div><input type="range" id="calc-q" min="1" max="99" value="' + S.sheet.calcQ + '"></div>' +
        '<div class="row small muted" style="gap:14px"><label class="row" style="gap:6px">Bankroll <input class="inp" id="calc-bank" type="number" min="1" step="50" value="' + esc(S.settings.bankroll) + '" style="width:96px;padding:4px 6px"></label><label class="row" style="gap:6px">Kelly <select class="sel" id="calc-kelly" style="padding:4px 6px"><option value="1"' + (S.settings.kelly === 1 ? ' selected' : '') + '>Full</option><option value="0.5"' + (S.settings.kelly === 0.5 ? ' selected' : '') + '>Half</option><option value="0.25"' + (S.settings.kelly === 0.25 ? ' selected' : '') + '>Quarter</option><option value="0.1"' + (S.settings.kelly === 0.1 ? ' selected' : '') + '>Tenth</option></select></label></div>' +
        '<div class="evgrid" id="calc-out"></div>' +
        '<div class="faint small">EV uses the taker price plus Kalshi\'s fee for one contract. Kelly size assumes your probability is exactly right, which it is not; fractional Kelly is the usual correction.</div>';
      this.renderCalcOut();
    },
    renderCalcOut() {
      const m = S.universe.markets.get(S.sel); const out = $('calc-out'); if (!m || !out) return;
      const q = (S.sheet.calcQ === null ? 50 : S.sheet.calcQ) / 100;
      const info = Desk.feeInfo(m);
      const lbl = $('calc-q-label'); if (lbl) lbl.textContent = Math.round(q * 100) + '%';
      const bank = U.num(($('calc-bank') || {}).value, S.settings.bankroll), kf = U.num(($('calc-kelly') || {}).value, S.settings.kelly);
      const box = (side) => {
        const price = side === 'yes' ? (m.hasAsk ? m.ya : null) : (m.hasBid ? U.round(1 - m.yb, 4) : null);
        if (price === null) return '<div class="evbox"><div class="h ' + side + '">' + side.toUpperCase() + '</div><div class="faint">No offer</div></div>';
        const fee = F.perContract(price, 'taker', info, S.settings.rounding);
        const e = A.edge(q, side, price, fee);
        const sz = A.sizeFor(bank, kf, e);
        const good = e.ev > 0;
        return '<div class="evbox"><div class="h ' + side + '">Buy ' + side.toUpperCase() + ' at ' + U.cents(price) + '</div>' +
          '<div class="big ' + (good ? 'up' : 'down') + '">' + (e.ev >= 0 ? '+' : '−') + U.cents(Math.abs(e.ev)) + ' <span class="small" style="font-weight:400">EV / contract</span></div>' +
          '<div>Return on cost <b class="' + (good ? 'up' : 'down') + '">' + U.signed(e.roi * 100, 1) + '%</b></div>' +
          '<div>Breakeven belief <b>' + U.pct(e.breakeven, 1) + '</b></div>' +
          '<div>Fee <b>' + U.cents(fee) + '</b></div>' +
          (good ? '<div>Kelly ' + U.pct(e.kelly, 1) + ' → <b>' + sz.contracts + ' contracts</b> (' + U.money(sz.stake) + ')</div><button class="btn sm ' + side + '" style="margin-top:4px" data-act="ticket" data-t="' + esc(m.ticker) + '" data-side="' + side + '" data-qty="' + sz.contracts + '">Paper ' + sz.contracts + ' ' + side.toUpperCase() + '</button>' : '<div class="faint">No edge at this belief</div>') + '</div>';
      };
      out.innerHTML = box('yes') + box('no');
    },
    renderTicket() {
      const m = S.universe.markets.get(S.sel); const box = $('sh-ticket'); if (!m || !box) return;
      const t = S.sheet.ticket;
      if (t.price === null) t.price = t.side === 'yes' ? (m.hasBid ? m.yb : 0.5) : (m.hasAsk ? U.round(1 - m.ya, 4) : 0.5);
      box.innerHTML = '<div class="row" style="justify-content:space-between"><div class="seg"><button data-act="tside" data-s="yes"' + (t.side === 'yes' ? ' class="on"' : '') + '>YES</button><button data-act="tside" data-s="no"' + (t.side === 'no' ? ' class="on"' : '') + '>NO</button></div><div class="seg"><button data-act="ttype" data-s="market"' + (t.type === 'market' ? ' class="on"' : '') + '>Market</button><button data-act="ttype" data-s="limit"' + (t.type === 'limit' ? ' class="on"' : '') + '>Limit</button></div></div>' +
        '<div class="grid"><label>Contracts<input class="inp" id="tk-qty" type="number" min="1" step="1" value="' + esc(t.qty) + '"></label><label' + (t.type === 'limit' ? '' : ' hidden') + '>Limit price (¢)<input class="inp" id="tk-price" type="number" min="1" max="99" step="1" value="' + Math.round(t.price * 100) + '"></label></div>' +
        '<div class="preview" id="tk-preview"></div>' +
        '<button class="btn primary block" data-act="place">Place paper order</button>' +
        '<div class="faint small">Paper only. Market orders fill against the live book at taker fees; limit orders rest and fill when the market trades through your price. Nothing is sent to Kalshi.</div>';
      this.renderTicketPreview();
    },
    renderTicketPreview() {
      const m = S.universe.markets.get(S.sel); const pv = $('tk-preview'); if (!m || !pv) return;
      const t = S.sheet.ticket;
      const qty = U.num(($('tk-qty') || {}).value, t.qty);
      const price = t.type === 'limit' ? U.num(($('tk-price') || {}).value, Math.round(t.price * 100)) / 100 : null;
      const p = Desk.preview(m, t.side, qty, t.type, price, S.sheet.book);
      pv.innerHTML = '<div><span>' + (t.type === 'limit' ? 'Rest ' : 'Buy ') + U.compact(p.filled || qty) + ' ' + t.side.toUpperCase() + '</span><span>' + (p.price !== null ? U.cents(p.price) + (t.type === 'market' && p.filled > 0 ? ' avg' : '') : '—') + '</span></div>' +
        '<div><span>Fee (' + p.kind + ')</span><span>' + U.money(p.fee) + '</span></div>' +
        '<div><span>Total</span><b>' + U.money(p.cost) + '</b></div>' +
        '<div><span>Pays if right</span><span>' + U.money(p.filled || qty) + ' → ' + U.money((p.filled || qty) - p.cost, { plus: true }) + '</span></div>' +
        '<div class="faint small" style="display:block">' + esc(p.note) + '</div>';
    },

    /* ----- AI ----- */
    setAI(fn) {
      S.ai = fn;
      if (S.view === 'scanner') this.renderBrief();
      if (S.sel) this.renderAI();
    },
    readPrompt(m, asJson) {
      const ev = S.universe.events.get(m.event);
      const recent = S.sheet.candles.slice(-24).map(c => U.cents(c.c, { bare: true })).join(', ');
      const st = A.tapeStats(S.sheet.trades, 3600000 * 6);
      const body = 'You are a careful prediction-market analyst helping a trader think about ONE Kalshi event contract. Today is ' + new Date().toDateString() + '. You have no live news and no browsing: reason from the market text below, general knowledge, base rates and the price action, and say when something hinges on news you cannot see. Be calibrated: a wide range is better than false precision. The market price is already a strong estimate; only disagree with it for a stated reason.\n\n' +
        'EVENT: ' + (ev ? ev.title : m.event) + (ev && ev.category ? ' [' + ev.category + ']' : '') + (ev && ev.mutEx ? ' (one-winner event with ' + ev.markets.length + ' outcomes)' : '') + '\n' +
        'MARKET: ' + (m.yesSub || m.title) + ' (' + m.ticker + ')\n' +
        'RULES: ' + (m.rules || 'not loaded').slice(0, 2500) + (m.rules2 ? '\nSECONDARY: ' + m.rules2.slice(0, 800) : '') + '\n' +
        'CLOSES: ' + U.dateShort(m.close) + ' (in ' + U.countdown(m.close) + ')\n' +
        'PRICES (cents, YES): bid ' + U.cents(m.yb, { bare: true }) + ', ask ' + U.cents(m.ya, { bare: true }) + ', last ' + U.cents(m.last, { bare: true }) + ', a day ago ' + U.cents(m.prev, { bare: true }) + '\n' +
        'VOLUME: total ' + Math.round(m.vol) + ', 24h ' + Math.round(m.vol24) + ', open interest ' + Math.round(m.oi) + '\n' +
        (recent ? 'RECENT CLOSES (oldest→newest, cents): ' + recent + '\n' : '') +
        (st.n ? 'RECENT TAKER FLOW: ' + Math.round(st.yesQty) + ' contracts bought YES vs ' + Math.round(st.noQty) + ' bought NO\n' : '');
      if (asJson) return body + '\nReply with only a JSON object of this exact shape:\n{"probability":{"low":0.00,"mid":0.00,"high":0.00},"stance":"lean_yes"|"lean_no"|"no_edge","confidence":"low"|"medium"|"high","drivers":["up to 4 short points"],"watch_for":["up to 3 short points"],"risks":["up to 3 short points"],"verdict":"one plain sentence a trader can act on, including whether the price looks fair"}\nUse "no_edge" unless mid is clearly on one side of the ask/bid after fees (about 1.5¢).';
      return body + '\nReply briefly with: a probability range for YES (low / mid / high), whether the current price looks fair, up to four drivers, what would change your mind, the key risks, and a one-sentence verdict. Say "no edge" unless your mid is clearly past the ask or bid after fees (about 1.5¢).';
    },
    briefPrompt(ops, asJson) {
      const lines = ops.map((o, i) => { const m = S.universe.markets.get(o.tickers[0]); return (i + 1) + '. [' + KINDS[o.kind] + '] ' + o.title + ' — ' + o.headline + '. ' + o.math + (m && m.close ? ' Closes in ' + U.countdown(m.close) + '.' : ''); });
      const body = 'You are a skeptical prediction-market desk lead. Today is ' + new Date().toDateString() + '. A scanner flagged these Kalshi signals from live quotes. You have no live news. For each, say in one sentence what would make it worth acting on or why to skip it, then give an overall two-sentence brief. Prefer "skip" over "act" when the edge is small, the fill size is small, or the risk is a single bad outcome.\n\n' + lines.join('\n');
      if (asJson) return body + '\n\nReply with only JSON: {"summary":"two sentences","items":[{"n":1,"take":"one sentence","confidence":"low"|"medium"|"high","caution":"optional short caveat"}]}';
      return body + '\n\nAnswer as a numbered list matching the signals, then the two-sentence brief.';
    },
    renderAI() {
      const box = $('sh-ai'); if (!box) return;
      const m = S.universe.markets.get(S.sel); if (!m) return;
      if (!S.ai) { box.innerHTML = '<div class="row"><button class="btn sm" data-act="copyread">Copy a prompt for Claude</button><span class="faint small">This copy cannot call Claude directly; paste the prompt into a Claude chat for a calibrated read.</span></div>'; return; }
      if (S.sheet.aiBusy) { box.innerHTML = '<div class="think">Thinking… Claude is reading the rules, prices and recent history.</div><div class="row"><button class="btn sm" data-act="aistop">Stop</button></div>'; return; }
      const r = S.sheet.ai;
      if (!r) { box.innerHTML = '<div class="row"><button class="btn sm primary" data-act="airead">Ask Claude for a read</button><span class="faint small">Uses your Claude account.</span></div>'; return; }
      if (r.error) { box.innerHTML = '<div class="small down">' + esc(r.error) + '</div><div class="row"><button class="btn sm" data-act="airead">Try again</button></div>'; return; }
      const p = r.probability || {};
      const lo = U.clamp(U.num(p.low, 0), 0, 1), mid = U.clamp(U.num(p.mid, 0), 0, 1), hi = U.clamp(U.num(p.high, 0), 0, 1);
      const mkt = m.mid !== null ? m.mid : (m.last || 0.5);
      const list = (arr) => Array.isArray(arr) && arr.length ? '<ul>' + arr.slice(0, 5).map(x => '<li>' + esc(String(x)) + '</li>').join('') + '</ul>' : '';
      box.innerHTML = '<div class="row"><span class="stance ' + esc(r.stance || 'no_edge') + '">' + esc(String(r.stance || 'no_edge').replace('_', ' ')) + '</span><span class="small muted">' + esc(r.confidence || '') + ' confidence · estimate ' + U.pct(lo, 0) + '–' + U.pct(hi, 0) + ', mid ' + U.pct(mid, 0) + ' · market ' + U.cents(mkt) + '</span></div>' +
        '<div class="band"><div class="range" style="left:' + (lo * 100).toFixed(1) + '%;width:' + Math.max(0.5, (hi - lo) * 100).toFixed(1) + '%"></div><div class="mid" style="left:' + (mid * 100).toFixed(1) + '%"></div><div class="mkt" style="left:' + (mkt * 100).toFixed(1) + '%"></div><div class="lbl" style="left:' + (mid * 100).toFixed(1) + '%">Claude ' + U.pct(mid, 0) + '</div><div class="lbl" style="left:' + (mkt * 100).toFixed(1) + '%;top:-20px">market ' + U.cents(mkt) + '</div></div>' +
        (r.verdict ? '<div class="verdict">' + esc(r.verdict) + '</div>' : '') +
        (r.drivers && r.drivers.length ? '<div><div class="label" style="margin-bottom:4px">What drives it</div>' + list(r.drivers) + '</div>' : '') +
        (r.watch_for && r.watch_for.length ? '<div><div class="label" style="margin-bottom:4px">What would change the read</div>' + list(r.watch_for) + '</div>' : '') +
        (r.risks && r.risks.length ? '<div><div class="label" style="margin-bottom:4px">Risks</div>' + list(r.risks) + '</div>' : '') +
        '<div class="faint small">Reasoning from the market text, the numbers on this page and general knowledge. No live news, no guarantee. Not advice.</div>' +
        '<div class="row"><button class="btn sm" data-act="airead" data-fresh="1">Ask again</button></div>';
    },
    async aiRead(fresh) {
      const m = S.universe.markets.get(S.sel); if (!m || !S.ai) return;
      const t = S.sel;
      const prompt = this.readPrompt(m, true);
      S.sheet.aiBusy = true; S.sheet.ai = null; this.renderAI();
      const ctl = new AbortController(); S.sheet.aiCtl = ctl;
      try {
        const data = await S.ai.json(prompt, { signal: ctl.signal, modelTier: 'default', cache: fresh ? false : true });
        if (S.sel !== t) return;
        S.sheet.ai = (data && typeof data === 'object') ? data : { error: 'Claude did not return a usable read.' };
      } catch (e) {
        if (S.sel !== t) return;
        const code = e && e.code;
        if (code === 'cancelled') S.sheet.ai = null;
        else if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled') { this.setAI(null); return; }
        else S.sheet.ai = { error: code === 'rate_limited' ? 'Claude is busy or your usage limit is reached. Try again in a bit.' : code === 'invalid_json' ? 'Claude answered in prose instead of data. Try again.' : code === 'refused' ? 'Claude declined to read this one.' : 'Could not reach Claude (' + esc(code || 'error') + ').' };
      } finally { if (S.sel === t) { S.sheet.aiBusy = false; this.renderAI(); } }
    },
    async aiBrief() {
      if (!S.ai) return;
      const ops = this.briefOps();
      if (!ops.length) { this.toast('Nothing to brief yet'); return; }
      const prompt = this.briefPrompt(ops, true);
      S.scanner.briefBusy = true; this.renderBrief();
      const ctl = new AbortController(); S.scanner.briefCtl = ctl;
      try {
        const data = await S.ai.json(prompt, { signal: ctl.signal, modelTier: 'default', cache: false });
        const items = Array.isArray(data && data.items) ? data.items.map(it => { const o = ops[U.num(it.n, 0) - 1]; return o ? { key: this.opKey(o), take: String(it.take || ''), confidence: String(it.confidence || ''), caution: it.caution ? String(it.caution) : '' } : null; }).filter(Boolean) : [];
        S.scanner.brief = { at: Date.now(), summary: String((data && data.summary) || ''), items: items };
      } catch (e) {
        const code = e && e.code;
        if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled') { this.setAI(null); return; }
        if (code !== 'cancelled') this.toast('Claude could not brief the scan (' + (code || 'error') + ')');
      } finally { S.scanner.briefBusy = false; this.renderScanner(); }
    },

    /* ----- setup ----- */
    renderSetup() {
      const s = S.settings;
      const conn = $('setup-conn');
      const relay = (s.relayUrl || '').trim();
      const statusLine = S.mode === 'live' ? '<span class="dot live"></span> Live through ' + (S.source === 'relay' ? (S.sameOrigin ? 'this site\'s built-in relay' : 'your relay at ' + esc(Engine.relayLabel())) : 'a direct connection') + (s.env === 'demo' ? ' (demo exchange)' : '') : '<span class="dot sim"></span> Simulated data' + (S.health.lastErr && S.ctx !== 'artifact' ? ' · last error: ' + esc(S.health.lastErr) : '');
      const recipe = '<ol class="steps"><li>Create a free Cloudflare account, then open <b>Workers &amp; Pages → Create → Start with Hello World</b> and give the worker a name such as <code>edge-desk</code>.</li><li>Replace the editor contents with the <code>edge-desk.worker.js</code> file from this chat and tap <b>Deploy</b>. (From a terminal, <code>npx wrangler deploy</code> next to the included <code>wrangler.toml</code> does the same.)</li><li>Open the worker\'s URL, which looks like <code>https://edge-desk.yourname.workers.dev</code>. That page is this app with live Kalshi quotes, on any device. Optional: a worker variable named <code>RELAY_KEY</code> locks the relay to copies that know the key.</li></ol>';
      let guide = '';
      if (S.ctx === 'artifact') guide = '<div style="margin-top:12px"><p class="small" style="margin:0 0 10px"><b>Why this copy is simulated.</b> Pages inside Claude cannot call outside APIs, and Kalshi\'s API refuses browser requests anyway (no CORS headers). The live version is the same app served from your own free Cloudflare Worker, which also relays Kalshi\'s public, read-only market data. It never holds an API key and cannot trade.</p>' + recipe + '</div>';
      else if (S.mode !== 'live' && !relay) guide = '<div style="margin-top:12px"><p class="small" style="margin:0 0 10px"><b>Go live in about two minutes.</b> Kalshi\'s API refuses requests that carry a browser Origin, so Edge Desk reads through a tiny relay that strips it, adds CORS headers and caches responses for a few seconds. The relay only forwards public read-only market data.</p>' + recipe + '<p class="small" style="margin:10px 0 0">Prefer to keep using this file? Paste the worker URL into the Relay URL field below and tap <b>Reconnect</b>.</p></div>';
      conn.innerHTML = '<div class="card" style="margin-bottom:16px"><div class="row" style="justify-content:space-between"><div class="row">' + statusLine + '</div><div class="row">' + (S.ctx === 'artifact' ? '' : '<button class="btn sm" data-act="testconn">Test connection</button>') + '<button class="btn sm primary" data-act="reconnect">Reconnect</button></div></div><div id="conn-result" class="small" style="margin-top:8px"></div>' + guide + '</div>';
      const field = (id, labelTxt, inputHtml, help) => '<div class="field"><label for="' + id + '">' + labelTxt + '</label>' + inputHtml + (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
      const sel = (id, val, opts) => '<select class="sel" id="' + id + '" data-set="' + id + '">' + opts.map(o => '<option value="' + o[0] + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
      const inp = (id, val, attrs) => '<input class="inp" id="' + id + '" data-set="' + id + '" value="' + esc(val) + '" ' + (attrs || '') + '>';
      const sourceFields = S.ctx === 'artifact' ? '' :
        '<h3 class="label">Data source</h3>' +
        field('relayUrl', 'Relay URL', inp('relayUrl', s.relayUrl, 'type="url" placeholder="https://edge-desk.yourname.workers.dev" autocomplete="off" spellcheck="false"'), S.ctx === 'hosted' ? 'Leave empty when this page is served by the worker; it relays on its own address.' : 'Leave empty to try a direct connection (blocked by Kalshi today) and fall back to simulated data.') +
        '<div class="field-row">' + field('relayKey', 'Relay key (optional)', inp('relayKey', s.relayKey, 'type="password" autocomplete="off"'), 'Must match RELAY_KEY on the worker.') + field('env', 'Exchange', sel('env', s.env, [['prod', 'Production (real markets)'], ['demo', 'Demo exchange']]), 'The demo exchange has sparse, fake markets; useful for testing.') + '</div>' +
        field('dataMode', 'Mode', sel('dataMode', s.dataMode, [['auto', 'Auto (relay, then direct, then simulated)'], ['relay', 'Relay only'], ['direct', 'Direct only'], ['sim', 'Simulated data']]), '');
      $('setup-form').innerHTML = sourceFields +
        '<h3 class="label" style="margin-top:8px">Polling</h3>' +
        '<div class="field-row">' + field('pollTape', 'Tape every (s)', inp('pollTape', s.pollTape, 'type="number" min="2" max="60"'), '') + field('pollMarkets', 'Watched markets every (s)', inp('pollMarkets', s.pollMarkets, 'type="number" min="5" max="120"'), '') + '</div>' +
        '<div class="field-row">' + field('pollBook', 'Open market book every (s)', inp('pollBook', s.pollBook, 'type="number" min="2" max="60"'), '') + field('universePages', 'Universe pages', inp('universePages', s.universePages, 'type="number" min="1" max="60"'), 'Each page is 200 events with all their markets (a few MB). More pages widen the scan and slow the first load; pages render as they arrive.') + '</div>' +
        field('universeRefreshMin', 'Reload universe every (min)', inp('universeRefreshMin', s.universeRefreshMin, 'type="number" min="2" max="120"'), 'Watched markets, positions and scanner hits refresh far more often than this.') +
        '<h3 class="label" style="margin-top:8px">Fees and sizing</h3>' +
        '<div class="field-row">' + field('rounding', 'Fee rounding', sel('rounding', s.rounding, [['centicent', 'Centicent ($0.0001, direct Kalshi accounts)'], ['cent', 'Whole cent (brokerage / FCM accounts)']]), '') + field('takerRate', 'Taker rate', inp('takerRate', s.takerRate, 'type="number" step="0.005" min="0" max="0.2"'), 'Kalshi\'s schedule: 0.07 × contracts × P × (1−P), rounded up. Series multipliers are read from the API.') + '</div>' +
        '<div class="field-row">' + field('kelly', 'Kelly fraction', sel('kelly', s.kelly, [['1', 'Full'], ['0.5', 'Half'], ['0.25', 'Quarter'], ['0.1', 'Tenth']]), '') + field('minSpread', 'Flag spreads from (¢)', inp('minSpread', Math.round(s.minSpread * 100), 'type="number" min="2" max="40"'), '') + '</div>' +
        field('minArbAnn', 'Book arbitrage: minimum annualized return (%)', inp('minArbAnn', Math.round((s.minArbAnn === undefined ? 0.08 : s.minArbAnn) * 100), 'type="number" min="0" max="500"'), 'Locked books that settle within 45 days are always shown; longer-dated ones only when the margin, annualized over the time to settlement, clears this. Buy-the-book arbs are shown only when the legs are exhaustive (a catch-all leg, or buckets with open ends).') +
        field('bigPrint', 'Big print threshold (contracts)', inp('bigPrint', s.bigPrint, 'type="number" min="50" step="50"'), 'Prints at or above this size are highlighted on the tape.') +
        '<h3 class="label" style="margin-top:8px">Storage</h3>' +
        '<p class="small muted" style="margin:0">' + (Persist.cloud ? 'Your watchlist, paper desk and settings are saved to your Claude account and follow you across devices.' : 'Saved in this browser only. Open this page from the Claude app to sync across devices.') + '</p>' +
        '<div class="field"><label for="import-box">Import a desk export</label><textarea class="inp" id="import-box" rows="3" placeholder="Paste an export here"></textarea><div class="row"><button class="btn sm" data-act="import">Import</button></div></div>' +
        '<div class="disclaimer">Edge Desk is an independent analysis tool and is not affiliated with Kalshi. It shows public market data and simulated paper trades. Nothing here is investment advice; event contracts can lose the entire amount risked.</div>';
    },
    applySetting(id, value) {
      const s = S.settings;
      const nums = ['pollTape', 'pollMarkets', 'pollBook', 'universePages', 'universeRefreshMin', 'takerRate', 'bigPrint'];
      if (nums.includes(id)) { const n = U.num(value); if (n === null) return; s[id] = n; }
      else if (id === 'minSpread') { const n = U.num(value); if (n === null) return; s.minSpread = n / 100; }
      else if (id === 'minArbAnn') { const n = U.num(value); if (n === null) return; s.minArbAnn = Math.max(0, n) / 100; }
      else if (id === 'kelly') s.kelly = U.num(value, 0.25);
      else if (id === 'slim') s.slim = value === '1';
      else s[id] = value;
      Persist.save();
      if (id === 'minSpread' || id === 'takerRate' || id === 'rounding' || id === 'minArbAnn') Scanner.run();
    },
    async testConnection() {
      const box = $('conn-result'); if (!box) return;
      box.textContent = 'Testing…';
      const r = await Engine.testConnection();
      const line = (name, x) => x === null ? '' : '<div>' + name + ': ' + (x.ok ? '<span class="up">OK</span> · exchange ' + (x.st && x.st.trading_active ? 'open' : 'closed or paused') : '<span class="down">failed</span> · ' + esc(x.msg)) + '</div>';
      box.innerHTML = line('Relay', r.relay) + line('This site', r.same) + line('Direct', r.direct) + (!(r.relay && r.relay.ok) && !(r.same && r.same.ok) && !(r.direct && r.direct.ok) ? '<div class="muted">A direct connection is expected to fail; deploy the worker above.</div>' : '');
    }
  };

  /* ---------- actions ---------- */
  function openTicket(ticker, side, type, price, qty) {
    const prefill = () => { const t = S.sheet.ticket; if (side) t.side = side; if (type) t.type = type; if (price) t.price = U.num(price, t.price); if (qty) t.qty = Math.max(1, U.num(qty, t.qty)); UI.renderTicket(); const el = $('sh-ticket'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    if (S.sel === ticker && !$('sheet').hidden) prefill();
    else Engine.openMarket(ticker).then(() => { if (S.sel === ticker) prefill(); });
  }
  function placeOrder() {
    const m = S.universe.markets.get(S.sel); if (!m) return;
    const t = S.sheet.ticket;
    const qty = U.num(($('tk-qty') || {}).value, t.qty);
    const price = t.type === 'limit' ? U.num(($('tk-price') || {}).value, Math.round(t.price * 100)) / 100 : null;
    const r = Desk.buy(m, t.side, qty, t.type, price, S.sheet.book);
    UI.toast(r.msg);
    if (r.ok) { UI.onDesk(); UI.renderTicketPreview(); }
  }
  function paperSet(idx, n) {
    const o = S.scanner.ops[idx]; if (!o || o.kind !== 'arb') return;
    let placed = 0;
    for (const t of o.tickers) { const m = S.universe.markets.get(t); if (!m) continue; const r = Desk.buy(m, o.sub === 'no' ? 'no' : 'yes', n, 'market', null, null); if (r.ok) placed++; else { UI.toast(r.msg); break; } }
    if (placed) UI.toast('Paper: bought ' + o.sub.toUpperCase() + ' on ' + placed + ' of ' + o.tickers.length + ' legs, ' + n + ' each');
    UI.onDesk();
  }
  function copyText(text, doneMsg) {
    const done = () => UI.toast(doneMsg || ('Copied ' + (text.length > 40 ? text.slice(0, 40) + '…' : text)));
    try { navigator.clipboard.writeText(text).then(done, () => fallback()); } catch (e) { fallback(); }
    function fallback() { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { UI.toast('Select and copy: ' + text); } ta.remove(); }
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (el.tagName === 'A' && act !== 'none') ev.preventDefault();
    if (act === 'nav') { UI.nav(el.dataset.v); return; }
    if (act === 'open') { ev.stopPropagation(); Engine.openMarket(el.dataset.t); return; }
    if (act === 'ticket') { ev.stopPropagation(); openTicket(el.dataset.t, el.dataset.side, el.dataset.type, el.dataset.price, el.dataset.qty); return; }
    if (act === 'watch') { ev.stopPropagation(); const t = el.dataset.t; if (S.watch.has(t)) { S.watch.delete(t); UI.toast('Removed from watchlist'); } else { S.watch.add(t); UI.toast('Watching ' + t); } Persist.save(); UI.render(); if (S.sel) UI.renderSheet(); return; }
    if (act === 'skind') { S.scanner.kind = el.dataset.k; UI.renderScanner(); return; }
    if (act === 'mcat') { UI.mk.cat = el.dataset.c; UI.mk.limit = 80; UI.renderMarkets(); return; }
    if (act === 'mmore') { UI.mk.limit += 120; UI.renderMarkets(); return; }
    if (act === 'range') { S.sheet.range = el.dataset.r; UI.renderSheet(); Engine.loadCandles(); return; }
    if (act === 'tside') { S.sheet.ticket.side = el.dataset.s; S.sheet.ticket.price = null; UI.renderTicket(); return; }
    if (act === 'ttype') { S.sheet.ticket.type = el.dataset.s; UI.renderTicket(); return; }
    if (act === 'place') { placeOrder(); return; }
    if (act === 'paperset') { paperSet(U.num(el.dataset.i, -1), U.num(el.dataset.n, 1)); return; }
    if (act === 'sell') { const r = Desk.sell(el.dataset.k); UI.toast(r.msg); UI.onDesk(); return; }
    if (act === 'cancel') { Desk.cancel(el.dataset.id); UI.onDesk(); return; }
    if (act === 'reset1') { $('desk-reset-confirm').innerHTML = '<button class="btn sm danger" data-act="reset2">Confirm reset</button>'; return; }
    if (act === 'reset2') { const b = U.num(($('desk-bankroll') || {}).value, S.desk.start) || 1000; Desk.reset(b); UI.toast('Paper account reset to ' + U.money(b)); return; }
    if (act === 'export') { const box = $('desk-export'); box.innerHTML = '<textarea class="inp" rows="4" readonly id="export-box">' + esc(JSON.stringify(Persist.snapshot())) + '</textarea><div class="row" style="margin-top:6px"><button class="btn sm" data-act="copyexport">Copy export</button></div>'; return; }
    if (act === 'copyexport') { copyText($('export-box').value); return; }
    if (act === 'import') { try { const data = JSON.parse($('import-box').value); Persist.apply(data); Persist.save(); UI.toast('Imported'); UI.render(); } catch (e) { UI.toast('That is not a valid export'); } return; }
    if (act === 'copy') { copyText(el.dataset.text); return; }
    if (act === 'airead') { UI.aiRead(!!el.dataset.fresh); return; }
    if (act === 'copyread') { const m = S.universe.markets.get(S.sel); if (m) copyText(UI.readPrompt(m, false), 'Prompt copied. Paste it into a Claude chat.'); return; }
    if (act === 'copybrief') { const ops = UI.briefOps(); if (ops.length) copyText(UI.briefPrompt(ops, false), 'Prompt copied. Paste it into a Claude chat.'); return; }
    if (act === 'aistop') { if (S.sheet.aiCtl) S.sheet.aiCtl.abort(); return; }
    if (act === 'brief') { UI.aiBrief(); return; }
    if (act === 'briefstop') { if (S.scanner.briefCtl) S.scanner.briefCtl.abort(); return; }
    if (act === 'testconn') { UI.testConnection(); return; }
    if (act === 'reconnect') { Engine.stop(); S.mode = 'boot'; S.source = 'none'; S.health.lastErr = ''; S.health.errors = 0; S.blocked = {}; S.universe = { events: new Map(), markets: new Map(), loadedAt: 0, pages: 0, loading: false }; S.tape = { trades: [], seen: new Set(), lastTs: 0, paused: S.tape.paused }; S.scanner.ops = []; S.scanner.brief = null; UI.closeSheet(); Engine.boot().then(() => UI.renderSetup()); return; }
  });
  document.querySelectorAll('#nav button[data-nav]').forEach(b => b.addEventListener('click', () => UI.nav(b.dataset.nav)));
  $('sh-close').addEventListener('click', () => UI.closeSheet());
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('sheet').hidden) UI.closeSheet(); });
  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || !el.id) return;
    if (el.id === 'mk-search') { UI.mk.search = el.value; UI.mk.limit = 80; UI.renderMarkets(); }
    else if (el.id === 'tape-filter') { UI.tp.filter = el.value; UI.renderTape(); }
    else if (el.id === 'calc-q') { S.sheet.calcQ = U.num(el.value, 50); UI.renderCalcOut(); }
    else if (el.id === 'calc-bank' || el.id === 'calc-kelly') { if (el.id === 'calc-bank') S.settings.bankroll = U.num(el.value, S.settings.bankroll); UI.renderCalcOut(); }
    else if (el.id === 'tk-qty' || el.id === 'tk-price') { if (el.id === 'tk-qty') S.sheet.ticket.qty = U.num(el.value, S.sheet.ticket.qty); if (el.id === 'tk-price') S.sheet.ticket.price = U.num(el.value, 50) / 100; UI.renderTicketPreview(); }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || !el.id) return;
    if (el.dataset && el.dataset.set) { UI.applySetting(el.dataset.set, el.value); return; }
    if (el.id === 'mk-sort') { UI.mk.sort = el.value; UI.renderMarkets(); }
    else if (el.id === 'mk-watch-only') { UI.mk.watchOnly = el.checked; UI.renderMarkets(); }
    else if (el.id === 'tape-min') { UI.tp.min = U.num(el.value, 0); UI.renderTape(); }
    else if (el.id === 'tape-pause') { S.tape.paused = el.checked; }
    else if (el.id === 'calc-kelly') { S.settings.kelly = U.num(el.value, 0.25); Persist.save(); UI.renderCalcOut(); }
    else if (el.id === 'desk-bankroll') { /* applied on reset */ }
  });
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (VIEWS.includes(v) && v !== S.view) UI.nav(v, false); });
  window.addEventListener('resize', U.debounce(() => { if (S.sel && !$('sheet').hidden) { UI.renderChart(); UI.renderSheetLive(); } if (S.view === 'desk') Chart.spark($('desk-equity'), $('desk-equity-tip'), S.desk.equity); }, 200));
  const themeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onTheme = () => { if (S.sel && !$('sheet').hidden) { UI.renderChart(); UI.renderSheetLive(); } if (S.view === 'desk') UI.renderDesk(); };
  if (themeMq && themeMq.addEventListener) themeMq.addEventListener('change', onTheme);
  if (window.MutationObserver) new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.mode !== 'boot') { Engine.refreshTracked().catch(noteError); Engine.pollTape().catch(noteError); } });

  /* ---------- boot ---------- */
  (async function boot() {
    Persist.apply(Persist.loadLocal());
    if (!S.desk) S.desk = window.EDApp.newDesk(S.settings.bankroll);
    const v = location.hash.replace('#', '');
    UI.nav(VIEWS.includes(v) ? v : 'scanner', false);
    UI.renderStatus();
    Engine.boot();
    // capabilities arrive later; light features up when they do
    Persist.initCloud().then(cloud => {
      if (cloud === null) return;
      const local = Persist.loadLocal();
      if (cloud && cloud.v && (!local || (cloud.updatedAt || 0) > (local.updatedAt || 0))) { Persist.apply(cloud); UI.render(); if (S.sel) UI.renderSheet(); }
      else Persist.flush(Persist.snapshot());
      if (S.view === 'setup') UI.renderSetup();
    });
    if (window.claude && typeof window.claude.use === 'function') {
      window.claude.use('sample').then(fn => { if (fn) UI.setAI(fn); }).catch(() => { /* unavailable */ });
    }
  })();
})();
