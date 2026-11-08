/* Edge Desk account layer: talks to the Worker's /desk routes (real Kalshi account) with the desk password. */
(function () {
  'use strict';
  const { U, N, F } = window.ED;
  const { S, Persist, noteError } = window.EDApp;

  const KEY = 'edgedesk.deskpw';
  const A = {
    st: { known: false, passwordSet: false, configured: { prod: false, demo: false }, unlocked: false, limits: null, busy: false, error: '', at: 0,
      balance: null, positions: [], orders: [], fills: [], pw: '' },
    available() { return S.ctx === 'hosted' && S.mode === 'live' && S.source === 'relay'; },
    envOk() { return !!(this.st.configured && this.st.configured[S.settings.env === 'demo' ? 'demo' : 'prod']); },
    base() { const r = (S.settings.relayUrl || '').trim().replace(/\/+$/, ''); return r || location.origin; },
    loadPw() { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    savePw(pw, remember) { try { sessionStorage.setItem(KEY, pw); if (remember) localStorage.setItem(KEY, pw); else localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    clearPw() { try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    async req(path, opts) {
      opts = opts || {};
      const u = new URL(this.base() + '/desk/' + path);
      u.searchParams.set('env', S.settings.env === 'demo' ? 'demo' : 'prod');
      if (opts.query) for (const k in opts.query) if (opts.query[k] !== undefined && opts.query[k] !== null && opts.query[k] !== '') u.searchParams.set(k, String(opts.query[k]));
      const headers = { 'Accept': 'application/json' };
      if (this.st.pw) headers['Authorization'] = 'Bearer ' + this.st.pw;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), opts.timeout || 20000);
      let res, data;
      try { res = await fetch(u.toString(), { method: opts.method || 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store', signal: ctl.signal }); }
      catch (e) { clearTimeout(to); throw Object.assign(new Error(e.name === 'AbortError' ? 'The account request timed out' : 'Could not reach the Worker'), { status: 0 }); }
      clearTimeout(to);
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok) throw Object.assign(new Error((data && data.error) || ('HTTP ' + res.status)), { status: res.status, data });
      return data;
    },
    async probe() {
      if (!this.available()) { this.st.known = true; return this.st; }
      try {
        const st = await this.req('status', { timeout: 10000 });
        this.st.known = true; this.st.passwordSet = !!st.passwordSet; this.st.configured = st.configured || { prod: false, demo: false };
        const pw = this.loadPw();
        if (pw && this.st.passwordSet && !this.st.unlocked) { this.st.pw = pw; try { await this.unlock(pw, true); } catch (e) { this.st.pw = ''; this.clearPw(); } }
      } catch (e) { this.st.known = true; this.st.error = e.message; }
      return this.st;
    },
    async unlock(pw, remember) {
      this.st.pw = pw;
      const r = await this.req('unlock', { method: 'POST', body: {} });
      this.st.unlocked = true; this.st.limits = r.limits || null; this.st.configured = r.configured || this.st.configured; this.st.error = '';
      this.savePw(pw, remember !== false);
      this.refresh().catch(() => { /* shown in panel */ });
      return r;
    },
    lock() { this.st.unlocked = false; this.st.pw = ''; this.st.balance = null; this.st.positions = []; this.st.orders = []; this.st.fills = []; this.clearPw(); },
    async refresh() {
      if (!this.st.unlocked || !this.envOk()) return;
      if (this.st.busy) return;
      this.st.busy = true;
      try {
        const [bal, pos, ord, fil] = await Promise.all([this.req('balance'), this.req('positions'), this.req('orders'), this.req('fills', { query: { limit: 60 } })]);
        this.st.balance = { cash: U.num(bal.balance_dollars, (U.num(bal.balance, 0) || 0) / 100), portfolio: (U.num(bal.portfolio_value, 0) || 0) / 100, at: Date.now() };
        this.st.positions = (pos.market_positions || []).map(p => {
          const q = U.num(p.position_fp, U.num(p.position, 0)) || 0;
          return { ticker: p.ticker, side: q >= 0 ? 'yes' : 'no', qty: Math.abs(q), exposure: U.num(p.market_exposure_dollars, (U.num(p.market_exposure, 0) || 0) / 100) || 0, realized: U.num(p.realized_pnl_dollars, (U.num(p.realized_pnl, 0) || 0) / 100) || 0, fees: U.num(p.fees_paid_dollars, (U.num(p.fees_paid, 0) || 0) / 100) || 0, traded: U.num(p.total_traded_dollars, 0) || 0 };
        }).filter(p => p.qty > 0);
        this.st.orders = (ord.orders || []).map(o => {
          const yesP = U.num(o.yes_price_dollars, (U.num(o.yes_price, 0) || 0) / 100) || 0;
          const side = o.side || (o.outcome_side || 'yes');
          const action = o.action || (o.book_side === 'ask' && side === 'yes' ? 'sell' : 'buy');
          return { id: o.order_id, ticker: o.ticker, side, action, price: side === 'yes' ? yesP : U.round(1 - yesP, 4), remaining: U.num(o.remaining_count_fp, U.num(o.remaining_count, 0)) || 0, initial: U.num(o.initial_count_fp, U.num(o.initial_count, 0)) || 0, status: o.status, created: o.created_time ? Date.parse(o.created_time) : null, type: o.type || 'limit' };
        });
        this.st.fills = (fil.fills || []).map(f => {
          const yesP = U.num(f.yes_price_dollars, (U.num(f.yes_price, 0) || 0) / 100) || 0;
          const side = f.side || f.outcome_side || 'yes';
          return { id: f.fill_id || f.trade_id, ticker: f.ticker || f.market_ticker, side, action: f.action || 'buy', qty: U.num(f.count_fp, U.num(f.count, 0)) || 0, price: side === 'yes' ? yesP : U.round(1 - yesP, 4), taker: !!f.is_taker, fee: U.num(f.fee_cost, 0) || 0, t: f.created_time ? Date.parse(f.created_time) : (f.ts ? f.ts * 1000 : null) };
        });
        this.st.at = Date.now(); this.st.error = '';
        // make sure every market we hold is tracked so marks stay fresh
        for (const p of this.st.positions) if (!S.universe.markets.has(p.ticker)) S.extras.add(p.ticker);
      } catch (e) {
        this.st.error = e.message;
        if (e.status === 401) { this.lock(); }
      } finally { this.st.busy = false; }
      if (window.UI) { UI.onAccount(); }
    },
    // Order preview using live quotes; mirrors what the Worker will send
    preview(m, o) {
      const count = Math.max(0, Math.floor(U.num(o.count, 0) || 0));
      const limit = U.clamp(U.num(o.limit, 0) || 0, 0.01, 0.99);
      const info = window.EDApp.Desk.feeInfo(m);
      const buy = o.action === 'buy';
      const best = buy ? (o.side === 'yes' ? (m.hasAsk ? m.ya : null) : (m.hasBid ? U.round(1 - m.yb, 4) : null)) : (o.side === 'yes' ? (m.hasBid ? m.yb : null) : (m.hasAsk ? U.round(1 - m.ya, 4) : null));
      const crosses = best !== null && (buy ? limit >= best : limit <= best);
      const fillPrice = crosses ? best : limit;
      const feeKind = o.tif === 'gtc' && !crosses ? 'maker' : 'taker';
      const fee = F.calc(count, fillPrice, feeKind, info, S.settings.rounding);
      const cost = buy ? count * fillPrice + fee : 0;
      const risk = buy ? count * limit + fee : count * (1 - limit);
      const proceeds = buy ? 0 : count * fillPrice - fee;
      const lim = this.st.limits || { contracts: 100, dollars: 100 };
      let block = '';
      if (count < 1) block = 'Enter a number of contracts.';
      else if (count > lim.contracts) block = 'Above the Worker\'s per-order cap of ' + lim.contracts + ' contracts.';
      else if (risk > lim.dollars + 1e-9) block = 'Risks ' + U.money(risk) + ', above the Worker\'s per-order cap of ' + U.money(lim.dollars) + '.';
      else if (o.tif !== 'gtc' && !crosses) block = buy ? 'Your limit is below the best offer (' + U.cents(best) + '); a fill-or-cancel order would not fill. Raise the limit or rest it on the book.' : 'Your limit is above the best bid (' + U.cents(best) + '); a fill-or-cancel order would not fill.';
      else if (!buy) {
        const pos = this.st.positions.find(p => p.ticker === m.ticker && p.side === o.side);
        if (!pos) block = 'You do not hold any ' + o.side.toUpperCase() + ' contracts in this market to sell.';
        else if (count > pos.qty) block = 'You hold ' + pos.qty + ' ' + o.side.toUpperCase() + ' contracts; selling more would open a new position.';
      }
      return { count, limit, best, crosses, fillPrice, feeKind, fee, risk, cost, proceeds, block };
    },
    async place(m, o) {
      const r = await this.req('order', { method: 'POST', body: { ticker: m.ticker, side: o.side, action: o.action, count: o.count, limit: o.limit, tif: o.tif, postOnly: !!o.postOnly } });
      this.refresh().catch(() => { /* shown in panel */ });
      return r;
    },
    async cancel(order) {
      const r = await this.req('order/' + encodeURIComponent(order.id), { method: 'DELETE', query: { ticker: order.ticker } });
      this.refresh().catch(() => { /* shown in panel */ });
      return r;
    },
    mark(p) {
      const m = S.universe.markets.get(p.ticker); if (!m) return null;
      return p.side === 'yes' ? (m.hasBid ? m.yb : null) : (m.hasAsk ? U.round(1 - m.ya, 4) : null);
    },
    summary() {
      let value = 0, exposure = 0;
      for (const p of this.st.positions) { const mk = this.mark(p); value += p.qty * (mk !== null ? mk : (p.exposure / Math.max(1, p.qty))); exposure += p.exposure; }
      return { value, exposure, openPnl: value - exposure };
    }
  };
  window.EDAcct = A;
})();
