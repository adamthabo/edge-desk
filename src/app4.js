/* Edge Desk app, part 4: trading-engine UI (Desk → Engine tab). */
(function () {
  'use strict';
  const { U } = window.ED;
  const { S } = window.EDApp;
  const UI = window.UI, Acct = window.EDAcct, P = window.EDPlain;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;

  const Eng = window.EDEngine = {
    st: { known: false, status: null, games: [], bets: [], log: [], error: '', busy: false, at: 0 },
    async req(path, opts) { return Acct.req('../engine/' + path, opts); },
    async refresh(full) {
      if (!Acct.st.unlocked) return;
      try {
        const [status, games, bets, log] = await Promise.all([this.req('status'), this.req('games'), this.req('bets'), full ? this.req('log') : Promise.resolve(null)]);
        this.st.status = status; this.st.games = games.games || []; this.st.bets = bets.bets || []; if (log) this.st.log = log.log || [];
        this.st.known = true; this.st.error = ''; this.st.at = Date.now();
      } catch (e) { this.st.known = true; this.st.error = e.message; }
      if (UI.deskTab === 'engine' && S.view === 'desk') UI.renderEngine();
    }
  };

  const money = (v) => U.money(v, { plus: true });
  const pct = (v) => (v === null || v === undefined) ? '—' : (v * 100).toFixed(1) + '%';
  const field = (id, labelTxt, inputHtml, help) => '<div class="field"><label for="' + id + '">' + labelTxt + '</label>' + inputHtml + (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  const inp = (id, val, attrs) => '<input class="inp" id="eng-' + id + '" data-eng="' + id + '" value="' + esc(val) + '" ' + (attrs || '') + '>';
  const sel = (id, val, opts) => '<select class="sel" id="eng-' + id + '" data-eng="' + id + '">' + opts.map(o => '<option value="' + o[0] + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';

  Object.assign(UI, {
    renderEngine() {
      const box = $('desk-engine'); if (!box) return;
      if (!Acct.available()) { box.innerHTML = '<div class="empty">The engine runs inside your Worker on the live site' + (S.ctx === 'artifact' && UI.liveUrl() ? ': <a href="' + esc(UI.liveUrl()) + '" target="_blank" rel="noopener">open the live desk</a>.' : '.') + '</div>'; return; }
      if (!Acct.st.unlocked) { box.innerHTML = '<div class="empty">Unlock your account (Live account tab) to control the engine.</div>'; return; }
      const st = Eng.st;
      if (!st.known) { box.innerHTML = '<div class="empty">Loading the engine…</div>'; Eng.refresh(true); return; }
      if (st.error && !st.status) { box.innerHTML = '<div class="banner danger"><div><p>' + esc(st.error) + '</p>' + (/not bound|redeploy/.test(st.error) ? '<p class="small">The Worker needs one more deploy with the current <code>wrangler.toml</code> (it adds the engine\'s storage and the minute-by-minute schedule). Cloudflare → edge-desk → Deployments → redeploy, or push the repo once more.</p>' : '') + '<div class="actions"><button class="btn sm" data-act="engrefresh">Retry</button></div></div></div>'; return; }
      const s = st.status, cfg = s.settings, last = s.lastTick || {}, stats = s.stats || {};
      const on = !!cfg.enabled;
      const settledAll = (stats.settled || []).reduce((a, r) => ({ n: a.n + r.n, pnl: a.pnl + (r.pnl || 0), wins: a.wins + (r.wins || 0), bs: a.bs + (r.brier_sum || 0), bm: a.bm + (r.brier_mkt || 0), staked: a.staked + (r.staked || 0) }), { n: 0, pnl: 0, wins: 0, bs: 0, bm: 0, staked: 0 });
      const today = (stats.days || [])[0] || { realized: 0, bets: 0 };
      let html = '';
      // status header
      html += '<div class="card" style="display:grid;gap:10px;border-color:' + (on ? 'var(--up)' : 'var(--line)') + '">' +
        '<div class="row" style="justify-content:space-between"><div class="row"><span class="dot ' + (on ? 'live' : '') + '"></span><b>' + (on ? 'Engine running' : 'Engine off') + '</b><span class="small muted">' + (last.ts ? 'last tick ' + U.ago(last.ts) + ' ago' + (last.reason ? ' (' + esc(last.reason) + ')' : '') : 'no tick yet') + (last.note ? ' · ' + esc(last.note) : '') + '</span></div>' +
        '<div class="row">' + (on ? '<button class="btn sm" data-act="engtick">Run a tick now</button><button class="btn sm danger-fill" data-act="engstop">Stop and cancel quotes</button>' : '<button class="btn sm" data-act="engpreview">Dry run</button><button class="btn sm primary" data-act="engstart">Start trading</button>') + '</div></div>' +
        (!s.oddsKey ? '<div class="banner warn" style="margin:0"><div><p><b>Needs a sharp-lines feed.</b> Create a free account at the-odds-api.com, copy the API key, and add it to the Worker as a secret named <code>ODDS_API_KEY</code> (Cloudflare → edge-desk → Settings → Variables and Secrets). The free tier is enough to test; continuous NFL + NBA + NHL polling fits their 20k-request plan.</p></div></div>' : '') +
        (last.errors && last.errors.length ? '<div class="small down">' + last.errors.map(esc).join(' · ') + '</div>' : '') +
        '<div class="row small muted" style="gap:14px">' + (last.ts ? '<span>' + (last.matched || 0) + ' games matched · ' + (last.unmatched || 0) + ' unmatched</span><span>' + (last.taker || 0) + ' taken · ' + (last.maker || 0) + ' quoted · ' + (last.cancels || 0) + ' cancelled</span>' + (last.exposure !== undefined ? '<span>exposure ' + U.money(last.exposure) + '</span>' : '') : '') + (stats.oddsRemaining !== null && stats.oddsRemaining !== undefined ? '<span>odds credits left ' + U.compact(stats.oddsRemaining) + '</span>' : '') + (last.odds ? '<span>' + Object.entries(last.odds).map(([k, v]) => k + ': ' + esc(v)).join(' · ') + '</span>' : '') + '</div>' +
        '<div id="eng-confirm"></div></div>';
      const meansSimple = !s.oddsKey ? 'Add the sharp-lines key to the Worker, then run a dry run. Nothing can happen until then.'
        : !on ? 'The engine is off; nothing happens on its own. Run a <b>dry run</b> to see what it would do tonight, then <b>Start trading</b> if the plans look sensible.'
        : (last.matched ? 'Running. It is watching ' + last.matched + ' game' + (last.matched > 1 ? 's' : '') + ' and acting on its own inside your caps. You do not need to do anything; glance at Today and Calibration once a day.' : 'Running, but no games match the enabled sports right now. It will act when lines and games line up.');
      const meansWhy = '<p>The engine borrows the sharp books\' probability for each team and only acts on the gap between that and Kalshi\'s price: it buys when Kalshi is clearly too cheap, otherwise it rests a bid below fair value and waits to be paid the spread. It pulls every quote before kickoff and holds the rest to settlement. The caps below are the whole risk budget; the daily stop ends the day automatically.</p>';
      const meansDeep = '<p>Fair value p* = ' + Math.round((cfg.sharpWeight || 0.8) * 100) + '% books + ' + Math.round((1 - (cfg.sharpWeight || 0.8)) * 100) + '% Kalshi mid. Take when ask + fee + ' + Math.round(cfg.takerMargin * 100) + '¢ ≤ p* (fill-or-cancel, sized by ' + (cfg.kelly === 1 ? 'full' : cfg.kelly === 0.5 ? 'half' : cfg.kelly === 0.1 ? 'tenth' : 'quarter') + ' Kelly on $' + cfg.bankroll + '). Otherwise rest a post-only bid at floor(p* − ' + Math.round(cfg.makerMargin * 100) + '¢ − maker fee). Cancel within ' + cfg.preKickoffSec + 's of kickoff. Caps: $' + cfg.maxPerGame + ' per game, $' + cfg.maxExposure + ' total, stop at −$' + cfg.dailyLoss + ' settled for the day, ' + cfg.maxOpenGames + ' games with positions.</p>';
      html += P.layer(meansSimple, meansWhy, meansDeep, { label: 'What this means for you' });
      // stats
      html += '<div class="tiles" style="margin-top:12px">' +
        '<div class="tile"><div class="label">Today</div><div class="v ' + (today.realized >= 0 ? 'up' : 'down') + '">' + money(today.realized || 0) + '</div><div class="s">' + (today.bets || 0) + ' orders · stop at ' + U.money(-Math.abs(cfg.dailyLoss)) + '</div></div>' +
        '<div class="tile"><div class="label">Settled</div><div class="v ' + (settledAll.pnl >= 0 ? 'up' : 'down') + '">' + money(settledAll.pnl) + '</div><div class="s">' + settledAll.n + ' bets · ' + (settledAll.n ? Math.round(settledAll.wins / settledAll.n * 100) + '% won' : '—') + (settledAll.staked ? ' · ROI ' + pct(settledAll.pnl / settledAll.staked) : '') + '</div></div>' +
        '<div class="tile"><div class="label">Calibration</div><div class="v">' + (settledAll.n ? (settledAll.bs / settledAll.n).toFixed(3) : '—') + '</div><div class="s">Brier score vs market ' + (settledAll.n ? (settledAll.bm / settledAll.n).toFixed(3) : '—') + ' (lower is better)</div></div>' +
        '<div class="tile"><div class="label">Open</div><div class="v">' + ((stats.open && stats.open.n) || 0) + '</div><div class="s">' + ((stats.resting && stats.resting.n) || 0) + ' resting quotes · ' + ((stats.open && stats.open.staked) ? U.money(stats.open.staked) + ' staked' : 'nothing staked') + '</div></div></div>';
      // games
      const games = st.games.filter(g => g.status !== 'unmatched');
      const unmatched = st.games.filter(g => g.status === 'unmatched');
      html += '<div class="section"><h3>Games in view</h3>' + (games.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>Game</th><th class="r">Kickoff</th><th class="r">Sharp</th><th class="r">Kalshi ask</th><th>Plan</th></tr></thead><tbody>' + games.map(g => {
        const plan = (() => { try { return JSON.parse(g.plan || '[]'); } catch (e) { return []; } })();
        const planTxt = plan.length ? plan.map(p => '<div><span class="muted">' + esc(p.team.split(' ').pop()) + ':</span> ' + esc(p.text) + (p.pStar !== undefined ? '<details class="layer-d" style="display:inline-block;margin-left:6px"><summary>numbers</summary><div class="layer-body" style="padding-left:0">books ' + pct(p.pSharp) + ' → fair ' + pct(p.pStar) + ' · Kalshi bid ' + U.cents(p.bid) + ' / ask ' + U.cents(p.ask) + ' · take if ask + fee + ' + Math.round(cfg.takerMargin * 100) + '¢ ≤ fair; quote at fair − ' + Math.round(cfg.makerMargin * 100) + '¢ − fee</div></details>' : '') + '</div>').join('') : (g.note ? esc(g.note) : '—');
        return '<tr><td><b>' + esc(g.away) + '</b> at <b>' + esc(g.home) + '</b><div class="faint small"><span class="chip" style="padding:1px 6px">' + esc(g.sport) + '</span> <span class="mono">' + esc(g.event_ticker) + '</span> · ' + esc(g.status) + (g.books ? ' · ' + g.books + ' book' + (g.books > 1 ? 's' : '') : '') + '</div></td><td class="r nowrap">' + (g.commence_ts ? U.countdown(g.commence_ts) : '—') + '</td><td class="r nowrap">' + (g.p_home !== null ? pct(g.p_home) + ' / ' + pct(g.p_away) : '—') + '</td><td class="r nowrap">' + (g.k_home_ask !== null ? U.cents(g.k_home_ask) + ' / ' + U.cents(g.k_away_ask) : '—') + '</td><td class="small">' + planTxt + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="faint small" style="margin-top:6px">Sharp and ask columns read home / away. A plan line names the team and what the engine did or why it held back.</div>' : '<div class="empty">' + (on || last.ts ? 'No matched games in the next ' + cfg.maxHoursAhead + ' hours for the enabled sports.' : 'Run a dry run to see which games the engine would trade and why.') + '</div>') +
        (unmatched.length ? '<details style="margin-top:8px"><summary class="small muted">' + unmatched.length + ' Kalshi game' + (unmatched.length > 1 ? 's' : '') + ' without a matching sportsbook line</summary><div class="small muted" style="margin-top:6px">' + unmatched.map(g => esc(g.away) + ' vs ' + esc(g.home) + ' <span class="mono">' + esc(g.event_ticker) + '</span>').join('<br>') + '</div></details>' : '') + '</div>';
      // bets
      html += '<div class="section"><h3>Engine bets</h3>' + (st.bets.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>When</th><th>Bet</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fair</th><th class="r">Edge</th><th class="r">Status</th><th class="r">P&amp;L</th></tr></thead><tbody>' + st.bets.slice(0, 60).map(b => '<tr><td class="faint nowrap">' + U.dateShort(b.ts) + '</td><td>' + esc(b.team || b.ticker) + ' <span class="faint small">' + esc(b.kind) + '</span><div class="faint small mono">' + esc(b.ticker) + '</div></td><td class="r">' + (b.fill_count ? U.compact(b.fill_count) + '/' : '') + U.compact(b.count) + '</td><td class="r">' + U.cents(b.price) + '</td><td class="r">' + U.cents(b.p_star) + '</td><td class="r">' + (b.edge !== null ? U.cents(b.edge) : '—') + '</td><td class="r">' + esc(b.status) + (b.result ? ' · ' + esc(b.result).toUpperCase() : '') + '</td><td class="r ' + (b.pnl === null || b.pnl === undefined ? '' : b.pnl >= 0 ? 'up' : 'down') + '">' + (b.pnl === null || b.pnl === undefined ? '—' : money(b.pnl)) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No engine bets yet.</div>') + '</div>';
      // settings
      html += '<div class="section"><h3>Limits and strategy</h3><div class="form">' +
        '<div class="field-row">' + field('eng-bankroll', 'Bankroll the engine sizes against ($)', inp('bankroll', cfg.bankroll, 'type="number" min="10" step="10"'), 'Quarter-Kelly on this number; it never spends more than your actual cash.') + field('eng-kelly', 'Kelly fraction', sel('kelly', cfg.kelly, [['0.5', 'Half'], ['0.25', 'Quarter'], ['0.1', 'Tenth']]), '') + '</div>' +
        '<div class="field-row">' + field('eng-maxPerGame', 'Max per game ($)', inp('maxPerGame', cfg.maxPerGame, 'type="number" min="1" step="1"'), 'Both teams\' positions and quotes count together.') + field('eng-maxExposure', 'Max total exposure ($)', inp('maxExposure', cfg.maxExposure, 'type="number" min="1" step="5"'), '') + '</div>' +
        '<div class="field-row">' + field('eng-dailyLoss', 'Daily loss stop ($)', inp('dailyLoss', cfg.dailyLoss, 'type="number" min="1" step="5"'), 'When settled losses for the day reach this, the engine turns itself off and cancels its quotes.') + field('eng-maxOpenGames', 'Max games with positions', inp('maxOpenGames', cfg.maxOpenGames, 'type="number" min="1" step="1"'), '') + '</div>' +
        '<div class="field-row">' + field('eng-takerMargin', 'Take the price when edge beats fees by (¢)', inp('takerMargin', Math.round(cfg.takerMargin * 100), 'type="number" min="0" max="20"'), 'Higher means fewer, surer trades.') + field('eng-makerMargin', 'Rest bids this far under fair value (¢)', inp('makerMargin', Math.round(cfg.makerMargin * 100), 'type="number" min="1" max="20"'), 'The spread you ask to be paid for waiting.') + '</div>' +
        '<div class="field-row">' + field('eng-sharpWeight', 'Trust in the sportsbooks vs Kalshi', sel('sharpWeight', cfg.sharpWeight, [['1', 'Books only'], ['0.8', '80% books, 20% Kalshi'], ['0.6', '60 / 40'], ['0.5', 'Even']]), '') + field('eng-maxHoursAhead', 'Trade games starting within (hours)', inp('maxHoursAhead', cfg.maxHoursAhead, 'type="number" min="1" max="168"'), 'Lines firm up close to kickoff.') + '</div>' +
        '<div class="field-row">' + field('eng-takerEnabled', 'Taking prices', sel('takerEnabled', cfg.takerEnabled ? '1' : '0', [['1', 'On'], ['0', 'Off']]), '') + field('eng-makerEnabled', 'Resting quotes', sel('makerEnabled', cfg.makerEnabled ? '1' : '0', [['1', 'On'], ['0', 'Off']]), '') + '</div>' +
        '<div class="field"><label>Sports</label><div class="chips">' + Object.keys(cfg.sports).map(k => '<label class="chip"><input type="checkbox" data-eng-sport="' + k + '"' + (cfg.sports[k] ? ' checked' : '') + ' style="margin:0"> ' + k + '</label>').join('') + '</div></div>' +
        '<div class="field-row">' + field('eng-env', 'Exchange', sel('env', cfg.env, [['prod', 'Production (real money)'], ['demo', 'Demo exchange']]), 'Demo needs KALSHI_DEMO_KEY_ID / KALSHI_DEMO_PRIVATE_KEY on the Worker.') + field('eng-ntfyTopic', 'Push alerts (ntfy.sh topic)', inp('ntfyTopic', cfg.ntfyTopic || '', 'type="text" placeholder="e.g. adam-edge-desk-7f3k" autocomplete="off"'), 'Install the ntfy app, subscribe to a topic name of your choosing, and type it here. Fills and stops get pushed to your phone.') + '</div>' +
        '<div class="row"><button class="btn primary" data-act="engsave">Save settings</button><span class="faint small" id="eng-save-note">Changes apply on the next tick.' + (on ? '' : ' Bookmakers: ' + esc(cfg.bookmakers)) + '</span></div>' +
        '</div></div>';
      // log
      html += '<div class="section"><h3>Engine log</h3>' + (st.log.length ? '<div class="small" style="display:grid;gap:3px">' + st.log.slice(0, 40).map(l => '<div><span class="faint nowrap">' + U.timeOnly(l.ts) + '</span> <span class="' + (l.level === 'error' ? 'down' : l.level === 'warn' ? 'warn' : '') + '">' + esc(l.msg) + '</span></div>').join('') + '</div>' : '<div class="empty">Nothing logged yet.</div>') + '<div class="row" style="margin-top:8px"><button class="btn sm ghost" data-act="engrefresh">Refresh</button><span class="faint small">' + (st.at ? 'updated ' + U.ago(st.at) + ' ago' : '') + '</span></div></div>';
      html += '<div class="disclaimer">The engine places real orders under your API key when it is running. It is a tool executing the rules above, not a promise of profit; sports edges are small and a losing streak is normal. Keep the caps where a bad week would not matter.</div>';
      box.innerHTML = html;
    }
  });

  // Desk tab integration
  const origRenderDesk = UI.renderDesk.bind(UI);
  UI.renderDesk = function () {
    origRenderDesk();
    const tabs = $('desk-tabs');
    if (tabs && !tabs.querySelector('[data-s="engine"]')) {
      const seg = tabs.querySelector('.seg');
      if (seg) seg.insertAdjacentHTML('beforeend', '<button data-act="desktab" data-s="engine"' + (UI.deskTab === 'engine' ? ' class="on"' : '') + '>Engine' + (Eng.st.status && Eng.st.status.settings && Eng.st.status.settings.enabled ? ' <span class="dot live" style="width:6px;height:6px;margin-left:4px;vertical-align:middle"></span>' : '') + '</button>');
    }
    const eng = $('desk-engine'); if (eng) eng.hidden = UI.deskTab !== 'engine';
    const paper = $('desk-paper'), live = $('desk-live');
    if (UI.deskTab === 'engine') { if (paper) paper.hidden = true; if (live) live.hidden = true; UI.renderEngine(); if (Acct.st.unlocked && (!Eng.st.at || Date.now() - Eng.st.at > 15000)) Eng.refresh(true); }
  };
  // account loop: also refresh engine when its tab is open
  const origOnAccount = UI.onAccount.bind(UI);
  UI.onAccount = function () { origOnAccount(); if (!Acct.st.unlocked) { Eng.st = { known: false, status: null, games: [], bets: [], log: [], error: '', busy: false, at: 0 }; } };
  setInterval(() => { if (Acct.st.unlocked && S.view === 'desk' && UI.deskTab === 'engine' && !document.hidden) Eng.refresh(false); }, 20000);

  function collectSettings() {
    const get = (k) => { const el = document.querySelector('[data-eng="' + k + '"]'); return el ? el.value : undefined; };
    const num = (k, scale) => { const v = U.num(get(k)); return v === null ? undefined : (scale ? v * scale : v); };
    const patch = { bankroll: num('bankroll'), kelly: num('kelly'), maxPerGame: num('maxPerGame'), maxExposure: num('maxExposure'), dailyLoss: num('dailyLoss'), maxOpenGames: num('maxOpenGames'), takerMargin: num('takerMargin', 0.01), makerMargin: num('makerMargin', 0.01), sharpWeight: num('sharpWeight'), maxHoursAhead: num('maxHoursAhead'), takerEnabled: get('takerEnabled') === '1', makerEnabled: get('makerEnabled') === '1', env: get('env'), ntfyTopic: (get('ntfyTopic') || '').trim(), sports: {} };
    document.querySelectorAll('[data-eng-sport]').forEach(cb => { patch.sports[cb.dataset.engSport] = cb.checked; });
    for (const k in patch) if (patch[k] === undefined) delete patch[k];
    return patch;
  }

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act;
    if (act === 'engrefresh') { await Eng.refresh(true); return; }
    if (act === 'engsave') { el.disabled = true; try { await Eng.req('settings', { method: 'POST', body: collectSettings() }); UI.toast('Engine settings saved'); } catch (e) { UI.toast('Could not save: ' + e.message); } await Eng.refresh(false); return; }
    if (act === 'engpreview') { el.disabled = true; el.textContent = 'Running…'; try { await Eng.req('preview', { method: 'POST', body: {}, timeout: 60000 }); UI.toast('Dry run complete'); } catch (e) { UI.toast('Dry run failed: ' + e.message); } await Eng.refresh(true); return; }
    if (act === 'engtick') { el.disabled = true; el.textContent = 'Running…'; try { await Eng.req('tick', { method: 'POST', body: {}, timeout: 60000 }); } catch (e) { UI.toast('Tick failed: ' + e.message); } await Eng.refresh(true); return; }
    if (act === 'engstart') {
      const cfg = Eng.st.status && Eng.st.status.settings; if (!cfg) return;
      const c = $('eng-confirm'); if (!c) return;
      c.innerHTML = '<div class="confirm"><p><b>Real money.</b> The engine will place orders on your ' + (cfg.env === 'demo' ? 'demo' : 'Kalshi') + ' account on its own, every minute, within these limits: up to <b>' + U.money(cfg.maxPerGame) + '</b> per game, <b>' + U.money(cfg.maxExposure) + '</b> in total, and it stops for the day after <b>' + U.money(cfg.dailyLoss) + '</b> of settled losses. Orders also obey the Worker\'s MAX_ORDER caps. You can stop it any time; stopping cancels its resting quotes.</p><div class="actions"><button class="btn sm danger-fill" data-act="engstart2">Start the engine</button><button class="btn sm" data-act="engcancel">Back</button></div></div>';
      return;
    }
    if (act === 'engcancel') { const c = $('eng-confirm'); if (c) c.innerHTML = ''; return; }
    if (act === 'engstart2') { el.disabled = true; try { await Eng.req('toggle', { method: 'POST', body: { enabled: true } }); UI.toast('Engine started'); } catch (e) { UI.toast(e.message); } await Eng.refresh(true); return; }
    if (act === 'engstop') { el.disabled = true; try { await Eng.req('toggle', { method: 'POST', body: { enabled: false, flatten: true }, timeout: 60000 }); UI.toast('Engine stopped; quotes cancelled'); } catch (e) { UI.toast(e.message); } await Eng.refresh(true); if (Acct.st.unlocked) Acct.refresh(); return; }
  });
})();
