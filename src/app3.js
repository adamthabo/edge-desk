/* Edge Desk app, part 3: real-account UI (live panel, real-money ticket, setup, header chip). */
(function () {
  'use strict';
  const { U, F } = window.ED;
  const { S, Engine, Desk, label, Persist } = window.EDApp;
  const UI = window.UI, Acct = window.EDAcct, P = window.EDPlain;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const envName = () => S.settings.env === 'demo' ? 'demo exchange' : 'Kalshi';

  const setupSteps = () => '<ol class="steps">' +
    '<li>On Kalshi, open your account settings → <b>API Keys</b> → <b>Create New API Key</b> (Ed25519 is fine). Save the private key file it downloads; Kalshi shows it only once.</li>' +
    '<li>In Cloudflare, open your <b>edge-desk</b> Worker → <b>Settings</b> → <b>Variables and Secrets</b> and add three secrets: <code>KALSHI_KEY_ID</code> (the key id), <code>KALSHI_PRIVATE_KEY</code> (paste the whole private key file, including the BEGIN and END lines), and <code>DESK_PASSWORD</code> (a password you choose for this app).</li>' +
    '<li>Optional caps: <code>MAX_ORDER_CONTRACTS</code> (default 100) and <code>MAX_ORDER_DOLLARS</code> (default 100) limit any single order. For the demo exchange use <code>KALSHI_DEMO_KEY_ID</code> and <code>KALSHI_DEMO_PRIVATE_KEY</code>.</li>' +
    '<li>Tap <b>Deploy</b> in Cloudflare if it asks, come back here and tap <b>Check again</b>, then unlock with your password.</li></ol>' +
    '<p class="small muted" style="margin:10px 0 0">The key stays inside your Worker and signs each request there; this page only ever holds the password. Edge Desk never sees the key.</p>';

  const pwForm = (compact) => '<div class="card" style="display:grid;gap:10px"><div><b>Unlock your account on this device</b><div class="small muted">Enter the DESK_PASSWORD you set on the Worker.</div></div>' +
    '<div class="row"><input class="inp" id="acct-pw" type="password" autocomplete="current-password" placeholder="Desk password" style="flex:1 1 180px"><button class="btn primary" data-act="unlock">Unlock</button></div>' +
    '<label class="row small muted" style="gap:6px"><input type="checkbox" id="acct-remember" checked style="margin:0"> Remember on this device</label>' +
    (Acct.st.error ? '<div class="small down">' + esc(Acct.st.error) + '</div>' : '') + '</div>';

  Object.assign(UI, {
    onAccount() {
      this.renderAcctChip();
      if (S.view === 'desk' && this.deskTab === 'live') this.renderDeskLive();
      if (S.view === 'setup') this.renderSetupAccount();
      if (S.sel && !$('sheet').hidden) { if (S.sheet.ticket.real) this.renderTicket(); else { const bar = $('tk-modebar'); if (bar) bar.outerHTML = '<div id="tk-modebar">' + this.ticketModeBar() + '</div>'; else this.renderTicket(); } }
      Engine.accountLoop();
    },
    renderAcctChip() {
      let chip = $('st-acct');
      if (!chip) { chip = document.createElement('button'); chip.id = 'st-acct'; chip.className = 'chip'; chip.dataset.act = 'gotoacct'; $('status').insertBefore(chip, $('guide-btn')); }
      if (Acct.st.unlocked) { chip.hidden = false; chip.className = 'chip on'; chip.textContent = (S.settings.env === 'demo' ? 'Demo account' : 'Account') + (Acct.st.balance ? ' · ' + U.money(Acct.st.balance.cash) : ''); }
      else if (Acct.available() && Acct.st.known && Acct.st.passwordSet) { chip.hidden = false; chip.className = 'chip'; chip.textContent = 'Account locked'; }
      else chip.hidden = true;
    },
    renderDeskLive() {
      const box = $('desk-live'); if (!box) return;
      const st = Acct.st;
      if (!Acct.available()) {
        box.innerHTML = '<div class="empty">Real trading works on your live site only (the Worker signs orders with your Kalshi key). ' + (S.ctx === 'artifact' && UI.liveUrl() ? '<a href="' + esc(UI.liveUrl()) + '" target="_blank" rel="noopener">Open the live desk</a> to connect your account.' : 'Connect live data first (Setup).') + '</div>';
        return;
      }
      if (!st.known) { box.innerHTML = '<div class="empty">Checking the Worker…</div>'; return; }
      if (!st.passwordSet) {
        box.innerHTML = '<div class="card"><h3 style="font-size:16px;font-weight:600;margin-bottom:8px">Connect your Kalshi account</h3><p class="small muted" style="margin:0 0 12px">Three secrets on your Worker turn this into a real trading desk: your API key, its private key, and a password for this app. About five minutes.</p>' + setupSteps() + '<div class="row" style="margin-top:12px"><button class="btn primary" data-act="acctcheck">Check again</button></div></div>';
        return;
      }
      if (!st.unlocked) { box.innerHTML = pwForm(); return; }
      if (!Acct.envOk()) { box.innerHTML = '<div class="banner warn"><div><p>No API key is configured for the <b>' + envName() + '</b>. ' + (S.settings.env === 'demo' ? 'Add <code>KALSHI_DEMO_KEY_ID</code> and <code>KALSHI_DEMO_PRIVATE_KEY</code> to the Worker, or switch Setup → Exchange to Production.' : 'Add <code>KALSHI_KEY_ID</code> and <code>KALSHI_PRIVATE_KEY</code> to the Worker.') + '</p><div class="actions"><button class="btn sm" data-act="acctcheck">Check again</button><button class="btn sm ghost" data-act="lock">Lock</button></div></div></div>'; return; }
      const sum = Acct.summary();
      const b = st.balance;
      const lim = st.limits || {};
      let html = (st.error ? '<div class="banner danger"><div><p>' + esc(st.error) + '</p></div></div>' : '') +
        (S.settings.env === 'demo' ? '<div class="banner"><div><p><b>Demo exchange.</b> These are Kalshi\'s practice balances, not real money. Switch Setup → Exchange to Production for your real account.</p></div></div>' : '') +
        (P.on() ? P.hint('<p>This is your actual ' + envName() + ' account, read through your Worker. <b>Cash</b> is what you can spend; <b>positions</b> are contracts you hold, valued at what you could sell them for right now; <b>resting orders</b> are waiting for their price and can be cancelled. Buying and selling happens from a market\'s panel with the ticket set to Real money; every order is capped by the limits on your Worker (' + (lim.contracts || '—') + ' contracts, ' + (lim.dollars ? U.money(lim.dollars) : '—') + ' at risk per order).</p>') : '') +
        '<div class="tiles">' +
        '<div class="tile"><div class="label">Cash</div><div class="v">' + (b ? U.money(b.cash) : '—') + '</div><div class="s">available to trade</div></div>' +
        '<div class="tile"><div class="label">Positions</div><div class="v">' + U.money(sum.value) + '</div><div class="s">' + st.positions.length + ' open · cost ' + U.money(sum.exposure) + '</div></div>' +
        '<div class="tile"><div class="label">Open P&amp;L</div><div class="v ' + (sum.openPnl >= 0 ? 'up' : 'down') + '">' + U.money(sum.openPnl, { plus: true }) + '</div><div class="s">' + P.term('marked', 'marked at the bid') + '</div></div>' +
        '<div class="tile"><div class="label">Resting orders</div><div class="v">' + st.orders.length + '</div><div class="s">' + (st.at ? 'updated ' + U.ago(st.at) + ' ago' : '') + '</div></div></div>';
      html += '<div class="section"><h3>Positions</h3>' + (st.positions.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>Market</th><th class="r">Qty</th><th class="r">Avg cost</th><th class="r">Bid</th><th class="r">P&amp;L</th><th></th></tr></thead><tbody>' + st.positions.map(p => {
        const m = S.universe.markets.get(p.ticker); const mk = Acct.mark(p); const avg = p.qty ? p.exposure / p.qty : null; const val = p.qty * (mk !== null ? mk : (avg || 0)); const pnl = val - p.exposure;
        return '<tr><td><a href="#" data-act="open" data-t="' + esc(p.ticker) + '">' + esc(m ? label(m) : p.ticker) + '</a><div class="faint small"><span class="' + p.side + '">' + p.side.toUpperCase() + '</span> · <span class="mono">' + esc(p.ticker) + '</span>' + (m && m.close ? ' · closes ' + U.countdown(m.close) : '') + (p.realized ? ' · realized ' + U.money(p.realized, { plus: true }) : '') + '</div></td><td class="r">' + p.qty + '</td><td class="r">' + U.cents(avg) + '</td><td class="r">' + U.cents(mk) + '</td><td class="r ' + (pnl >= 0 ? 'up' : 'down') + '">' + U.money(pnl, { plus: true }) + '</td><td class="r"><button class="btn sm" data-act="realclose" data-t="' + esc(p.ticker) + '" data-side="' + p.side + '" data-qty="' + p.qty + '">Sell</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">No open positions in this account.</div>') + '</div>';
      html += '<div class="section"><h3>Resting orders</h3>' + (st.orders.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>Market</th><th class="r">Order</th><th class="r">Left</th><th class="r">Limit</th><th class="r">Now</th><th></th></tr></thead><tbody>' + st.orders.map(o => {
        const m = S.universe.markets.get(o.ticker); const now = m ? (o.action === 'buy' ? (o.side === 'yes' ? (m.hasAsk ? m.ya : null) : (m.hasBid ? U.round(1 - m.yb, 4) : null)) : (o.side === 'yes' ? (m.hasBid ? m.yb : null) : (m.hasAsk ? U.round(1 - m.ya, 4) : null))) : null;
        return '<tr><td><a href="#" data-act="open" data-t="' + esc(o.ticker) + '">' + esc(m ? label(m) : o.ticker) + '</a><div class="faint small mono">' + esc(o.ticker) + (o.created ? ' · ' + U.dateShort(o.created) : '') + '</div></td><td class="r">' + o.action + ' <span class="' + o.side + '">' + o.side.toUpperCase() + '</span></td><td class="r">' + U.compact(o.remaining) + '</td><td class="r">' + U.cents(o.price) + '</td><td class="r">' + U.cents(now) + '</td><td class="r" id="cx-' + esc(o.id) + '"><button class="btn sm ghost" data-act="realcancel1" data-id="' + esc(o.id) + '">Cancel</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">No resting orders.</div>') + '</div>';
      html += '<div class="section"><h3>Recent fills</h3>' + (st.fills.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>When</th><th>Market</th><th class="r">Fill</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fee</th></tr></thead><tbody>' + st.fills.slice(0, 40).map(f => {
        const m = S.universe.markets.get(f.ticker);
        return '<tr><td class="faint">' + U.dateShort(f.t) + '</td><td><a href="#" data-act="open" data-t="' + esc(f.ticker) + '">' + esc(m ? label(m) : f.ticker) + '</a></td><td class="r">' + f.action + ' <span class="' + f.side + '">' + f.side.toUpperCase() + '</span>' + (f.taker ? '' : ' <span class="faint">(maker)</span>') + '</td><td class="r">' + U.compact(f.qty) + '</td><td class="r">' + U.cents(f.price) + '</td><td class="r">' + (f.fee ? U.money(f.fee) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty">No fills yet.</div>') + '</div>';
      html += '<div class="section"><div class="row"><button class="btn" data-act="acctrefresh">Refresh</button><button class="btn ghost" data-act="lock">Lock on this device</button><span class="faint small">Per-order caps: ' + (lim.contracts || '—') + ' contracts · ' + (lim.dollars ? U.money(lim.dollars) : '—') + ' at risk. Change them on the Worker.</span></div></div>' +
        '<div class="disclaimer">Orders go to ' + envName() + ' under your own API key, signed inside your Worker. Edge Desk does not decide anything for you. Event contracts can lose the entire amount risked.</div>';
      box.innerHTML = html;
    },
    renderSetupAccount() {
      const box = $('setup-account'); if (!box) return;
      const st = Acct.st;
      if (!Acct.available()) { box.innerHTML = '<p class="small muted" style="margin:0">Real trading is available on your live site, where the Worker can sign orders with your Kalshi key.</p>'; return; }
      if (!st.known) { box.innerHTML = '<p class="small muted" style="margin:0">Checking the Worker…</p>'; return; }
      if (!st.passwordSet) { box.innerHTML = '<p class="small muted" style="margin:0 0 10px">Not connected yet. Add these to your Worker:</p>' + setupSteps() + '<div class="row" style="margin-top:10px"><button class="btn sm primary" data-act="acctcheck">Check again</button></div>'; return; }
      if (!st.unlocked) { box.innerHTML = pwForm(true); return; }
      box.innerHTML = '<div class="row"><span class="dot live"></span><span>Unlocked on this device · keys configured for ' + ['prod', 'demo'].filter(k => st.configured[k]).map(k => k === 'prod' ? 'production' : 'demo').join(' and ') + ' · caps ' + (st.limits ? st.limits.contracts + ' contracts, ' + U.money(st.limits.dollars) : '—') + '</span></div><div class="row" style="margin-top:8px"><button class="btn sm" data-act="gotoacct">Open account</button><button class="btn sm ghost" data-act="lock">Lock on this device</button></div>';
    },
    /* ----- real-money ticket ----- */
    realTicketState(m) {
      const t = S.sheet.ticket;
      if (!t.r) t.r = { side: t.side || 'yes', action: 'buy', count: t.qty || 10, limit: null, tif: 'ioc', stage: 'edit', result: null, error: '' };
      const r = t.r;
      if (r.limit === null) r.limit = r.action === 'buy' ? (r.side === 'yes' ? (m.hasAsk ? m.ya : 0.5) : (m.hasBid ? U.round(1 - m.yb, 4) : 0.5)) : (r.side === 'yes' ? (m.hasBid ? m.yb : 0.5) : (m.hasAsk ? U.round(1 - m.ya, 4) : 0.5));
      return r;
    },
    renderRealTicket(m, box) {
      const r = this.realTicketState(m);
      const pos = Acct.st.positions.find(p => p.ticker === m.ticker);
      box.innerHTML = '<div id="tk-modebar">' + this.ticketModeBar() + '</div>' +
        '<div class="realbox">' +
        '<div class="row" style="justify-content:space-between"><div class="seg"><button data-act="rside" data-s="yes"' + (r.side === 'yes' ? ' class="on"' : '') + '>YES</button><button data-act="rside" data-s="no"' + (r.side === 'no' ? ' class="on"' : '') + '>NO</button></div><div class="seg"><button data-act="raction" data-s="buy"' + (r.action === 'buy' ? ' class="on"' : '') + '>Buy</button><button data-act="raction" data-s="sell"' + (r.action === 'sell' ? ' class="on"' : '') + '>Sell</button></div></div>' +
        (pos ? '<div class="small muted">You hold ' + pos.qty + ' ' + pos.side.toUpperCase() + ' here (avg ' + U.cents(pos.qty ? pos.exposure / pos.qty : null) + ').</div>' : '') +
        '<div class="grid"><label>Contracts<input class="inp" id="rk-qty" type="number" min="1" step="1" value="' + esc(r.count) + '"></label><label>' + (r.action === 'buy' ? 'Pay at most (¢)' : 'Receive at least (¢)') + '<input class="inp" id="rk-limit" type="number" min="1" max="99" step="1" value="' + Math.round(r.limit * 100) + '"></label></div>' +
        '<div class="seg" style="align-self:start"><button data-act="rtif" data-s="ioc"' + (r.tif === 'ioc' ? ' class="on"' : '') + '>Fill now or cancel</button><button data-act="rtif" data-s="gtc"' + (r.tif === 'gtc' ? ' class="on"' : '') + '>Rest on the book</button></div>' +
        '<div class="preview" id="rk-preview"></div>' +
        '<div id="rk-confirm"></div>' +
        (P.on() ? P.hint('<p><b>Fill now or cancel</b> buys or sells immediately at the best available price up to your limit, and cancels whatever cannot fill; it pays the taker fee. <b>Rest on the book</b> waits at your price until someone trades with you (usually no fee) or you cancel it from the Desk.</p>') : '') +
        '</div>';
      this.renderRealPreview(m);
    },
    renderRealPreview(m) {
      const pv = $('rk-preview'); if (!pv) return;
      const r = this.realTicketState(m);
      r.count = U.num(($('rk-qty') || {}).value, r.count); r.limit = U.clamp(U.num(($('rk-limit') || {}).value, Math.round(r.limit * 100)) / 100, 0.01, 0.99);
      const p = Acct.preview(m, r);
      const buy = r.action === 'buy';
      pv.innerHTML = '<div><span>' + (buy ? 'Buy' : 'Sell') + ' ' + U.compact(p.count) + ' ' + r.side.toUpperCase() + '</span><span>' + (buy ? 'at most ' : 'at least ') + U.cents(p.limit) + '</span></div>' +
        '<div><span>Best price now</span><span>' + U.cents(p.best) + (p.crosses ? ' · fills now' : (r.tif === 'gtc' ? ' · will rest' : ' · would not fill')) + '</span></div>' +
        '<div><span>Fee (' + p.feeKind + ', estimate)</span><span>' + U.money(p.fee) + '</span></div>' +
        (buy ? '<div><span>Max cost</span><b>' + U.money(p.count * p.limit + p.fee) + '</b></div><div><span>Pays if right</span><span>' + U.money(p.count) + '</span></div>' : '<div><span>Proceeds (est.)</span><b>' + U.money(p.proceeds) + '</b></div>') +
        (buy ? '<div><span>Money at risk</span><b>' + U.money(p.risk) + '</b></div>' : '') +
        (p.block ? '<div class="small down" style="display:block">' + esc(p.block) + '</div>' : '');
      const c = $('rk-confirm'); if (!c) return;
      if (r.stage === 'sending') { c.innerHTML = '<div class="confirm"><p class="think">Sending to ' + envName() + '…</p></div>'; return; }
      if (r.stage === 'done' && r.result) { const res = r.result.result || {}; const filled = U.num(res.fill_count, 0) || 0, left = U.num(res.remaining_count, 0) || 0; c.innerHTML = '<div class="confirm ok"><p><b>Order accepted by ' + envName() + '.</b> ' + (filled ? 'Filled ' + U.compact(filled) + (res.average_fill_price ? ' at ' + U.cents(U.num(res.average_fill_price)) + ' average' : '') + '.' : 'Nothing filled yet.') + (left > 0 ? ' ' + U.compact(left) + ' resting on the book.' : '') + (res.order_id ? ' <span class="mono faint">' + esc(res.order_id) + '</span>' : '') + '</p><div class="actions"><button class="btn sm" data-act="rnew">New order</button><button class="btn sm ghost" data-act="gotoacct">Open account</button></div></div>'; return; }
      if (r.stage === 'confirm') { c.innerHTML = '<div class="confirm"><p><b>Real money.</b> This sends a ' + (buy ? 'buy' : 'sell') + ' order for <b>' + U.compact(p.count) + ' ' + r.side.toUpperCase() + '</b> on <i>' + esc(label(m)) + '</i>, ' + (buy ? 'paying at most ' : 'receiving at least ') + '<b>' + U.cents(p.limit) + '</b> per contract (' + (r.tif === 'gtc' ? 'resting until filled or cancelled' : 'fill now or cancel') + '). Up to <b>' + U.money(p.risk) + '</b> is at risk.' + (r.error ? ' <span class="down">' + esc(r.error) + '</span>' : '') + '</p><div class="actions"><button class="btn sm danger-fill" data-act="rsend">Confirm and send</button><button class="btn sm" data-act="rback">Back</button></div></div>'; return; }
      c.innerHTML = '<button class="btn block danger-fill" data-act="rreview"' + (p.block ? ' disabled' : '') + '>Review real order</button>' + (r.error ? '<div class="small down" style="margin-top:6px">' + esc(r.error) + '</div>' : '');
    }
  });

  Engine.accountLoop = function () {
    if (S.timers.acct) { clearTimeout(S.timers.acct); delete S.timers.acct; }
    if (!Acct.st.unlocked) return;
    const tick = async () => {
      if (!Acct.st.unlocked) return;
      const want = (S.view === 'desk' && UI.deskTab === 'live') || (S.sel && !$('sheet').hidden && S.sheet.ticket.real);
      if (want && !document.hidden) { try { await Acct.refresh(); } catch (e) { /* shown in panel */ } }
      S.timers.acct = setTimeout(tick, 10000);
    };
    S.timers.acct = setTimeout(tick, 10000);
  };

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act;
    const m = S.sel ? S.universe.markets.get(S.sel) : null;
    if (act === 'desktab') { UI.deskTab = el.dataset.s; UI.renderDesk(); if (UI.deskTab === 'live' && Acct.st.unlocked) Acct.refresh(); return; }
    if (act === 'gotoacct') { UI.deskTab = 'live'; UI.nav('desk'); if (Acct.st.unlocked) Acct.refresh(); return; }
    if (act === 'acctcheck') { Acct.st.known = false; UI.onAccount(); await Acct.probe(); UI.onAccount(); return; }
    if (act === 'acctrefresh') { await Acct.refresh(); return; }
    if (act === 'lock') { Acct.lock(); if (S.sheet.ticket) { S.sheet.ticket.real = false; S.sheet.ticket.r = null; } UI.onAccount(); UI.toast('Account locked on this device'); if (S.sel && !$('sheet').hidden) UI.renderTicket(); return; }
    if (act === 'unlock') {
      const pw = ($('acct-pw') || {}).value || ''; const remember = !!(($('acct-remember') || {}).checked);
      if (!pw) { UI.toast('Enter the desk password'); return; }
      el.disabled = true;
      try { await Acct.unlock(pw, remember); UI.toast('Account unlocked'); } catch (e) { Acct.st.pw = ''; Acct.st.error = e.status === 401 ? 'Wrong password.' : e.message; }
      UI.onAccount(); return;
    }
    if (act === 'tmode') { S.sheet.ticket.real = el.dataset.s === 'real'; if (S.sheet.ticket.real && Acct.st.unlocked) Acct.refresh(); UI.renderTicket(); return; }
    if (!m) return;
    if (act === 'rside') { const r = UI.realTicketState(m); r.side = el.dataset.s; r.limit = null; r.stage = 'edit'; r.error = ''; UI.renderTicket(); return; }
    if (act === 'raction') { const r = UI.realTicketState(m); r.action = el.dataset.s; r.limit = null; r.stage = 'edit'; r.error = ''; UI.renderTicket(); return; }
    if (act === 'rtif') { const r = UI.realTicketState(m); r.tif = el.dataset.s; r.stage = 'edit'; UI.renderRealPreview(m); return; }
    if (act === 'rreview') { const r = UI.realTicketState(m); const p = Acct.preview(m, r); if (p.block) { UI.toast(p.block); return; } r.stage = 'confirm'; r.error = ''; UI.renderRealPreview(m); return; }
    if (act === 'rback') { const r = UI.realTicketState(m); r.stage = 'edit'; UI.renderRealPreview(m); return; }
    if (act === 'rnew') { const r = UI.realTicketState(m); r.stage = 'edit'; r.result = null; r.error = ''; UI.renderTicket(); return; }
    if (act === 'rsend') {
      const r = UI.realTicketState(m); if (r.stage !== 'confirm') return;
      const p = Acct.preview(m, r); if (p.block) { r.stage = 'edit'; r.error = p.block; UI.renderRealPreview(m); return; }
      r.stage = 'sending'; UI.renderRealPreview(m);
      try { r.result = await Acct.place(m, { side: r.side, action: r.action, count: p.count, limit: p.limit, tif: r.tif }); r.stage = 'done'; UI.toast('Order sent to ' + envName()); }
      catch (e) { r.stage = 'confirm'; r.error = e.message || 'Order rejected'; }
      UI.renderRealPreview(m); return;
    }
    if (act === 'realclose') {
      const t = el.dataset.t; const side = el.dataset.side; const qty = U.num(el.dataset.qty, 1);
      const go = () => { S.sheet.ticket.real = true; S.sheet.ticket.r = { side, action: 'sell', count: qty, limit: null, tif: 'ioc', stage: 'edit', result: null, error: '' }; UI.renderTicket(); const box = $('sh-ticket'); if (box && box.scrollIntoView) box.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      if (S.sel === t && !$('sheet').hidden) go(); else Engine.openMarket(t).then(() => { if (S.sel === t) go(); });
      return;
    }
    if (act === 'realcancel1') { const cell = $('cx-' + el.dataset.id); if (cell) cell.innerHTML = '<button class="btn sm danger" data-act="realcancel2" data-id="' + esc(el.dataset.id) + '">Confirm cancel</button>'; return; }
    if (act === 'realcancel2') {
      const o = Acct.st.orders.find(x => x.id === el.dataset.id); if (!o) return;
      el.disabled = true;
      try { await Acct.cancel(o); UI.toast('Order cancelled'); } catch (e) { UI.toast('Cancel failed: ' + e.message); }
      return;
    }
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target; if (!el || !el.id) return;
    if ((el.id === 'rk-qty' || el.id === 'rk-limit') && S.sel) { const m = S.universe.markets.get(S.sel); if (m) { const r = UI.realTicketState(m); if (r.stage !== 'edit') r.stage = 'edit'; UI.renderRealPreview(m); } }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target && ev.target.id === 'acct-pw') { const b = document.querySelector('[data-act="unlock"]'); if (b) b.click(); } });
})();
