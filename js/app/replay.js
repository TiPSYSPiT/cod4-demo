/* Replay controller: the ONE playback state both views share - time (C4.Playback), range
 * (whole match / one round), player visibility, the selected player, hover and the display
 * options. It owns the controls bar, the timeline, the team panel and the kill & bomb feed,
 * and draws the active view (2D or 3D) on every frame. Switching views keeps all of it. */
import { upperBound } from './match.js';

const C4 = window.C4;
const { el, clear, fmtTime, icon } = C4.ui;
const CFG = C4.mapConfig;
const PF = C4.collect.PF;
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

export class Replay {
  /** dom: {viewport, controls, teams, feed, head (the drawer's header: round and status)} */
  constructor(match, app, dom) {
    this.match = match;
    this.d = match.d;
    this.app = app;
    this.dom = dom;
    this.views = {};
    this.view = null;
    const d = this.d;
    // display state shared by both views
    this.selected = new Set(d.players.filter(p => p.team === 'A' || p.team === 'B').map(p => p.client));
    if (!this.selected.size) for (const p of d.players) this.selected.add(p.client);
    this.focus = null;               // the selected player: highlighted in both views, followed by the 3D camera
    this.selection = { a: null, b: null };   // the export range markers on the timeline (I / O)
    this.hover = null;               // player under the mouse in the team panel
    this.opts = { labels: true, lastKnown: false, trails: true, killLines: true, grenadeKinds: new Set(['smoke', 'frag', 'flash', 'concussion', 'other']) };
    this.scope = -1;
    this.base = 0;
    this.listeners = new Set();
    this.pb = new C4.Playback(t => this.frame(t));
    this.pb.active = true;
    this.buildControls();
    this.buildTeamPanel();
    this.setScope(-1);
  }

  /* ---------- views ---------- */
  addView(view) { this.views[view.key] = view; }
  /** drop a view (destroyed); the active one leaves nothing shown until the next setView */
  removeView(key) {
    const v = this.views[key];
    if (!v) return;
    if (this.view === v) this.view = null;
    delete this.views[key];
    if (v.destroy) v.destroy();
  }
  setView(key) {
    const v = this.views[key];
    if (!v || v === this.view) return;
    if (this.view) this.view.hide();
    this.view = v;
    v.show();
    this.emit('view');
    this.pb.invalidate();
  }

