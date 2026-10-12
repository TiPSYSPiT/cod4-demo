/* Tab 7 - Map: 2D replay with trails, view direction, grenades, the bomb, a heatmap,
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
    C4.mapStats.close();
    if (S && S.heatUi) S.heatUi.close();
    if (S && S.pb) { S.pb.active = false; S.pb.playing = false; S.pb.onFrame = () => {}; }
    S = null;
  }

  /* ---------- preparation ---------- */
  function prepare(app) {
    const d = app.data, m = d.meta;
    const positions = d.positions;
    // world rectangle: compass rectangle from the demo (CS 823) > maps.js > extent of positions.
    // The image (the compass map) covers exactly that rectangle - it is only drawn with a real
    // calibration, never on the rectangle guessed from the positions.
    const known = C4.maps ? C4.maps.entry(m.map) : null;
    let rect = null, rectSource = null, calibrated = false;
    const toRect = c => ({ minX: Math.min(c[0], c[2]), maxX: Math.max(c[0], c[2]), minY: Math.min(c[1], c[3]), maxY: Math.max(c[1], c[3]) });
    if (m.minimap && m.minimap.corners) { rect = toRect(m.minimap.corners); rectSource = 'compass rectangle from the demo (config string 823)'; calibrated = true; }
    else if (known && known.bounds) { rect = toRect(known.bounds); rectSource = 'calibration from assets/maps/maps.js'; calibrated = true; }
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
    // player colours: one colour per team - the POV's team blue, the other red (app.teamColor,
    // styles.css); the player table (hover) tells the players of a team apart
    const colors = new Map();
    for (const p of d.players) colors.set(p.client, app.teamColor(p.team));
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
    const teamColor = key => app.teamColor(key);
    const bombTimes = (d.bombTrack || []).map(e => e.t);
    return { d, rect, rectSource, calibrated, known, bbox, colors, deaths, live, countdowns, bounds, grenades, teamColor, bombTimes };
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
    S.labels = true;
    S.lastKnown = false;
    S.grenadeKinds = new Set(['smoke', 'frag', 'flash', 'concussion', 'other']);
    S.scope = -1;
    S.hover = null;                 // player under the mouse in the round table: highlighted on the map
    S.panelOpen = true;

    // toolbar
    const scopeSel = el('select', { title: 'replay range', onchange: e => setScope(Number(e.target.value)) }, el('option', { value: '-1' }, 'Whole match'));
    d.rounds.forEach((r, i) => scopeSel.append(el('option', { value: String(i) },
      (r.kind === 'knife' ? 'Knife round (not counted)' : r.kind === 'prematch' ? 'Pre-match round (not counted)' : r.kind === 'aftermatch' ? 'Aftermatch (not counted)' : 'Round ' + r.label) + '  (' + fmtTime(S.live[i]) + ' – ' + fmtTime(r.segEnd) + ')')));
    S.scopeSel = scopeSel;
    const opt = (label, checked, fn, title) => el('label', { class: 'opt', title: title || null }, el('input', { type: 'checkbox', checked: checked || null, onchange: e => { fn(e.target.checked); S.pb.invalidate(); } }), label);
    const gOpts = el('span', { class: 'opt' }, 'Grenades:');
    for (const kind of ['smoke', 'frag', 'flash']) {
      const c = CFG.GRENADE[kind];
      gOpts.append(el('label', { class: 'opt', style: { color: c.color } }, el('input', { type: 'checkbox', checked: true, onchange: e => { if (e.target.checked) S.grenadeKinds.add(kind); else S.grenadeKinds.delete(kind); S.pb.invalidate(); } }), c.label));
    }
    // rotation (quarter turns counter-clockwise), stored per map
    const rotLabel = el('span', { class: 'rot-label', title: 'orientation of the map (counter-clockwise)' });
    S.rotLabel = rotLabel;
    const rotSeg = el('div', { class: 'seg rot' },
      el('button', { title: 'rotate 90° to the left (Q)', onclick: () => rotate(1) }, '⟲'),
      rotLabel,
      el('button', { title: 'rotate 90° to the right (E)', onclick: () => rotate(-1) }, '⟳'));
    const toolbar = el('div', { class: 'toolbar' }, scopeSel, rotSeg,
      opt('Names', true, v => { S.labels = v; }),
      opt('Last known position', false, v => { S.lastKnown = v; }, 'players the server stopped sending are drawn hollow at their last known position (same life only)'),
      gOpts,
      el('span', { class: 'muted', title: 'The thrower of a grenade is not in the demo, so grenades are shown for all players. Smoke size and duration are display constants (the smoke cloud is not an entity).' }, 'all throwers', approx('the thrower of a grenade is not in the demo')));

    // stage
    const stage = el('div', { class: 'map-stage' });
    const clock = el('div', { class: 'map-clock' }, '00:00');
    const hint = el('div', { class: 'map-hint' });
    S.renderer = new C4.MapRenderer(stage, S.rect);
    S.renderer.setRotation(loadRotation());
    S.renderer.onChange = () => S.pb.invalidate();
    rotLabel.textContent = S.renderer.rot * 90 + '°';
    // tooltip of the bomb icon
    S.renderer.canvas.addEventListener('mousemove', e => {
      const r = S.renderer.canvas.getBoundingClientRect();
      S.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      updateBombTitle();
    });
    S.renderer.canvas.addEventListener('mouseleave', () => { S.mouse = null; updateBombTitle(); });
    // heatmap (heatmap.js data + raster, heatPanel.js options) and the map tools top right
    S.heatPts = {};                 // data points per category, built on first use
    S.heatLayer = new C4.HeatLayer(S.rect);
    S.heatUi = C4.mapHeat.create({ app, data: d, onChange: () => S.pb.invalidate() });
    const tools = el('div', { class: 'map-tools' },
      el('button', { class: 'map-tool', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.25) }, '+'),
      el('button', { class: 'map-tool', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.25) }, '−'),
      S.heatUi.button);
    stage.append(clock, hint, tools, S.heatUi.panel, S.heatUi.chip);
    S.clock = clock;
    const imgName = S.known && S.known.image;
    if (imgName && S.calibrated) {
      const img = new Image();
      img.onload = () => { S.renderer.setImage(img, S.rect); S.pb.invalidate(); };
      img.onerror = () => { hint.textContent = 'Background image ' + imgName + ' could not be loaded - neutral grid.'; };
      img.src = C4.maps.IMAGE_DIR + imgName;
      hint.textContent = 'Background: ' + imgName + ', placed with the ' + S.rectSource + '. Wheel = zoom, drag = pan, double-click = reset.';
    } else {
      hint.textContent = (imgName ? 'Background ' + imgName + ' not shown: no calibration for this demo' : 'No background image for ' + (d.meta.map || 'this map')) +
        ' - neutral grid (' + S.rectSource + '). Wheel = zoom, drag = pan.';
    }

    // side: the round table (players of the round at the playback time) + events
    const roundPanel = buildRoundPanel(app);
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
      speedSeg, timeNow, tlBox,
      el('button', { class: 'btn', title: 'export the current view as MP4 or GIF', onclick: () => C4.mapExport.open(exportApi()) }, 'Export'));

    root.append(toolbar,
      el('div', { class: 'map-layout' }, stage, el('div', { class: 'map-side' }, roundPanel, eventsPanel)),
      controls,
      el('p', { class: 'note', style: { marginTop: '8px' } }, 'Keys: Space = play / pause, ← / → = ±5 s, Q / E = rotate the map 90° left / right. ',
        'Dots = players with view direction (the POV\'s team ', el('span', { class: 'team-blue-text' }, 'blue'), ', the other team ', el('span', { class: 'team-red-text' }, 'red'),
        '; hover a row of the round table to find a player); ring = firing; X = death position (5 s). ',
        'A client demo only contains other players while the POV could see them; gaps are not bridged. ',
        'Bomb ', el('span', { style: { color: CFG.BOMB.color } }, '◆'), ' (S&D): diamond = lying, small dot + orange ring = carried, pulsing = planted, green = defused; ',
        'hollow and faded = last known position while the POV cannot see it (a defending POV does not see the carrier). Smoke ', el('span', { style: { color: CFG.GRENADE.smoke.color } }, '●'),
        ' frag ', el('span', { style: { color: CFG.GRENADE.frag.color } }, '●'), ' flash ', el('span', { style: { color: CFG.GRENADE.flash.color } }, '●'),
        ' - effect radii and the smoke duration (' + CFG.SMOKE_DURATION_MS / 1000 + ' s) are display constants. ',
        'Heatmap: the button top right of the map (+ / − = zoom). ',
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
    // whole match: up to a map change at most (after it the positions belong to another map)
    const mw = d.meta.mapWindow || { start: 0, end: d.meta.durationMs };
    const range = i < 0 ? [mw.start, mw.end] : [S.live[i], Math.min(d.rounds[i].segEnd, mw.end)];
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
        C4.ui.phaseBadge(C4.rounds.phaseAt(d.phases, it.t)),
        el('span', { class: 'tl-what' }, it.kill ? C4.ui.killNodes(S.app, it.kill) : el('span', { style: { color: 'var(--warn)' } }, it.ev.text)));
      S.evList.append(node);
      S.evItems.push({ t: it.t, node });
    }
    if (!items.length) S.evList.append(el('div', { class: 'empty' }, 'No kills or bomb events in this range.'));
    S.pb.invalidate();
  }

  /* ---------- drawing one frame ---------- */
  function frame(t) {
    const d = S.d, R = S.renderer;
    const ui = !S.exporting;                 // video export: draw the map only, leave the page alone
    if (ui) {
      const rl = roundLabel(t);
      // round view: round time first (00:00 = live start); whole match: match time first
      S.clock.textContent = S.scope >= 0 ? (rl ? rl + '  ·  ' : '') + 'match ' + fmtTime(t) : fmtTime(t) + (rl ? '  ·  ' + rl : '');
      S.timeNow.textContent = fmtTime(t - S.base) + ' / ' + fmtTime(S.pb.range[1] - S.base);
      S.timeline.setTime(t);
      if (S.updatePlay) S.updatePlay();
    }
    const ep = epochStart(t);
    R.begin();
    R.drawBackground();

    // heatmap (on the map, below everything else)
    const heatInfo = drawHeat(t);
    if (ui) S.heatUi.info(heatInfo);
    // "Keep players visible" off: only the heatmap on the map
    if (heatInfo && !S.heatUi.opts.keep) { S.bombHit = null; if (ui) finishUi(t); return; }

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

    // trails (the hovered player's trail even if hidden)
    const shown = new Set(S.selected);
    if (S.hover != null) shown.add(S.hover);
    for (const cl of shown) R.drawTrail(trailOf(cl, t), S.colors.get(cl), S.hover != null && cl !== S.hover ? 0.45 : 1);

    // death markers
    for (const cl of shown) {
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
    // the hovered player last, on top of the others
    const order = [...shown].sort((a, b) => (a === S.hover) - (b === S.hover));
    for (const cl of order) {
      const s = sampleAt(cl, t);
      if (!s) continue;
      const stale = s.age > CFG.STALE_MS;
      if (stale && (!S.lastKnown || s.age > CFG.LAST_KNOWN_MAX_MS)) continue;
      const p = d.players.find(x => x.client === cl);
      const hover = cl === S.hover;
      R.drawPlayer(s, S.colors.get(cl), {
        hollow: stale, alpha: stale ? 0.55 : 1, firing: s.firing, highlight: cl === povFollow, hover,
        label: S.labels || hover ? (p ? p.cleanName : 'Client ' + cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '') : null
      });
    }

    // the bomb (on top; independent of the player selection)
    drawBomb(t);
    if (ui) finishUi(t);
  }

  /** the page parts of a frame (not in a video export): bomb tooltip, round table, popup, event list */
  function finishUi(t) {
    updateBombTitle();
    updateRoundPanel(t);
    C4.mapStats.refresh();

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

  /* ---------- heatmap ---------- */
  /** draws the heatmap of the options (heatPanel.js) at time t -> legend info, or null when off.
   *  The points of a category are built once; the raster is rebuilt only when the filters, the range
   *  or the time change ("Up to current time": points are added incrementally, while playing at most
   *  4 times per second; the video export draws every frame exactly). */
  function drawHeat(t) {
    const o = S.heatUi.opts, L = S.heatLayer;
    if (o.cat === 'off') return null;
    const pts = S.heatPts[o.cat] || (S.heatPts[o.cat] = C4.heatPoints.build(S.d, o.cat));
    const players = o.players ? [...o.players].sort((x, y) => x - y).join(',') : '*';
    const fkey = o.cat + '|' + o.team + '|' + o.side + '|' + players;
    if (S.heatMaskKey !== fkey) { S.heatMask = C4.heatPoints.mask(pts, o.team, o.side, o.players); S.heatMaskKey = fkey; }
    const [from, end] = S.pb.range;
    const to = o.upTo ? t : end;
    const key = fkey + '|' + from + '|' + (o.upTo ? 'upto' : end);
    const now = performance.now();
    const throttle = !S.exporting && o.upTo && S.pb.playing && L.key === key && to >= L.until && now - (S.heatAt || 0) < CFG.HEAT.THROTTLE_MS;
    if (!throttle) { L.accumulate(key, pts, S.heatMask, from, to); S.heatAt = now; }
    S.renderer.drawRaster(L.paint(o.radius, o.intensity), L.rect, 1);
    return { n: L.n, missing: L.missing, unattributed: L.unattributed, filtered: o.team !== 'both' || o.side !== 'both' || !!o.players };
  }

  /** zoom buttons: around the centre of the view */
  function zoomBy(f) {
    const R = S.renderer, cx = R.w / 2, cy = R.h / 2;
    const [wx, wy] = R.inv(cx, cy);
    R.zoom = Math.min(12, Math.max(0.5, R.zoom * f));
    const [nx, ny] = R.pt(wx, wy);
    R.pan.x += cx - nx; R.pan.y += cy - ny;
    S.pb.invalidate();
  }

  /* ---------- the bomb (DemoData.bombTrack, events.js) ---------- */
  /** the bomb entry valid at t - computed from t alone, so seeking needs no playback history;
   * nothing from another round (every round starts with its own entry) */
  function bombAt(t) {
    const T = S.d.bombTrack;
    if (!T || !T.length) return null;
    const i = upperBound(S.bombTimes, t) - 1;
    const e = i >= 0 ? T[i] : null;
    if (!e || e.state === 'none' || e.t < epochStart(t)) return null;
    return e;
  }
  const BOMB_TEXT = { base: 'Bomb at its start position', dropped: 'Dropped', planted: 'Planted', defused: 'Defused', exploded: 'Exploded' };
  const BOMB_SOURCE = { objective: 'compass objective', model: 'bomb model', 'last known': 'last known position', message: 'server message' };

  function drawBomb(t) {
    const e = bombAt(t), R = S.renderer, B = CFG.BOMB;
    S.bombHit = null;
    if (!e) return;
    const name = cl => { const p = S.d.players.find(x => x.client === cl); return p ? p.cleanName : 'client ' + cl; };
    let pos = null, opts = {}, text;
    if (e.state === 'carried') {
      const s = sampleAt(e.carrier, t);
      if (!s || s.age > CFG.STALE_MS) return;                  // the carrier is not in the snapshots: nothing to place
      R.drawRing(s.x, s.y, B.color, CFG.PLAYER_RADIUS_PX + 3.5, 0.9);
      pos = [s.x, s.y];
      opts = { dx: 8, dy: -8, round: true };
      text = 'Carried by ' + name(e.carrier);
    } else if (e.state === 'unknown') {
      if (e.x == null) return;
      pos = [e.x, e.y];
      opts = { alpha: B.unknownAlpha, hollow: true };
      text = 'Bomb position unknown (not visible to POV) - last known position';
    } else if (e.state === 'exploded') {
      const age = t - e.t;
      if (age > B.explodedMs || e.x == null) return;
      pos = [e.x, e.y];
      opts = { burst: age / B.explodedMs, alpha: 1 - 0.6 * age / B.explodedMs };
      text = 'Exploded' + (e.site ? ' - site ' + e.site : '');
    } else {
      if (e.x == null) return;
      pos = [e.x, e.y];
      if (e.state === 'planted') opts = { pulse: ((t - e.t) % B.pulseMs) / B.pulseMs };
      if (e.state === 'defused') opts = { color: B.defusedColor };
      text = BOMB_TEXT[e.state] + (e.site ? ' - site ' + e.site : '');
    }
    const sp = R.drawBomb(pos[0], pos[1], opts);
    if (e.source && BOMB_SOURCE[e.source]) text += ' (position: ' + BOMB_SOURCE[e.source] + ')';
    S.bombHit = { x: sp.x, y: sp.y, text };
  }

  /** canvas tooltip of the bomb icon (the mouse position is kept by the mousemove handler) */
  function updateBombTitle() {
    const h = S.bombHit, m = S.mouse;
    const on = !!(h && m && Math.hypot(h.x - m.x, h.y - m.y) <= CFG.BOMB.hitPx);
    const title = on ? h.text : '';
    if (S.renderer.canvas.title !== title) S.renderer.canvas.title = title;
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

  /* ---------- video export (exportVideo.js): the map frame drawn into another renderer ---------- */
  function exportApi() {
    return {
      state: S,
      roundAtOrBefore,
      /** draw the map at demo time t into renderer (no page updates; no hover highlight) */
      drawFrame(renderer, t) {
        const keep = S.renderer, hover = S.hover;
        S.renderer = renderer; S.exporting = true; S.hover = null;
        try { frame(t); } finally { S.renderer = keep; S.exporting = false; S.hover = hover; }
      },
      /** after the export: the heatmap of the view is rebuilt, the view redrawn */
      done() { S.heatLayer.invalidate(); S.pb.invalidate(); }
    };
  }

  /* ---------- rotation (quarter turns counter-clockwise, stored per map) ---------- */
  function loadRotation() {
    try {
      const v = localStorage.getItem(CFG.ROTATION_KEY + (S.d.meta.map || ''));
      if (v != null && /^[0-3]$/.test(v)) return Number(v);
    } catch (err) { /* storage blocked: the default */ }
    return CFG.ROTATION_DEFAULT;
  }
  /** dir +1 = 90° to the left (counter-clockwise), -1 = to the right; keeps playing, zoom and pan */
  function rotate(dir) {
    const R = S.renderer;
    R.setRotation(R.rot + dir);
    S.rotLabel.textContent = R.rot * 90 + '°';
    try { localStorage.setItem(CFG.ROTATION_KEY + (S.d.meta.map || ''), String(R.rot)); } catch (err) { /* not stored */ }
    S.pb.invalidate();
  }

  /* ---------- round table: the players of the round at the playback time ---------- */
  /** weapon index held at time t -> readable name (DemoData.weaponLists, weapons.js labels) */
  function weaponLabel(index, t) {
    if (!index) return '-';
    let list = null;
    for (const w of S.d.weaponLists || []) { if (w.t <= t) list = w.list; else break; }
    const name = list && index <= list.length ? list[index - 1] : null;
    return name ? C4.weapons.label(name) : '#' + index;
  }

  function buildRoundPanel(app) {
    const d = S.d;
    const setHover = cl => { if (S.hover !== cl) { S.hover = cl; S.pb.invalidate(); } };
    const changed = () => { S.pb.invalidate(); };
    const toggle = cl => { if (S.selected.has(cl)) S.selected.delete(cl); else S.selected.add(cl); changed(); };
    const setAll = (cls, on) => { for (const cl of cls) { if (on) S.selected.add(cl); else S.selected.delete(cl); } changed(); };
    // the statistics popup (statsPopup.js)
    S.statsCtx = { app, data: d, time: () => S.pb.t, roundAt: t => roundAtOrBefore(t), onChange: () => S.pb.invalidate() };
    const withPos = p => !!d.positions[p.client];
    const title = el('div', { class: 'rp-title' }), status = el('div', { class: 'rp-status' });
    const box = el('div', { class: 'map-panel rp' });
    const reopen = el('button', { class: 'btn small rp-open', title: 'show the round table', hidden: true, onclick: () => setPanel(true) }, 'Round table ▾');
    const setPanel = open => { S.panelOpen = open; box.hidden = !open; reopen.hidden = open; S.pb.invalidate(); };
    const all = d.players.filter(withPos).map(p => p.client);
    box.append(el('div', { class: 'rp-head' },
      el('div', { class: 'rp-head-text' }, title, status),
      el('div', { class: 'rp-tools' },
        el('button', { class: 'btn small', title: 'show every player on the map', onclick: () => setAll(all, true) }, 'All'),
        el('button', { class: 'btn small', title: 'hide every player', onclick: () => setAll(all, false) }, 'None'),
        el('button', { class: 'rp-close', title: 'collapse the round table', onclick: () => setPanel(false) }, '×'))));
    S.rp = { title, status, cards: [], rows: new Map() };
    // one card per team, in the order of the scoreboard
    for (const t of d.teams) {
      const ps = d.players.filter(p => p.team === t.key && withPos(p));
      if (!ps.length) continue;
      const score = el('span', { class: 'rp-score' }), side = el('span', { class: 'rp-side' }), alive = el('span', { class: 'rp-alive' });
      const card = el('div', { class: 'rp-card', style: { '--tc': app.teamColor(t.key) } },
        el('div', { class: 'rp-card-head' },
          el('span', { class: 'rp-team-name', title: t.name + ' - click: show / hide the whole team on the map',
            onclick: () => setAll(ps.map(p => p.client), !ps.every(p => S.selected.has(p.client))) }, t.name),
          score, side, alive));
      const tbody = el('tbody');
      card.append(el('table', { class: 'rp-table' },
        el('thead', null, el('tr', null, el('th', null, 'Player'), el('th', null, 'In hand'), el('th', { class: 'num' }, 'K'), el('th', { class: 'num' }, 'D'), el('th', null, ''))), tbody));
      for (const p of ps) S.rp.rows.set(p.client, playerRow(p, tbody, toggle, setHover));
      box.append(card);
      S.rp.cards.push({ key: t.key, score, side, alive, ps });
    }
    // spectators with positions (a spectating POV, followed players): same rows
    const specs = d.players.filter(p => p.team !== 'A' && p.team !== 'B' && withPos(p));
    if (specs.length) {
      const tbody = el('tbody');
      box.append(el('div', { class: 'rp-card spec', style: { '--tc': app.teamColor('spectator') } },
        el('div', { class: 'rp-card-head' }, el('span', { class: 'rp-team-name', title: 'click: show / hide all spectators',
          onclick: () => setAll(specs.map(p => p.client), !specs.every(p => S.selected.has(p.client))) }, 'Spectators')),
        el('table', { class: 'rp-table' }, tbody)));
      for (const p of specs) S.rp.rows.set(p.client, playerRow(p, tbody, toggle, setHover));
    }
    return el('div', { class: 'rp-wrap' }, reopen, box);
  }

  function playerRow(p, tbody, toggle, setHover) {
    const w = el('td', { class: 'rp-w' }), k = el('td', { class: 'num' }), dd = el('td', { class: 'num' });
    const stats = el('button', { class: 'rp-stats', title: 'Player stats', 'aria-label': 'Player stats: ' + p.cleanName,
      onclick: e => { e.stopPropagation(); C4.mapStats.open(stats, p.client, S.statsCtx); } }, C4.mapStats.statsIcon());
    const tr = el('tr', { class: 'rp-row', title: p.cleanName + ' - click: show / hide on the map', onclick: () => toggle(p.client),
      onmouseenter: () => setHover(p.client), onmouseleave: () => setHover(null) },
      el('td', { class: 'rp-name' }, el('span', { class: 'rp-dot' }), el('span', { class: 'rp-pname' }, p.cleanName),
        p.isPov ? el('span', { class: 'badge pov rp-pov', title: 'recording player' }, 'POV') : null),
      w, k, dd, el('td', { class: 'rp-stats-td' }, stats));
    tbody.append(tr);
    return { p, tr, w, k, d: dd };
  }

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  /** the round at t; between two rounds the last one before t (null before the first) */
  function roundAtOrBefore(t) {
    const d = S.d;
    let ri = C4.events.roundAt(d.rounds, t);
    if (ri < 0) for (let i = 0; i < d.rounds.length; i++) if (d.rounds[i].segStart <= t) ri = i;
    return ri >= 0 ? d.rounds[ri] : null;
  }

  /** the round table at time t: round and status, per team score, side and alive players, per player
   *  the weapon in hand and K / D up to t (the scoreboard rule, phase "live" only) */
  function updateRoundPanel(t) {
    if (!S.rp || !S.panelOpen) return;
    const d = S.d;
    // the round at t (between two rounds: the last one before t)
    const r = roundAtOrBefore(t);
    const phase = C4.rounds.phaseAt(d.phases, t);
    setText(S.rp.title, r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : r.kind === 'prematch' ? 'Pre-match round' : 'Aftermatch') : 'Before the first round');
    let st;
    if (phase === 'halftime') st = 'Halftime';
    else if (phase === 'timeout') st = 'Timeout';
    else if (phase === 'warmup') st = 'Warm-up';
    else if (!r) st = '-';
    else if (r.end != null && t >= r.end) st = 'Won by ' + (r.winnerTeam ? S.app.teamName(r.winnerTeam) : 'unknown team') + (r.reason ? ' (' + r.reason + ')' : '');
    else if (r.start != null && t < r.start) st = 'Strat time';
    else if (t >= r.segEnd) st = 'Round over';
    else st = 'In progress';
    setText(S.rp.status, st);
    S.rp.status.title = st;
    // K / D up to t (C4.build.kdRule) and the players killed in this round up to t
    const kd = new Map(), dead = new Set();
    for (const k of d.kills) {
      if (k.t > t) break;
      if (r && k.t >= r.segStart) dead.add(k.victim);
      if (k.phase !== 'live') continue;
      const { credit, death } = C4.build.kdRule(k);
      if (credit) { const o = kd.get(k.attacker) || { k: 0, d: 0 }; o.k++; kd.set(k.attacker, o); }
      if (death) { const o = kd.get(k.victim) || { k: 0, d: 0 }; o.d++; kd.set(k.victim, o); }
    }
    // score after the last round finished before t
    let score = d.initialScore || { A: 0, B: 0 };
    for (const x of d.rounds) if (x.kind === 'round' && x.end != null && x.end <= t && x.scoreAfter) score = x.scoreAfter;
    for (const c of S.rp.cards) {
      setText(c.score, String(score[c.key] != null ? score[c.key] : 0));
      const sd = r && r.sides ? r.sides[c.key] : null;
      setText(c.side, sd === 'attack' ? 'ATTACK' : sd === 'defence' ? 'DEFENCE' : '');
      // players of this round: a position sample in it; alive = not killed in it up to t
      const inRound = r ? c.ps.filter(p => { const P = d.positions[p.client]; const i = upperBound(P.t, r.segEnd) - 1; return i >= 0 && P.t[i] >= r.segStart; }) : [];
      setText(c.alive, r ? inRound.filter(p => !dead.has(p.client)).length + '/' + inRound.length + ' alive' : '');
    }
    for (const [cl, row] of S.rp.rows) {
      const o = kd.get(cl) || { k: 0, d: 0 };
      setText(row.k, String(o.k));
      setText(row.d, String(o.d));
      const isDead = dead.has(cl);
      let w = '-';
      if (!isDead && r) {
        const P = d.positions[cl], i = upperBound(P.t, t) - 1;
        if (i >= 0 && P.t[i] >= r.segStart && !(P.flags[i] & PF.DEAD)) w = weaponLabel(P.weapon[i], P.t[i]);
      }
      setText(row.w, w);
      row.w.title = w !== '-' ? w : isDead ? 'dead' : 'not in the snapshots';
      row.tr.classList.toggle('dead', isDead);
      row.tr.classList.toggle('off', !S.selected.has(cl));
      row.tr.classList.toggle('hover', S.hover === cl);
    }
  }

  /* ---------- keyboard ---------- */
  window.addEventListener('keydown', e => {
    if (!S || !S.active) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' && document.activeElement.type !== 'checkbox' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); S.pb.toggle(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); S.pb.seek(S.pb.t - CFG.SEEK_STEP_MS, -1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); S.pb.seek(S.pb.t + CFG.SEEK_STEP_MS, 1); }
    else if (e.code === 'KeyQ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); rotate(1); }
    else if (e.code === 'KeyE' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); rotate(-1); }
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
