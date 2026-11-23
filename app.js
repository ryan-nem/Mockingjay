/* Mockingjay app — Round 1
 * Talks to the league's Apps Script (config.js → API_URL) with the player's
 * private link token. Shows the last data instantly from this device, then
 * refreshes in the background. Saves show right away and undo themselves if
 * the server says no. All names and picks are inserted as text, never HTML. */
(function () {
  'use strict';

  var API_URL = (window.MJ_CONFIG || {}).API_URL;
  var LS = { token: 'mj_token', cache: 'mj_cache_v1', install: 'mj_install_dismissed', tab: 'mj_tab', opp: 'mj_compare' };
  var BT_LABEL = { ML: 'Moneyline', Spread: 'Spread', OU: 'Total' };
  var BT_SHORT = { ML: 'ML', Spread: 'SPR', OU: 'O/U' };
  var PLAYER_COLORS = ['#3DDC97', '#F5B451', '#7AA7FF', '#F07AB4', '#B79CFF', '#5ED3E6', '#FF8A65', '#C5E063'];

  var state = { token: null, data: null, tab: 'picks', loading: false, lastLoad: 0, opp: null, installEvt: null };

  // ---------- small helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the page's security policy
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function $(id) { return document.getElementById(id); }
  function money(n, opts) {
    opts = opts || {};
    if (n === null || n === undefined || isNaN(n)) return '—';
    var a = Math.abs(n);
    var dec = opts.whole || (a >= 1000 && !opts.cents) ? 0 : 2;
    var s = '$' + a.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    if (opts.signed) return (n > 0.004 ? '+' : n < -0.004 ? '−' : '') + s;
    return (n < -0.004 ? '−' : '') + s;
  }
  function pct(x) { return x === null || x === undefined ? '—' : Math.round(x * 100) + '%'; }
  function signPct(x) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function cls(n) { return n > 0.004 ? 'up' : n < -0.004 ? 'down' : 'even'; }
  function oddsNum(t) { var m = String(t || '').match(/[+-]?\d+/); return m ? Number(m[0]) : null; }
  function paysOut(o) { o = Number(o); return o > 0 ? o / 100 : 100 / Math.abs(o); }
  function toast(msg, bad) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast'; }, bad ? 4200 : 2000);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function colorFor(name) {
    var s = state.data && state.data.standings;
    var idx = 0;
    if (s && s.players) { var p = s.players.filter(function (x) { return x.name === name; })[0]; if (p) idx = p.slot; }
    return PLAYER_COLORS[idx % PLAYER_COLORS.length];
  }
  function avatar(name) { return h('span', { class: 'avatar', style: 'background:' + colorFor(name), 'aria-hidden': 'true' }, String(name || '?').slice(0, 1).toUpperCase()); }

  // ---------- platform ----------
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  var isStandalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (!isIOS) {
    // Android/Chrome installs from the manifest. iPhone uses the page URL instead,
    // so the Home Screen icon keeps the player's private link.
    var link = document.createElement('link'); link.rel = 'manifest'; link.href = 'manifest.webmanifest'; document.head.appendChild(link);
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); state.installEvt = e; if (state.tab === 'picks') render(); });

  // ---------- token ----------
  function readToken() {
    var params = new URLSearchParams(location.search);
    var t = params.get('t');
    if (t && /^[A-Za-z0-9]{32,128}$/.test(t)) { lsSet(LS.token, t); return t; }
    var saved = lsGet(LS.token);
    if (saved && !t && !isIOS) {
      // keep the link in the address bar so a later "Add to Home Screen" carries it
      try { history.replaceState(null, '', location.pathname + '?t=' + saved); } catch (e) { /* ignore */ }
    }
    return saved;
  }

  // ---------- API ----------
  function api(action, payload) {
    var body = Object.assign({ action: action, token: state.token }, payload || {});
    return fetch(API_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('The league server didn\'t answer (' + r.status + '). Try again.'); return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Something went wrong.'); return j.data; });
  }

  function load(opts) {
    opts = opts || {};
    if (state.loading) return Promise.resolve();
    state.loading = true;
    $('refresh').classList.add('spin');
    return api('bootstrap').then(function (d) {
      state.data = d; state.lastLoad = Date.now();
      lsSet(LS.cache, JSON.stringify({ at: Date.now(), token: state.token, data: d }));
      render();
    }).catch(function (err) {
      if (!state.data) renderError(err.message);
      else if (!opts.quiet) toast(err.message, true);
    }).then(function () { state.loading = false; $('refresh').classList.remove('spin'); });
  }

  function mergeFresh(d) {
    // save/remove answers skip standings (unchanged until grading); keep ours
    if (!d.standings && state.data) d.standings = state.data.standings;
    state.data = d; state.lastLoad = Date.now();
    lsSet(LS.cache, JSON.stringify({ at: Date.now(), token: state.token, data: d }));
  }

  // ---------- chrome ----------
  function renderChrome() {
    var d = state.data;
    if (!d) return;
    $('funds-value').textContent = money(d.funds.available, { whole: true });
    $('weekbar').hidden = false;
    $('week-label').textContent = d.weekLabel;
    var m = $('meter'); m.textContent = '';
    var used = d.board.used, max = d.board.max;
    for (var i = 0; i < max; i++) m.appendChild(h('i', { class: i < used ? 'on' : '' }));
    m.appendChild(document.createTextNode(' ' + used + ' of ' + max));
    m.setAttribute('aria-label', used + ' of ' + max + ' wagers used');
    document.querySelectorAll('.tabbar button').forEach(function (b) {
      if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function render() {
    renderChrome();
    var v = $('view'); v.textContent = '';
    if (!state.data) { for (var i = 0; i < 4; i++) v.appendChild(h('div', { class: 'skel' })); return; }
    var fn = { picks: renderPicks, week: renderWeek, chat: renderChat, standings: renderStandings, stats: renderStats }[state.tab] || renderPicks;
    add(v, fn());
  }

  function renderError(msg) {
    var v = $('view'); v.textContent = '';
    v.appendChild(h('div', { class: 'empty' }, h('h2', { text: 'Couldn\'t load the league' }), h('p', { text: msg }),
      h('button', { class: 'btn primary', type: 'button', onclick: function () { load(); } }, 'Try again')));
  }

  function renderNoToken() {
    $('weekbar').hidden = true;
    var v = $('view'); v.textContent = '';
    v.appendChild(h('div', { class: 'empty' },
      h('h2', { text: 'Open your personal link' }),
      h('p', { text: 'Mockingjay opens from the private link Ryan sent you. Tap it on this phone and the app will remember you.' })));
  }

  // ---------- install card ----------
  function installCard() {
    if (isStandalone || lsGet(LS.install) === '1') return null;
    var dismiss = h('button', { class: 'x', type: 'button', 'aria-label': 'Dismiss', onclick: function () { lsSet(LS.install, '1'); render(); } }, '×');
    if (isIOS) {
      return h('div', { class: 'card install' }, h('div', { class: 'notice' },
        h('div', null,
          h('h3', { text: 'Add Mockingjay to your Home Screen' }),
          h('p', { class: 'muted small', text: 'It opens full screen, like a real app, and stays signed in.' }),
          h('ol', null,
            h('li', null, 'Tap ', h('b', { text: 'Share' }), ' (the square with the arrow) in Safari'),
            h('li', null, 'Scroll down and tap ', h('b', { text: 'Add to Home Screen' })),
            h('li', null, 'Tap ', h('b', { text: 'Add' }), ', then open Mockingjay from your Home Screen'))),
        dismiss));
    }
    if (state.installEvt) {
      return h('div', { class: 'card install' }, h('div', { class: 'notice' },
        h('div', null, h('h3', { text: 'Install Mockingjay' }), h('p', { class: 'muted small', text: 'Opens full screen from your Home Screen.' }),
          h('button', { class: 'btn primary', type: 'button', style: 'margin-top:8px', onclick: function () {
            var e = state.installEvt; state.installEvt = null; e.prompt(); e.userChoice.then(function () { render(); });
          } }, 'Install app')),
        dismiss));
    }
    return null;
  }

  // ---------- Picks ----------
  function renderPicks() {
    var d = state.data, b = d.board;
    var out = [installCard()];
    if (!b.games.length) {
      out.push(h('div', { class: 'empty' }, h('h2', { text: d.week === 22 ? 'Super Bowl lines coming soon' : 'No games yet' }),
        h('p', { text: d.week === 22 ? 'The Super Bowl board opens once the books post lines.' : 'This week\'s games appear after the next odds refresh.' })));
      return out;
    }
    if (b.movedCount) out.push(h('div', { class: 'card notice', style: 'margin-top:10px;border-color:#5a4520' },
      h('span', { class: 'pill amber', text: 'Line moved' }),
      h('span', { class: 'small muted', text: b.movedCount + (b.movedCount === 1 ? ' of your bets has' : ' of your bets have') + ' a new line. Your locked line still counts; tap the game to update.' })));
    var lastDay = null;
    b.games.forEach(function (g) {
      if (g.dayLabel !== lastDay) { out.push(h('div', { class: 'day', text: g.dayLabel })); lastDay = g.dayLabel; }
      out.push(gameCard(g));
    });
    return out;
  }

  /** This week's result for one of my bets: {status, net, toWin} or null. */
  function resultFor(gameId, bt) {
    var tw = state.data && state.data.thisWeek;
    if (!tw) return null;
    return tw.mine.filter(function (b) { return b.gameId === gameId && b.betType === bt; })[0] || null;
  }
  function resultText(r) {
    if (!r) return null;
    if (r.status === 'win') return { cls: 'up', text: 'Won ' + money(r.net, { cents: true }) };
    if (r.status === 'loss') return { cls: 'down', text: 'Lost ' + money(Math.abs(r.net), { cents: true }) };
    if (r.status === 'push') return { cls: 'even', text: 'Push · refunded' };
    if (r.toWin) return { cls: 'even', text: (r.status === 'live' ? 'Live · to win ' : 'To win ') + money(r.toWin, { cents: true }) };
    return null;
  }

  function priceOf(g, bt, side) {
    var m = g.markets[bt]; if (!m) return null;
    var o = m.options.filter(function (x) { return x.side === side; })[0];
    return o ? o : null;
  }

  function gameCard(g) {
    var cells = function (side, label) {
      var ml = priceOf(g, 'ML', side), sp = priceOf(g, 'Spread', side);
      return [h('span', { class: 'tn', text: label }), h('span', { class: 'od', text: sp ? sp.lineText : '—' }), h('span', { class: 'od', text: ml ? ml.priceText : '—' }),
        h('span', { class: 'od', text: side === 'Away' ? (g.markets.OU ? 'O ' + g.markets.OU.options[0].lineText : '—') : (g.markets.OU ? 'U ' + g.markets.OU.options[1].lineText : '—') })];
    };
    var badges = [];
    if (g.started) badges.push(h('span', { class: 'pill gray', text: 'Locked' }));
    if (g.anyMoved && !g.started) badges.push(h('span', { class: 'pill amber', text: 'Line moved' }));
    if (g.anyBet) badges.push(h('span', { class: 'pill mint', text: 'Your pick' }));
    var mine = [];
    ['ML', 'Spread', 'OU'].forEach(function (bt) {
      var bet = g.bets[bt]; if (!bet) return;
      var rt = resultText(resultFor(g.id, bt));
      mine.push(h('div', { class: 'my-bet' }, h('span', { text: BT_SHORT[bt] + ' · ' + bet.pickText }),
        h('span', { class: 'my-amt num' }, h('span', { text: money(bet.wager, { cents: true }) }), rt ? h('span', { class: 'my-res ' + rt.cls, text: rt.text }) : null)));
    });
    return h('button', { class: 'game' + (g.anyBet ? ' mine' : '') + (g.started ? ' locked' : ''), type: 'button', onclick: function () { openGame(g.id); } },
      h('div', { class: 'game-top' }, h('span', { class: 'game-time', text: g.timeLabel || g.dayLabel }), h('span', { style: 'display:flex;gap:6px' }, badges)),
      h('div', { class: 'teams' },
        h('span', { class: 'hd', style: 'text-align:left' }, ''), h('span', { class: 'hd', text: 'Spread' }), h('span', { class: 'hd', text: 'ML' }), h('span', { class: 'hd', text: 'Total' }),
        cells('Away', g.away), cells('Home', g.home)),
      mine.length ? h('div', { class: 'my-bets' }, mine) : null);
  }

  // ---------- game sheet ----------
  function closeSheet() { var s = $('sheet'); s.hidden = true; s.textContent = ''; }
  function openGame(gameId) {
    var g = state.data.board.games.filter(function (x) { return x.id === gameId; })[0];
    if (!g) return;
    var s = $('sheet'); s.textContent = ''; s.hidden = false;
    var panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': g.away + ' at ' + g.home });
    panel.appendChild(h('div', { class: 'grab' }));
    panel.appendChild(h('div', { class: 'sheet-head' },
      h('div', null, h('h2', { text: g.away + ' @ ' + g.home }), h('div', { class: 'muted small', text: g.dayLabel + (g.timeLabel ? ' · ' + g.timeLabel : '') + (g.started ? ' · locked at kickoff' : '') })),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '×')));
    ['ML', 'Spread', 'OU'].forEach(function (bt) { panel.appendChild(marketBlock(g, bt)); });
    s.appendChild(panel);
    s.onclick = function (e) { if (e.target === s) closeSheet(); };
  }

  function marketBlock(g, bt) {
    var m = g.markets[bt], bet = g.bets[bt];
    var wrap = h('div', { class: 'market' }, h('h3', null, h('span', { text: BT_LABEL[bt] }), bet ? h('span', { class: 'pill mint', text: 'Your bet' }) : null));
    if (!m) { wrap.appendChild(h('div', { class: 'muted small', text: 'Lines not posted yet.' })); return wrap; }
    var sel = { side: bet ? bet.side : null };
    var opts = h('div', { class: 'opts' });
    var editor = h('div');
    m.options.forEach(function (o) {
      var btn = h('button', { class: 'opt', type: 'button', 'aria-pressed': sel.side === o.side ? 'true' : 'false', disabled: g.started,
        onclick: function () { sel.side = o.side; opts.querySelectorAll('.opt').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); btn.setAttribute('aria-pressed', 'true'); drawEditor(); } },
        h('span', { class: 'ol', text: o.label + (o.lineText ? ' ' + o.lineText : '') }), h('span', { class: 'op', text: o.priceText }));
      opts.appendChild(btn);
    });
    wrap.appendChild(opts);
    wrap.appendChild(editor);

    function drawEditor() {
      editor.textContent = '';
      if (g.started) {
        if (bet) {
          var rt = resultText(resultFor(g.id, bt));
          editor.appendChild(h('div', { class: 'payout' }, 'Locked: ', h('b', { text: bet.pickText }), ' · ' + money(bet.wager, { cents: true }) + ' bet',
            rt ? h('div', { class: 'my-res ' + rt.cls, style: 'margin-top:4px', text: rt.text }) : null));
        }
        return;
      }
      if (!sel.side) return;
      var o = priceOf(g, bt, sel.side);
      var sameSide = bet && bet.side === sel.side;
      var lockedPrice = sameSide ? oddsNum(bet.pickText.match(/\(([^)]*)\)\s*$/) ? bet.pickText.match(/\(([^)]*)\)\s*$/)[1] : '') : null;
      var price = lockedPrice !== null ? lockedPrice : oddsNum(o.priceText);
      var box = h('div', { class: 'wager' });
      var input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Wager amount', value: bet ? String(bet.wager) : '' });
      var payout = h('div', { class: 'payout' });
      var err = h('div', { class: 'err', role: 'alert' });
      var avail = state.data.funds.available + (bet ? bet.wager : 0);
      function amount() { var v = Number(String(input.value).replace(/[$,\s]/g, '')); return isFinite(v) ? v : NaN; }
      function updatePayout() {
        var a = amount();
        payout.textContent = '';
        if (a > 0 && price) add(payout, ['To win ', h('b', { text: money(a * paysOut(price), { cents: true }) }), ' · returns ' + money(a + a * paysOut(price), { cents: true })]);
        else payout.textContent = 'Available: ' + money(avail, { cents: true });
      }
      input.addEventListener('input', function () { err.textContent = ''; updatePayout(); });
      box.appendChild(h('label', { text: (sameSide ? 'Your wager on ' : 'Wager on ') + o.label + (o.lineText ? ' ' + o.lineText : '') + ' (' + (sameSide ? bet.pickText.replace(/^.*\(/, '').replace(')', '') : o.priceText) + ')' }));
      box.appendChild(h('div', { class: 'amount' }, h('span', { text: '$' }), input));
      var chips = h('div', { class: 'chips' });
      [100, 250, 500, 1000].forEach(function (n) { chips.appendChild(h('button', { class: 'chip', type: 'button', onclick: function () { input.value = String(n); err.textContent = ''; updatePayout(); } }, '$' + n.toLocaleString())); });
      box.appendChild(chips);
      box.appendChild(payout);
      box.appendChild(err);
      var actions = h('div', { class: 'actions' });
      actions.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: function () {
        var a = amount();
        if (!(a > 0)) { err.textContent = 'Enter a wager above $0.'; return; }
        if (a > avail + 0.004) { err.textContent = 'You have ' + money(avail, { cents: true }) + ' available.'; return; }
        var used = state.data.board.used, max = state.data.board.max;
        if (!bet && used >= max) { err.textContent = 'You\'ve placed all ' + max + ' wagers this week. Remove one first.'; return; }
        saveBet(g, bt, sel.side, Math.round(a * 100) / 100, false);
      } }, bet ? (sameSide ? 'Update wager' : 'Switch pick') : 'Place bet'));
      if (bet) actions.appendChild(h('button', { class: 'btn danger', type: 'button', onclick: function () { removeBet(g, bt); } }, 'Remove'));
      box.appendChild(actions);
      if (bet && sameSide && bet.movement) {
        box.appendChild(h('div', { class: 'moved' }, h('div', { text: 'Line moved: ' + bet.movement.deltaText + '. Now ' + bet.movement.nowText + '.' }),
          h('button', { class: 'btn', type: 'button', onclick: function () { saveBet(g, bt, sel.side, bet.wager, true); } }, 'Update to current line')));
      }
      editor.appendChild(box);
      updatePayout();
    }
    drawEditor();
    return wrap;
  }

  // ---------- optimistic saves ----------
  function saveBet(g, bt, side, wager, relock) {
    var before = clone(state.data);
    var d = state.data;
    var game = d.board.games.filter(function (x) { return x.id === g.id; })[0];
    var existing = game.bets[bt];
    var o = priceOf(game, bt, side);
    var keepText = existing && existing.side === side && !relock;
    game.bets[bt] = { pickText: keepText ? existing.pickText : (o.label + (o.lineText ? ' ' + o.lineText : '') + ' (' + o.priceText + ')'), side: side, wager: wager, locked: true, movement: null };
    if (!existing) d.board.used++;
    game.anyBet = true;
    d.funds.available = Math.round((d.funds.available + (existing ? existing.wager : 0) - wager) * 100) / 100;
    closeSheet(); render(); toast(relock ? 'Updated to the current line' : 'Bet saved');
    api('save', { gameId: g.id, betType: bt, side: side, wager: wager, relock: relock })
      .then(function (fresh) { mergeFresh(fresh); render(); })
      .catch(function (err) { state.data = before; render(); toast(err.message, true); });
  }

  function removeBet(g, bt) {
    var before = clone(state.data);
    var d = state.data;
    var game = d.board.games.filter(function (x) { return x.id === g.id; })[0];
    var existing = game.bets[bt];
    if (!existing) return;
    game.bets[bt] = null; d.board.used = Math.max(0, d.board.used - 1);
    game.anyBet = !!(game.bets.ML || game.bets.Spread || game.bets.OU);
    d.funds.available = Math.round((d.funds.available + existing.wager) * 100) / 100;
    closeSheet(); render(); toast('Bet removed');
    api('remove', { gameId: g.id, betType: bt })
      .then(function (fresh) { mergeFresh(fresh); render(); })
      .catch(function (err) { state.data = before; render(); toast(err.message, true); });
  }

  // ---------- This Week ----------
  function statusPill(st, net) {
    if (st === 'win') return h('span', { class: 'pill mint', text: 'Won ' + money(net, { signed: true, cents: true }) });
    if (st === 'loss') return h('span', { class: 'pill red', text: 'Lost ' + money(Math.abs(net), { cents: true }) });
    if (st === 'push') return h('span', { class: 'pill gray', text: 'Push' });
    if (st === 'live') return h('span', { class: 'pill amber', text: 'Live' });
    return h('span', { class: 'pill gray', text: 'Locked in' });
  }

  function renderWeek() {
    var d = state.data, tw = d.thisWeek;
    var mine = tw.mine;
    var stake = 0, toWin = 0, net = 0;
    mine.forEach(function (b) { if (b.status === 'locked' || b.status === 'live') { stake += b.wager; toWin += b.toWin || 0; } if (b.net !== null) net += b.net; });
    var out = [h('div', { class: 'section-title', text: 'Your ' + d.weekLabel.replace(/^Week/, 'week') })];
    out.push(h('div', { class: 'summary' },
      h('div', null, h('span', { text: 'Wagers' }), h('b', { text: d.board.used + ' of ' + d.board.max })),
      h('div', null, h('span', { text: 'At stake' }), h('b', { class: 'num', text: money(stake, { whole: true }) })),
      h('div', null, h('span', { text: 'Settled' }), h('b', { class: 'num ' + cls(net), text: money(net, { signed: true, whole: true }) }))));
    if (!mine.length) {
      out.push(h('div', { class: 'card', style: 'margin-top:10px' }, h('p', { class: 'muted', style: 'margin:0', text: 'No bets yet this week. Pick a game on the Picks tab.' })));
    } else {
      var card = h('div', { class: 'card', style: 'margin-top:10px' });
      mine.forEach(function (b) {
        card.appendChild(h('div', { class: 'wk-row' },
          h('div', { class: 'wk-main' }, h('div', { class: 'wk-pick', text: b.pickText }), h('div', { class: 'wk-sub', text: BT_LABEL[b.betType] + ' · ' + b.matchup + ' · ' + b.when })),
          h('div', { class: 'wk-amt' }, h('div', { class: 'num', text: money(b.wager, { cents: true }) }),
            b.toWin && (b.status === 'locked' || b.status === 'live') ? h('div', { class: 'wk-sub', text: 'to win ' + money(b.toWin, { cents: true }) }) : null,
            h('div', { style: 'margin-top:4px' }, statusPill(b.status, b.net)))));
      });
      out.push(card);
    }
    out.push(h('div', { class: 'section-title', text: 'Everyone\'s picks' }));
    out.push(h('p', { class: 'muted small', style: 'margin:-4px 4px 10px', text: 'Picks stay hidden until each game kicks off.' }));
    tw.games.forEach(function (g) {
      var others = g.picks;
      if (!g.started && !g.hiddenCount) return;
      var card = h('div', { class: 'card', style: 'margin-bottom:10px' },
        h('div', { class: 'game-top' }, h('b', { text: g.matchup }), h('span', { class: 'game-time', text: g.when })));
      if (!g.started) {
        card.appendChild(h('div', { class: 'muted small', text: '🔒 ' + g.hiddenCount + (g.hiddenCount === 1 ? ' player has' : ' players have') + ' a pick here — revealed at kickoff' }));
      } else if (!others.length) {
        card.appendChild(h('div', { class: 'muted small', text: 'Nobody bet this game.' }));
      } else {
        others.forEach(function (b) {
          card.appendChild(h('div', { class: 'wk-row' },
            h('div', { class: 'wk-main', style: 'display:flex;gap:10px;align-items:center' }, avatar(b.player),
              h('div', null, h('div', { class: 'reveal-player', text: b.player }), h('div', { class: 'wk-pick', text: b.pickText }), h('div', { class: 'wk-sub', text: BT_LABEL[b.betType] }))),
            h('div', { class: 'wk-amt' }, h('div', { class: 'num', text: money(b.wager, { cents: true }) }), h('div', { style: 'margin-top:4px' }, statusPill(b.status, b.net)))));
        });
      }
      out.push(card);
    });
    return out;
  }

  // ---------- Chat (Round 2) ----------
  function renderChat() {
    return h('div', { class: 'card soon', style: 'margin-top:10px' },
      h('div', { class: 'bubble' }, h('span', { style: 'font-size:28px', 'aria-hidden': 'true' }, '💬')),
      h('h2', { text: 'Smack talk is coming' }),
      h('p', { class: 'muted', text: 'Group chat with notifications lands in the next update. Picks revealed at kickoff and nightly results will post here automatically.' }));
  }

  // ---------- Standings ----------
  function standingsOrEmpty() {
    var s = state.data.standings;
    if (!s || !s.players || !s.lastGradedWeek) return null;
    return s;
  }

  function renderStandings() {
    var s = standingsOrEmpty(), me = state.data.player;
    if (!s) return h('div', { class: 'empty' }, h('h2', { text: 'No results yet' }), h('p', { text: 'Standings appear after the first graded bets.' }));
    var P = s.players;
    var leader = P[0], second = P[1];
    var gap = second ? leader.bankroll - second.bankroll : 0;
    var others = P.slice(1).map(function (p, i) { return i === 0 ? p.name + ' is chasing' : p.name + ' is ' + money(leader.bankroll - p.bankroll, { whole: true }) + ' back'; });
    var label = s.weekLabels && s.weekLabels[s.lastGradedWeek] ? s.weekLabels[s.lastGradedWeek] : 'Week ' + s.lastGradedWeek;
    var gradedCount = P.reduce(function (n, p) { return n + p.bets; }, 0);
    var out = [h('div', { class: 'lead' },
      h('div', { class: 'eyebrow', text: 'Through ' + label }),
      h('h2', { text: gap > 0.004 ? leader.name + ' leads by ' + money(gap, { cents: true }) : 'All square at the top' }),
      h('p', { text: others.join(', ') + '.' }),
      h('div', { class: 'lead-stats' },
        h('div', null, h('span', { text: 'Total pot' }), h('b', { class: 'num', text: money(s.pot, { whole: true }) })),
        h('div', null, h('span', { text: 'Vs. start' }), h('b', { class: 'num ' + cls(s.pot - s.start * P.length), text: money(s.pot - s.start * P.length, { signed: true, cents: true }) })),
        h('div', null, h('span', { text: 'Bets graded' }), h('b', { class: 'num', text: String(gradedCount) }))))];
    out.push(h('div', { class: 'section-title', text: 'Leaderboard · started at ' + money(s.start, { whole: true }) }));
    P.forEach(function (p) {
      var st = p.streak && p.streak.kind ? (p.streak.kind === 'w' ? 'W' : 'L') + p.streak.n : '—';
      var hot = p.streak && p.streak.kind === 'w' && p.streak.n >= 3;
      out.push(h('button', { class: 'player' + (p.name === me ? ' me' : ''), type: 'button', onclick: function () { state.opp = p.name === me ? null : p.name; lsSet(LS.opp, state.opp || ''); go('stats'); } },
        h('div', { class: 'p-top' },
          h('span', { class: 'rank' + (p.rank === 1 ? ' first' : ''), text: String(p.rank) }),
          avatar(p.name),
          h('div', { style: 'min-width:0' }, h('div', { class: 'p-name' }, p.name, p.name === me ? h('span', { class: 'pill mint', text: 'You' }) : null),
            h('div', { class: 'p-sub', text: p.lastWeekNet === null ? 'Sat out ' + label.replace(/^Week/, 'week') : label + ': ' + money(p.lastWeekNet, { signed: true, cents: true }) })),
          h('div', { class: 'p-money' }, h('b', { class: 'num', text: money(p.bankroll, { whole: true }) }), h('span', { class: 'pill ' + (p.delta >= 0 ? 'mint' : 'red'), text: money(p.delta, { signed: true, cents: Math.abs(p.delta) < 1000 }) }))),
        h('div', { class: 'p-grid' },
          h('div', null, h('span', { text: 'Record' }), h('b', { text: p.record.w + '-' + p.record.l + (p.record.p ? '-' + p.record.p : '') })),
          h('div', null, h('span', { text: 'Win %' }), h('b', { text: pct(p.winPct) })),
          h('div', null, h('span', { text: 'ROI' }), h('b', { class: cls(p.roi || 0), text: signPct(p.roi) })),
          h('div', null, h('span', { text: 'Streak' }), h('b', { text: (hot ? '🔥 ' : '') + st })))));
    });
    out.push(h('p', { class: 'muted small', style: 'text-align:center', text: 'Tap a player to compare stats head to head. Updated ' + (s.updated || '') }));
    return out;
  }

  // ---------- Stats ----------
  function typeWinPct(t) { var d = t.w + t.l; return d ? t.w / d : null; }
  function avgOf(arr) { var v = arr.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }

  function renderStats() {
    var s = standingsOrEmpty(), meName = state.data.player;
    if (!s) return h('div', { class: 'empty' }, h('h2', { text: 'No stats yet' }), h('p', { text: 'Stats appear after the first graded bets.' }));
    var P = s.players;
    var me = P.filter(function (p) { return p.name === meName; })[0] || P[0];
    var others = P.filter(function (p) { return p.name !== me.name; });
    if (state.opp && !others.some(function (p) { return p.name === state.opp; })) state.opp = null; // null = just my stats
    var opp = P.filter(function (p) { return p.name === state.opp; })[0] || null;
    var lg = {
      bankroll: avgOf(P.map(function (p) { return p.bankroll; })),
      winPct: avgOf(P.map(function (p) { return p.winPct; })),
      roi: avgOf(P.map(function (p) { return p.roi; })),
      ML: avgOf(P.map(function (p) { return typeWinPct(p.byType.ML || { w: 0, l: 0 }); })),
      Spread: avgOf(P.map(function (p) { return typeWinPct(p.byType.Spread || { w: 0, l: 0 }); })),
      Total: avgOf(P.map(function (p) { return typeWinPct(p.byType.Total || { w: 0, l: 0 }); }))
    };

    var out = [h('div', { class: 'section-title', text: opp ? 'Head to head' : 'Your stats' })];
    if (others.length) {
      var select = h('select', { 'aria-label': 'Compare with', onchange: function (e) { state.opp = e.target.value || null; lsSet(LS.opp, state.opp || ''); render(); } });
      var none = h('option', { value: '', text: 'Just me' }); if (!opp) none.selected = true; select.appendChild(none);
      others.forEach(function (p) { var o = h('option', { value: p.name, text: 'vs ' + p.name }); if (opp && p.name === opp.name) o.selected = true; select.appendChild(o); });
      out.push(h('div', { class: 'vs' }, h('b', { text: me.name + (opp ? ' (you)' : '') }), select));
    }

    var rows = [
      ['Bankroll', me.bankroll, opp && opp.bankroll, lg.bankroll, function (v) { return money(v, { whole: true }); }, 1],
      ['Season +/−', me.delta, opp && opp.delta, null, function (v) { return money(v, { signed: true, whole: true }); }, 1],
      ['Win %', me.winPct, opp && opp.winPct, lg.winPct, pct, 1],
      ['ROI', me.roi, opp && opp.roi, lg.roi, signPct, 1],
      ['Moneyline win %', typeWinPct(me.byType.ML), opp && typeWinPct(opp.byType.ML), lg.ML, pct, 1],
      ['Spread win %', typeWinPct(me.byType.Spread), opp && typeWinPct(opp.byType.Spread), lg.Spread, pct, 1],
      ['O/U Total win %', typeWinPct(me.byType.Total), opp && typeWinPct(opp.byType.Total), lg.Total, pct, 1],
      ['Bets graded', me.bets, opp && opp.bets, null, String, 0]
    ];
    var table = h('table', { class: 'h2h' }, h('thead', null, h('tr', null, h('th', { text: '' }), h('th', { text: 'You' }), opp ? h('th', { text: opp.name }) : null, h('th', { text: 'League' }))));
    var tb = h('tbody');
    rows.forEach(function (r) {
      var a = r[1], b = r[2], fmt = r[4], compare = r[5];
      var aWin = compare && opp && a !== null && b !== null && a > b + 1e-9;
      var bWin = compare && opp && a !== null && b !== null && b > a + 1e-9;
      tb.appendChild(h('tr', null, h('td', { text: r[0] }),
        h('td', { class: aWin ? 'win' : '', text: a === null ? '—' : fmt(a) }),
        opp ? h('td', { class: bWin ? 'win' : '', text: b === null || b === undefined ? '—' : fmt(b) }) : null,
        h('td', { class: 'lg', text: r[3] === null || r[3] === undefined ? '' : fmt(r[3]) })));
    });
    var streakTxt = function (p) { return p.streak && p.streak.kind ? (p.streak.kind === 'w' ? 'W' : 'L') + p.streak.n : '—'; };
    tb.appendChild(h('tr', null, h('td', { text: 'Streak' }), h('td', { text: streakTxt(me) }), opp ? h('td', { text: streakTxt(opp) }) : null, h('td', { class: 'lg', text: '' })));
    table.appendChild(tb);
    out.push(h('div', { class: 'card', style: 'margin-top:10px' }, table));

    out.push(h('div', { class: 'section-title', text: 'Bankroll over the season' }));
    out.push(h('div', { class: 'card chart' }, bankrollChart(s, me, opp)));

    out.push(h('div', { class: 'section-title', text: 'Your highlights' }));
    var types = ['ML', 'Spread', 'Total'].map(function (t) { var x = me.byType[t] || { w: 0, l: 0, net: 0, wagered: 0 }; return { t: t, net: x.net, roi: x.wagered ? x.net / x.wagered : null, n: x.w + x.l + (x.p || 0) }; }).filter(function (x) { return x.n > 0; });
    types.sort(function (a, b) { return b.net - a.net; });
    var label = function (t) { return t === 'ML' ? 'Moneyline' : t === 'Total' ? 'O/U Total' : t; };
    out.push(h('div', { class: 'hl' },
      hlBox('Biggest win', me.best ? money(me.best.net, { signed: true, cents: true }) : '—', me.best ? me.best.pick + ' · wk ' + me.best.week : ''),
      hlBox('Biggest loss', me.worst ? money(me.worst.net, { signed: true, cents: true }) : '—', me.worst ? me.worst.pick + ' · wk ' + me.worst.week : ''),
      hlBox('Best bet type', types.length ? label(types[0].t) : '—', types.length ? money(types[0].net, { signed: true, whole: true }) + ' · ROI ' + signPct(types[0].roi) : ''),
      hlBox('Toughest bet type', types.length > 1 ? label(types[types.length - 1].t) : '—', types.length > 1 ? money(types[types.length - 1].net, { signed: true, whole: true }) : '')));
    return out;
  }
  function hlBox(t, v, sub) { return h('div', null, h('span', { text: t }), h('b', { text: v }), sub ? h('small', { text: sub }) : null); }

  function bankrollChart(s, me, opp) {
    var W = 340, H = 200, L = 46, R = 12, T = 12, B = 26;
    var series = s.players.map(function (p) { return p.series; });
    var all = [].concat.apply([], series);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var pad = Math.max(200, (hi - lo) * 0.12); lo -= pad; hi += pad;
    var n = Math.max(2, series[0].length);
    var x = function (i) { return L + (W - L - R) * i / (n - 1); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Bankroll by week for every player' });
    // grid + labels
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var v = lo + (hi - lo) * i / steps;
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#262D37', 'stroke-width': 1 }));
      var t = svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#6B7480' }); t.textContent = '$' + (v / 1000).toFixed(1) + 'k'; svg.appendChild(t);
    }
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(s.start), y2: y(s.start), stroke: '#4A5260', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
    [0, n - 1].forEach(function (i) { var t = svgEl('text', { x: x(i), y: H - 8, 'text-anchor': i ? 'end' : 'start', 'font-size': 10, fill: '#6B7480' }); t.textContent = i ? 'Wk ' + (n - 1) : 'Start'; svg.appendChild(t); });
    var order = s.players.slice().sort(function (a, b) { var r = function (p) { return p.name === me.name ? 2 : opp && p.name === opp.name ? 1 : 0; }; return r(a) - r(b); });
    order.forEach(function (p) {
      var isMe = p.name === me.name, isOpp = opp && p.name === opp.name;
      var pts = p.series.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: isMe ? '#3DDC97' : isOpp ? '#F5B451' : '#4A5260', 'stroke-width': isMe ? 3 : isOpp ? 2.5 : 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      var last = p.series[p.series.length - 1];
      if (isMe || isOpp) svg.appendChild(svgEl('circle', { cx: x(p.series.length - 1), cy: y(last), r: 4, fill: isMe ? '#3DDC97' : '#F5B451' }));
    });
    var legend = h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:#3DDC97' }), 'You'),
      opp ? h('span', null, h('i', { style: 'background:#F5B451' }), opp.name) : null,
      s.players.length > 2 ? h('span', null, h('i', { style: 'background:#4A5260' }), 'Rest of league') : null,
      h('span', null, h('i', { style: 'background:#4A5260;height:1px;border-top:1px dashed #6B7480' }), 'Starting bankroll'));
    var wrap = h('div'); wrap.appendChild(svg); wrap.appendChild(legend);
    return wrap;
  }

  // ---------- navigation ----------
  function go(tab) {
    state.tab = tab; lsSet(LS.tab, tab);
    window.scrollTo(0, 0);
    render();
  }
  document.querySelectorAll('.tabbar button').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.tab); }); });
  $('refresh').addEventListener('click', function () { load(); });
  $('funds').addEventListener('click', function () {
    var f = state.data && state.data.funds; if (!f) return;
    toast('Bankroll ' + money(f.bankroll, { cents: true }) + ' · ' + money(f.open, { cents: true }) + ' in open bets');
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.token && Date.now() - state.lastLoad > 60000) load({ quiet: true });
  });

  // ---------- start ----------
  state.token = readToken();
  var savedTab = lsGet(LS.tab);
  if (savedTab && /^(picks|week|chat|standings|stats)$/.test(savedTab)) state.tab = savedTab;
  state.opp = lsGet(LS.opp) || null;
  if (!state.token) { renderNoToken(); return; }
  try {
    var cached = JSON.parse(lsGet(LS.cache) || 'null');
    if (cached && cached.token === state.token && cached.data && cached.data.player) { state.data = cached.data; }
  } catch (e) { /* ignore bad cache */ }
  render();
  load({ quiet: !!state.data });
})();