  /** change notifications for views and panels: 'focus' | 'selection' | 'options' | 'scope' | 'view' */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }

  setFocus(cl) {
    this.focus = this.focus === cl ? null : cl;
    if (this.focus != null) this.selected.add(this.focus);
    this.emit('focus');
    this.pb.invalidate();
  }
  setHover(cl) { if (this.hover !== cl) { this.hover = cl; this.pb.invalidate(); } }
  setOption(key, value) { this.opts[key] = value; this.emit('options'); this.pb.invalidate(); }
  invalidate() { this.pb.invalidate(); }

  /** the players drawn: the visible ones plus the hovered and the selected player */
  shownPlayers() {
    const s = new Set(this.selected);
    if (this.hover != null) s.add(this.hover);
    if (this.focus != null) s.add(this.focus);
    return s;
  }

  /** seek to t (ms); switches to the whole match if t is outside the current round */
  seek(t, dir) { this.pb.seek(t, dir); }
  gotoEvent(t, roundIndex) {
    const d = this.d;
    const ri = roundIndex != null && roundIndex >= 0 ? roundIndex : C4.events.roundAt(d.rounds, t);
    if (this.scope >= 0 && this.scope !== ri) this.setScope(ri >= 0 ? ri : -1);
    this.pb.seek(Math.max(this.pb.range[0], t));
    this.pb.invalidate();
  }

  /* ---------- controls + timeline ---------- */
  buildControls() {
    const d = this.d, M = this.match;
    const scopeSel = el('select', { class: 'scope', title: 'Replay range', onchange: e => this.setScope(Number(e.target.value)) }, el('option', { value: '-1' }, 'Whole match'));
    d.rounds.forEach((r, i) => scopeSel.append(el('option', { value: String(i) },
      (r.kind === 'knife' ? 'Knife round' : r.kind === 'prematch' ? 'Pre-match round' : r.kind === 'aftermatch' ? 'Aftermatch' : 'Round ' + r.label) + '  (' + fmtTime(M.live[i]) + ')')));
    this.scopeSel = scopeSel;
    const playBtn = el('button', { class: 'big', title: 'Play / pause (Space)', 'aria-label': 'Play / pause', onclick: () => this.pb.toggle() }, icon('play'));
    this.playBtn = playBtn;
    const speedSel = el('select', { title: 'Playback speed', 'aria-label': 'Playback speed', onchange: e => { this.pb.speed = Number(e.target.value); } },
      CFG.SPEEDS.map(s => el('option', { value: String(s), selected: s === 1 ? 'selected' : null }, s + '×')));
    this.timeNow = el('span', { class: 'clock-now' });
    this.timeTotal = el('small');
    this.clockSub = el('div', { class: 'clock-sub' });
    const tlBox = el('div', { class: 'timeline' });
    this.timeline = new C4.Timeline(tlBox, (t, dir) => this.pb.seek(t, dir));
    this.exportBtn = el('button', { class: 'pill acc', title: 'Export the current view as MP4 or GIF', onclick: () => this.view && this.view.exportVideo && this.view.exportVideo() }, icon('download', 's'), 'Export video');
    // start / end markers of the export range (keys I / O; clicking a set marker's button again clears it)
    const mark = (which, label, title) => el('button', { class: 'pill mark', title, 'aria-label': title, 'aria-pressed': 'false', onclick: () => this.setMark(which) }, label);
    this.markBtns = { a: mark('a', '[', 'Export range: start at the current time (I) - again to clear'), b: mark('b', ']', 'Export range: end at the current time (O) - again to clear') };
    clear(this.dom.controls).append(
      el('div', { class: 'play' },
        el('button', { class: 'ib', title: '−5 s (←)', 'aria-label': 'Back 5 seconds', onclick: () => this.pb.seek(this.pb.t - CFG.SEEK_STEP_MS, -1) }, icon('back')),
        playBtn,
        el('button', { class: 'ib', title: '+5 s (→)', 'aria-label': 'Forward 5 seconds', onclick: () => this.pb.seek(this.pb.t + CFG.SEEK_STEP_MS, 1) }, icon('fwd'))),
      el('div', { class: 'clock', 'aria-live': 'off' }, this.timeNow, ' ', this.timeTotal, this.clockSub),
      tlBox,
      el('div', { class: 'bar-r' },
        el('label', { class: 'pill range-pill' }, el('small', null, 'Range'), scopeSel),
        el('label', { class: 'pill' }, speedSel),
        el('span', { class: 'marks' }, this.markBtns.a, this.markBtns.b), this.exportBtn));

    // shared display options (both views): the Layers popover of the rail (main.js)
    const sw = (label, key, title, small) => C4.ui.switchRow(label,
      el('input', { type: 'checkbox', checked: this.opts[key] || null, onchange: e => this.setOption(key, e.target.checked) }), { title, small });
    const nades = el('div', { class: 'grp', title: 'The thrower of a grenade is not in the demo, so grenades are shown for all players. Smoke size and duration are display constants.' },
      el('h4', null, 'Grenades'));
    for (const kind of ['smoke', 'frag', 'flash']) {
      const c = CFG.GRENADE[kind];
      nades.append(C4.ui.switchRow(c.label, el('input', { type: 'checkbox', checked: true, onchange: e => {
        if (e.target.checked) this.opts.grenadeKinds.add(kind); else this.opts.grenadeKinds.delete(kind);
        this.emit('options'); this.pb.invalidate();
      } }), { dot: c.color }));
    }
    this.layersPanel = { key: 'layers', title: 'Layers', hint: '2D and 3D', icon: 'layers',
      node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' },
          sw('Names', 'labels'), sw('Trails', 'trails', 'Last ' + CFG.TRAIL_MS / 1000 + ' s of movement', 'last ' + CFG.TRAIL_MS / 1000 + ' s'),
          sw('Kill lines', 'killLines', 'Line from killer to victim for 5 s after a kill'),
          sw('Last known position', 'lastKnown', 'Players the server stopped sending are drawn hollow at their last known position (same life only)')),
        nades) };
  }

  setScope(i) {
    const d = this.d, M = this.match;
    this.scope = i;
    this.scopeSel.value = String(i);
    const mw = d.meta.mapWindow || { start: 0, end: d.meta.durationMs };
    const range = i < 0 ? [mw.start, mw.end] : [M.live[i], Math.min(d.rounds[i].segEnd, mw.end)];
    this.base = i < 0 ? 0 : M.live[i];
    this.pb.skips = i < 0 ? M.countdowns : [];
    this.pb.setRange(range[0], range[1]);
    if (i >= 0 || this.pb.t < range[0] || this.pb.t > range[1]) this.pb.seek(range[0]);
    // timeline: the rounds as segments (underlined in the winner's colour once over), kills as ticks
    // (the blue team's above the bar, the red team's below), bomb plants / defuses, halftimes
    const markers = [], app = this.app;
    d.rounds.forEach((r, k) => {
      if (i >= 0 && k !== i) return;
      markers.push({ kind: 'seg', t: M.live[k], t1: Math.min(r.segEnd, mw.end), end: r.end != null ? r.end : r.segEnd,
        color: r.winnerTeam === 'A' || r.winnerTeam === 'B' ? app.teamColor(r.winnerTeam) : null });
    });
    for (const k of d.kills) markers.push({ t: k.t, kind: 'kill', up: k.attackerTeam === app.blueTeam, color: k.world || k.suicide ? app.teamColor('spectator') : app.teamColor(k.attackerTeam) });
    for (const e of d.events) {
      if (e.type === 'bomb_planted') markers.push({ t: e.t, kind: 'bomb' });
      if (e.type === 'bomb_defused') markers.push({ t: e.t, kind: 'defuse' });
    }
    if (i < 0) for (const t of d.halftimes || []) markers.push({ t: t.t != null ? t.t : t, kind: 'half' });
    this.timeline.set(range, markers, { skips: this.pb.skips, base: this.base });
    this.buildFeed(range);
    this.emit('scope');
    this.pb.invalidate();
  }

  /** set the export range's start ('a') or end ('b') to the current time; the same time again clears it */
  setMark(which, t = this.pb.t) {
    const s = this.selection;
    s[which] = s[which] === t ? null : t;
    if (s.a != null && s.b != null && s.b < s.a) { const x = s.a; s.a = s.b; s.b = x; }
    for (const k of ['a', 'b']) { this.markBtns[k].classList.toggle('active', s[k] != null); this.markBtns[k].setAttribute('aria-pressed', String(s[k] != null)); }
    this.timeline.setSelection(s);
    this.emit('selection-range');
  }

  /* ---------- kill & bomb feed (side panel) ---------- */
  buildFeed(range) {
    const d = this.d, box = this.dom.feed;
    clear(box);
    this.evItems = [];
    this.evCurrent = -1;
    const items = [];
    for (const k of d.kills) if (k.t >= range[0] && k.t <= range[1]) items.push({ t: k.t, kill: k });
    for (const e of d.events) if ((e.type === 'bomb_planted' || e.type === 'bomb_defused') && e.t >= range[0] && e.t <= range[1]) items.push({ t: e.t, ev: e });
    items.sort((a, b) => a.t - b.t);
    for (const it of items) {
      const node = el('div', { class: 'map-ev future', title: 'Jump to 2 s before', onclick: () => this.pb.seek(it.t - 2000) },
        el('span', { class: 'time' }, fmtTime(it.t - this.base)),
        C4.ui.phaseBadge(C4.rounds.phaseAt(d.phases, it.t)),
        el('span', { class: 'tl-what' }, it.kill ? C4.ui.killNodes(this.app, it.kill) : el('span', { style: { color: 'var(--warn)' } }, it.ev.text)));
      box.append(node);
      this.evItems.push({ t: it.t, node });
    }
    if (!items.length) box.append(el('div', { class: 'empty' }, 'No kills or bomb events in this range.'));
  }

  /* ---------- team panel: players of the round at the playback time ---------- */
  buildTeamPanel() {
    const d = this.d, app = this.app, box = this.dom.teams, head = this.dom.head;
    clear(box);
    clear(head);
    const withPos = p => !!d.positions[p.client];
    const title = el('b', { class: 'rp-title' }), status = el('span', { class: 'rp-status' });
    const all = d.players.filter(withPos).map(p => p.client);
    const setAll = (cls, on) => { for (const cl of cls) { if (on) this.selected.add(cl); else this.selected.delete(cl); } this.emit('selection'); this.pb.invalidate(); };
    this.statsCtx = { app, data: d, time: () => this.pb.t, roundAt: t => this.match.roundAtOrBefore(t), onChange: () => this.pb.invalidate() };
    // (how to use it: the header's tooltip, not a permanent line)
    head.append(el('div', { class: 'rp-head-text', title: 'Click a player to select them (highlighted in 2D and 3D; the 3D follow camera uses the selection). The eye shows or hides a player.' }, title, status),
      el('div', { class: 'rp-tools' },
        el('button', { class: 'chip-btn', title: 'Show every player', onclick: () => setAll(all, true) }, 'All'),
        el('button', { class: 'chip-btn', title: 'Hide every player', onclick: () => setAll(all, false) }, 'None')));
    this.rp = { title, status, cards: [], rows: new Map() };
    const addCard = (key, name, ps, color) => {
      const score = el('span', { class: 'rp-score', title: 'rounds won' }), side = el('small', { class: 'rp-side' }), alive = el('span', { class: 'rp-alive' });
      const rows = el('div', { class: 'rp-rows' });
      const card = el('div', { class: 'rp-card', style: { '--tc': color } },
        el('div', { class: 'th' },
          key ? app.teamMark(key) : null,
          el('span', { class: 'rp-team-name', role: 'button', tabindex: '0', title: name + ' - click: show / hide the whole team',
            onclick: () => setAll(ps.map(p => p.client), !ps.every(p => this.selected.has(p.client))),
            onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); } } }, name),
          side, key ? score : null, alive),
        el('div', { class: 'rp-row rp-cols', 'aria-hidden': 'true' }, el('span'), el('span'), el('span', null, 'In hand'), el('span', { class: 'num' }, 'K'), el('span', { class: 'num' }, 'D'), el('span')),
        rows);
      for (const p of ps) this.rp.rows.set(p.client, this.playerRow(p, rows));
      box.append(card);
      if (key) this.rp.cards.push({ key, score, side, alive, ps, aliveKey: null });
    };
    for (const t of d.teams) {
      const ps = d.players.filter(p => p.team === t.key && withPos(p));
      if (ps.length) addCard(t.key, t.name, ps, app.teamColor(t.key));
    }
    const specs = d.players.filter(p => p.team !== 'A' && p.team !== 'B' && withPos(p));
    if (specs.length) addCard(null, 'Spectators', specs, app.teamColor('spectator'));
  }

  playerRow(p, rows) {
    const w = el('span', { class: 'rp-w' }), k = el('span', { class: 'num' }), dd = el('span', { class: 'num dd' });
    const eye = el('button', { class: 'rp-eye', title: 'Show / hide ' + p.cleanName, 'aria-label': 'Show or hide ' + p.cleanName,
      onclick: e => { e.stopPropagation(); if (this.selected.has(p.client)) this.selected.delete(p.client); else this.selected.add(p.client); this.emit('selection'); this.pb.invalidate(); } }, icon('eye', 's'));
    const stats = el('button', { class: 'rp-stats', title: 'Player stats', 'aria-label': 'Player stats: ' + p.cleanName,
      onclick: e => { e.stopPropagation(); C4.mapStats.open(stats, p.client, this.statsCtx); } }, icon('chart', 's'));
    const tr = el('div', { class: 'rp-row' + (p.isPov ? ' pov' : ''), title: p.cleanName + ' - click: select', tabindex: '0', role: 'button', onclick: () => this.setFocus(p.client),
      onkeydown: e => { if (e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.setFocus(p.client); } },
      onmouseenter: () => this.setHover(p.client), onmouseleave: () => this.setHover(null) },
      eye,
      el('span', { class: 'rp-name' }, el('span', { class: 'rp-pname' }, p.cleanName),
        p.isPov ? el('span', { class: 'pov-tag', title: 'Recording player' }, 'POV') : null),
      w, k, dd, stats);
    rows.append(tr);
    return { p, tr, w, k, d: dd };
  }

  updateTeamPanel(t) {
    const d = this.d, M = this.match;
    const r = M.roundAtOrBefore(t);
    const phase = C4.rounds.phaseAt(d.phases, t);
    setText(this.rp.title, r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : r.kind === 'prematch' ? 'Pre-match round' : 'Aftermatch') : 'Before the first round');
    let st;
    if (phase === 'halftime') st = 'Halftime';
    else if (phase === 'timeout') st = 'Timeout';
    else if (phase === 'warmup') st = 'Warm-up';
    else if (!r) st = '-';
    else if (r.end != null && t >= r.end) st = 'Won by ' + (r.winnerTeam ? this.app.teamName(r.winnerTeam) : 'unknown team') + (r.reason ? ' (' + r.reason + ')' : '');
    else if (r.start != null && t < r.start) st = 'Strat time';
    else if (t >= r.segEnd) st = 'Round over';
    else st = 'In progress';
    setText(this.rp.status, st);
    const kd = new Map(), dead = new Set();
    for (const k of d.kills) {
      if (k.t > t) break;
      if (r && k.t >= r.segStart) dead.add(k.victim);
      if (k.phase !== 'live') continue;
      const { credit, death } = C4.build.kdRule(k);
      if (credit) { const o = kd.get(k.attacker) || { k: 0, d: 0 }; o.k++; kd.set(k.attacker, o); }
      if (death) { const o = kd.get(k.victim) || { k: 0, d: 0 }; o.d++; kd.set(k.victim, o); }
    }
    this.deadNow = dead;
    let score = d.initialScore || { A: 0, B: 0 };
    for (const x of d.rounds) if (x.kind === 'round' && x.end != null && x.end <= t && x.scoreAfter) score = x.scoreAfter;
    this.scoreNow = score;
    for (const c of this.rp.cards) {
      setText(c.score, String(score[c.key] != null ? score[c.key] : 0));
      const sd = r && r.sides ? r.sides[c.key] : null;
      setText(c.side, sd === 'attack' ? 'Attack' : sd === 'defence' ? 'Defence' : '');
      const inRound = r ? c.ps.filter(p => { const P = d.positions[p.client]; const i = upperBound(P.t, r.segEnd) - 1; return i >= 0 && P.t[i] >= r.segStart; }) : [];
      // the players alive as bars (one per player of the round, dimmed when dead)
      const nAlive = inRound.filter(p => !dead.has(p.client)).length, aliveKey = r ? nAlive + '/' + inRound.length : '';
      if (c.aliveKey !== aliveKey) {
        c.aliveKey = aliveKey;
        clear(c.alive);
        for (let i = 0; r && i < inRound.length; i++) c.alive.append(el('i', { class: i < nAlive ? null : 'off' }));
        c.alive.title = r ? aliveKey + ' alive' : '';
        c.alive.setAttribute('aria-label', c.alive.title);
      }
    }
    for (const [cl, row] of this.rp.rows) {
      const o = kd.get(cl) || { k: 0, d: 0 };
      setText(row.k, String(o.k));
      setText(row.d, String(o.d));
      const isDead = dead.has(cl);
      // the weapon in hand: its killfeed icon (the name as tooltip), else the name
      let w = isDead ? '✕' : '-', name = null;
      if (!isDead && r) {
        const P = d.positions[cl], i = upperBound(P.t, t) - 1;
        if (i >= 0 && P.t[i] >= r.segStart && !(P.flags[i] & PF.DEAD)) { w = M.weaponLabel(P.weapon[i], P.t[i]); name = M.weaponName(P.weapon[i], P.t[i]); }
      }
      if (row.wKey !== w) {
        row.wKey = w;
        const ic = name ? C4.weapons.weaponIcon(name) : null;
        row.w.replaceChildren(ic ? C4.ui.iconNode(ic, w) : w);
        row.w.title = w === '✕' ? 'dead' : w;
      }
      row.tr.classList.toggle('dead', isDead);
      row.tr.classList.toggle('off', !this.selected.has(cl));
      row.tr.classList.toggle('hover', this.hover === cl);
      row.tr.classList.toggle('focus', this.focus === cl);
    }
  }

  /* ---------- one frame ---------- */
  frame(t) {
    const r = C4.events.roundAt(this.d.rounds, t);
    const rl = r >= 0 ? C4.ui.fmtRoundTime(this.d, r, t) : '';
    // the clock: the time in the range / its length, under it the round time (round range: also the match time)
    setText(this.timeNow, fmtTime(t - this.base));
    setText(this.timeTotal, '/ ' + fmtTime(this.pb.range[1] - this.base));
    setText(this.clockSub, this.scope >= 0 ? (rl ? rl + ' · ' : '') + 'match ' + fmtTime(t) : (rl || 'match ' + fmtTime(t)));
    if (this.playing !== this.pb.playing) {
      this.playing = this.pb.playing;
      this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    }
    this.timeline.setTime(t);
    this.updateTeamPanel(t);
    // the score pill: the rounds won up to now (the final score only on request: overview.js)
    C4.tabs.overview.update(this.scoreNow, this.rp.title.textContent, rl ? rl.split(' · ')[1] || '' : '');
    if (this.view) this.view.draw(t);
    C4.mapStats.refresh();
    // feed: the latest entry highlighted and kept in view, the ones after the playback time dimmed
    if (this.evItems && this.evItems.length) {
      let cur = -1;
      for (let i = 0; i < this.evItems.length; i++) if (this.evItems[i].t <= t) cur = i; else break;
      if (cur !== this.evCurrent) {
        const prev = this.evCurrent;
        if (prev >= 0 && this.evItems[prev]) this.evItems[prev].node.classList.remove('current');
        for (let i = Math.min(prev, cur) + 1; i <= Math.max(prev, cur); i++) this.evItems[i].node.classList.toggle('future', i > cur);
        if (cur >= 0) {
          this.evItems[cur].node.classList.add('current');
          this.scrollFeedTo(this.evItems[cur].node);
        }
        this.evCurrent = cur;
      }
    }
  }

  /** keep a feed entry in view (centred when it left the box); positions relative to the box itself -
   *  offsetTop counts from the nearest positioned ancestor, which is not the feed */
  scrollFeedTo(n) {
    const box = this.dom.feed, b = box.getBoundingClientRect(), r = n.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += (r.top - b.top) - (box.clientHeight - r.height) / 2;
  }

  /** kills shown as kill lines / markers at t (the last KILL_LINE_MS, same round) */
  recentKills(t, ms = 5000) {
    const out = [], ep = this.match.epochStart(t);
    for (const k of this.d.kills) {
      if (k.t > t) break;
      if (t - k.t <= ms && k.t >= ep) out.push(k);
    }
    return out;
  }

  destroy() {
    this.pb.active = false;
    this.pb.playing = false;
    this.pb.onFrame = () => {};
    C4.mapStats.close();
    for (const v of Object.values(this.views)) if (v.destroy) v.destroy();
  }
}
