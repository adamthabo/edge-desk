const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.EDGE_DESK_ROOT || path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'artifact.html'), 'utf8');
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => { const msg = String(e && e.message || e); if (!/Not implemented: HTMLCanvasElement|Could not load link|Could not parse CSS stylesheet/.test(msg)) errors.push('jsdomError: ' + msg); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => { /* ignore warnings */ });
const dom = new JSDOM('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/edge', virtualConsole: vc,
  beforeParse(window) {
    window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    window.scrollTo = () => {};
  }
});
const { window } = dom;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const $ = (id) => window.document.getElementById(id);
const assert = (cond, msg) => { if (!cond) { errors.push('ASSERT: ' + msg); console.log('FAIL', msg); } else console.log('ok  ', msg); };

(async () => {
  await sleep(1500);
  const S = window.EDS, App = window.EDApp, UI = window.UI;
  assert(S && App && UI, 'app globals exist');
  assert(S.mode === 'sim', 'falls back to sim mode when fetch fails (mode=' + S.mode + ')');
  assert(S.universe.markets.size > 40, 'sim universe loaded (' + S.universe.markets.size + ' markets)');
  assert(S.scanner.ops.length > 0, 'scanner produced ops (' + S.scanner.ops.length + ')');
  // Money is the landing view: locks and spreads, checked against the order books, with paper buttons
  assert(S.view === 'money' && !$('view-money').hidden && $('view-scanner').hidden, 'Money is the landing view');
  assert($('money-locks').querySelectorAll('.card.money').length > 0, 'lock cards render (' + $('money-locks').querySelectorAll('.card.money').length + ')');
  assert(/Locks now/.test($('money-tiles').textContent) && /Spreads to quote/.test($('money-tiles').textContent), 'money tiles render');
  const firstLock = $('money-locks').querySelector('.card.money');
  assert(/(Buy|Sell) the book/.test(firstLock.textContent) && /(locked|right now)/.test(firstLock.textContent) && /My call/.test(firstLock.textContent), 'lock card shows the play, the money and the call');
  assert(!$('money-locks').querySelector('[data-act="mreal"]'), 'no real-money button on simulated data');
  await sleep(700);
  assert(window.EDMoneyState.checks.size >= 1, 'top locks checked against the order books (' + window.EDMoneyState.checks.size + ')');
  assert(/on the live books/.test($('money-locks').textContent), 'live-check status shown on the cards');
  const cash0 = S.desk.cash;
  $('money-locks').querySelector('[data-act="mpaperl"]:not([disabled])').click(); await sleep(30);
  assert(S.desk.cash < cash0 && Object.keys(S.desk.positions).length >= 2, 'paper lock buys every leg (' + Object.keys(S.desk.positions).length + ' positions)');
  const sq = $('money-spreads').querySelector('[data-act="mpaperq"]');
  if (sq) { const before = S.desk.orders.length; sq.click(); await sleep(30); assert(S.desk.orders.length === before + 2 && S.desk.orders.some(o => o.side === 'yes') && S.desk.orders.some(o => o.side === 'no'), 'paper quote rests a bid and an offer'); }
  else console.log('note: no spreads in this sim run');
  App.Desk.reset(S.settings.bankroll); await sleep(10);
  UI.nav('scanner'); await sleep(50);
  assert($('scanner-list').children.length > 0, 'scanner cards rendered (' + $('scanner-list').children.length + ')');
  assert(/Simulated/.test($('st-source').textContent), 'status shows simulated');
  const kinds = new Set(S.scanner.ops.map(o => o.kind));
  console.log('kinds:', Array.from(kinds).join(', '));
  assert(kinds.has('arb'), 'arb detected in sim');

  // markets view
  UI.nav('markets');
  await sleep(50);
  assert($('mk-list').querySelectorAll('.mrow').length > 10, 'market rows rendered');
  $('mk-search').value = 'fed'; $('mk-search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(20);
  assert($('mk-list').querySelectorAll('.mrow').length >= 4 && $('mk-list').querySelectorAll('.mrow').length < 10, 'search filters rows (' + $('mk-list').querySelectorAll('.mrow').length + ')');
  $('mk-search').value = ''; $('mk-search').dispatchEvent(new window.Event('input', { bubbles: true }));
  // click a category chip
  const chip = $('mk-cats').querySelector('button[data-c]:nth-child(2)'); chip.click(); await sleep(20);
  assert($('mk-list').querySelectorAll('.mrow').length > 0, 'category filter works (' + chip.textContent.trim() + ')');

  // tape
  UI.nav('tape'); await sleep(50);
  await App.Engine.pollTape(); await sleep(50);
  assert(S.tape.trades.length > 0, 'tape has trades (' + S.tape.trades.length + ')');
  assert($('tape-list').querySelectorAll('.trow').length > 0, 'tape rows rendered');
  await App.Engine.pollTape(); await sleep(20);
  assert($('tape-list').querySelectorAll('.trow.new').length > 0, 'new tape rows prepended');

  // open a market
  const ticker = S.scanner.ops.find(o => o.kind === 'arb').tickers[0];
  await App.Engine.openMarket(ticker); await sleep(300);
  assert(S.sel === ticker && !$('sheet').hidden, 'sheet opened for ' + ticker);
  assert($('sh-ladder').textContent.includes('¢'), 'ladder rendered');
  assert($('calc-out').textContent.includes('EV'), 'edge calculator rendered');
  assert($('tk-preview').textContent.includes('Total'), 'ticket preview rendered');
  assert($('sh-trades').querySelectorAll('.trow').length > 0, 'recent trades rendered');
  // slider
  $('calc-q').value = '80'; $('calc-q').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert($('calc-q-label').textContent === '80%', 'slider updates belief');
  assert($('calc-out').textContent.includes('contracts') || $('calc-out').textContent.includes('No edge'), 'calc output updates');

  // place paper market order
  const cashBefore = S.desk.cash;
  $('tk-qty').value = '25'; $('tk-qty').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.querySelector('[data-act="place"]').click(); await sleep(20);
  assert(S.desk.cash < cashBefore, 'paper buy reduced cash (' + cashBefore.toFixed(2) + ' -> ' + S.desk.cash.toFixed(2) + ')');
  assert(Object.keys(S.desk.positions).length === 1, 'one position opened');
  // limit order
  window.document.querySelector('[data-act="ttype"][data-s="limit"]').click(); await sleep(20);
  $('tk-price').value = '1'; $('tk-price').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.querySelector('[data-act="place"]').click(); await sleep(20);
  assert(S.desk.orders.length === 1, 'limit order rests (' + S.desk.orders.length + ')');
  // desk view
  UI.nav('desk'); await sleep(50);
  assert($('desk-positions').querySelectorAll('tr').length >= 2, 'positions table rendered');
  assert($('desk-orders').querySelectorAll('tr').length >= 2, 'orders table rendered');
  // sell position
  window.document.querySelector('[data-act="sell"]').click(); await sleep(20);
  assert(Object.keys(S.desk.positions).length === 0, 'position closed');
  assert(S.desk.fills.length === 2, 'two fills recorded');
  // cancel order
  window.document.querySelector('[data-act="cancel"]').click(); await sleep(20);
  assert(S.desk.orders.length === 0, 'order cancelled');
  // paper set from scanner
  UI.nav('scanner'); await sleep(50);
  const ps = window.document.querySelector('[data-act="paperset"]');
  assert(!!ps, 'paper set button exists');
  if (ps) { ps.click(); await sleep(30); assert(Object.keys(S.desk.positions).length >= 2, 'paper set opened legs (' + Object.keys(S.desk.positions).length + ')'); }
  // settlement
  const posKey = Object.keys(S.desk.positions)[0];
  if (posKey) { const pos = S.desk.positions[posKey]; const m = S.universe.markets.get(pos.ticker); App.Desk.settle(pos.ticker, pos.side); assert(!S.desk.positions[posKey], 'settlement closes position'); }
  // refresh tracked + scanner rerun
  await App.Engine.refreshTracked(); await sleep(20);
  assert(true, 'refreshTracked ran');
  // persistence
  const raw = window.localStorage.getItem('edgedesk.v1');
  await sleep(1500);
  const raw2 = window.localStorage.getItem('edgedesk.v1');
  assert(raw2 && JSON.parse(raw2).desk.fills.length >= 2, 'state persisted to localStorage');
  // setup view
  UI.nav('setup'); await sleep(50);
  assert($('setup-form').querySelectorAll('input,select').length > 10, 'setup form rendered');
  $('pollTape').value = '7'; $('pollTape').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(S.settings.pollTape === 7, 'setting applied');
  // watch
  UI.nav('markets'); await sleep(30);
  const wbtn = window.document.querySelector('[data-act="open"].mrow');
  await App.Engine.openMarket(wbtn.dataset.t); await sleep(100);
  window.document.querySelector('#sheet [data-act="watch"]').click(); await sleep(20);
  assert(S.watch.size === 1, 'watchlist add');
  // close sheet
  $('sh-close').click(); assert($('sheet').hidden, 'sheet closes');
  // plain-language layer
  UI.nav('scanner'); await sleep(50);
  assert($('scanner-primer').textContent.includes('New to prediction markets'), 'first-visit primer shown');
  assert(window.document.querySelectorAll('#scanner-list .layer').length > 0 && /My call/.test($('scanner-list').textContent) && window.document.querySelectorAll('#scanner-list .verdict').length > 0 && window.document.querySelectorAll('#scanner-list details.layer-d').length >= 2, 'cards carry My call / Why / math layers (' + window.document.querySelectorAll('#scanner-list .verdict').length + ' verdicts)');
  assert(/My read of the board/.test($('scanner-read').textContent), 'board read line renders');
  const verdicts = Array.from(window.document.querySelectorAll('#scanner-list .verdict')).map(v => v.className.replace('verdict ', ''));
  const order = verdicts.map(v => ({ do: 0, maybe: 1, skip: 2 })[v]); assert(order.every((r, i) => i === 0 || r >= order[i - 1]), 'cards sorted Do it → Maybe → Skip (' + verdicts.join(',') + ')');
  const firstCard = window.document.querySelector('#scanner-list .card .layer-do').textContent; assert(/Buy (NO|YES) on all \d+ outcomes|Quote both sides|Skip|Only|Do not cross|Nothing to do/.test(firstCard), 'first verdict is a concrete instruction: ' + firstCard.slice(0, 90));
  const kb = window.document.querySelector('.kindbtn'); kb.click(); await sleep(20);
  assert(!$('pop').hidden && $('pop').textContent.includes('How it pays'), 'kind popover explains how it pays/loses');
  window.document.body.click(); await sleep(20); assert($('pop').hidden, 'popover closes on outside click');
  window.document.querySelector('[data-act="guide"]').click(); await sleep(20);
  assert(!$('guide').hidden && $('guide-body').textContent.includes('Start here') && $('guide-body').textContent.includes('Neither is smarter') && $('guide-body').querySelectorAll('details').length >= 20, 'Learn opens with layered lessons');
  const anyTerm = window.document.querySelector('#sh-facts [data-term], #scanner-list [data-term], #view-scanner [data-term]');
  if (anyTerm) { anyTerm.click(); await sleep(20); assert(!$('pop').hidden, 'glossary popover works'); window.document.body.click(); }
  window.document.querySelector('[data-act="guideclose"]').click(); assert($('guide').hidden, 'guide closes');
  assert($('scanner-primer').textContent === '', 'primer dismissed after reading guide');
  const midMarket = Array.from(S.universe.markets.values()).find(m => m.mid > 0.3 && m.mid < 0.7 && m.hasBid && m.hasAsk);
  await App.Engine.openMarket(midMarket.ticker); await sleep(200);
  assert($('sh-plain').textContent.includes('odds of'), 'market panel has plain reading of the quote');
  assert(/What to do/.test($('calc-decision').textContent) && (/Buy (YES|NO)/.test($('calc-decision').textContent) || /Nothing to do/.test($('calc-decision').textContent)), 'decision line renders (' + $('calc-decision').textContent.slice(0, 60) + ')');
  $('calc-q').value = '95'; $('calc-q').dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(10);
  assert(/Buy YES/.test($('calc-decision').textContent) && /contracts/.test($('calc-decision').textContent), 'decision says Buy YES at a high belief');
  $('calc-q').value = '3'; $('calc-q').dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(10);
  assert(/Buy NO/.test($('calc-decision').textContent), 'decision says Buy NO at a low belief');
  assert($('sh-facts').querySelectorAll('[data-term]').length >= 6, 'fact labels are tappable terms');
  UI.applySetting('explain', '0'); await sleep(20);
  assert(window.document.querySelectorAll('#scanner-list .layer').length === 0 && $('sh-plain').textContent === '' && $('calc-decision').textContent === '', 'explanations switch off');
  UI.applySetting('explain', '1');
  // hash nav
  window.location.hash = '#tape'; await sleep(50);
  assert(S.view === 'tape', 'hash routing');
  console.log('\nERRORS:', errors.length); errors.forEach(e => console.log(' -', e.slice(0, 400)));
  window.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
