/* Edge Desk app, part 1: state, persistence, data sources, polling engine, paper desk, charts. */
(function () {
  'use strict';
  const { U, N, F, A, SIM } = window.ED;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const isMobile = () => window.innerWidth < 980;

  /* ---------- state ---------- */
  const DEFAULTS = {
    relayUrl: '', relayKey: '', env: 'prod', dataMode: 'auto', slim: false,
    pollTape: 4, pollMarkets: 10, pollBook: 3, universePages: isMobile() ? 4 : 8, universeRefreshMin: 15,
    bankroll: 1000, kelly: 0.25, rounding: 'centicent', takerRate: 0.07, minSpread: 0.04, minArbAnn: 0.08, bigPrint: 500
  };
  // Where is this page running? Inside the Claude artifact viewer (outside network blocked), self-hosted on the
  // Edge Desk worker (same-origin relay), or opened as a plain file.
  const CTX = (window.claude && typeof window.claude.use === 'function') ? 'artifact' : (location.protocol === 'file:' ? 'file' : 'hosted');
  const S = window.EDS = {
    ctx: CTX,
    sameOrigin: false,       // true when this page's own origin relays Kalshi (worker deployment)
    settings: Object.assign({}, DEFAULTS),
    mode: 'boot',            // boot | live | sim
    source: 'none',          // relay | direct | sim
    health: { status: 'idle', text: 'Starting', lastOk: 0, lastErr: '', exchange: null, errors: 0 },
    blocked: {},             // endpoint family → true when the public API answered 401/403 (needs auth)
    universe: { events: new Map(), markets: new Map(), loadedAt: 0, pages: 0, loading: false },
    extras: new Set(),       // tickers fetched individually (kept across universe reloads)
    tape: { trades: [], seen: new Set(), lastTs: 0, paused: false },
    scanner: { ops: [], kind: 'all', at: 0, brief: null },
    watch: new Set(),
    desk: null,
    seriesCache: {},
    view: 'scanner',
    sel: null,
    sheet: { book: null, trades: [], candles: [], range: '1W', candlesAt: 0, ai: null, aiBusy: false, calcQ: null, ticket: { side: 'yes', type: 'market', qty: 10, price: null } },
    ai: null,                // sample() or null
    sim: null,
    timers: {},
    flash: new Map()
  };

  /* ---------- persistence (db capability per viewer, localStorage fallback) ---------- */
  const Persist = {
    key: 'edgedesk.v1', docRef: null, cloud: false, saving: false, pending: false,
    loadLocal() { try { const raw = localStorage.getItem(this.key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } },
    saveLocal(data) { try { localStorage.setItem(this.key, JSON.stringify(data)); } catch (e) { /* storage unavailable */ } },
    snapshot() {
      return { v: 1, updatedAt: Date.now(), settings: S.settings, desk: S.desk, watch: Array.from(S.watch), seriesCache: S.seriesCache };
    },
    apply(data) {
      if (!data) return;
      if (data.settings) S.settings = Object.assign({}, DEFAULTS, data.settings);
      if (data.desk) S.desk = normalizeDesk(data.desk);
      if (Array.isArray(data.watch)) S.watch = new Set(data.watch);
      if (data.seriesCache) S.seriesCache = Object.assign({}, data.seriesCache, S.seriesCache);
    },
    save: null,
    async initCloud() {
      if (!window.claude || typeof window.claude.use !== 'function') return null;
      try {
        const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
        if (!db || !user) return null;
        const id = await user.id();
        if (!id) return null;
        this.docRef = db.doc('data/users/' + id + '/desk');
        const snap = await this.docRef.get();
        this.cloud = true;
        return snap.exists ? snap.data() : {};
      } catch (e) { return null; }
    },
    async flush(data) {
      if (!this.docRef) return;
      if (this.saving) { this.pending = true; return; }
      this.saving = true;
      try { await this.docRef.set(data); } catch (e) { /* keep local copy */ }
      this.saving = false;
      if (this.pending) { this.pending = false; this.flush(this.snapshot()); }
    }
  };
  Persist.save = U.debounce(function () {
    const snap = Persist.snapshot();
    Persist.saveLocal(snap);
    Persist.flush(snap);
  }, 1200);

  function normalizeDesk(d) {
    const base = newDesk(S.settings.bankroll);
    if (!d) return base;
    return {
      cash: U.num(d.cash, base.cash), start: U.num(d.start, base.start), realized: U.num(d.realized, 0), fees: U.num(d.fees, 0),
      positions: d.positions && typeof d.positions === 'object' ? d.positions : {},
      orders: Array.isArray(d.orders) ? d.orders : [],
      fills: Array.isArray(d.fills) ? d.fills.slice(0, 300) : [],
      equity: Array.isArray(d.equity) ? d.equity.slice(-400) : [],
      createdAt: d.createdAt || Date.now()
    };
  }
  function newDesk(bankroll) {
    return { cash: bankroll, start: bankroll, realized: 0, fees: 0, positions: {}, orders: [], fills: [], equity: [], createdAt: Date.now() };
  }

  /* ---------- API (live) ---------- */
  const API = {
    PROD: 'https://api.elections.kalshi.com/trade-api/v2',
    DEMO: 'https://demo-api.kalshi.co/trade-api/v2',
    bucket: { tokens: 10, cap: 10, rate: 5, t: Date.now() },
    relayRoot(opts) {
      if (opts && opts.direct) return '';
      const relay = (S.settings.relayUrl || '').trim().replace(/\/+$/, '');
      if (relay) return relay;
      if ((S.sameOrigin || (opts && opts.sameOrigin)) && /^https?:$/.test(location.protocol)) return location.origin;
      // A relay key without a relay URL means "this site's own relay, with a key"
      if ((S.settings.relayKey || '').trim() && S.ctx === 'hosted' && /^https?:$/.test(location.protocol)) return location.origin;
      return '';
    },
    base(opts) {
      const root = this.relayRoot(opts);
      if (root) return root + (S.settings.env === 'demo' ? '/demo' : '') + '/trade-api/v2';
      return S.settings.env === 'demo' ? this.DEMO : this.PROD;
    },
    url(path, params, opts) {
      const u = new URL(this.base(opts) + path);
      for (const k in (params || {})) { const v = params[k]; if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v)); }
      if (this.relayRoot(opts)) {
        if (S.settings.relayKey) u.searchParams.set('k', S.settings.relayKey);
        if (opts && opts.slim && S.settings.slim) u.searchParams.set('slim', '1');
      }
      return u.toString();
    },
    async take() {
      const b = this.bucket, now = Date.now();
      b.tokens = Math.min(b.cap, b.tokens + (now - b.t) / 1000 * b.rate); b.t = now;
      if (b.tokens >= 1) { b.tokens -= 1; return; }
      const wait = (1 - b.tokens) / b.rate * 1000;
      await sleep(wait); b.tokens = 0; b.t = Date.now();
    },
    async get(path, params, opts) {
      opts = opts || {};
      await this.take();
      const url = this.url(path, params, opts);
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), opts.timeout || 15000);
        try {
          const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(to);
          if (res.status === 429) { lastErr = err('rate', 'Rate limited by the API', 429); await sleep(700 * Math.pow(2, attempt) + Math.random() * 400); continue; }
          if (!res.ok) {
            let detail = '';
            try { const j = await res.json(); detail = (j && (j.message || j.error)) ? String(j.message || j.error) : ''; } catch (e) { /* no body */ }
            throw err('http', 'HTTP ' + res.status + (detail ? ' · ' + detail : ''), res.status);
          }
          const data = await res.json();
          S.health.lastOk = Date.now(); S.health.errors = 0;
          return data;
        } catch (e) {
          clearTimeout(to);
          if (e && e.kind) { if (e.kind === 'rate') { lastErr = e; continue; } throw e; }
          if (e && e.name === 'AbortError') throw err('timeout', 'The request timed out');
          throw err('network', 'Browser could not reach the API (blocked, offline, or no CORS headers)');
        }
      }
      throw lastErr || err('rate', 'Rate limited');
    }
  };
  function err(kind, message, status) { const e = new Error(message); e.kind = kind; e.status = status; return e; }
  function isAuthErr(e) { return !!(e && (e.status === 401 || e.status === 403 || e.kind === 'auth')); }

  /* ---------- data source abstraction ---------- */
  const DS = {
    isSim() { return S.mode === 'sim'; },
    async status() {
      if (this.isSim()) return S.sim.status;
      return API.get('/exchange/status', {}, { timeout: 8000 });
    },
    async eventsPage(cursor) {
      if (this.isSim()) {
        const events = Array.from(S.sim.events.values()).map(e => Object.assign({}, e, { _markets: e.markets.map(t => S.sim.markets.get(t)) }));
        return { events: events, cursor: '' };
      }
      return API.get('/events', { status: 'open', with_nested_markets: true, limit: 200, cursor: cursor || undefined }, { slim: true });
    },
    async marketsByTickers(tickers) {
      if (this.isSim()) return tickers.map(t => S.sim.markets.get(t)).filter(Boolean).map(m => Object.assign({}, m));
      const res = await API.get('/markets', { tickers: tickers.join(','), limit: 100 }, { slim: true });
      return (res.markets || []).map(m => N.market(m, S.universe.events.get(m.event_ticker))).filter(Boolean);
    },
    async market(ticker) {
      if (this.isSim()) { const m = S.sim.markets.get(ticker); return m ? Object.assign({}, m) : null; }
      const res = await API.get('/markets/' + encodeURIComponent(ticker));
      const raw = res.market || res;
      return N.market(raw, S.universe.events.get(raw.event_ticker));
    },
    async event(ticker) {
      if (this.isSim()) return S.sim.events.get(ticker) || null;
      const res = await API.get('/events/' + encodeURIComponent(ticker), {}, { slim: true });
      const ne = N.event(res.event || res);
      if (ne && res.markets && !ne.markets.length) ne.markets = res.markets.map(m => m.ticker);
      return ne;
    },
    async book(ticker) {
      if (this.isSim()) return S.sim.book(ticker);
      return N.book(await API.get('/markets/' + encodeURIComponent(ticker) + '/orderbook', { depth: 30 }));
    },
    async trades(params) {
      if (this.isSim()) return S.sim.trades(3 + Math.floor(Math.random() * 10));
      const res = await API.get('/markets/trades', params);
      return (res.trades || []).map(N.trade).filter(Boolean);
    },
    async marketTrades(ticker) {
      if (this.isSim()) return S.sim.marketTrades(ticker, 24);
      const res = await API.get('/markets/trades', { ticker: ticker, limit: 40 });
      return (res.trades || []).map(N.trade).filter(Boolean);
    },
    async tradeHistory(ticker, sinceMs) {
      if (this.isSim()) return S.sim.marketTrades(ticker, 200);
      const out = [];
      let cursor = '';
      for (let p = 0; p < 3; p++) {
        const res = await API.get('/markets/trades', { ticker: ticker, limit: 1000, min_ts: Math.floor(sinceMs / 1000), cursor: cursor || undefined });
        for (const t of (res.trades || [])) { const nt = N.trade(t); if (nt) out.push(nt); }
        cursor = res.cursor || '';
        if (!cursor || !(res.trades || []).length) break;
      }
      return out;
    },
    async candles(m, period, startMs, endMs) {
      if (this.isSim()) return S.sim.candles(m.ticker, period, startMs);
      const start = Math.floor(startMs / 1000), end = Math.ceil(endMs / 1000);
      try {
        const res = await API.get('/markets/candlesticks', { market_tickers: m.ticker, period_interval: period, start_ts: start, end_ts: end });
        const entry = (res.markets || [])[0];
        if (entry) return N.candles(entry.candlesticks);
        if (res.candlesticks) return N.candles(res.candlesticks);
      } catch (e) { /* fall through to the series-scoped endpoint */ }
      const res2 = await API.get('/series/' + encodeURIComponent(m.series) + '/markets/' + encodeURIComponent(m.ticker) + '/candlesticks', { period_interval: period, start_ts: start, end_ts: end });
      return N.candles(res2.candlesticks);
    },
    async series(ticker) {
      if (this.isSim()) return S.sim.seriesFees[ticker] || { fee_type: 'quadratic', fee_multiplier: 1 };
      const res = await API.get('/series/' + encodeURIComponent(ticker));
      const s = res.series || res;
      return { fee_type: s.fee_type || 'quadratic', fee_multiplier: U.num(s.fee_multiplier, 1), title: s.title || '', category: s.category || '', at: Date.now() };
    }
  };

  /* ---------- engine ---------- */
  const Engine = {
    async boot() {
      setHealth('idle', 'Connecting');
      const mode = S.settings.dataMode;
      const relay = (S.settings.relayUrl || '').trim();
      let ok = false, how = '';
      S.sameOrigin = false;
      if (mode === 'sim') { this.useSim('Simulated data selected in Setup'); return; }
      if (S.ctx === 'artifact') { this.useSim('This copy runs inside Claude, which blocks outside network calls'); return; }
      if (relay && mode !== 'direct') {
        try { S.health.exchange = await API.get('/exchange/status', {}, { timeout: 10000 }); ok = true; how = 'relay'; }
        catch (e) { S.health.lastErr = 'Relay: ' + e.message; }
      }
      let keyNeeded = false;
      if (!ok && !relay && mode !== 'direct' && S.ctx === 'hosted') {
        // the page may be served by the Edge Desk worker, which relays on the same origin
        try { S.health.exchange = await API.get('/exchange/status', {}, { timeout: 10000, sameOrigin: true }); ok = true; how = 'relay'; S.sameOrigin = true; }
        catch (e) { S.health.lastErr = 'Same-origin relay: ' + e.message; if (e.status === 401) keyNeeded = true; }
      }
      if (!ok && mode !== 'relay') {
        try { S.health.exchange = await API.get('/exchange/status', {}, { timeout: 8000, direct: true }); ok = true; how = 'direct'; }
        catch (e) { if (!S.health.lastErr) S.health.lastErr = 'Direct: ' + e.message; }
      }
      if (ok) {
        S.mode = 'live'; S.source = how;
        setHealth('live', 'Live');
        UI.renderStatus();
        this.start();
      } else {
        this.useSim(keyNeeded ? 'This site\'s relay asked for a key (RELAY_KEY is set on the Worker): paste it under Setup → Relay key, or remove the variable in Cloudflare' : relay ? 'The relay did not answer (' + (S.health.lastErr || 'no response').replace(/^Relay: /, '') + ')' : 'Kalshi blocks browser requests');
      }
    },
    useSim(reason) {
      S.mode = 'sim'; S.source = 'sim';
      S.sim = SIM.create(7);
      S.health.exchange = S.sim.status; S.health.simReason = reason;
      setHealth('sim', 'Simulated');
      UI.renderStatus();
      this.start();
    },
    start() {
      this.stop();
      this.loadUniverse().then(() => { this.loop('markets', () => this.refreshTracked(), () => S.settings.pollMarkets * 1000); });
      this.loop('tape', () => this.pollTape(), () => S.settings.pollTape * 1000);
      this.loop('universe', () => this.loadUniverse(), () => Math.max(2, S.settings.universeRefreshMin) * 60000, true);
      this.loop('sheet', () => this.pollSheet(), () => S.settings.pollBook * 1000);
      this.loop('clock', () => UI.tickClock(), () => 1000);
      if (S.mode === 'sim') this.loop('simtick', () => { S.sim.tick(); }, () => 3000);
    },
    stop() { for (const k in S.timers) clearTimeout(S.timers[k]); S.timers = {}; },
    // Relay URL (or same-origin worker) the page is using, for display
    relayLabel() { const r = (S.settings.relayUrl || '').trim(); return r ? r.replace(/^https?:\/\//, '') : (S.sameOrigin ? 'this site' : ''); },
    loop(name, fn, every, delayFirst) {
      const run = async () => {
        if (!document.hidden || name === 'clock') { try { await fn(); } catch (e) { noteError(e); } }
        S.timers[name] = setTimeout(run, every());
      };
      S.timers[name] = setTimeout(run, delayFirst ? every() : 0);
    },
    async loadUniverse() {
      if (S.universe.loading) return;
      S.universe.loading = true;
      const ev = new Map(), mk = new Map();
      let cursor = '', pages = 0;
      const max = S.mode === 'sim' ? 1 : Math.max(1, S.settings.universePages);
      const firstLoad = S.universe.markets.size === 0;
      const publish = (done) => {
        // Merge: on first load show pages as they arrive; on a refresh swap in the new set only when complete
        if (!firstLoad && !done) return;
        for (const t of S.extras) { const old = S.universe.markets.get(t); if (old && !mk.has(t)) mk.set(t, old); }
        for (const [k, e] of S.universe.events) if (!ev.has(k) && e.markets.some(t => mk.has(t))) ev.set(k, e);
        // keep fresher quotes from the tracked-refresh loop for markets that reappear
        for (const [t, nm] of mk) { const old = S.universe.markets.get(t); if (old && old.updated > nm.updated) { if (!nm.rules && old.rules) nm.rules = old.rules; if (!nm.rules2 && old.rules2) nm.rules2 = old.rules2; } }
        S.universe = { events: new Map(ev), markets: new Map(mk), loadedAt: Date.now(), pages: pages, loading: !done };
        Scanner.run();
        Desk.markAll();
        UI.onUniverse();
      };
      try {
        for (let p = 0; p < max; p++) {
          if (S.mode === 'live') setHealth('live', 'Loading markets ' + (p + 1) + '/' + max);
          const res = await DS.eventsPage(cursor);
          for (const e of (res.events || [])) {
            const ne = S.mode === 'sim' ? Object.assign({}, e, { markets: e.markets.slice() }) : N.event(e);
            if (!ne) continue;
            const rawMarkets = S.mode === 'sim' ? e._markets : (e.markets || []);
            const kept = [];
            for (const m of rawMarkets) {
              const nm = S.mode === 'sim' ? Object.assign({}, m) : N.market(m, ne);
              if (nm && nm.status === 'active') { mk.set(nm.ticker, nm); kept.push(nm.ticker); }
            }
            ne.markets = kept;
            if (S.mode === 'sim') delete ne._markets;
            ev.set(ne.ticker, ne);
          }
          pages++;
          cursor = res.cursor || '';
          if (cursor && p < max - 1) publish(false);
          if (!cursor) break;
        }
        S.universe.complete = !cursor;
        publish(true);
        if (S.mode === 'live') setHealth('live', 'Live');
      } catch (e) {
        if (pages > 0) publish(true); else S.universe.loading = false;
        noteError(e);
      }
    },
    trackedTickers() {
      const set = new Set();
      for (const t of S.watch) set.add(t);
      for (const k in S.desk.positions) set.add(S.desk.positions[k].ticker);
      for (const o of S.desk.orders) set.add(o.ticker);
      if (S.sel) set.add(S.sel);
      let n = 0;
      for (const op of S.scanner.ops) { for (const t of op.tickers) { if (n >= 60) break; set.add(t); n++; } }
      return Array.from(set).filter(t => S.universe.markets.has(t) || S.extras.has(t));
    },
    async refreshTracked() {
      const list = this.trackedTickers();
      if (!list.length) return;
      const changed = [];
      for (let i = 0; i < list.length; i += 40) {
        const chunk = list.slice(i, i + 40);
        const ms = await DS.marketsByTickers(chunk);
        for (const nm of ms) { const c = applyMarket(nm); if (c) changed.push(c); }
      }
      if (changed.length) { Scanner.run(); Desk.markAll(); UI.onPrices(changed); }
      Desk.checkOrders();
    },
    async pollTape() {
      if (S.tape.paused || S.blocked.trades) return;
      const params = { limit: 100 };
      if (S.tape.lastTs) params.min_ts = Math.max(0, Math.floor(S.tape.lastTs / 1000) - 2);
      let list;
      try { list = await DS.trades(params); }
      catch (e) { if (isAuthErr(e)) { S.blocked.trades = true; UI.onTape([]); return; } throw e; }
      const fresh = [];
      for (const t of list) { if (S.tape.seen.has(t.id)) continue; S.tape.seen.add(t.id); fresh.push(t); }
      if (!fresh.length) return;
      fresh.sort((a, b) => b.t - a.t);
      S.tape.trades = fresh.concat(S.tape.trades).slice(0, 600);
      S.tape.lastTs = Math.max(S.tape.lastTs || 0, fresh[0].t);
      if (S.tape.seen.size > 8000) { S.tape.seen = new Set(S.tape.trades.map(t => t.id)); }
      for (const t of fresh) { const m = S.universe.markets.get(t.ticker); if (m && t.yes !== null) { m.last = t.yes; m.updated = t.t; } }
      UI.onTape(fresh);
    },
    async pollSheet() {
      if (!S.sel || $('sheet').hidden) return;
      const m = S.universe.markets.get(S.sel);
      if (!m) return;
      const cyc = (S.sheet.cycle = (S.sheet.cycle || 0) + 1);
      if (!S.blocked.book) {
        try { const book = await DS.book(m.ticker); if (S.sel !== m.ticker) return; S.sheet.book = book; }
        catch (e) { if (isAuthErr(e)) { S.blocked.book = true; S.sheet.book = null; } else throw e; }
      }
      if (cyc % 2 === 0) {
        const [nm, trades] = await Promise.all([DS.market(m.ticker), DS.marketTrades(m.ticker).catch(e => { if (isAuthErr(e)) { S.blocked.trades = true; return S.sheet.trades; } throw e; })]);
        if (S.sel !== m.ticker) return;
        if (nm) { nm.rules = nm.rules || m.rules; nm.rules2 = nm.rules2 || m.rules2; const c = applyMarket(nm); if (c) UI.onPrices([c]); }
        S.sheet.trades = trades;
      }
      if (Date.now() - S.sheet.candlesAt > 120000) this.loadCandles();
      UI.renderSheetLive();
    },
    rangeSpec(m) {
      const now = Date.now();
      const r = S.sheet.range;
      let period = 60, start = now - 7 * 86400000;
      if (r === '1D') { period = 1; start = now - 86400000; }
      else if (r === '1M') { period = 60; start = now - 30 * 86400000; }
      else if (r === 'All') { period = 1440; start = (m.open || now - 180 * 86400000) - 86400000; }
      if (m.open && start < m.open - 86400000) start = m.open - 86400000;
      return { period: period, start: start, now: now };
    },
    async loadCandles() {
      const m = S.universe.markets.get(S.sel);
      if (!m) return;
      const spec = this.rangeSpec(m);
      S.sheet.candlesAt = spec.now;
      S.sheet.candleSource = '';
      try {
        if (S.blocked.candles) throw err('auth', 'candles need authentication', 401);
        const candles = await DS.candles(m, spec.period, spec.start, spec.now);
        if (S.sel !== m.ticker) return;
        S.sheet.candles = candles;
        S.sheet.candleSource = 'candles';
        UI.renderChart();
        return;
      } catch (e) {
        if (isAuthErr(e)) S.blocked.candles = true; else if (S.mode === 'live') noteError(e);
      }
      // Fallback: build a price series from the public trade history
      try {
        const trades = await DS.tradeHistory(m.ticker, spec.start);
        if (S.sel !== m.ticker) return;
        S.sheet.candles = A.candlesFromTrades(trades, spec.period === 1 ? 300000 : spec.period === 60 ? 3600000 : 86400000);
        S.sheet.candleSource = trades.length ? 'trades' : 'none';
        UI.renderChart();
      } catch (e) { if (S.sel === m.ticker) { S.sheet.candles = []; S.sheet.candleSource = 'none'; UI.renderChart(); } noteError(e); }
    },
    async openMarket(ticker) {
      let m = S.universe.markets.get(ticker);
      if (!m) {
        try {
          m = await DS.market(ticker);
          if (!m) { UI.toast('Market ' + ticker + ' not found'); return; }
          S.universe.markets.set(m.ticker, m); S.extras.add(m.ticker);
          if (!S.universe.events.has(m.event)) { try { const ev = await DS.event(m.event); if (ev) { if (!ev.markets.includes(m.ticker)) ev.markets.push(m.ticker); S.universe.events.set(ev.ticker, ev); } } catch (e) { /* optional */ } }
        } catch (e) { noteError(e); UI.toast('Could not load ' + ticker); return; }
      }
      S.sel = ticker;
      S.sheet = Object.assign(S.sheet, { book: null, trades: [], candles: [], candlesAt: 0, ai: null, aiBusy: false, calcQ: null, cycle: 0 });
      S.sheet.ticket = { side: 'yes', type: 'market', qty: 10, price: null };
      UI.openSheet();
      this.ensureSeries(m.series);
      if (!m.rules && S.mode === 'live') { DS.market(ticker).then(nm => { if (nm) { applyMarket(nm); if (S.sel === ticker) UI.renderSheet(); } }).catch(noteError); }
      // immediate data pulls
      (async () => {
        const [book, trades] = await Promise.all([
          S.blocked.book ? Promise.resolve(null) : DS.book(ticker).catch(e => { if (isAuthErr(e)) S.blocked.book = true; else noteError(e); return null; }),
          S.blocked.trades ? Promise.resolve([]) : DS.marketTrades(ticker).catch(e => { if (isAuthErr(e)) S.blocked.trades = true; else noteError(e); return []; })
        ]);
        if (S.sel !== ticker) return;
        S.sheet.book = book; S.sheet.trades = trades;
        UI.renderSheetLive();
      })();
      this.loadCandles();
    },
    async ensureSeries(series) {
      if (!series) return;
      const c = S.seriesCache[series];
      if (c && c.at && Date.now() - c.at < 86400000) return c;
      try {
        const info = await DS.series(series);
        S.seriesCache[series] = Object.assign({ at: Date.now() }, info);
        Persist.save();
        if (S.sel && S.universe.markets.get(S.sel) && S.universe.markets.get(S.sel).series === series) UI.renderSheet();
        return info;
      } catch (e) { S.seriesCache[series] = { fee_type: 'quadratic', fee_multiplier: 1, at: Date.now(), unknown: true }; return null; }
    },
    async testConnection() {
      const out = { relay: null, same: null, direct: null };
      const relay = (S.settings.relayUrl || '').trim();
      if (relay) { try { const st = await API.get('/exchange/status', {}, { timeout: 10000 }); out.relay = { ok: true, st: st }; } catch (e) { out.relay = { ok: false, msg: e.message }; } }
      if (S.ctx === 'hosted' && !relay) { try { const st = await API.get('/exchange/status', {}, { timeout: 10000, sameOrigin: true }); out.same = { ok: true, st: st }; } catch (e) { out.same = { ok: false, msg: e.message }; } }
      if (S.ctx !== 'artifact') { try { const st = await API.get('/exchange/status', {}, { timeout: 8000, direct: true }); out.direct = { ok: true, st: st }; } catch (e) { out.direct = { ok: false, msg: e.message }; } }
      return out;
    }
  };

  function applyMarket(nm) {
    if (!nm) return null;
    const old = S.universe.markets.get(nm.ticker);
    if (old) {
      // preserve fields the slim payload may lack
      if (!nm.rules && old.rules) nm.rules = old.rules;
      if (!nm.rules2 && old.rules2) nm.rules2 = old.rules2;
      if (!nm.title && old.title) nm.title = old.title;
    }
    S.universe.markets.set(nm.ticker, nm);
    if (nm.result && nm.result !== 'scalar') Desk.settle(nm.ticker, nm.result);
    if (!old) return { ticker: nm.ticker, dir: 0 };
    const a = old.mid, b = nm.mid;
    let dir = 0;
    if (a !== null && b !== null && Math.abs(b - a) > 1e-6) dir = b > a ? 1 : -1;
    const changed = dir !== 0 || old.ya !== nm.ya || old.yb !== nm.yb || old.last !== nm.last || old.vol !== nm.vol;
    return changed ? { ticker: nm.ticker, dir: dir } : null;
  }

  function setHealth(status, text) {
    S.health.status = status; S.health.text = text;
    if (window.UI) UI.renderStatus();
  }
  function noteError(e) {
    if (!e) return;
    S.health.errors = (S.health.errors || 0) + 1;
    S.health.lastErr = e.message || String(e);
    if (S.mode === 'live' && S.health.errors >= 3) setHealth('stale', 'Stale');
    if (window.console) console.warn('[Edge Desk]', e.message || e);
  }

  /* ---------- paper desk ---------- */
  const Desk = {
    feeInfo(m) { return A.feeInfoFor(m, S.universe.events.get(m.event), S.seriesCache[m.series], S.settings); },
    quote(m, side, kind) {
      // best executable price for buying `side` (ask) or selling (bid)
      if (side === 'yes') return kind === 'sell' ? (m.hasBid ? m.yb : null) : (m.hasAsk ? m.ya : null);
      return kind === 'sell' ? (m.hasAsk ? U.round(1 - m.ya, 4) : null) : (m.hasBid ? U.round(1 - m.yb, 4) : null);
    },
    preview(m, side, qty, type, limitPrice, book) {
      qty = Math.max(0, Math.floor(U.num(qty, 0)));
      const info = this.feeInfo(m);
      if (type === 'limit') {
        const price = U.clamp(U.num(limitPrice, 0), 0.01, 0.99);
        const fee = F.calc(qty, price, 'maker', info, S.settings.rounding);
        const crosses = side === 'yes' ? (m.hasAsk && price >= m.ya) : (m.hasBid && price >= U.round(1 - m.yb, 4));
        return { qty: qty, price: price, fee: fee, cost: qty * price + fee, filled: qty, crosses: crosses, kind: 'maker', note: crosses ? 'This price crosses the book; it would fill immediately as a taker.' : 'Rests until the market trades through ' + U.cents(price) + '.' };
      }
      let fill = null;
      if (book) {
        const levels = side === 'yes' ? book.yesAsks : book.noAsks;
        fill = A.fillFromBook(levels, qty);
      }
      if (!fill || fill.filled === 0) {
        const p = this.quote(m, side, 'buy');
        if (p === null) return { qty: qty, price: null, fee: 0, cost: 0, filled: 0, kind: 'taker', note: 'No offers on this side right now.' };
        fill = { filled: qty, cost: qty * p, avg: p, unfilled: 0 };
      }
      const fee = F.calc(fill.filled, fill.avg, 'taker', info, S.settings.rounding);
      return { qty: qty, price: fill.avg, fee: fee, cost: fill.cost + fee, filled: fill.filled, unfilled: fill.unfilled, kind: 'taker', note: fill.unfilled > 0 ? 'Only ' + U.compact(fill.filled) + ' contracts are offered at these levels.' : 'Fills against the live book; average price ' + U.cents(fill.avg) + '.' };
    },
    buy(m, side, qty, type, limitPrice, book) {
      const pv = this.preview(m, side, qty, type, limitPrice, book);
      if (pv.filled <= 0) return { ok: false, msg: pv.note };
      if (type === 'limit' && !pv.crosses) {
        const o = { id: U.uid(), ticker: m.ticker, side: side, price: pv.price, qty: pv.qty, createdAt: Date.now(), title: label(m) };
        S.desk.orders.push(o); Persist.save();
        return { ok: true, msg: 'Resting ' + side.toUpperCase() + ' bid for ' + pv.qty + ' at ' + U.cents(pv.price), order: o };
      }
      if (pv.cost > S.desk.cash + 1e-9) return { ok: false, msg: 'Not enough cash: needs ' + U.money(pv.cost) + ', you have ' + U.money(S.desk.cash) };
      const key = m.ticker + '|' + side;
      const pos = S.desk.positions[key] || { ticker: m.ticker, side: side, qty: 0, cost: 0, openedAt: Date.now(), title: label(m) };
      pos.qty += pv.filled; pos.cost += pv.cost; pos.title = label(m);
      S.desk.positions[key] = pos;
      S.desk.cash -= pv.cost; S.desk.fees += pv.fee;
      this.fill({ action: 'buy', ticker: m.ticker, side: side, qty: pv.filled, price: pv.price, fee: pv.fee, title: label(m) });
      this.markAll(); Persist.save();
      return { ok: true, msg: 'Bought ' + pv.filled + ' ' + side.toUpperCase() + ' at ' + U.cents(pv.price) + (pv.fee ? ' (+' + U.money(pv.fee) + ' fee)' : '') };
    },
    sell(key, qty) {
      const pos = S.desk.positions[key]; if (!pos) return { ok: false, msg: 'No position' };
      const m = S.universe.markets.get(pos.ticker); if (!m) return { ok: false, msg: 'Market not loaded' };
      qty = Math.min(pos.qty, Math.max(1, Math.floor(U.num(qty, pos.qty))));
      const px = this.quote(m, pos.side, 'sell');
      if (px === null) return { ok: false, msg: 'No bids to sell into right now' };
      const fee = F.calc(qty, px, 'taker', this.feeInfo(m), S.settings.rounding);
      const proceeds = qty * px - fee;
      const basis = pos.cost * (qty / pos.qty);
      pos.qty -= qty; pos.cost -= basis;
      if (pos.qty <= 0) delete S.desk.positions[key];
      S.desk.cash += proceeds; S.desk.realized += proceeds - basis; S.desk.fees += fee;
      this.fill({ action: 'sell', ticker: pos.ticker, side: pos.side, qty: qty, price: px, fee: fee, pnl: proceeds - basis, title: pos.title });
      this.markAll(); Persist.save();
      return { ok: true, msg: 'Sold ' + qty + ' ' + pos.side.toUpperCase() + ' at ' + U.cents(px) + ' · ' + U.money(proceeds - basis, { plus: true }) };
    },
    settle(ticker, result) {
      let touched = false;
      for (const key in S.desk.positions) {
        const pos = S.desk.positions[key];
        if (pos.ticker !== ticker) continue;
        const won = pos.side === result;
        const payout = won ? pos.qty : 0;
        S.desk.cash += payout; S.desk.realized += payout - pos.cost;
        this.fill({ action: 'settle', ticker: ticker, side: pos.side, qty: pos.qty, price: won ? 1 : 0, fee: 0, pnl: payout - pos.cost, title: pos.title });
        delete S.desk.positions[key]; touched = true;
      }
      const before = S.desk.orders.length;
      S.desk.orders = S.desk.orders.filter(o => o.ticker !== ticker);
      if (touched || before !== S.desk.orders.length) { Persist.save(); UI.toast(ticker + ' settled ' + result.toUpperCase()); }
    },
    checkOrders() {
      let changed = false;
      for (const o of S.desk.orders.slice()) {
        const m = S.universe.markets.get(o.ticker); if (!m) continue;
        const ask = this.quote(m, o.side, 'buy');
        if (ask !== null && ask <= o.price) {
          const info = this.feeInfo(m);
          const fee = F.calc(o.qty, o.price, 'maker', info, S.settings.rounding);
          const cost = o.qty * o.price + fee;
          if (cost > S.desk.cash) { UI.toast('Resting order skipped: not enough cash'); S.desk.orders = S.desk.orders.filter(x => x.id !== o.id); changed = true; continue; }
          const key = o.ticker + '|' + o.side;
          const pos = S.desk.positions[key] || { ticker: o.ticker, side: o.side, qty: 0, cost: 0, openedAt: Date.now(), title: o.title };
          pos.qty += o.qty; pos.cost += cost; S.desk.positions[key] = pos;
          S.desk.cash -= cost; S.desk.fees += fee;
          this.fill({ action: 'buy', ticker: o.ticker, side: o.side, qty: o.qty, price: o.price, fee: fee, title: o.title, maker: true });
          S.desk.orders = S.desk.orders.filter(x => x.id !== o.id);
          UI.toast('Resting order filled: ' + o.qty + ' ' + o.side.toUpperCase() + ' at ' + U.cents(o.price));
          changed = true;
        }
      }
      if (changed) { this.markAll(); Persist.save(); UI.onDesk(); }
    },
    cancel(id) { S.desk.orders = S.desk.orders.filter(o => o.id !== id); Persist.save(); },
    fill(f) { f.t = Date.now(); f.id = U.uid(); S.desk.fills.unshift(f); if (S.desk.fills.length > 300) S.desk.fills.length = 300; },
    value() {
      let pos = 0;
      for (const key in S.desk.positions) {
        const p = S.desk.positions[key]; const m = S.universe.markets.get(p.ticker);
        const bid = m ? this.quote(m, p.side, 'sell') : null;
        pos += p.qty * (bid !== null ? bid : (p.cost / p.qty));
      }
      return { positions: pos, equity: S.desk.cash + pos };
    },
    markAll() {
      const v = this.value();
      const eq = S.desk.equity;
      const last = eq[eq.length - 1];
      const now = Date.now();
      if (!last || (Math.abs(last.v - v.equity) > 0.005 && now - last.t > 30000) || now - last.t > 600000) {
        eq.push({ t: now, v: U.round(v.equity, 2) });
        if (eq.length > 400) eq.splice(0, eq.length - 400);
        Persist.save();
      }
      UI.onDesk();
    },
    reset(bankroll) { S.desk = newDesk(bankroll); S.settings.bankroll = bankroll; Persist.save(); UI.onDesk(); }
  };
  function label(m) { const ev = S.universe.events.get(m.event); if (m.title) return m.title; return (ev ? ev.title + ' · ' : '') + (m.yesSub || m.ticker); }

  /* ---------- charts (canvas) ---------- */
  const Chart = {
    tokens() {
      const cs = getComputedStyle(document.documentElement);
      const g = (k) => cs.getPropertyValue(k).trim();
      return { fg: g('--fg'), fg2: g('--fg-2'), fg3: g('--fg-3'), line: g('--line'), line2: g('--line-2'), yes: g('--yes'), no: g('--no'), up: g('--up'), down: g('--down'), bg: g('--bg-elev'), ink: g('--ink') };
    },
    setup(canvas, h) {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
      const height = h || canvas.height || 160;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr);
      canvas.style.height = height + 'px';
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx: ctx, w: w, h: height };
    },
    font(ctx, size, weight) { ctx.font = (weight || 400) + ' ' + (size || 11) + 'px ' + "'Archivo', system-ui, sans-serif"; },
    price(canvas, tip, candles, opts) {
      const s = this.setup(canvas, 190); if (!s) return;
      const { ctx, w, h } = s; const T = this.tokens();
      ctx.clearRect(0, 0, w, h);
      const pad = { l: 8, r: 44, t: 10, b: 20 }, volH = 34;
      const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b - volH - 6;
      if (!candles || candles.length < 2) { this.font(ctx, 12); ctx.fillStyle = T.fg3; ctx.fillText(candles && candles.length === 1 ? 'One data point so far' : 'No price history yet', pad.l, pad.t + 16); canvas._hit = null; return; }
      let lo = Infinity, hi = -Infinity, maxV = 0;
      for (const c of candles) { lo = Math.min(lo, c.l, c.c); hi = Math.max(hi, c.h, c.c); maxV = Math.max(maxV, c.vol || 0); }
      const span = Math.max(0.04, hi - lo);
      lo = Math.max(0, lo - span * 0.15); hi = Math.min(1, hi + span * 0.15);
      const t0 = candles[0].t, t1 = candles[candles.length - 1].t;
      const x = (t) => pad.l + (t - t0) / Math.max(1, t1 - t0) * pw;
      const y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * ph;
      // grid + y labels
      ctx.strokeStyle = T.line2; ctx.lineWidth = 1; this.font(ctx, 10.5); ctx.fillStyle = T.fg3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (const tk of U.niceTicks(lo, hi, 4)) { const yy = Math.round(y(tk)) + 0.5; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + pw, yy); ctx.stroke(); ctx.fillText(Math.round(tk * 100) + '¢', pad.l + pw + 6, yy); }
      // x labels
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const nX = w < 420 ? 3 : 5;
      for (let i = 0; i <= nX; i++) { const t = t0 + (t1 - t0) * i / nX; const d = new Date(t); const lbl = (t1 - t0) <= 2 * 86400000 ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); ctx.fillText(lbl, U.clamp(x(t), pad.l + 22, pad.l + pw - 22), h - 5); }
      // volume
      const vb = pad.t + ph + 6 + volH;
      ctx.fillStyle = T.line;
      const bw = Math.max(1, pw / candles.length - 1);
      for (const c of candles) { if (!c.vol) continue; const vh = (c.vol / maxV) * volH; ctx.fillRect(x(c.t) - bw / 2, vb - vh, bw, vh); }
      // area + line
      ctx.beginPath(); ctx.moveTo(x(candles[0].t), y(candles[0].c));
      for (const c of candles) ctx.lineTo(x(c.t), y(c.c));
      const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
      grad.addColorStop(0, hexA(T.yes, 0.22)); grad.addColorStop(1, hexA(T.yes, 0.0));
      ctx.lineTo(x(t1), pad.t + ph); ctx.lineTo(x(t0), pad.t + ph); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x(candles[0].t), y(candles[0].c));
      for (const c of candles) ctx.lineTo(x(c.t), y(c.c));
      ctx.strokeStyle = T.yes; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      // endpoint
      const lastC = candles[candles.length - 1];
      ctx.beginPath(); ctx.arc(x(lastC.t), y(lastC.c), 3.5, 0, Math.PI * 2); ctx.fillStyle = T.yes; ctx.fill();
      ctx.fillStyle = T.bg; ctx.fillRect(pad.l + pw + 2, y(lastC.c) - 8, 40, 16);
      ctx.fillStyle = T.yes; this.font(ctx, 11, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(U.cents(lastC.c), pad.l + pw + 6, y(lastC.c));
      canvas._hit = { candles: candles, x: x, y: y, pad: pad, pw: pw, ph: ph };
      this.bindHover(canvas, tip, (px) => {
        const hit = canvas._hit; if (!hit) return null;
        let best = null, bd = Infinity;
        for (const c of hit.candles) { const d = Math.abs(hit.x(c.t) - px); if (d < bd) { bd = d; best = c; } }
        if (!best) return null;
        return { x: hit.x(best.t), y: hit.y(best.c), text: U.cents(best.c) + ' · ' + U.dateShort(best.t) + (best.vol ? ' · ' + U.compact(best.vol) + ' vol' : '') };
      });
    },
    depth(canvas, tip, book) {
      const s = this.setup(canvas, 120); if (!s) return;
      const { ctx, w, h } = s; const T = this.tokens();
      ctx.clearRect(0, 0, w, h);
      const pad = { l: 8, r: 8, t: 8, b: 18 };
      const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
      if (!book || (!book.yesBids.length && !book.yesAsks.length)) { this.font(ctx, 12); ctx.fillStyle = T.fg3; ctx.fillText('Empty book', pad.l, pad.t + 14); canvas._hit = null; return; }
      const bids = book.yesBids.slice(0, 20), asks = book.yesAsks.slice(0, 20);
      let cum = 0; const bidPts = bids.map(([p, q]) => { cum += q; return { p: p, c: cum }; });
      cum = 0; const askPts = asks.map(([p, q]) => { cum += q; return { p: p, c: cum }; });
      const maxC = Math.max(bidPts.length ? bidPts[bidPts.length - 1].c : 0, askPts.length ? askPts[askPts.length - 1].c : 0, 1);
      const lo = Math.max(0, Math.min(bids.length ? bids[bids.length - 1][0] : 1, asks.length ? asks[0][0] : 1) - 0.02);
      const hi = Math.min(1, Math.max(asks.length ? asks[asks.length - 1][0] : 0, bids.length ? bids[0][0] : 0) + 0.02);
      const x = (p) => pad.l + (p - lo) / Math.max(0.02, hi - lo) * pw;
      const y = (c) => pad.t + (1 - c / maxC) * ph;
      const step = (pts, color, dir) => {
        if (!pts.length) return;
        ctx.beginPath();
        const first = pts[0];
        const base = pad.t + ph;
        ctx.moveTo(x(first.p), base);
        let prev = first;
        for (const pt of pts) { ctx.lineTo(x(prev.p), y(pt.c)); ctx.lineTo(x(pt.p), y(pt.c)); prev = pt; }
        ctx.lineTo(x(prev.p), base); ctx.closePath();
        ctx.fillStyle = hexA(color, 0.18); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      };
      step(bidPts, T.yes, -1); step(askPts, T.no, 1);
      // x labels
      this.font(ctx, 10.5); ctx.fillStyle = T.fg3; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (const tk of U.niceTicks(lo, hi, 4)) if (tk >= lo && tk <= hi) ctx.fillText(Math.round(tk * 100) + '¢', x(tk), h - 4);
      this.font(ctx, 10, 700); ctx.textAlign = 'left'; ctx.fillStyle = T.yes; ctx.fillText('YES bids', pad.l + 2, pad.t + 10);
      ctx.textAlign = 'right'; ctx.fillStyle = T.no; ctx.fillText('YES offers', pad.l + pw - 2, pad.t + 10);
      canvas._hit = { bidPts: bidPts, askPts: askPts, x: x, y: y };
      this.bindHover(canvas, tip, (px) => {
        const hit = canvas._hit; if (!hit) return null;
        const all = hit.bidPts.map(p => Object.assign({ side: 'bid' }, p)).concat(hit.askPts.map(p => Object.assign({ side: 'offer' }, p)));
        let best = null, bd = Infinity;
        for (const pt of all) { const d = Math.abs(hit.x(pt.p) - px); if (d < bd) { bd = d; best = pt; } }
        if (!best) return null;
        return { x: hit.x(best.p), y: hit.y(best.c), text: U.compact(best.c) + ' contracts ' + (best.side === 'bid' ? 'bid at or above ' : 'offered at or below ') + U.cents(best.p) };
      });
    },
    spark(canvas, tip, pts) {
      const s = this.setup(canvas, 110); if (!s) return;
      const { ctx, w, h } = s; const T = this.tokens();
      ctx.clearRect(0, 0, w, h);
      const pad = { l: 8, r: 56, t: 10, b: 8 };
      const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
      if (!pts || pts.length < 2) { this.font(ctx, 12); ctx.fillStyle = T.fg3; ctx.fillText('Equity history appears after your first paper trade', pad.l, pad.t + 14); canvas._hit = null; return; }
      let lo = Infinity, hi = -Infinity; for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
      if (hi - lo < 1) { lo -= 1; hi += 1; }
      const span = hi - lo; lo -= span * 0.1; hi += span * 0.1;
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      const x = (t) => pad.l + (t - t0) / Math.max(1, t1 - t0) * pw;
      const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
      const start = pts[0].v, end = pts[pts.length - 1].v;
      const color = end >= start ? T.up : T.down;
      ctx.strokeStyle = T.line2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y(start)) + 0.5); ctx.lineTo(pad.l + pw, Math.round(y(start)) + 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x(pts[0].t), y(pts[0].v)); for (const p of pts) ctx.lineTo(x(p.t), y(p.v));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x(t1), y(end), 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      this.font(ctx, 11, 700); ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(U.money(end), pad.l + pw + 6, y(end));
      canvas._hit = { pts: pts, x: x, y: y };
      this.bindHover(canvas, tip, (px) => { const hit = canvas._hit; if (!hit) return null; let best = null, bd = Infinity; for (const p of hit.pts) { const d = Math.abs(hit.x(p.t) - px); if (d < bd) { bd = d; best = p; } } return best ? { x: hit.x(best.t), y: hit.y(best.v), text: U.money(best.v) + ' · ' + U.dateShort(best.t) } : null; });
    },
    bindHover(canvas, tip, find) {
      if (!tip) return;
      if (canvas._bound) { canvas._find = find; return; }
      canvas._bound = true; canvas._find = find;
      const show = (ev) => {
        const r = canvas.getBoundingClientRect();
        const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
        const hit = canvas._find ? canvas._find(px) : null;
        if (!hit) { tip.style.display = 'none'; return; }
        tip.textContent = hit.text; tip.style.display = 'block';
        tip.style.left = U.clamp(hit.x, 60, r.width - 60) + 'px'; tip.style.top = Math.max(16, hit.y - 8) + 'px';
      };
      canvas.addEventListener('mousemove', show); canvas.addEventListener('touchstart', show, { passive: true }); canvas.addEventListener('touchmove', show, { passive: true });
      canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; }); canvas.addEventListener('touchend', () => { tip.style.display = 'none'; });
    }
  };
  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------- scanner ---------- */
  const Scanner = {
    run() {
      const t = Date.now();
      S.scanner.ops = A.scan(S.universe, S.settings, S.seriesCache, t);
      S.scanner.at = t;
      if (window.UI) UI.onScanner();
    },
    counts() { const c = { all: S.scanner.ops.length }; for (const o of S.scanner.ops) c[o.kind] = (c[o.kind] || 0) + 1; return c; }
  };

  Object.assign(window, { EDApp: { S: S, Persist: Persist, API: API, DS: DS, Engine: Engine, Desk: Desk, Chart: Chart, Scanner: Scanner, label: label, DEFAULTS: DEFAULTS, newDesk: newDesk, setHealth: setHealth, noteError: noteError } });
})();
