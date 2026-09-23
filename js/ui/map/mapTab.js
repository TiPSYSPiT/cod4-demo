/* Tab 7 - Map: 2D replay with trails, view direction, grenades, heatmaps,
 * timeline and an event list. Renders only from DemoData. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, approx } = C4.ui;
  const CFG = C4.mapConfig;
  const PF = C4.collect.PF;
  const lowerBound = C4.lowerBound;
  const upperBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };

  let S = null;              // state of the rendered map tab

  function reset() {
    if (S && S.pb) { S.pb.active = false; S.pb.playing = false; S.pb.onFrame = () => {}; }
    S = null;
  }

  /* ---------- preparation ---------- */
  function prepare(app) {
    const d = app.data, m = d.meta;
    const positions = d.positions;
    // world rectangle: compass rectangle from the demo (CS 823) > maps.js > extent of positions
    const known = window.C4MAPS && m.mapKey ? window.C4MAPS[m.mapKey] : null;
    let rect = null, rectSource = null;
    const toRect = c => ({ minX: Math.min(c[0], c[2]), maxX: Math.max(c[0], c[2]), minY: Math.min(c[1], c[3]), maxY: Math.max(c[1], c[3]) });
    if (m.minimap && m.minimap.corners) { rect = toRect(m.minimap.corners); rectSource = 'compass rectangle from the demo (config string 823)'; }
    else if (known && known.bounds) { rect = toRect(known.bounds); rectSource = 'calibration from assets/maps/maps.js'; }
    let bbox = null;
    for (const p of Object.values(positions)) {
      for (let i = 0; i < p.t.length; i++) {
        if (!bbox) bbox = { minX: p.x[i], maxX: p.x[i], minY: p.y[i], maxY: p.y[i] };
        else { if (p.x[i] < bbox.minX) bbox.minX = p.x[i]; if (p.x[i] > bbox.maxX) bbox.maxX = p.x[i]; if (p.y[i] < bbox.minY) bbox.minY = p.y[i]; if (p.y[i] > bbox.maxY) bbox.maxY = p.y[i]; }
      }
    }
    if (!rect) {
      const b = bbox || { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 };
      const pad = 300;
      rect = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
      rectSource = 'no calibration: grid fitted to the bounding box of all positions';
    }
    // player colours: team hue family, distinguishable within the team
    const colors = new Map();
    const idx = { A: 0, B: 0 };
    for (const p of d.players) {
      if (p.team === 'A' || p.team === 'B') {
        const hues = CFG.TEAM_HUES[p.team];
        const k = idx[p.team]++;
        colors.set(p.client, 'hsl(' + hues[k % hues.length] + ',' + (k < hues.length ? 90 : 60) + '%,' + (58 + (k % 3) * 6) + '%)');
      } else colors.set(p.client, 'hsl(210,8%,70%)');
    }
    // deaths per client
    const deaths = new Map();
    for (const k of d.kills) {
      if (!deaths.has(k.victim)) deaths.set(k.victim, []);
      deaths.get(k.victim).push(k);
    }
    // Live start per round = config string 11 (round timer) set, which is the end of
    // the strat time (docs/ANALYSIS.md, section 4). Knife rounds have no strat time
    // (live from the restart); a round already running when the recording started
    // begins at the first snapshot. The countdown [segStart, live) is never shown.
    const live = d.rounds.map(r => r.start != null ? r.start : r.segStart);
    const countdowns = d.rounds.map((r, i) => [r.segStart, live[i]]).filter(c => c[1] > c[0]);
    // segment boundaries (restarts): nothing drawn may cross one
    const bounds = [...new Set(d.rounds.flatMap(r => [r.segStart, r.segEnd]))].sort((a, b) => a - b);
    // grenade flight paths from the trajectory segments
    const grenades = d.grenades.map(g => {
      const pts = [];
      const end = g.detonation ? g.detonation.t : g.last + 50;
      for (let s = 0; s < g.segments.length; s++) {
        const [trTime, trType, bx, by, bz, vx, vy, vz] = g.segments[s];
        const from = Math.max(trTime, s === 0 ? (g.launch != null ? g.launch : g.first) : trTime);
        const to = s + 1 < g.segments.length ? g.segments[s + 1][0] : end;
        for (let t = from; t <= to; t += 40) {
          const dt = (t - trTime) / 1000;
          if (trType === 5) pts.push([t, bx + vx * dt, by + vy * dt]);
          else pts.push([t, bx, by]);
          if (trType !== 5) break;
        }
      }
      if (g.detonation) pts.push([g.detonation.t, g.detonation.x, g.detonation.y]);
      const start = pts.length ? pts[0][0] : (g.detonation ? g.detonation.t : g.first);
      const c = CFG.GRENADE[g.kind] || CFG.GRENADE.other;
      return { g, pts, start, end: g.detonation ? g.detonation.t + c.duration : end + 500, cfg: c };
    });
    const teamColor = key => key === 'A' ? '#ff6a3d' : key === 'B' ? '#3ea8ff' : '#9aa4b2';
    return { d, rect, rectSource, known, bbox, colors, deaths, live, countdowns, bounds, grenades, teamColor };
  }

  /** start of the segment (round) containing t: trails, grenades, death markers and
   * last known positions from before it are not drawn */
  function epochStart(t) {
    const i = upperBound(S.bounds, t) - 1;
    return i >= 0 ? S.bounds[i] : -Infinity;
  }

  /* ---------- position lookup ---------- */
  function sampleAt(cl, t) {
    const P = S.d.positions[cl];
    if (!P || !P.t.length) return null;
    const i = upperBound(P.t, t) - 1;
    if (i < 0) return null;
    const t0 = P.t[i];
    if ((P.flags[i] & PF.DEAD)) return null;
    // no position across a death or a round restart (a new life / another round)
    const dl = S.deaths.get(cl);
    if (dl) for (const k of dl) if (k.t > t0 && k.t <= t) return null;
    if (t0 < epochStart(t)) return null;
    let x = P.x[i], y = P.y[i], yaw = P.yaw[i], age = t - t0;
    if (i + 1 < P.t.length && epochStart(P.t[i + 1]) <= t0) {
      const t1 = P.t[i + 1];
      const dx = P.x[i + 1] - x, dy = P.y[i + 1] - y;
      if (t1 - t0 <= CFG.GAP_MS && Math.hypot(dx, dy) <= CFG.JUMP_UNITS && !(P.flags[i + 1] & PF.DEAD)) {
        const f = (t - t0) / (t1 - t0);
        x += dx * f; y += dy * f;
        let dyaw = ((P.yaw[i + 1] - yaw + 540) % 360) - 180;          // shortest way
        yaw += dyaw * f;
        age = 0;
      }
    }
    const fl = P.flags[i];
    return { x, y, yaw, age, crouch: !!(fl & PF.CROUCH), prone: !!(fl & PF.PRONE), firing: !!(fl & PF.FIRING), weapon: P.weapon[i] };
  }

  function trailOf(cl, t) {
    const P = S.d.positions[cl];
    if (!P) return [];
    const from = Math.max(t - CFG.TRAIL_MS, epochStart(t));     // never into the previous round
    let i = lowerBound(P.t, from);
    const end = upperBound(P.t, t);
    const segs = [];
    let seg = [];
    let prev = null;
    const brk = () => { if (seg.length > 1) segs.push(seg); seg = []; };
    for (; i < end; i++) {
      if (P.flags[i] & PF.DEAD) { brk(); prev = null; continue; }
      if (prev != null) {
        const gap = P.t[i] - P.t[prev];
        const jump = Math.hypot(P.x[i] - P.x[prev], P.y[i] - P.y[prev]);
        if (gap > CFG.GAP_MS || jump > CFG.JUMP_UNITS) brk();
      }
      seg.push([P.x[i], P.y[i], (t - P.t[i]) / CFG.TRAIL_MS]);
      prev = i;
    }
    const cur = sampleAt(cl, t);
    if (cur && cur.age === 0 && seg.length) seg.push([cur.x, cur.y, 0]);
    brk();
    return segs;
  }

  /* ---------- UI ---------- */
  function render(root, app) {
    const d = app.data;
    clear(root);
    S = prepare(app);
    S.app = app;
    S.selected = new Set(d.players.filter(p => p.team === 'A' || p.team === 'B').map(p => p.client));
    if (!S.selected.size) for (const p of d.players) S.selected.add(p.client);
    S.mode = 'trail';
    S.labels = true;
    S.lastKnown = false;
    S.grenadeKinds = new Set(['smoke', 'frag', 'flash', 'concussion', 'other']);
    S.scope = -1;

    // toolbar
    const scopeSel = el('select', { title: 'replay range', onchange: e => setScope(Number(e.target.value)) }, el('option', { value: '-1' }, 'Whole match'));
    d.rounds.forEach((r, i) => scopeSel.append(el('option', { value: String(i) },
      (r.kind === 'knife' ? 'Knife round' : r.kind === 'prematch' ? 'Pre-match round' : 'Round ' + r.label) + '  (' + fmtTime(S.live[i]) + ' – ' + fmtTime(r.segEnd) + ')')));
    S.scopeSel = scopeSel;
    const modeSeg = el('div', { class: 'seg' });
    for (const [key, label] of [['trail', 'Recent trail'], ['heat-player', 'Heatmap player'], ['heat-team', 'Heatmap team']]) {
      const b = el('button', { class: key === S.mode ? 'active' : null, onclick: () => { S.mode = key; modeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); S.heatKey = null; S.pb.invalidate(); } }, label);
      modeSeg.append(b);
    }
    const opt = (label, checked, fn, title) => el('label', { class: 'opt', title: title || null }, el('input', { type: 'checkbox', checked: checked || null, onchange: e => { fn(e.target.checked); S.pb.invalidate(); } }), label);
    const gOpts = el('span', { class: 'opt' }, 'Grenades:');
    for (const kind of ['smoke', 'frag', 'flash']) {
      const c = CFG.GRENADE[kind];
      gOpts.append(el('label', { class: 'opt', style: { color: c.color } }, el('input', { type: 'checkbox', checked: true, onchange: e => { if (e.target.checked) S.grenadeKinds.add(kind); else S.grenadeKinds.delete(kind); S.pb.invalidate(); } }), c.label));
    }
    const toolbar = el('div', { class: 'toolbar' }, scopeSel, modeSeg,
      opt('Names', true, v => { S.labels = v; }),
      opt('Last known position', false, v => { S.lastKnown = v; }, 'players the server stopped sending are drawn hollow at their last known position (same life only)'),
      gOpts,
      el('span', { class: 'muted', title: 'The thrower of a grenade is not in the demo, so grenades are shown for all players. Smoke size and duration are display constants (the smoke cloud is not an entity).' }, 'all throwers', approx('the thrower of a grenade is not in the demo')));

    // stage
    const stage = el('div', { class: 'map-stage' });
    const clock = el('div', { class: 'map-clock' }, '00:00');
    const hint = el('div', { class: 'map-hint' });
    S.renderer = new C4.MapRenderer(stage, S.rect);
    S.renderer.onChange = () => S.pb.invalidate();
    stage.append(clock, hint);
    S.clock = clock;
    const imgName = S.known && S.known.image;
    if (imgName) {
      const img = new Image();
      img.onload = () => { S.renderer.setImage(img, S.rect); S.pb.invalidate(); };
      img.onerror = () => { hint.textContent = 'Background image ' + imgName + ' could not be loaded - neutral grid.'; };
      img.src = 'assets/maps/' + imgName;
      hint.textContent = 'Background: ' + imgName + ', placed with the ' + S.rectSource + '. Wheel = zoom, drag = pan, double-click = reset.';
    } else {
      hint.textContent = 'No background image for ' + (d.meta.map || 'this map') + ' - neutral grid (' + S.rectSource + '). Wheel = zoom, drag = pan.';
    }

    // side: players + events
    const plist = el('div', { class: 'player-list' });
    const checkboxes = new Map();
    const refreshChecks = () => { for (const [cl, cb] of checkboxes) cb.checked = S.selected.has(cl); S.heatKey = null; S.pb.invalidate(); };
    const groups = [...d.teams.map(t => t.key), 'spectator'];
    for (const key of groups) {
      const ps = d.players.filter(p => p.team === key && d.positions[p.client]);
      if (!ps.length) continue;
      plist.append(el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '12px' } },
        el('span', { class: C4.ui.teamClass(key), style: { fontWeight: 700 } }, app.teamName(key)),
        el('span', { class: 'team-toggle', onclick: () => { const all = ps.every(p => S.selected.has(p.client)); for (const p of ps) { if (all) S.selected.delete(p.client); else S.selected.add(p.client); } refreshChecks(); } }, 'toggle')));
      for (const p of ps) {
        const cb = el('input', { type: 'checkbox', checked: S.selected.has(p.client) || null, onchange: e => { if (e.target.checked) S.selected.add(p.client); else S.selected.delete(p.client); S.heatKey = null; S.pb.invalidate(); } });
        checkboxes.set(p.client, cb);
        plist.append(el('label', { class: 'player-row' }, cb, el('span', { class: 'swatch', style: { background: S.colors.get(p.client) } }), app.playerNode(p.client)));
      }
    }
    const playersPanel = el('div', { class: 'map-panel' },
      el('h3', null, 'Players', el('span', null,
        el('button', { class: 'btn small', onclick: () => { for (const p of d.players) S.selected.add(p.client); refreshChecks(); } }, 'All'), ' ',
        el('button', { class: 'btn small', onclick: () => { S.selected.clear(); refreshChecks(); } }, 'None'))),
      plist,
      el('div', { class: 'note', style: { margin: '6px 0 0' } }, 'A client demo only contains other players while the POV could see them; gaps are not bridged.'));
    const evList = el('div', { class: 'map-events' });
    S.evList = evList;
    const eventsPanel = el('div', { class: 'map-panel', style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } }, el('h3', null, 'Kills & bomb'), evList);

    // controls
    const playBtn = el('button', { class: 'btn primary', style: { minWidth: '84px' }, title: 'Space', onclick: () => { S.pb.toggle(); updatePlay(); } }, '▶ Play');
    const updatePlay = () => { playBtn.textContent = S.pb.playing ? '❚❚ Pause' : '▶ Play'; };
    S.updatePlay = updatePlay;
    const speedSeg = el('div', { class: 'seg' });
    for (const s of CFG.SPEEDS) {
      const b = el('button', { class: s === 1 ? 'active' : null, onclick: () => { S.pb.speed = s; speedSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); } }, s + '×');
      speedSeg.append(b);
    }
    const timeNow = el('span', { class: 'time-now' });
    S.timeNow = timeNow;
    const tlBox = el('div', { class: 'timeline' });
    S.timeline = new C4.Timeline(tlBox, (t, dir) => { S.pb.seek(t, dir); });
    const controls = el('div', { class: 'controls' },
      el('button', { class: 'btn', title: '← = -5 s', onclick: () => S.pb.seek(S.pb.t - CFG.SEEK_STEP_MS, -1) }, '⏪ 5s'),
      playBtn,
      el('button', { class: 'btn', title: '→ = +5 s', onclick: () => S.pb.seek(S.pb.t + CFG.SEEK_STEP_MS, 1) }, '5s ⏩'),
      speedSeg, timeNow, tlBox);

    root.append(toolbar,
      el('div', { class: 'map-layout' }, stage, el('div', { class: 'map-side' }, playersPanel, eventsPanel)),
      controls,
      el('p', { class: 'note', style: { marginTop: '8px' } }, 'Keys: Space = play / pause, ← / → = ±5 s. ',
        'Dots = players with view direction; ring = firing; X = death position (5 s). Smoke ', el('span', { style: { color: CFG.GRENADE.smoke.color } }, '●'),
        ' frag ', el('span', { style: { color: CFG.GRENADE.frag.color } }, '●'), ' flash ', el('span', { style: { color: CFG.GRENADE.flash.color } }, '●'),
        ' - effect radii and the smoke duration (' + CFG.SMOKE_DURATION_MS / 1000 + ' s) are display constants. ',
        'Strat time / countdown before each round is skipped (dark on the timeline); drawings are reset at every new round.'));

    S.pb = new C4.Playback(frame);
    setScope(-1);
  }

  function setScope(i) {
    const d = S.d;
    S.scope = i;
    S.scopeSel.value = String(i);
    // round view: live start (00:00) to the next restart; whole match: everything,
    // the countdown phases are skipped by the playback clock
    const range = i < 0 ? [0, d.meta.durationMs] : [S.live[i], d.rounds[i].segEnd];
    S.base = i < 0 ? 0 : S.live[i];
    S.pb.skips = i < 0 ? S.countdowns : [];
    S.pb.setRange(range[0], range[1]);
    if (i >= 0 || S.pb.t < range[0] || S.pb.t > range[1]) S.pb.seek(range[0]);
    // timeline markers
    const markers = [];
    for (const k of d.kills) markers.push({ t: k.t, kind: 'kill', color: k.world || k.suicide ? '#9aa4b2' : S.teamColor(k.attackerTeam) });
    for (const e of d.events) {
      if (e.type === 'bomb_planted') markers.push({ t: e.t, kind: 'bomb', color: '#f5c451' });
      if (e.type === 'bomb_defused') markers.push({ t: e.t, kind: 'bomb', color: '#58d68d' });
    }
    if (i < 0) for (const t of S.live) markers.push({ t, kind: 'round' });
    S.timeline.set(range, markers, { skips: S.pb.skips, base: S.base });
    // event list
    clear(S.evList);
    S.evItems = [];
    const items = [];
    for (const k of d.kills) if (k.t >= range[0] && k.t <= range[1]) items.push({ t: k.t, kill: k });
    for (const e of d.events) if ((e.type === 'bomb_planted' || e.type === 'bomb_defused') && e.t >= range[0] && e.t <= range[1]) items.push({ t: e.t, ev: e });
    items.sort((a, b) => a.t - b.t);
    for (const it of items) {
      const node = el('div', { class: 'map-ev', title: 'jump to 2 s before', onclick: () => S.pb.seek(it.t - 2000) },
        el('span', { class: 'time' }, fmtTime(it.t - S.base)),
        el('span', { class: 'tl-what' }, it.kill ? C4.ui.killNodes(S.app, it.kill) : el('span', { style: { color: 'var(--warn)' } }, it.ev.text)));
      S.evList.append(node);
      S.evItems.push({ t: it.t, node });
    }
    if (!items.length) S.evList.append(el('div', { class: 'empty' }, 'No kills or bomb events in this range.'));
    S.heatKey = null;
    S.pb.invalidate();
  }

  /* ---------- drawing one frame ---------- */
  function frame(t) {
    const d = S.d, R = S.renderer;
    const rl = roundLabel(t);
    // round view: round time first (00:00 = live start); whole match: match time first
    S.clock.textContent = S.scope >= 0 ? (rl ? rl + '  ·  ' : '') + 'match ' + fmtTime(t) : fmtTime(t) + (rl ? '  ·  ' + rl : '');
    S.timeNow.textContent = fmtTime(t - S.base) + ' / ' + fmtTime(S.pb.range[1] - S.base);
    S.timeline.setTime(t);
    const ep = epochStart(t);
    if (S.updatePlay) S.updatePlay();
    R.begin();
    R.drawBackground();

    // heatmaps
    if (S.mode !== 'trail') {
      const key = S.mode + '|' + S.scope + '|' + [...S.selected].sort().join(',');
      if (!S.heat) S.heat = new C4.Heatmap(S.rect);
      if (S.heatKey !== key || t < S.heat.until) { S.heat.reset(key); S.heatKey = key; S.heat.until = S.pb.range[0] - 1; }
      if (t > S.heat.until) {
        for (const cl of S.selected) {
          const P = d.positions[cl];
          if (!P) continue;
          const p = d.players.find(x => x.client === cl);
          const bucket = S.mode === 'heat-team' ? (p && p.team === 'B' ? 'B' : 'A') : 'A';
          // samples from the countdown phases are left out (they are never shown)
          let from = S.heat.until;
          for (const [a, b] of S.countdowns) {
            if (b <= from || a > t) continue;
            if (a - 1 > from) S.heat.add(P, from, a - 1, bucket);
            from = Math.max(from, b - 1);
          }
          if (t > from) S.heat.add(P, from, t, bucket);
        }
        S.heat.until = t;
      }
      let colorA = null;
      if (S.mode === 'heat-player' && S.selected.size === 1) colorA = hslToRgb(S.colors.get([...S.selected][0]));
      R.drawOverlay(S.heat.paint(S.mode === 'heat-team' ? 'team' : 'player', colorA), S.rect, 0.8);
    }

    // grenades (all throwers: the thrower is not in the demo); only those of the current round
    for (const gr of S.grenades) {
      if (!S.grenadeKinds.has(gr.g.kind) || t < gr.start || t > gr.end || gr.start < ep) continue;
      const det = gr.g.detonation;
      if (!det || t < det.t) {
        const shown = gr.pts.filter(p => p[0] <= t);
        R.drawPath(shown.map(p => [p[1], p[2]]), gr.cfg.color, 0.85, [4, 3]);
        const cur = shown[shown.length - 1];
        if (cur) R.drawDot(cur[1], cur[2], gr.cfg.color, 1, 3);
      } else {
        const age = t - det.t;
        const fadeStart = gr.cfg.duration - gr.cfg.fade;
        const alpha = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / gr.cfg.fade);
        R.drawPath(gr.pts.map(p => [p[1], p[2]]), gr.cfg.color, 0.35 * alpha, [4, 3]);
        R.drawCircle(det.x, det.y, gr.cfg.radius, gr.cfg.color, 0.95 * alpha, gr.g.kind === 'smoke' ? 0.35 : 0.22);
      }
    }

    // trails
    if (S.mode === 'trail') for (const cl of S.selected) R.drawTrail(trailOf(cl, t), S.colors.get(cl));

    // death markers
    for (const cl of S.selected) {
      const dl = S.deaths.get(cl);
      if (!dl) continue;
      for (const k of dl) {
        const age = t - k.t;
        if (age < 0 || age > CFG.DEATH_MARKER_MS || k.t < ep) continue;
        let pos = k.victimPos;
        if (!pos) {
          const P = d.positions[cl];
          const i = P ? upperBound(P.t, k.t) - 1 : -1;
          if (i >= 0 && k.t - P.t[i] <= 2000) pos = [P.x[i], P.y[i]];
        }
        if (pos) R.drawDeath(pos[0], pos[1], S.colors.get(cl), 1 - age / CFG.DEATH_MARKER_MS * 0.7);
      }
    }

    // players
    const povFollow = followedAt(t);
    for (const cl of S.selected) {
      const s = sampleAt(cl, t);
      if (!s) continue;
      const stale = s.age > CFG.STALE_MS;
      if (stale && (!S.lastKnown || s.age > CFG.LAST_KNOWN_MAX_MS)) continue;
      const p = d.players.find(x => x.client === cl);
      R.drawPlayer(s, S.colors.get(cl), {
        hollow: stale, alpha: stale ? 0.55 : 1, firing: s.firing, highlight: cl === povFollow,
        label: S.labels ? (p ? p.cleanName : 'Client ' + cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '') : null
      });
    }

    // event list highlight
    if (S.evItems && S.evItems.length) {
      let cur = -1;
      for (let i = 0; i < S.evItems.length; i++) if (S.evItems[i].t <= t) cur = i; else break;
      if (cur !== S.evCurrent) {
        if (S.evCurrent >= 0 && S.evItems[S.evCurrent]) S.evItems[S.evCurrent].node.classList.remove('current');
        if (cur >= 0) {
          S.evItems[cur].node.classList.add('current');
          const box = S.evList, n = S.evItems[cur].node;
          if (n.offsetTop < box.scrollTop || n.offsetTop > box.scrollTop + box.clientHeight - 30) box.scrollTop = n.offsetTop - box.clientHeight / 2;
        }
        S.evCurrent = cur;
      }
    }
  }

  /** the player the POV follows (player state) at time t - highlighted with a white ring */
  function followedAt(t) {
    const pov = S.d.meta.povClient;
    const P = S.d.positions[pov];
    if (P) { const i = upperBound(P.t, t) - 1; if (i >= 0 && t - P.t[i] < 200 && (P.flags[i] & PF.FROM_PS)) return pov; }
    for (const [cl, Q] of Object.entries(S.d.positions)) {
      const i = upperBound(Q.t, t) - 1;
      if (i >= 0 && t - Q.t[i] < 200 && (Q.flags[i] & PF.FROM_PS)) return Number(cl);
    }
    return pov;
  }

  function roundLabel(t) {
    const i = C4.events.roundAt(S.d.rounds, t);
    return i >= 0 ? C4.ui.fmtRoundTime(S.d, i, t) : '';
  }

  function hslToRgb(hsl) {
    const m = /hsl\((\d+),(\d+)%,(\d+)%\)/.exec(hsl || '');
    if (!m) return null;
    const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
    const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
    return [f(0), f(8), f(4)];
  }

  /* ---------- keyboard ---------- */
  window.addEventListener('keydown', e => {
    if (!S || !S.active) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' && document.activeElement.type !== 'checkbox' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); S.pb.toggle(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); S.pb.seek(S.pb.t - CFG.SEEK_STEP_MS, -1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); S.pb.seek(S.pb.t + CFG.SEEK_STEP_MS, 1); }
  });

  C4.tabs.map = {
    render, reset,
    get state() { return S; },            // for tests / debugging
    shown() { if (S) { S.active = true; S.pb.active = true; S.renderer.resize(); S.pb.invalidate(); } },
    hidden() { if (S) { S.active = false; S.pb.active = false; S.pb.playing = false; } },
    /** jump to time t (ms) - used by the other tabs */
    seek(t, roundIndex) {
      if (!S) return;
      const d = S.d;
      const ri = roundIndex != null && roundIndex >= 0 ? roundIndex : C4.events.roundAt(d.rounds, t);
      if (S.scope >= 0 && S.scope !== ri) setScope(ri >= 0 ? ri : -1);
      S.pb.seek(t);
      S.pb.invalidate();
    }
  };
})(window.C4);
