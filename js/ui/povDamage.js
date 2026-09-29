/* Tab 8 - POV Damage: damage taken / hits dealt of the recording player, per round, per opponent,
 * per weapon, and his health over time. Everything comes from DemoData.povDamage (povDamage.js) -
 * the same object the JSON export contains. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, na, approx, sortableTable } = C4.ui;
  const W = C4.weapons;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const SOURCE_LABEL = { enemy: 'Enemies', team: 'Team mates', self: 'Self (own grenade, fall, suicide)', other: 'Other / unknown source' };

  const NA_DEALT = 'Not in the demo: the server sends the POV no damage value for his own hits, only the hit marker (see Hits dealt).';
  const HITS_DEALT_INFO = 'Hit-marker sound (mp_hit_alert) the server plays for the POV whenever he damages a player - an exact count of damage events, without value or victim (grenade damage and hits on team mates included).';
  const APPROX_TAKEN = 'part of it derived: damage without a bullet hit event - without attacker direction = own grenade or fall, with direction and a frag detonation = explosion (thrower unknown)';
  const NA_HITS_DEALT = 'No hit-marker sound in this demo although the POV killed players - this server does not send it.';
  const IMPACT_VICTIM = 'The POV\'s own bullet impacts (EV_BULLET_HIT: shooter = POV) - the victim is not transmitted: the nearest player to the impact (within 80 units). Bullets only (no grenade damage), and only impacts sent to the POV - so the sum can differ from the hit markers.';

  let state = null;

  function svg(tag, attrs, ...children) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    for (const c of children) if (c != null) e.append(c);
    return e;
  }
  const svgTitle = text => svg('title', null, text);

  function card(label, value, sub, title) {
    return el('div', { class: 'ov-card', title: title || null },
      el('div', { class: 'ov-label' }, label),
      el('div', { class: 'ov-value' }, value),
      sub ? el('div', { class: 'ov-sub' }, sub) : null);
  }
  const bySources = (by, unit) => ['enemy', 'team', 'self', 'other'].filter(s => by[s]).map(s => SOURCE_LABEL[s].split(' (')[0].toLowerCase() + ' ' + by[s] + (unit || '')).join(' · ') || 'none';

  function weaponCell(name, label, isApprox, reason) {
    const ic = name ? W.weaponIcon(name) : null;
    return el('span', { class: 'kf-weapon pd-weapon' }, ic ? C4.ui.iconNode(ic, label) : null, el('span', null, label),
      isApprox ? approx(reason) : null);
  }

  function render(root, app) {
    const d = app.data, P = d.povDamage;
    clear(root);
    const povName = P && P.povName ? P.povName : 'the recording player';
    root.append(el('div', { class: 'banner banner-info pd-note' },
      'These statistics cover only the demo\'s POV player ', el('strong', null, povName),
      ' - a client demo contains only his view. Only the live match time counts (no warm-up, knife round, timeout, halftime or aftermatch).'));
    if (!P || !P.available || !P.overview) {
      root.append(el('div', { class: 'empty' }, 'No player state of the POV player in this demo (spectator or shoutcaster recording).'));
      return;
    }
    const O = P.overview;
    const povPlayer = d.players.find(p => p.client === P.povClient);

    // ---- overview
    const dealtHits = O.hitsDealt == null ? na(NA_HITS_DEALT) : el('span', null, String(O.hitsDealt));
    const kd = el('span', null, O.kills + ' / ' + O.deaths);
    const sbK = povPlayer ? povPlayer.kills : null;
    const kdSub = sbK != null && sbK !== O.kills ? 'scoreboard K ' + sbK + ' (game scoreboard, see Scoreboard tab)' : 'from the kill feed';
    root.append(el('div', { class: 'pd-cards' },
      card('Damage taken', el('span', null, String(O.damageTaken), O.damageTakenApprox ? approx(O.damageTakenApprox + ' HP of it: ' + APPROX_TAKEN) : null),
        bySources(O.damageTakenBy, ' HP'), 'Health lost while alive (player state). The lethal hit counts with the health left, not its raw damage.'),
      card('Damage dealt', na(NA_DEALT), 'value not in the demo'),
      card('Hits taken', String(O.hitsTaken), bySources(O.hitsTakenBy), 'Damage events of the POV (player state damage counter; a lethal hit without counter step counts once)'),
      card('Hits dealt', dealtHits, O.hitsDealt == null ? 'no hit-marker sound' : 'hit markers, no value / victim', HITS_DEALT_INFO),
      card('Headshots', el('span', null,
        O.headshotKills + ' kills · ' + O.headshotHitsDealt + ' hits'),
        'taken: ' + O.headshotHitsTaken + ' hits (≈)',
        'Headshot kills: kill feed. Headshot hits dealt: head flag of the POV\'s own bullet impacts. Headshot hits taken (≈): sound bullet_impact_headshot_2 at a health drop, or a headshot kill.'),
      card('Kills / Deaths', kd, kdSub, 'Kills: kill feed, the scoreboard\'s rule (no team kills / suicides). Deaths: every death of the POV incl. falls.')));

    // ---- health chart
    const matchRounds = d.rounds.map((r, i) => ({ r, i })).filter(x => x.r.kind === 'round');
    const sel = el('select', { title: 'range of the chart' },
      el('option', { value: 'all' }, 'Whole match'),
      matchRounds.map(({ r, i }) => el('option', { value: String(i) }, 'Round ' + r.label)));
    const chartBox = el('div', { class: 'pd-chart' });
    root.append(el('div', { class: 'pd-section' },
      el('div', { class: 'toolbar' }, el('h3', { class: 'pd-h' }, 'Health of ' + povName), el('span', { class: 'spacer' }), sel),
      chartBox,
      el('div', { class: 'legend' },
        el('span', null, el('span', { class: 'sw', style: { background: 'var(--good)' } }), 'health'),
        el('span', null, el('span', { class: 'pd-sym taken' }, '▼'), 'damage taken (hollow = source ≈)'),
        el('span', null, el('span', { class: 'pd-sym dealt' }, '▲'), 'hit dealt (hit marker)'),
        el('span', null, el('span', { class: 'pd-sym kill' }, '★'), 'kill'),
        el('span', null, el('span', { class: 'pd-sym death' }, '✕'), 'death'),
        el('span', null, el('span', { class: 'sw', style: { background: 'rgba(255,255,255,.06)' } }), 'not live / POV spectating'),
        el('span', { class: 'muted' }, 'click a marker: Map tab 2 s before'))));
    state = { app, P, box: chartBox, scope: 'all', ro: null };
    sel.addEventListener('change', () => { state.scope = sel.value; drawChart(); });
    state.ro = new ResizeObserver(() => { if (state && state.box.clientWidth && state.box.clientWidth !== state.w) drawChart(); });
    state.ro.observe(chartBox);
    state.select = sel;

    // ---- per round
    const roundRows = P.rounds.slice();
    const roundTotals = { label: 'Total', damageDealt: 'n/a', damageTaken: O.damageTaken, hitsTaken: O.hitsTaken, hitsDealt: O.hitsDealt == null ? 'n/a' : O.hitsDealt, kills: O.kills, died: O.deaths };
    const roundCols = [
      { key: 'label', label: 'Round', sort: r => r.round, render: r => r.label },
      { key: 'damageDealt', label: 'Damage dealt', num: true, sort: false, render: () => na(NA_DEALT) },
      { key: 'damageTaken', label: 'Damage taken', num: true, render: r => el('span', { title: bySources(r.damageTakenBy, ' HP') }, String(r.damageTaken), r.damageTakenApprox ? approx(r.damageTakenApprox + ' HP of it: ' + APPROX_TAKEN) : null) },
      { key: 'hitsTaken', label: 'Hits taken', num: true },
      { key: 'hitsDealt', label: 'Hits dealt', num: true, title: HITS_DEALT_INFO, render: r => r.hitsDealt == null ? na(NA_HITS_DEALT) : String(r.hitsDealt) },
      { key: 'kills', label: 'Kills', num: true },
      { key: 'died', label: 'Died', sort: r => (r.died ? 1 : 0), render: r => r.died ? el('span', { class: 'pd-died', title: r.deathCause || '' }, 'yes') : el('span', { class: 'dim' }, 'no') }
    ];
    const groups = [{ rows: roundRows, totals: roundTotals }];
    if (P.otherLive) groups.push({ label: 'Live time outside a match round', rows: [Object.assign({ label: '-', round: 1e9 }, P.otherLive)] });
    root.append(el('div', { class: 'pd-section' }, el('h3', { class: 'pd-h' }, 'Per round'),
      sortableTable(roundCols, groups, { cls: 'pd-table', onRowClick: r => { if (r.round < 1e9) { sel.value = String(r.round); state.scope = sel.value; drawChart(); chartBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } } })));

    // ---- per opponent
    const hitsByPovCell = o => el('span', { title: o.headshotHitsDealt ? o.headshotHitsDealt + ' of them in the head' : null }, String(o.hitsDealt || 0), o.hitsDealt ? approx(IMPACT_VICTIM) : null);
    const oppCols = [
      { key: 'name', label: 'Player', sort: o => o.name, render: o => app.playerNode(o.client) },
      { key: 'damageTaken', label: 'Damage to POV', num: true, title: 'health the POV lost by this player (bullet hits and lethal hits: exact)' },
      { key: 'hitsTaken', label: 'Hits on POV', num: true },
      { key: 'killedPov', label: 'Killed POV', num: true },
      { key: 'kills', label: 'Killed by POV', num: true },
      { key: 'hitsDealt', label: 'Hits by POV', num: true, render: hitsByPovCell, title: 'bullet impacts of the POV, victim = nearest player (≈)' }
    ];
    const enemies = P.opponents.filter(o => o.relation === 'enemy'), mates = P.opponents.filter(o => o.relation === 'team');
    const sum = (rows, k) => rows.reduce((a, o) => a + (o[k] || 0), 0);
    const oppGroups = [];
    const totals = rows => ({ name: 'Total', damageTaken: sum(rows, 'damageTaken'), hitsTaken: sum(rows, 'hitsTaken'), killedPov: sum(rows, 'killedPov'), kills: sum(rows, 'kills'), hitsDealt: sum(rows, 'hitsDealt') });
    if (enemies.length) oppGroups.push({ label: 'Enemies', cls: 'b', rows: enemies, totals: totals(enemies) });
    if (mates.length) oppGroups.push({ label: 'Team mates (team damage)', cls: 'a', rows: mates, totals: totals(mates) });
    root.append(el('div', { class: 'pd-section' }, el('h3', { class: 'pd-h' }, 'Per opponent'),
      oppGroups.length ? sortableTable(oppCols, oppGroups, { cls: 'pd-table', sortKey: 'damageTaken' }) : el('div', { class: 'empty' }, 'No damage from or kills of other players in the live match time.'),
      el('p', { class: 'note' }, 'Self damage (' + O.damageTakenBy.self + ' HP) and damage of other / unknown source (' + O.damageTakenBy.other + ' HP) are listed per weapon below, not per player. ' +
        'Hits by POV: ' + O.impacts + ' own bullet impacts' + (O.impactsNoVictim ? ', ' + O.impactsNoVictim + ' of them without a player near the impact (not assigned)' : '') +
        ' - another source than the ' + (O.hitsDealt == null ? 'hit markers (not sent here)' : O.hitsDealt + ' hit markers') + ' (impacts: bullets only; hit markers: every damage incl. grenades).')));

    // ---- per weapon
    const takenCols = [
      { key: 'label', label: 'Weapon / cause', sort: w => w.label, render: w => weaponCell(w.weapon, w.label, w.approx, 'source or weapon derived (' + APPROX_TAKEN + '; or the killer\'s held weapon for a headshot kill)') },
      { key: 'source', label: 'Source', sort: w => w.source, render: w => SOURCE_LABEL[w.source] || w.source || '' },
      { key: 'damage', label: 'Damage taken', num: true },
      { key: 'hits', label: 'Hits', num: true },
      { key: 'kills', label: 'Lethal', num: true, title: 'the POV died by it' }
    ];
    const dealtCols = [
      { key: 'label', label: 'Weapon of the POV', sort: w => w.label, render: w => weaponCell(w.weapon, w.label, w.hits > 0, 'hits: the weapon the POV held at the hit marker; a hit right at a detonation of his own frag grenade counts as grenade') },
      { key: 'hits', label: 'Hits dealt', num: true, render: w => O.hitsDealt == null ? na(NA_HITS_DEALT) : String(w.hits) },
      { key: 'kills', label: 'Kills', num: true, title: 'kill feed (exact)' },
      { key: 'headshotKills', label: 'HS kills', num: true }
    ];
    root.append(el('div', { class: 'pd-section pd-weapons' },
      el('div', null, el('h3', { class: 'pd-h' }, 'Damage taken per weapon'),
        P.weapons.taken.length ? sortableTable(takenCols, [{ rows: P.weapons.taken }], { cls: 'pd-table', sortKey: 'damage' }) : el('div', { class: 'empty' }, 'No damage taken.')),
      el('div', null, el('h3', { class: 'pd-h' }, 'Hits and kills per weapon of the POV'),
        P.weapons.dealt.length ? sortableTable(dealtCols, [{ rows: P.weapons.dealt }], { cls: 'pd-table', sortKey: 'hits' }) : el('div', { class: 'empty' }, 'No hits or kills.'))));
  }

  /* ---- health chart (SVG, no library) ---- */
  function drawChart() {
    if (!state) return;
    const { app, P, box } = state;
    const d = app.data;
    const w = Math.max(320, box.clientWidth || 900), h = 240;
    state.w = box.clientWidth;
    const padL = 34, padR = 10, padT = 22, padB = 24;
    const rounds = d.rounds.map((r, i) => ({ r, i })).filter(x => x.r.kind === 'round');
    let t0, t1;
    if (state.scope === 'all') {
      t0 = rounds.length ? rounds[0].r.segStart : 0;
      t1 = rounds.length ? rounds[rounds.length - 1].r.segEnd : d.meta.durationMs;
    } else {
      const r = d.rounds[+state.scope];
      t0 = r.segStart; t1 = r.segEnd;
    }
    if (!(t1 > t0)) t1 = t0 + 1000;
    const X = t => padL + (t - t0) / (t1 - t0) * (w - padL - padR);
    const Y = hp => padT + (1 - hp / 100) * (h - padT - padB);
    const root = svg('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, class: 'pd-svg', role: 'img', 'aria-label': 'health of the POV over time' });

    // not live (phases) - shaded
    const phases = d.phases || [];
    phases.forEach((ph, i) => {
      if (ph.phase === 'live') return;
      const a = Math.max(t0, ph.start), b = Math.min(t1, i + 1 < phases.length ? phases[i + 1].start : d.meta.durationMs);
      if (b > a) root.append(svg('rect', { x: X(a), y: padT, width: X(b) - X(a), height: h - padT - padB, class: 'pd-notlive' }, svgTitle(ph.phase + ' (not counted)')));
    });
    // grid + y axis
    for (const hp of [0, 25, 50, 75, 100]) {
      root.append(svg('line', { x1: padL, x2: w - padR, y1: Y(hp), y2: Y(hp), class: 'pd-grid' }));
      root.append(svg('text', { x: padL - 6, y: Y(hp) + 4, class: 'pd-axis', 'text-anchor': 'end' }, String(hp)));
    }
    // time ticks
    const span = t1 - t0, steps = [5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5];
    const step = steps.find(s => span / s <= 10) || 18e5;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      root.append(svg('text', { x: X(t), y: h - 6, class: 'pd-axis', 'text-anchor': 'middle' }, fmtTime(t)));
    }
    // round boundaries
    for (const { r, i } of rounds) {
      if (r.segStart < t0 - 1 || r.segStart > t1) continue;
      const x = X(Math.max(t0, r.segStart));
      root.append(svg('line', { x1: x, x2: x, y1: padT - 14, y2: h - padB, class: 'pd-round' }));
      root.append(svg('text', { x: x + 3, y: padT - 5, class: 'pd-axis pd-round-label' }, 'R' + r.label, svgTitle('round ' + r.label)));
      void i;
    }
    // health line: steps, gaps while the POV is not followed
    const H = P.timeline.health;
    let dPath = '', open = false, lastY = null;
    let i0 = 0;
    while (i0 + 1 < H.t.length && H.t[i0 + 1] <= t0) i0++;
    for (let i = i0; i < H.t.length && H.t[i] <= t1; i++) {
      const hp = H.hp[i];
      const x = X(Math.max(t0, H.t[i]));
      if (hp == null) {
        if (open) { dPath += 'H' + x.toFixed(1); open = false; }
        continue;
      }
      const y = Y(hp);
      if (!open) { dPath += 'M' + x.toFixed(1) + ' ' + y.toFixed(1); open = true; }
      else dPath += 'H' + x.toFixed(1) + 'V' + y.toFixed(1);
      lastY = y;
    }
    if (open && lastY != null) dPath += 'H' + X(t1).toFixed(1);
    if (dPath) root.append(svg('path', { d: dPath, class: 'pd-health' }));

    // markers (counted events only)
    const go = e => () => app.gotoMap(e.t, e.round >= 0 ? e.round : undefined);
    const name = cl => (cl == null ? 'unknown' : app.playerLabel(cl));
    for (const e of P.timeline.events) {
      if (!e.counted || e.t < t0 || e.t > t1) continue;
      const x = X(e.t);
      let node;
      if (e.type === 'taken') {
        const who = e.source === 'enemy' || e.source === 'team' ? name(e.attacker) : e.how;
        const tip = fmtTime(e.t) + '  -' + e.amount + ' HP (' + e.healthBefore + ' → ' + e.healthAfter + ')  ' + (SOURCE_LABEL[e.source] || e.source) +
          ': ' + who + (e.weapon ? ', ' + W.label(e.weapon) : '') + (e.headshot ? ', headshot' + (e.headshotApprox ? ' ≈' : '') : '') + (e.approx ? '  (source ≈)' : '');
        const y = Y(e.healthAfter);
        node = svg('path', { d: 'M' + (x - 5) + ' ' + (y - 9) + 'H' + (x + 5) + 'L' + x + ' ' + y + 'Z', class: 'pd-m taken ' + e.source + (e.approx ? ' approx' : '') }, svgTitle(tip));
      } else if (e.type === 'dealt') {
        const tip = fmtTime(e.t) + '  hit dealt (hit marker)' + (e.weapon ? ', ' + W.label(e.weapon) + (e.weaponApprox ? ' ≈' : '') : '') + (e.headshot ? ', headshot' : '') +
          (e.victim != null ? ', victim ≈ ' + name(e.victim) : ', victim unknown');
        node = svg('path', { d: 'M' + (x - 4) + ' ' + (padT + 1) + 'H' + (x + 4) + 'L' + x + ' ' + (padT - 7) + 'Z', class: 'pd-m dealt' }, svgTitle(tip));
      } else if (e.type === 'kill') {
        node = svg('text', { x, y: padT + 14, class: 'pd-m kill', 'text-anchor': 'middle' }, '★',
          svgTitle(fmtTime(e.t) + '  kill: ' + name(e.victim) + ' (' + (e.weaponLabel || '') + ')' + (e.teamkill ? ', team kill' : '')));
      } else if (e.type === 'death') {
        node = svg('text', { x, y: h - padB - 3, class: 'pd-m death', 'text-anchor': 'middle' }, '✕',
          svgTitle(fmtTime(e.t) + '  death: ' + (e.suicide ? 'suicide' : e.world ? 'world / fall' : 'by ' + name(e.attacker)) + ' (' + (e.weaponLabel || '') + ')'));
      }
      if (node) { node.addEventListener('click', go(e)); root.append(node); }
    }
    clear(box).append(root);
  }

  function shown() { if (state) drawChart(); }
  function reset() { if (state && state.ro) state.ro.disconnect(); state = null; }

  C4.tabs.povdmg = { render, shown, reset };
})(window.C4);
