/* Map tab: the heatmap options panel (button "Heatmap" in the map tools, top right of the map).
 *
 *   const hp = C4.mapHeat.create({app, data, onChange})
 *   hp.button, hp.panel, hp.chip  - DOM: the tool button, the floating panel, the legend on the map
 *   hp.opts                       - {cat, team, side, players (null = all | Set of clients), radius,
 *                                    intensity, keep, upTo}; stored in localStorage (by team and player
 *                                    name, so the choice carries over to demos of the same teams)
 *   hp.info({n, missing, unattributed, filtered}) - legend: number of points and notes
 * The panel closes with the button, Escape or a click outside. It is DOM over the map, so it never
 * appears in a video export. */
(function (C4) {
  'use strict';
  const { el, clear } = C4.ui;
  const H = C4.mapConfig.HEAT;

  const CATS = [['off', 'Off'], ['positions', 'Positions'], ['kills', 'Kills (killer spots)'], ['deaths', 'Deaths'],
    ['landings', 'Grenade landings'], ['smokes', 'Smokes'], ['shots', 'Shots fired']];
  const CAT_HELP = {
    positions: 'where living players were, sampled every ' + H.SAMPLE_MS + ' ms (no dead players, no spectators)',
    kills: 'the killer\'s position at each kill - no team kills and suicides (the scoreboard rule)',
    deaths: 'the victim\'s position at each death',
    landings: 'detonation points of frag, flash and stun grenades',
    smokes: 'detonation points of smoke grenades',
    shots: 'the shooter\'s position at every shot seen in the demo'
  };
  const SIDES = [['both', 'Attack and defence'], ['attack', 'Attacking only'], ['defence', 'Defending only']];
  const DEFAULTS = { cat: 'off', team: 'both', side: 'both', players: null, radius: H.RADIUS.def, intensity: H.INTENSITY.def, keep: true, upTo: true };
  const POV_NOTE = 'Based on data visible in this POV demo: other players are only included while the POV could see them.';

  /* ---------- settings (localStorage, every access in try / catch) ---------- */
  function load(d, app) {
    const o = { ...DEFAULTS };
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(H.STORE_KEY) || 'null'); } catch (err) { raw = null; }
    if (!raw || typeof raw !== 'object') return o;
    if (CATS.some(c => c[0] === raw.cat)) o.cat = raw.cat;
    if (SIDES.some(s => s[0] === raw.side)) o.side = raw.side;
    // team and players by name: the keys A / B and the client numbers belong to one demo
    if (raw.teamName) { const t = d.teams.find(x => app.teamName(x.key) === raw.teamName); if (t) o.team = t.key; }
    if (Array.isArray(raw.players) && raw.players.length) {
      const set = new Set(d.players.filter(p => raw.players.includes(p.cleanName) && (p.team === 'A' || p.team === 'B')).map(p => p.client));
      if (set.size) o.players = set;
    }
    const num = (v, r) => (typeof v === 'number' && v >= r.min && v <= r.max ? v : r.def);
    o.radius = num(raw.radius, H.RADIUS);
    o.intensity = num(raw.intensity, H.INTENSITY);
    if (typeof raw.keep === 'boolean') o.keep = raw.keep;
    if (typeof raw.upTo === 'boolean') o.upTo = raw.upTo;
    return o;
  }
  function save(o, d, app) {
    const v = { cat: o.cat, side: o.side, teamName: o.team === 'both' ? null : app.teamName(o.team),
      players: o.players ? d.players.filter(p => o.players.has(p.client)).map(p => p.cleanName) : null,
      radius: o.radius, intensity: o.intensity, keep: o.keep, upTo: o.upTo };
    try { localStorage.setItem(H.STORE_KEY, JSON.stringify(v)); } catch (err) { /* storage blocked: not kept */ }
  }

  /** the tool icon: a hot spot (three nested blobs, currentColor) */
  function heatIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
    for (const [cx, cy, r, op] of [[8, 8, 7, 0.28], [8.6, 7.4, 4.6, 0.5], [9.2, 6.8, 2.2, 1]]) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r); c.setAttribute('fill', 'currentColor'); c.setAttribute('fill-opacity', op);
      svg.append(c);
    }
    return svg;
  }

  /** the colour ramp as a CSS gradient (the same stops as the raster) */
  const rampCss = () => 'linear-gradient(to right, ' + H.STOPS.map(([v, c]) => 'rgb(' + c.join(',') + ') ' + Math.round(v * 100) + '%').join(', ') + ')';

  function create(ctx) {
    const { app, data: d } = ctx;
    const o = load(d, app);
    const changed = what => { save(o, d, app); update(); ctx.onChange(what); };
    let open = false;

    const button = el('button', { class: 'map-tool heat-btn', title: 'Heatmap', 'aria-label': 'Heatmap', 'aria-expanded': 'false', onclick: () => setOpen(!open) }, heatIcon());
    const panel = el('div', { class: 'heat-panel', role: 'dialog', 'aria-label': 'Heatmap', hidden: true });
    const uid = 'hp' + Math.random().toString(36).slice(2, 7);
    const radios = (name, items, get, set) => el('div', { class: 'hp-radios' }, items.map(([v, label, title]) => {
      const inp = el('input', { type: 'radio', name: uid + name, value: v });
      inp.checked = get() === v;
      inp.addEventListener('change', () => { if (inp.checked) { set(v); } });
      return el('label', { class: 'hp-radio', title: title || null }, inp, label);
    }));
    const section = (title, ...c) => el('div', { class: 'hp-sec' }, el('div', { class: 'hp-h' }, title), ...c);

    // player dropdown: checkboxes grouped by team, a team colour dot before the name
    const teamPlayers = d.teams.map(t => ({ t, ps: d.players.filter(p => p.team === t.key) })).filter(x => x.ps.length);
    const ddLabel = el('span', { class: 'hp-dd-label' });
    const ddList = el('div', { class: 'hp-dd-list', hidden: true });
    const ddBtn = el('button', { class: 'hp-dd-btn', 'aria-haspopup': 'listbox', onclick: () => { ddList.hidden = !ddList.hidden; } }, ddLabel, el('span', { class: 'hp-dd-caret' }, '▾'));
    const fillList = () => {
      clear(ddList);
      const all = el('input', { type: 'checkbox' }); all.checked = !o.players;
      all.addEventListener('change', () => { o.players = null; fillList(); changed('filter'); });
      ddList.append(el('label', { class: 'hp-dd-item all' }, all, 'All players'));
      for (const { t, ps } of teamPlayers) {
        ddList.append(el('div', { class: 'hp-dd-team', style: { color: app.teamColor(t.key) } }, app.teamName(t.key)));
        for (const p of ps) {
          const cb = el('input', { type: 'checkbox' }); cb.checked = !!(o.players && o.players.has(p.client));
          cb.addEventListener('change', () => {
            const s = new Set(o.players || []);
            if (cb.checked) s.add(p.client); else s.delete(p.client);
            o.players = s.size ? s : null;
            fillList(); changed('filter');
          });
          ddList.append(el('label', { class: 'hp-dd-item', title: p.cleanName }, cb, el('span', { class: 'rp-dot', style: { '--tc': app.teamColor(p.team) } }), el('span', { class: 'hp-dd-name' }, p.cleanName)));
        }
      }
    };
    fillList();

    const slider = (r, get, set, fmt) => {
      const val = el('span', { class: 'hp-val' });
      const inp = el('input', { type: 'range', min: String(r.min), max: String(r.max), step: String(r.step) });
      inp.value = String(get());
      const show = () => { val.textContent = fmt(get()); };
      inp.addEventListener('input', () => { set(Number(inp.value)); show(); changed('look'); });
      show();
      return { inp, val };
    };
    const rad = slider(H.RADIUS, () => o.radius, v => { o.radius = v; }, v => v + ' units');
    const ins = slider(H.INTENSITY, () => o.intensity, v => { o.intensity = v; }, v => '×' + v.toFixed(2));
    const keep = el('input', { type: 'checkbox' }); keep.checked = o.keep;
    keep.addEventListener('change', () => { o.keep = keep.checked; changed('look'); });
    const rangeSeg = el('div', { class: 'seg small hp-range' });
    for (const [v, label, title] of [[true, 'Up to current time', 'up to the playback time'], [false, 'Full range', 'the whole range chosen (whole match or the round)']]) {
      rangeSeg.append(el('button', { 'data-v': String(v), title, onclick: () => { o.upTo = v; changed('filter'); } }, label));
    }

    const legendN = el('span', { class: 'hp-n' }), legendNote = el('div', { class: 'hp-note' });
    const legend = el('div', { class: 'hp-legend', title: POV_NOTE },
      el('div', { class: 'hp-ramp', style: { background: rampCss() } }),
      el('div', { class: 'hp-ramp-labels' }, el('span', null, 'low'), el('span', null, '→'), el('span', null, 'high')),
      el('div', { class: 'hp-legend-foot' }, legendN, el('span', { class: 'hp-pov' }, 'POV data ⓘ')),
      legendNote);
    const chipN = el('span', { class: 'hp-n' });
    const chip = el('div', { class: 'heat-chip', title: POV_NOTE, hidden: true },
      el('span', { class: 'hp-chip-cat' }), el('div', { class: 'hp-ramp', style: { background: rampCss() } }), el('span', { class: 'hp-chip-lh' }, 'low → high'), chipN);

    panel.append(
      el('div', { class: 'hp-head' }, el('strong', null, 'Heatmap'), el('button', { class: 'rp-close', title: 'close (Esc)', onclick: () => setOpen(false) }, '×')),
      section('Heatmap', radios('cat', CATS.map(([v, l]) => [v, l, CAT_HELP[v] || 'no heatmap']), () => o.cat, v => { o.cat = v; changed('filter'); })),
      section('Team', radios('team', [['both', 'Both teams'], ...d.teams.map(t => [t.key, app.teamName(t.key)])], () => o.team, v => { o.team = v; changed('filter'); })),
      section('Side', radios('side', SIDES, () => o.side, v => { o.side = v; changed('filter'); })),
      section('Player', el('div', { class: 'hp-dd' }, ddBtn, ddList)),
      section('Look',
        el('label', { class: 'hp-slider', title: 'size of the hot spots in world units (scales with zoom and map)' }, el('span', null, 'Radius'), rad.inp, rad.val),
        el('label', { class: 'hp-slider', title: 'gain of the colour scale (normalised to the maximum of the data shown)' }, el('span', null, 'Intensity'), ins.inp, ins.val),
        el('label', { class: 'hp-check', title: 'players, trails, grenades and the bomb stay visible above the heatmap; off: only the heatmap on the map' }, keep, 'Keep players visible')),
      el('div', { class: 'hp-sec' }, rangeSeg),
      legend);

    function update() {
      ddLabel.textContent = !o.players ? 'All players' : o.players.size === 1 ? (d.players.find(p => o.players.has(p.client)) || {}).cleanName || '1 player' : o.players.size + ' players';
      rangeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === String(o.upTo)));
      const on = o.cat !== 'off';
      button.classList.toggle('active', on);
      button.title = on ? 'Heatmap: ' + CATS.find(c => c[0] === o.cat)[1] : 'Heatmap';
      chip.hidden = !on;
      chip.querySelector('.hp-chip-cat').textContent = on ? CATS.find(c => c[0] === o.cat)[1] : '';
      legend.classList.toggle('off', !on);
      if (!on) { legendN.textContent = 'n = 0'; chipN.textContent = ''; legendNote.textContent = ''; }
    }

    // close with the button, Escape or a click outside
    const outside = e => { if (open && !panel.contains(e.target) && !button.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } };
    function setOpen(v) {
      if (v === open) return;
      open = v;
      panel.hidden = !v;
      button.classList.toggle('open', v);
      button.setAttribute('aria-expanded', String(v));
      if (v) { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', onKey, true); }
      else { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); ddList.hidden = true; }
    }

    /** legend: points in the heatmap and what was left out */
    let lastInfo = '';
    function info(x) {
      const key = x ? x.n + '|' + x.missing + '|' + x.unattributed + '|' + x.filtered : '';
      if (key === lastInfo) return;
      lastInfo = key;
      if (!x) return;
      const txt = 'n = ' + x.n.toLocaleString('en');
      legendN.textContent = txt; chipN.textContent = txt;
      const notes = [];
      if (x.missing) notes.push(x.missing + (o.cat === 'shots' ? ' shot(s)' : o.cat === 'kills' ? ' kill(s)' : ' death(s)') + ' without a known position (the player was not in the snapshots) - not drawn.');
      if ((o.cat === 'landings' || o.cat === 'smokes')) {
        if (x.filtered) notes.push('Grenades without a known thrower are left out by the team / side / player filter.');
        else if (x.unattributed) notes.push(x.unattributed + ' of them without a known thrower (the thrower is estimated, ≈).');
      }
      legendNote.textContent = notes.join(' ');
    }

    update();
    return { button, panel, chip, opts: o, info, close: () => setOpen(false), get isOpen() { return open; } };
  }

  C4.mapHeat = { create, load, DEFAULTS, POV_NOTE };
})(window.C4);
