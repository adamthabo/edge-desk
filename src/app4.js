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
  const centsSigned = (v) => (v === null || v === undefined) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '¢';
  const field = (id, labelTxt, inputHtml, help) => '<div class="field"><label for="' + id + '">' + labelTxt + '</label>' + inputHtml + (help ? '<div class="help">' + help + '</div>' : '') + '</div>';
  const inp = (id, val, attrs) => '<input class="inp" id="eng-' + id + '" data-eng="' + id + '" value="' + esc(val) + '" ' + (attrs || '') + '>';
  const sel = (id, val, opts) => '<select class="sel" id="eng-' + id + '" data-eng="' + id + '">' + opts.map(o => '<option value="' + o[0] + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
  const check = (ok, label, detail, optional) => '<div class="row" style="gap:8px;align-items:flex-start"><span class="' + (ok ? 'up' : optional ? 'muted' : 'down') + '" style="font-weight:700;min-width:14px">' + (ok ? '✓' : optional ? '–' : '✗') + '</span><div><div>' + label + '</div>' + (detail ? '<div class="small muted">' + detail + '</div>' : '') + '</div></div>';
  // My call on the engine: what to do next, judged on the closing line, the one scorecard that says something within weeks.
  const NEED = 30;
  function engineCall(s, cfg, stats, on, shadow) {
    const rows = stats.clv || [];
    const n = rows.reduce((a, r) => a + r.n, 0);
    const avg = (f) => n ? rows.reduce((a, r) => a + (f(r) || 0) * r.n, 0) / n : 0;
    const clv = avg(r => r.clv), fee = avg(r => r.fee_pc), net = clv - fee;
    const sg = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '¢', ab = (v) => Math.abs(v * 100).toFixed(1) + '¢';
    const bySport = {}; for (const r of rows) { const k = r.sport || '?'; const b = bySport[k] || (bySport[k] = { n: 0, s: 0, f: 0 }); b.n += r.n; b.s += (r.clv || 0) * r.n; b.f += (r.fee_pc || 0) * r.n; }
    const weak = Object.keys(bySport).filter(k => bySport[k].n >= 15 && (bySport[k].s - bySport[k].f) / bySport[k].n < -0.005);
    const sportLine = Object.keys(bySport).map(k => k + ' ' + sg((bySport[k].s - bySport[k].f) / bySport[k].n) + ' over ' + bySport[k].n).join(' · ');
    const them = weak.length > 1 ? 'them' : 'it', weakTxt = weak.join(' and ');
    const v = (stance, label, text) => ({ stance, label, text, n, clv, fee, net, sportLine });
    if (!s.oddsKey) return v('skip', 'Not yet', 'Add the sharp-lines key first (see Ready? below). Until then the engine has nothing to compare Kalshi against.');
    if (shadow) {
      if (!on && !n) return v('maybe', 'Start on paper', 'Start the shadow run and leave it for a week or two. It trades on paper exactly as it would for real and scores every bet against the closing line. I will make the call here once ' + NEED + ' bets are scored.');
      if (n < NEED) return v('maybe', 'Keep it on paper', n + ' of ' + NEED + ' bets scored so far' + (n ? ', averaging ' + sg(net) + ' against the closing line after fees' : '') + '. Too few to tell skill from luck; let it keep running.');
      if (net >= 0.01) return v('do', 'Ready to go live, small', 'Over ' + n + ' paper bets it beat the closing line by ' + ab(net) + ' a bet after fees' + (weak.length ? ', except in ' + weakTxt + ' (switch ' + them + ' off first)' : '') + '. That is what a real edge looks like. Switch the mode to Live, keep the caps where a bad week would not matter (halving them for the first two weeks is sensible), and check this call again after another ' + NEED + ' bets.');
      if (net >= -0.005) return v('maybe', 'Stay on paper', 'Over ' + n + ' paper bets it is about even with the closing line after fees (' + sg(net) + ' a bet). Even at the close is a slow loss once real fills are a little worse than paper ones. Raise "Take the price when edge beats fees by" to 3 or 4¢ and give it another ' + NEED + ' bets.');
      return v('skip', 'Don\'t go live', 'Over ' + n + ' paper bets it paid ' + ab(-net) + ' more than the closing price after fees, on average. Real money would very likely lose. ' + (weak.length ? 'Switch off ' + weakTxt + ', ' : '') + 'raise the margins and let it run on paper again.');
    }
    if (!on && !n) return v('maybe', 'Your call', 'Live mode, engine off. A dry run shows exactly what it would do right now. If it has not had a run on paper yet, shadow mode first is the cautious route.');
    if (n < NEED) return v('maybe', 'Let it run', (on ? 'Running live. ' : '') + n + ' of ' + NEED + ' bets scored' + (n ? ', averaging ' + sg(net) + ' against the closing line after fees' : '') + '. Judge it on that number once it reaches ' + NEED + ', not on the profit and loss.');
    if (net >= 0.01) return v('do', 'Working; keep it running', 'Over ' + n + ' live bets it beat the closing line by ' + ab(net) + ' a bet after fees' + (weak.length ? ' (' + weakTxt + ' lag' + (weak.length > 1 ? '' : 's') + '; consider switching ' + them + ' off)' : '') + '. If that holds over the next 50, raising the caps one step is reasonable.');
    if (net >= -0.005) return v('maybe', 'Edge is thin', 'About even with the closing line after fees over ' + n + ' live bets (' + sg(net) + ' a bet). Keep the caps where they are and try a wider margin before risking more.');
    return v('skip', 'Stop, or back to paper', 'Over ' + n + ' live bets it paid ' + ab(-net) + ' more than the closing price after fees, on average. Stop it, or switch to shadow mode, until a change of settings shows positive closing-line value on paper.');
  }
  const STATUS_WORDS = { active: 'trading', live: 'started', far: 'too far out', thin: 'thin line', stale: 'lines stale', disputed: 'books disagree', guarded: 'move guard', braked: 'sport paused', unmatched: 'no line' };

  Object.assign(UI, {
    renderEngine() {
      const box = $('desk-engine'); if (!box) return;
      if (!Acct.available()) { box.innerHTML = '<div class="empty">The engine runs inside your Worker on the live site' + (S.ctx === 'artifact' && UI.liveUrl() ? ': <a href="' + esc(UI.liveUrl()) + '" target="_blank" rel="noopener">open the live desk</a>.' : '.') + '</div>'; return; }
      if (!Acct.st.unlocked) { box.innerHTML = '<div class="empty">Unlock your account (Live account tab) to control the engine.</div>'; return; }
      const st = Eng.st;
      if (!st.known) { box.innerHTML = '<div class="empty">Loading the engine…</div>'; Eng.refresh(true); return; }
      if (st.error && !st.status) { box.innerHTML = '<div class="banner danger"><div><p>' + esc(st.error) + '</p>' + (/not bound|redeploy/.test(st.error) ? '<p class="small">The Worker needs one more deploy with the current <code>wrangler.toml</code> (it adds the engine\'s storage and the minute-by-minute schedule). Cloudflare → edge-desk → Deployments → redeploy, or push the repo once more.</p>' : '') + '<div class="actions"><button class="btn sm" data-act="engrefresh">Retry</button></div></div></div>'; return; }
      const s = st.status, cfg = s.settings, last = s.lastTick || {}, stats = s.stats || {}, h = s.health || {};
      const on = !!cfg.enabled;
      const settledAll = (stats.settled || []).reduce((a, r) => ({ n: a.n + r.n, pnl: a.pnl + (r.pnl || 0), wins: a.wins + (r.wins || 0), bs: a.bs + (r.brier_sum || 0), bm: a.bm + (r.brier_mkt || 0), staked: a.staked + (r.staked || 0) }), { n: 0, pnl: 0, wins: 0, bs: 0, bm: 0, staked: 0 });
      const clvAll = (stats.clv || []).reduce((a, r) => ({ n: a.n + r.n, s: a.s + (r.clv || 0) * r.n, f: a.f + (r.fee_pc || 0) * r.n, m: a.m + (r.clv_mkt || 0) * r.n, beat: a.beat + (r.beat || 0) }), { n: 0, s: 0, f: 0, m: 0, beat: 0 });
      const today = (stats.days || [])[0] || { realized: 0, bets: 0 };
      const exitsPnl = (stats.exits && stats.exits.pnl) || 0;
      const brakes = stats.brakes || {}; const braked = Object.keys(brakes);
      const trim = stats.trim || { trim: 1 };
      const shadow = !!cfg.shadow;
      const isDry = !!(last.dry || last.reason === 'preview');
      const tickAge = last.ts ? Date.now() - last.ts : null, stuck = on && !isDry && tickAge !== null && tickAge > 3 * 60000;
      const streak = h.errStreak && h.errStreak.n >= 3 ? h.errStreak : null;
      const ready = s.oddsKey && (shadow || s.kalshiKey !== false);
      let html = '';
      // status header
      html += '<div class="card" style="display:grid;gap:10px;border-color:' + (on ? (shadow ? 'var(--warn)' : 'var(--up)') : 'var(--line)') + '">' +
        '<div class="row" style="justify-content:space-between"><div class="row"><span class="dot ' + (on ? 'live' : '') + '"></span><b>' + (on ? (shadow ? 'Engine running on paper' : 'Engine running live') : 'Engine off') + '</b><span class="chip" style="padding:1px 8px">' + (shadow ? 'Shadow mode' : 'Live mode') + '</span><span class="small muted">' + (last.ts ? (isDry ? 'dry run ' : 'last tick ') + U.ago(last.ts) + ' ago' + (!isDry && last.reason ? ' (' + esc(last.reason) + ')' : '') : 'no tick yet') + (last.note ? ' · ' + esc(last.note) : '') + '</span></div>' +
        '<div class="row">' + (on ? '<button class="btn sm" data-act="engtick">Run a tick now</button><button class="btn sm ' + (shadow ? '' : 'danger-fill') + '" data-act="engstop">Stop' + (shadow ? ' the shadow run' : ' and cancel quotes') + '</button>' : '<button class="btn sm" data-act="engpreview"' + (s.oddsKey ? '' : ' disabled') + '>Dry run</button><button class="btn sm primary" data-act="engstart"' + (ready ? '' : ' disabled') + '>' + (shadow ? 'Start shadow run' : 'Start trading') + '</button>') + '</div></div>' +
        '<div class="row small" style="gap:8px;align-items:center"><span class="muted">Mode</span><select class="sel sm" data-eng-mode style="max-width:360px"' + (on ? ' disabled' : '') + '><option value="shadow"' + (shadow ? ' selected' : '') + '>Shadow: paper only, nothing sent to Kalshi</option><option value="live"' + (!shadow ? ' selected' : '') + '>Live: real orders on your account</option></select>' + (on ? '<span class="muted">Stop the engine to change mode.</span>' : '') + '</div>' +
        (last.errors && last.errors.length ? '<div class="small down">' + last.errors.map(esc).join(' · ') + '</div>' : '') +
        (last.notes && last.notes.length ? '<div class="small warn">' + last.notes.map(esc).join(' · ') + '</div>' : '') +
        '<div class="row small muted" style="gap:14px">' + (last.ts ? '<span>' + (last.matched || 0) + ' games matched · ' + (last.unmatched || 0) + ' unmatched</span><span>' + (isDry ? 'would take ' + (last.taker || 0) + ' · would quote ' + (last.maker || 0) + (last.exits ? ' · would sell ' + last.exits : '') : (last.taker || 0) + ' taken · ' + (last.maker || 0) + ' quoted · ' + (last.exits ? last.exits + ' sold · ' : '') + (last.cancels || 0) + ' cancelled') + (last.guarded ? ' · ' + last.guarded + ' guarded' : '') + '</span>' + (last.exposure !== undefined ? '<span>exposure ' + U.money(last.exposure) + '</span>' : '') + (last.subrequests ? '<span>' + last.subrequests + ' of ' + (h.subMax || 45) + ' requests used in the tick</span>' : '') : '') + '</div>' +
        '<div id="eng-confirm"></div></div>';
      // brakes + trim
      for (const k of braked) { const b = brakes[k]; html += '<div class="banner warn" style="margin-top:10px"><div><p><b>' + esc(k) + ' paused by the engine.</b> ' + esc(b.reason) + '. It keeps watching ' + esc(k) + ' but places nothing until ' + U.dateShort(b.until) + ' unless you resume it. Pausing is the engine admitting it has been on the wrong side of the closing line in this sport; resume only if you know why that will change.</p><div class="actions"><button class="btn sm" data-act="engunbrake" data-s="' + esc(k) + '">Resume ' + esc(k) + '</button></div></div></div>'; }
      if (trim.trim < 1) html += '<div class="banner warn" style="margin-top:10px"><div><p><b>Sizing halved.</b> Over ' + trim.n + ' settled bets the market\'s prices have been better calibrated than the model\'s (Brier ' + trim.market.toFixed(3) + ' vs ' + trim.model.toFixed(3) + '). Every new bet is sized at half until the model catches up; nothing else changes.</p></div></div>';
      // what this means
      const meansWhy = '<p>The engine borrows the sharp books\' probability for each team and only acts on the gap between that and Kalshi\'s price: it buys when Kalshi is clearly too cheap, otherwise it rests a bid below fair value and waits to be paid the spread. What it holds, it offers back above fair value, and sells outright the moment Kalshi pays more than fair: a position that was a 60/40 coin flip becomes a few locked cents and the money goes back to work. It pulls every quote before kickoff and holds the rest to settlement. It sizes by how much it trusts the line (' + P.term('confidence', 'confidence') + '), refuses to act on lines older than ' + cfg.maxOddsAgeMin + ' minutes or after a ' + Math.round(cfg.moveGuard * 100) + '¢ Kalshi move it cannot explain, and scores every fill against the ' + P.term('clv', 'closing line') + '. A sport it keeps getting wrong is paused automatically. The caps below are the whole risk budget; the daily stop ends the day on its own.</p>';
      const meansDeep = '<p>Fair value p* = ' + Math.round((cfg.sharpWeight || 0.8) * 100) + '% books (' + (cfg.devig === 'mult' ? 'multiplicative' : 'power') + ' devig, Pinnacle ×3, sharp ×2, retail ×1, stale books dropped within 3h of kickoff) + ' + Math.round((1 - (cfg.sharpWeight || 0.8)) * 100) + '% Kalshi mid when Kalshi\'s spread is 2¢, shrinking to 0% at 8¢ (the midpoint of a wide spread says little). Confidence: ×0.5 without a sharp book, ×0.5 at ' + Math.round(cfg.maxDisagree * 50) + '¢+ disagreement (blocked at ' + Math.round(cfg.maxDisagree * 100) + '¢), ×0.5 for a sharp line 15–45 min old near kickoff (blocked beyond). Take when ask + fee + ' + Math.round(cfg.takerMargin * 100) + '¢ ≤ p* (fill-or-cancel, ' + (cfg.kelly === 1 ? 'full' : cfg.kelly === 0.5 ? 'half' : cfg.kelly === 0.1 ? 'tenth' : 'quarter') + ' Kelly on $' + cfg.bankroll + ' × confidence, one add per line refresh). Otherwise rest a post-only bid at floor(p* − ' + Math.round(cfg.makerMargin * 100) + '¢ − maker fee). Held contracts carry a reduce-only ask at ceil(p* + ' + Math.round(cfg.makerMargin * 100) + '¢ + fee) and are sold outright when bid − fee ≥ p* + ' + Math.round((cfg.exitMargin === undefined ? 0.02 : cfg.exitMargin) * 100) + '¢. Cancel within ' + cfg.preKickoffSec + 's of kickoff and record the close. Caps: $' + cfg.maxPerGame + ' per game, $' + cfg.maxExposure + ' total, stop at −$' + cfg.dailyLoss + ' settled for the day, ' + cfg.maxOpenGames + ' games with positions. Brake: mean CLV below ' + (cfg.brakeClv * 100).toFixed(1) + '¢ over ' + cfg.brakeMinBets + '+ fills in 30 days pauses the sport ' + cfg.brakeDays + ' days.</p>';
      const call = engineCall(s, cfg, stats, on, shadow);
      const callWhy = '<p>Profit and loss needs hundreds of bets before it separates skill from luck. The ' + P.term('clv', 'closing line') + ' needs tens: it is the sharpest price there is, set minutes before the game by everyone\'s information. An engine that keeps buying below it has better prices than the market, which is what makes money over time; one that keeps buying above it is losing slowly however the results look. Fees are taken off because a price taker pays one on every bet.</p>';
      const callMath = '<p>' + (call.n ? call.n + ' scored bets in the last 30 days' + (shadow ? ' (paper)' : ' (live)') + ': average closing-line value ' + (call.clv >= 0 ? '+' : '−') + Math.abs(call.clv * 100).toFixed(2) + '¢, fees ' + (call.fee * 100).toFixed(2) + '¢ a contract, net ' + (call.net >= 0 ? '+' : '−') + Math.abs(call.net * 100).toFixed(2) + '¢.' + (call.sportLine ? ' By sport, net: ' + esc(call.sportLine) + '.' : '') : 'No scored bets yet.') + ' The call: under ' + NEED + ' bets, keep going; net +1¢ or better, go live small (or keep running); between −0.5¢ and +1¢, stay put and widen the margins; below −0.5¢, stop. A sport below −0.5¢ over 15+ bets is named so you can switch it off.</p>';
      html += '<div style="margin-top:10px">' + P.layer(P.verdictHtml(call), callWhy, callMath, { label: 'My call' }) + '</div>';
      if (stuck) html += '<div class="banner danger" style="margin-top:10px"><div><p><b>No tick has finished for ' + Math.round(tickAge / 60000) + ' minutes.</b> The cron trigger restarts the engine every minute, so a single stall clears itself. If this stays, open Cloudflare → edge-desk → Logs: "exceeded CPU" means the free plan is too small for this many games at once, and the Workers Paid plan ($5 a month) removes the limit; anything else, the log names it.</p></div></div>';
      if (streak) html += '<div class="banner warn" style="margin-top:10px"><div><p><b>The last ' + streak.n + ' ticks failed.</b> ' + esc(streak.last || '') + '. The engine retries every minute' + (shadow ? '.' : ' and stops itself after 30 failures in a row, cancelling its quotes.') + '</p></div></div>';
      html += P.layer('It copies the sharp sportsbooks\' odds, trades only where Kalshi\'s price is off by more than fees, sizes each bet by how much it trusts the line, and scores every bet against the final pre-game price.', meansWhy, meansDeep, { label: 'How it works' });
      // readiness
      const sportsOn = Object.keys(cfg.sports || {}).filter(k => cfg.sports[k]);
      const envName = cfg.env === 'demo' ? 'demo' : 'production';
      const oddsLines = Object.entries(h.odds || {}).map(([k, v]) => k + ': ' + v.events + ' event' + (v.events === 1 ? '' : 's') + ', ' + U.ago(v.at) + ' ago');
      const rem = stats.oddsRemaining, used = stats.oddsUsedToday || 0, daily = stats.oddsBudget;
      let creditDetail = rem === null || rem === undefined ? 'Known after the first fetch.' : U.compact(rem) + ' left · ' + used + ' used today · budget ' + (daily === null || daily === undefined ? '∞' : daily) + ' a day' + (stats.runwayDays ? ' · lasts ~' + stats.runwayDays + ' days at today\'s pace' : '');
      if (rem !== null && rem !== undefined && daily && sportsOn.length) { const minsBetween = Math.round(1440 / (daily / sportsOn.length)); if (minsBetween > cfg.maxOddsAgeMin) creditDetail += '. <b>At this plan each sport can refresh only every ~' + minsBetween + ' minutes, so trading will mostly wait</b> (it needs lines under ' + cfg.maxOddsAgeMin + ' min old). The 20k-credit plan at the-odds-api.com refreshes every 2–5 minutes.'; }
      html += '<div class="section"><h3>Ready?</h3><div style="display:grid;gap:8px">' +
        check(s.oddsKey, 'Sharp-lines key on the Worker', s.oddsKey ? 'ODDS_API_KEY is set.' : 'Create an account at the-odds-api.com, copy the API key, and add it to the Worker as a secret named <code>ODDS_API_KEY</code> (Cloudflare → edge-desk → Settings → Variables and Secrets).') +
        check(s.kalshiKey !== false, 'Kalshi API key for the ' + envName + ' exchange' + (shadow ? ' (not needed in shadow mode)' : ''), s.kalshiKey === false ? 'Kalshi → Account → API keys → create one, then add <code>' + (cfg.env === 'demo' ? 'KALSHI_DEMO_KEY_ID' : 'KALSHI_KEY_ID') + '</code> and <code>' + (cfg.env === 'demo' ? 'KALSHI_DEMO_PRIVATE_KEY' : 'KALSHI_PRIVATE_KEY') + '</code> (the whole PEM file) as Worker secrets. Shadow runs and dry runs work without them.' : 'Set; orders can be signed.', shadow) +
        check(!!(h.odds && Object.keys(h.odds).length), 'Sharp lines loaded', oddsLines.length ? oddsLines.join(' · ') : 'Nothing fetched yet; a dry run or the first tick loads them.') +
        check(rem === null || rem === undefined || rem > 200, 'Sharp-lines credits', creditDetail) +
        check(on && !stuck && h.alarm !== null && h.alarm !== undefined, 'Wakes every minute', !on ? 'Off. Start the engine to begin.' : stuck ? 'No tick has finished for ' + Math.round(tickAge / 60000) + ' minutes; see the note above.' : (h.alarm ? 'Next wake in ' + Math.max(0, Math.round((h.alarm - Date.now()) / 1000)) + 's; the cron trigger restarts it if it ever stops.' : 'Alarm not set; the next cron minute will set it.'), !on) +
        check(!!s.ntfy, 'Push alerts and a daily digest', s.ntfy ? 'Fills, stops, brakes and a 9am digest go to your ntfy topic.' : 'Optional: set an ntfy.sh topic below.', true) +
        '</div></div>';
      // stats
      html += '<div class="small muted" style="margin-top:12px">' + (shadow ? 'Paper results from the shadow run. Switching to live starts a fresh scorecard; the shadow one comes back when you switch back.' : 'Real results. The shadow scorecard is kept separately.') + '</div><div class="tiles" style="margin-top:6px">' +
        '<div class="tile"><div class="label">Today</div><div class="v ' + (today.realized >= 0 ? 'up' : 'down') + '">' + money(today.realized || 0) + '</div><div class="s">' + (today.bets || 0) + ' orders · stop at ' + U.money(-Math.abs(cfg.dailyLoss)) + '</div></div>' +
        '<div class="tile"><div class="label">Settled</div><div class="v ' + (settledAll.pnl + exitsPnl >= 0 ? 'up' : 'down') + '">' + money(settledAll.pnl + exitsPnl) + '</div><div class="s">' + settledAll.n + ' bets · ' + (settledAll.n ? Math.round(settledAll.wins / settledAll.n * 100) + '% won' : '—') + (settledAll.staked ? ' · ROI ' + pct((settledAll.pnl + exitsPnl) / settledAll.staked) : '') + (stats.exits && stats.exits.n ? ' · ' + stats.exits.n + ' sold early' : '') + '</div></div>' +
        '<div class="tile"><div class="label">' + P.term('clv', 'Closing line') + '</div><div class="v ' + (clvAll.n ? (clvAll.s / clvAll.n >= 0 ? 'up' : 'down') : '') + '">' + (clvAll.n ? centsSigned(clvAll.s / clvAll.n) : '—') + '</div><div class="s">' + (clvAll.n ? clvAll.n + ' fills · ' + centsSigned((clvAll.s - clvAll.f) / clvAll.n) + ' after fees · beat the close ' + Math.round(clvAll.beat / clvAll.n * 100) + '% · vs Kalshi ' + centsSigned(clvAll.m / clvAll.n) : 'scores each fill at kickoff; positive means good prices') + '</div></div>' +
        '<div class="tile"><div class="label">Calibration</div><div class="v">' + (settledAll.n ? (settledAll.bs / settledAll.n).toFixed(3) : '—') + '</div><div class="s">Brier vs market ' + (settledAll.n ? (settledAll.bm / settledAll.n).toFixed(3) : '—') + ' (lower is better)' + (stats.methods && stats.methods.n >= 10 ? ' · power ' + (stats.methods.b_pow / stats.methods.n).toFixed(3) + ' vs mult ' + (stats.methods.b_mult / stats.methods.n).toFixed(3) : '') + '</div></div>' +
        '<div class="tile"><div class="label">Open</div><div class="v">' + ((stats.open && stats.open.n) || 0) + '</div><div class="s">' + ((stats.resting && stats.resting.n) || 0) + ' resting quotes · ' + ((stats.open && stats.open.staked) ? U.money(stats.open.staked) + ' staked' : 'nothing staked') + '</div></div></div>';
      if ((stats.clv || []).length > 1) html += '<div class="small muted" style="margin-top:6px">Closing line by sport: ' + Object.entries((stats.clv || []).reduce((a, r) => { const k = r.sport || '?'; a[k] = a[k] || { n: 0, s: 0 }; a[k].n += r.n; a[k].s += (r.clv || 0) * r.n; return a; }, {})).map(([k, v]) => esc(k) + ' ' + centsSigned(v.s / v.n) + ' (' + v.n + ')').join(' · ') + '</div>';
      // games
      const games = st.games.filter(g => g.status !== 'unmatched');
      const unmatched = st.games.filter(g => g.status === 'unmatched');
      html += '<div class="section"><h3>Games in view</h3>' + (games.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>Game</th><th class="r">Kickoff</th><th class="r">Sharp</th><th class="r">Kalshi ask</th><th>Plan</th></tr></thead><tbody>' + games.map(g => {
        const plan = (() => { try { return JSON.parse(g.plan || '[]'); } catch (e) { return []; } })();
        const confTxt = g.conf !== null && g.conf !== undefined && g.conf < 1 ? ' · confidence ' + Math.round(g.conf * 100) + '%' + (g.conf_why ? ' (' + esc(g.conf_why) + ')' : '') : '';
        const planTxt = plan.length ? plan.map(p => '<div><span class="muted">' + esc(p.team.split(' ').pop()) + ':</span> ' + esc(p.text) + (p.pStar !== undefined ? '<details class="layer-d" style="display:inline-block;margin-left:6px"><summary>numbers</summary><div class="layer-body" style="padding-left:0">books ' + pct(p.pSharp) + ' → fair ' + pct(p.pStar) + (p.kw !== undefined ? ' (Kalshi weight ' + Math.round(p.kw * 100) + '%)' : '') + ' · Kalshi bid ' + U.cents(p.bid) + ' / ask ' + U.cents(p.ask) + (p.books ? ' · ' + p.books + ' book' + (p.books > 1 ? 's' : '') : '') + (p.disp !== undefined ? ', disagree ' + (p.disp * 100).toFixed(1) + '¢' : '') + (p.conf !== undefined ? ' · confidence ' + Math.round(p.conf * 100) + '%' + (p.confWhy ? ' (' + esc(p.confWhy) + ')' : '') : '') + (p.trim !== undefined && p.trim < 1 ? ' · trim ×' + p.trim : '') + ' · take if ask + fee + ' + Math.round(cfg.takerMargin * 100) + '¢ ≤ fair; quote at fair − ' + Math.round(cfg.makerMargin * 100) + '¢ − fee</div></details>' : '') + '</div>').join('') : (g.note ? esc(g.note) : '—');
        return '<tr><td><b>' + esc(g.away) + '</b> at <b>' + esc(g.home) + '</b><div class="faint small"><span class="chip" style="padding:1px 6px">' + esc(g.sport) + '</span> <span class="mono">' + esc(g.event_ticker) + '</span> · ' + esc(STATUS_WORDS[g.status] || g.status) + (g.books ? ' · ' + g.books + ' book' + (g.books > 1 ? 's' : '') : '') + confTxt + '</div></td><td class="r nowrap">' + (g.commence_ts ? U.countdown(g.commence_ts) : '—') + '</td><td class="r nowrap">' + (g.p_home !== null ? pct(g.p_home) + ' / ' + pct(g.p_away) : '—') + '</td><td class="r nowrap">' + (g.k_home_ask !== null ? U.cents(g.k_home_ask) + ' / ' + U.cents(g.k_away_ask) : '—') + '</td><td class="small">' + planTxt + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="faint small" style="margin-top:6px">Sharp and ask columns read home / away. A plan line names the team and what the engine did or why it held back.</div>' : '<div class="empty">' + (on || last.ts ? 'No matched games in the next ' + cfg.maxHoursAhead + ' hours for the enabled sports.' : 'Run a dry run to see which games the engine would trade and why.') + '</div>') +
        (unmatched.length ? '<details style="margin-top:8px"><summary class="small muted">' + unmatched.length + ' Kalshi game' + (unmatched.length > 1 ? 's' : '') + ' without a matching sportsbook line</summary><div class="small muted" style="margin-top:6px">' + unmatched.map(g => esc(g.away) + ' vs ' + esc(g.home) + ' <span class="mono">' + esc(g.event_ticker) + '</span>' + (g.note ? ' · ' + esc(g.note) : '')).join('<br>') + '</div></details>' : '') + '</div>';
      // bets
      html += '<div class="section"><h3>Engine bets</h3>' + (st.bets.length ? '<div class="tablewrap"><table class="table"><thead><tr><th>When</th><th>Bet</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fair</th><th class="r">Edge</th><th class="r">CLV</th><th class="r">Status</th><th class="r">P&amp;L</th></tr></thead><tbody>' + st.bets.slice(0, 60).map(b => '<tr><td class="faint nowrap">' + U.dateShort(b.ts) + '</td><td>' + esc(b.team || b.ticker) + ' <span class="faint small">' + esc(b.kind) + (b.action === 'sell' ? ' · sell' : '') + (b.mode === 'shadow' ? ' · shadow' : '') + (b.conf !== null && b.conf !== undefined && b.conf < 1 ? ' · ' + Math.round(b.conf * 100) + '%' : '') + '</span><div class="faint small mono">' + esc(b.ticker) + '</div></td><td class="r">' + (b.fill_count ? U.compact(b.fill_count) + '/' : '') + U.compact(b.count) + '</td><td class="r">' + U.cents(b.price) + '</td><td class="r">' + U.cents(b.p_star) + '</td><td class="r">' + (b.edge !== null ? U.cents(b.edge) : '—') + '</td><td class="r ' + (b.clv === null || b.clv === undefined ? '' : b.clv >= 0 ? 'up' : 'down') + '">' + centsSigned(b.clv) + '</td><td class="r">' + esc(b.status) + (b.result ? ' · ' + esc(b.result).toUpperCase() : '') + '</td><td class="r ' + (b.pnl === null || b.pnl === undefined ? '' : b.pnl >= 0 ? 'up' : 'down') + '">' + (b.pnl === null || b.pnl === undefined ? '—' : money(b.pnl)) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No engine bets yet.</div>') + '</div>';
      // settings
      html += '<div class="section"><h3>Limits and strategy</h3><div class="form">' +
        '<div class="field-row">' + field('eng-bankroll', 'Bankroll the engine sizes against ($)', inp('bankroll', cfg.bankroll, 'type="number" min="10" step="10"'), 'Quarter-Kelly on this number; it never spends more than your actual cash.') + field('eng-kelly', 'Kelly fraction', sel('kelly', cfg.kelly, [['0.5', 'Half'], ['0.25', 'Quarter'], ['0.1', 'Tenth']]), '') + '</div>' +
        '<div class="field-row">' + field('eng-maxPerGame', 'Max per game ($)', inp('maxPerGame', cfg.maxPerGame, 'type="number" min="1" step="1"'), 'Both teams\' positions and quotes count together.') + field('eng-maxExposure', 'Max total exposure ($)', inp('maxExposure', cfg.maxExposure, 'type="number" min="1" step="5"'), '') + '</div>' +
        '<div class="field-row">' + field('eng-dailyLoss', 'Daily loss stop ($)', inp('dailyLoss', cfg.dailyLoss, 'type="number" min="1" step="5"'), 'When settled losses for the day reach this, the engine turns itself off and cancels its quotes.') + field('eng-maxOpenGames', 'Max games with positions', inp('maxOpenGames', cfg.maxOpenGames, 'type="number" min="1" step="1"'), '') + '</div>' +
        '<div class="field-row">' + field('eng-takerMargin', 'Take the price when edge beats fees by (¢)', inp('takerMargin', Math.round(cfg.takerMargin * 100), 'type="number" min="0" max="20"'), 'Higher means fewer, surer trades.') + field('eng-makerMargin', 'Rest bids this far under fair value (¢)', inp('makerMargin', Math.round(cfg.makerMargin * 100), 'type="number" min="1" max="20"'), 'The spread you ask to be paid for waiting.') + '</div>' +
        '<div class="field-row">' + field('eng-sharpWeight', 'Trust in the sportsbooks vs Kalshi', sel('sharpWeight', cfg.sharpWeight, [['1', 'Books only'], ['0.8', '80% books, 20% Kalshi'], ['0.6', '60 / 40'], ['0.5', 'Even']]), '') + field('eng-devig', 'How the books\' margin is removed', sel('devig', cfg.devig || 'power', [['power', 'Power (longshot carries more of it)'], ['mult', 'Multiplicative (spread evenly)']]), 'Power matches how sharp books price; the Calibration tile compares both over time.') + '</div>' +
        '<div class="field-row">' + field('eng-maxOddsAgeMin', 'Stop trading when lines are older than (min)', inp('maxOddsAgeMin', cfg.maxOddsAgeMin, 'type="number" min="2" max="120"'), 'Quotes are pulled too. Protects you when the feed is down or credits run out.') + field('eng-moveGuard', 'Move guard (¢)', inp('moveGuard', Math.round(cfg.moveGuard * 100), 'type="number" min="1" max="20"'), 'A Kalshi move this big since the lines were fetched pulls quotes and forces a refresh before acting.') + '</div>' +
        '<div class="field-row">' + field('eng-maxHoursAhead', 'Trade games starting within (hours)', inp('maxHoursAhead', cfg.maxHoursAhead, 'type="number" min="1" max="168"'), 'Lines firm up close to kickoff.') + field('eng-brakeMinBets', 'Pause a sport after this many fills with negative closing-line value', inp('brakeMinBets', cfg.brakeMinBets, 'type="number" min="5" max="200"'), 'Trailing 30 days; the pause lasts ' + cfg.brakeDays + ' days or until you resume it.') + '</div>' +
        '<div class="field-row">' + field('eng-takerEnabled', 'Taking prices', sel('takerEnabled', cfg.takerEnabled ? '1' : '0', [['1', 'On'], ['0', 'Off']]), '') + field('eng-makerEnabled', 'Resting quotes', sel('makerEnabled', cfg.makerEnabled ? '1' : '0', [['1', 'On'], ['0', 'Off']]), '') + '</div>' +
        '<div class="field-row">' + field('eng-exitEnabled', 'Selling out before kickoff', sel('exitEnabled', cfg.exitEnabled === false ? '0' : '1', [['1', 'On'], ['0', 'Off (hold everything to settlement)']]), 'Held contracts get a reduce-only ask above fair value; when Kalshi\'s bid clears fair by the margin, they are sold outright and the profit is banked.') + field('eng-exitMargin', 'Sell when the bid beats fair by (¢, after fees)', inp('exitMargin', Math.round((cfg.exitMargin === undefined ? 0.02 : cfg.exitMargin) * 100), 'type="number" min="0" max="20"'), 'Lower turns positions over faster; higher holds for more.') + '</div>' +
        '<div class="field"><label>Sports</label><div class="chips">' + Object.keys(cfg.sports).map(k => '<label class="chip"><input type="checkbox" data-eng-sport="' + k + '"' + (cfg.sports[k] ? ' checked' : '') + ' style="margin:0"> ' + k + (brakes[k] ? ' (paused)' : '') + '</label>').join('') + '</div></div>' +
        '<div class="field-row">' + field('eng-env', 'Exchange', sel('env', cfg.env, [['prod', 'Production (real money)'], ['demo', 'Demo exchange']]), 'Demo needs KALSHI_DEMO_KEY_ID / KALSHI_DEMO_PRIVATE_KEY on the Worker.') + field('eng-ntfyTopic', 'Push alerts (ntfy.sh topic)', inp('ntfyTopic', cfg.ntfyTopic || '', 'type="text" placeholder="e.g. adam-edge-desk-7f3k" autocomplete="off"'), 'Install the ntfy app, subscribe to a topic name of your choosing, and type it here. Fills, stops, brakes and the daily digest get pushed to your phone.') + '</div>' +
        '<div class="field-row">' + field('eng-digestHour', 'Daily digest hour (0–23)', inp('digestHour', cfg.digestHour === undefined ? 9 : cfg.digestHour, 'type="number" min="0" max="23"'), 'In your timezone.') + field('eng-timezone', 'Timezone', inp('timezone', cfg.timezone || 'America/New_York', 'type="text" autocomplete="off"'), 'An IANA name such as America/New_York.') + '</div>' +
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
    const patch = { bankroll: num('bankroll'), kelly: num('kelly'), maxPerGame: num('maxPerGame'), maxExposure: num('maxExposure'), dailyLoss: num('dailyLoss'), maxOpenGames: num('maxOpenGames'), takerMargin: num('takerMargin', 0.01), makerMargin: num('makerMargin', 0.01), sharpWeight: num('sharpWeight'), maxHoursAhead: num('maxHoursAhead'), takerEnabled: get('takerEnabled') === '1', makerEnabled: get('makerEnabled') === '1', exitEnabled: get('exitEnabled') !== '0', exitMargin: num('exitMargin', 0.01), env: get('env'), ntfyTopic: (get('ntfyTopic') || '').trim(), devig: get('devig'), maxOddsAgeMin: num('maxOddsAgeMin'), moveGuard: num('moveGuard', 0.01), brakeMinBets: num('brakeMinBets'), digestHour: num('digestHour'), timezone: (get('timezone') || '').trim() || undefined, sports: {} };
    document.querySelectorAll('[data-eng-sport]').forEach(cb => { patch.sports[cb.dataset.engSport] = cb.checked; });
    for (const k in patch) if (patch[k] === undefined) delete patch[k];
    return patch;
  }

  document.addEventListener('change', async (ev) => {
    const el = ev.target.closest('[data-eng-mode]'); if (!el) return;
    const toShadow = el.value === 'shadow'; el.disabled = true;
    try { const r = await Eng.req('settings', { method: 'POST', body: { shadow: toShadow } }); UI.toast(toShadow ? 'Shadow mode: start a shadow run when ready; nothing is sent to Kalshi' : 'Live mode: Start trading will place real orders after you confirm' + (r && r.switched ? '' : '')); }
    catch (e) { UI.toast('Could not switch mode: ' + e.message); }
    await Eng.refresh(true);
  });
  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act;
    if (act === 'engrefresh') { await Eng.refresh(true); return; }
    if (act === 'engsave') { el.disabled = true; try { await Eng.req('settings', { method: 'POST', body: collectSettings() }); UI.toast('Engine settings saved'); } catch (e) { UI.toast('Could not save: ' + e.message); } await Eng.refresh(false); return; }
    if (act === 'engpreview') { el.disabled = true; el.textContent = 'Running…'; try { await Eng.req('preview', { method: 'POST', body: {}, timeout: 60000 }); UI.toast('Dry run complete'); } catch (e) { UI.toast('Dry run failed: ' + e.message); } await Eng.refresh(true); return; }
    if (act === 'engtick') { el.disabled = true; el.textContent = 'Running…'; try { await Eng.req('tick', { method: 'POST', body: {}, timeout: 60000 }); } catch (e) { UI.toast('Tick failed: ' + e.message); } await Eng.refresh(true); return; }
    if (act === 'engunbrake') { el.disabled = true; try { await Eng.req('unbrake', { method: 'POST', body: { sport: el.dataset.s } }); UI.toast(el.dataset.s + ' resumed'); } catch (e) { UI.toast(e.message); } await Eng.refresh(true); return; }
    if (act === 'engstart') {
      const cfg = Eng.st.status && Eng.st.status.settings; if (!cfg) return;
      if (cfg.shadow) { el.disabled = true; try { await Eng.req('toggle', { method: 'POST', body: { enabled: true } }); UI.toast('Shadow run started: paper only, scored against the closing line'); } catch (e) { UI.toast(e.message); } await Eng.refresh(true); return; }
      const c = $('eng-confirm'); if (!c) return;
      c.innerHTML = '<div class="confirm"><p><b>Real money.</b> The engine will place orders on your ' + (cfg.env === 'demo' ? 'demo' : 'Kalshi') + ' account on its own, every minute, within these limits: up to <b>' + U.money(cfg.maxPerGame) + '</b> per game, <b>' + U.money(cfg.maxExposure) + '</b> in total, and it stops for the day after <b>' + U.money(cfg.dailyLoss) + '</b> of settled losses. Orders also obey the Worker\'s MAX_ORDER caps. You can stop it any time; stopping cancels its resting quotes.</p><div class="actions"><button class="btn sm danger-fill" data-act="engstart2">Start the engine</button><button class="btn sm" data-act="engcancel">Back</button></div></div>';
      return;
    }
    if (act === 'engcancel') { const c = $('eng-confirm'); if (c) c.innerHTML = ''; return; }
    if (act === 'engstart2') { el.disabled = true; try { await Eng.req('toggle', { method: 'POST', body: { enabled: true } }); UI.toast('Engine started'); } catch (e) { UI.toast(e.message); } await Eng.refresh(true); return; }
    if (act === 'engstop') { el.disabled = true; const sh = Eng.st.status && Eng.st.status.settings && Eng.st.status.settings.shadow; try { await Eng.req('toggle', { method: 'POST', body: { enabled: false, flatten: true }, timeout: 60000 }); UI.toast(sh ? 'Shadow run stopped' : 'Engine stopped; quotes cancelled'); } catch (e) { UI.toast(e.message); } await Eng.refresh(true); if (Acct.st.unlocked) Acct.refresh(); return; }
  });
})();
