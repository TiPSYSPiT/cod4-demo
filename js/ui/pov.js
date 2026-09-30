/* Tab 8 - POV: the recording player's damage (DemoData.povDamage: health, damage taken, hits,
 * per round / opponent / weapon) and the own-kill metrics of all players (DemoData.ownKills).
 * Both objects are also in the JSON export. Three views: Health & rounds, Opponents & weapons,
 * Own-kill metrics. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, na, approx, sortableTable } = C4.ui;
  const W = C4.weapons;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const SOURCE_LABEL = { enemy: 'Enemies', team: 'Team mates', self: 'Self (own grenade, fall, suicide)', other: 'Other / unknown source' };

  const NA_DEALT = 'Not in the demo: the server sends the POV no damage value for the own hits, only the hit marker (see Hits dealt).';
  const HITS_DEALT_INFO = 'Hit-marker sound (mp_hit_alert) the server plays for the POV whenever he damages a player - an exact count of damage events, without value or victim (grenade damage and hits on team mates included).';
  const APPROX_TAKEN = 'part of it derived: damage without a bullet hit event - without attacker direction = own grenade or fall, with direction and a frag detonation = explosion (thrower unknown)';
  const NA_HITS_DEALT = 'No hit-marker sound in this demo although the POV killed players - this server does not send it.';
  const IMPACT_VICTIM = 'The POV\'s own bullet impacts (EV_BULLET_HIT: shooter = POV) - the victim is not transmitted: the nearest player to the impact (within 80 units). Bullets only (no grenade damage), and only impacts sent to the POV - so the sum can differ from the hit markers.';
  const OK_APPROX = 'derived: 3D angle between the view and the victim\'s upper body (nearest point chest -> head); eye = feet + the exact view height of the player state for a followed player, else 60 / 40 / 11 for stand / crouch / prone (lean ignored); values between two samples (50 ms) interpolated, shot times on the 50 ms grid. 12 units off are 3.4° at 200 units, 1.4° at 500.';
  const OK_SILENT = 'no sound event of the victim transmitted in the 2 s before the kill (footsteps, shots, jump, landing, reload, weapon switch, grenade, melee, item pickup) - "no transmitted sound", not "could not be heard". Only kills whose victim was in the snapshots for the whole 2 s count.';
  /** description of "% target silent & unseen" - with walls from the map geometry, or the view cone alone */
  function unseenText(sight) {
    const common = ' Only kills whose living team mates were all in the snapshots for the whole 2 s count.';
    if (sight && sight.method === 'geometry') {
      return 'derived: the victim was silent (see % target silent) and no living team mate of the killer saw it in the 2 s before - at no sample was the victim inside a team mate\'s view cone (±40° horizontal, ±35° vertical) with a free sight line through the map geometry of ' + sight.map + ' (team mate\'s eye -> the victim\'s feet, chest or head). Not in the geometry: static models (trees, bushes, cars, crates, awnings) and smoke; glass and doors do not block. A victim behind them counts as "seen", so the share is understated.' + common;
    }
    return 'ROUGH APPROXIMATION - ' + ((sight && sight.reason) || 'no map geometry') + ': the victim was silent (see % target silent) and in no view cone of a living team mate of the killer in the 2 s before. The cone (±40° horizontal, ±35° vertical around the team mate\'s view) has no walls, smoke or cover, so a victim behind a wall counts as "seen" - the share is understated.' + common;
  }
  let OK_UNSEEN = unseenText(null);  // set per demo in buildOwnKills
  const VIEWS = [['health', 'Health & rounds'], ['opponents', 'Opponents & weapons'], ['ownkills', 'Own-kill metrics']];

  let state = null;
  let currentView = 'health';        // kept when another demo is opened
  let showUnseen = false;            // optional column "% target silent & unseen" (off by default)
  let selectedTeam = null;           // POV without a team (spectator / shoutcaster): the team evaluated

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
  const pct = v => (v == null ? null : Math.round(v) + ' %');

  function weaponCell(name, label, isApprox, reason) {
    const ic = name ? W.weaponIcon(name) : null;
    return el('span', { class: 'kf-weapon pd-weapon' }, ic ? C4.ui.iconNode(ic, label) : null, el('span', null, label),
      isApprox ? approx(reason) : null);
  }

  function render(root, app) {
    const d = app.data, P = d.povDamage, OK = d.ownKills;
    clear(root);
    const povName = P && P.povName ? P.povName : 'the recording player';
    root.append(el('div', { class: 'pov-head' },
      el('h2', { class: 'pov-title' }, 'POV ', el('span', { class: 'pov-name' }, app.playerNode(P ? P.povClient : null))),
      el('p', { class: 'note pov-note' }, 'A client demo contains only the view of its recording player: health and damage come from the POV player state; other players only while they are in the POV snapshots. Only the live match time counts (no warm-up, knife round, timeout, halftime or aftermatch).')));
    if (!P || !P.available || !P.overview) {
      root.append(el('div', { class: 'empty' }, 'No player state of the POV player in this demo (spectator or shoutcaster recording).'));
      return;
    }
    const O = P.overview;
    const povPlayer = d.players.find(p => p.client === P.povClient);
    const okTeam = OK && OK.povTeam ? OK.teams[OK.povTeam] : null;
    const povOwn = okTeam && okTeam.players.find(r => r.client === P.povClient);

    // ---- key figures (always visible)
    const sbK = povPlayer ? povPlayer.kills : null;
    root.append(el('div', { class: 'pd-cards' },
      card('Damage taken', el('span', null, String(O.damageTaken), O.damageTakenApprox ? approx(O.damageTakenApprox + ' HP of it: ' + APPROX_TAKEN) : null),
        bySources(O.damageTakenBy, ' HP'), 'Health lost while alive (player state). The lethal hit counts with the health left, not its raw damage.'),
      card('Damage dealt', na(NA_DEALT), 'value not in the demo'),
      card('Hits taken / dealt', el('span', null, O.hitsTaken + ' / ', O.hitsDealt == null ? na(NA_HITS_DEALT) : String(O.hitsDealt)),
        'dealt = hit markers (no value)', 'Taken: damage events of the POV (player state). Dealt: ' + HITS_DEALT_INFO),
      card('Headshots', el('span', null, O.headshotKills + (O.headshotKills === 1 ? ' kill · ' : ' kills · ') + O.headshotHitsDealt + (O.headshotHitsDealt === 1 ? ' hit' : ' hits')),
        'taken: ' + O.headshotHitsTaken + (O.headshotHitsTaken === 1 ? ' hit' : ' hits') + ' (≈)',
        'Headshot kills: kill feed. Headshot hits dealt: head flag of the POV\'s own bullet impacts. Headshot hits taken (≈): sound bullet_impact_headshot_2 at a health drop, or a headshot kill.'),
      card('Kills / Deaths', el('span', null, O.kills + ' / ' + O.deaths),
        sbK != null && sbK !== O.kills ? 'scoreboard K ' + sbK + ' (game scoreboard)' : 'from the kill feed',
        'Kills: kill feed, the scoreboard\'s rule (no team kills / suicides). Deaths: every death of the POV incl. falls.'),
      card('Own kills', povOwn ? el('span', null, String(povOwn.ownKills), approx(OK_APPROX)) : na(OK && !OK.povTeam ? 'the POV plays in no team (spectator / shoutcaster)' : 'the POV has no kill in the live match time'),
        povOwn ? povOwn.evaluated + '/' + povOwn.kills + ' kills evaluated' + (povOwn.pctEarlyOnTarget != null ? ' · ' + pct(povOwn.pctEarlyOnTarget) + ' on target at -0.5 s' : '') : null,
        'Kills with a shot in the 300 ms before and the crosshair within 10° of the victim - see Own-kill metrics.')));

    // ---- views
    const nav = el('div', { class: 'pov-nav', role: 'tablist' });
    const panes = {};
    const body = el('div', { class: 'pov-body' });
    for (const [key, label] of VIEWS) {
      const b = el('button', { class: 'pov-nav-btn', role: 'tab', 'data-view': key }, label);
      b.addEventListener('click', () => showView(key));
      nav.append(b);
      panes[key] = el('div', { class: 'pov-pane', hidden: true });
      body.append(panes[key]);
    }
    root.append(nav, body);
    state = { app, P, OK, box: null, scope: 'all', ro: null, panes, nav, built: new Set() };
    showView(currentView);
  }

  function showView(key) {
    if (!state) return;
    currentView = key;
    for (const b of state.nav.children) b.classList.toggle('active', b.dataset.view === key);
    for (const [k, p] of Object.entries(state.panes)) p.hidden = k !== key;
    if (!state.built.has(key)) {
      state.built.add(key);
      ({ health: buildHealth, opponents: buildOpponents, ownkills: buildOwnKills })[key](state.panes[key]);
    }
    if (key === 'health') drawChart();
  }

  /* ---- view 1: health chart + per round ---- */
  function buildHealth(pane) {
    const { app, P } = state, d = app.data, O = P.overview;
    const povName = P.povName || 'the POV';
    const matchRounds = d.rounds.map((r, i) => ({ r, i })).filter(x => x.r.kind === 'round');
    const sel = el('select', { title: 'range of the chart' },
      el('option', { value: 'all' }, 'Whole match'),
      matchRounds.map(({ r, i }) => el('option', { value: String(i) }, 'Round ' + r.label)));
    const chartBox = el('div', { class: 'pd-chart' });
    pane.append(el('div', { class: 'pd-section' },
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
    state.box = chartBox;
    sel.addEventListener('change', () => { state.scope = sel.value; drawChart(); });
    state.ro = new ResizeObserver(() => { if (state && state.box && state.box.clientWidth && state.box.clientWidth !== state.w) drawChart(); });
    state.ro.observe(chartBox);

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
    const groups = [{ rows: P.rounds.slice(), totals: roundTotals }];
    if (P.otherLive) groups.push({ label: 'Live time outside a match round', rows: [Object.assign({ label: '-', round: 1e9 }, P.otherLive)] });
    pane.append(el('div', { class: 'pd-section' }, el('h3', { class: 'pd-h' }, 'Per round ', el('span', { class: 'muted pd-hint' }, '(click a row: chart of that round)')),
      sortableTable(roundCols, groups, { cls: 'pd-table', onRowClick: r => { if (r.round < 1e9) { sel.value = String(r.round); state.scope = sel.value; drawChart(); chartBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } } })));
  }

  /* ---- view 2: per opponent + per weapon ---- */
  function buildOpponents(pane) {
    const { app, P } = state, O = P.overview;
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
    const totals = rows => ({ name: 'Total', damageTaken: sum(rows, 'damageTaken'), hitsTaken: sum(rows, 'hitsTaken'), killedPov: sum(rows, 'killedPov'), kills: sum(rows, 'kills'), hitsDealt: sum(rows, 'hitsDealt') });
    const oppGroups = [];
    if (enemies.length) oppGroups.push({ label: 'Enemies', cls: 'b', rows: enemies, totals: totals(enemies) });
    if (mates.length) oppGroups.push({ label: 'Team mates (team damage)', cls: 'a', rows: mates, totals: totals(mates) });
    pane.append(el('div', { class: 'pd-section' }, el('h3', { class: 'pd-h' }, 'Per opponent'),
      oppGroups.length ? sortableTable(oppCols, oppGroups, { cls: 'pd-table', sortKey: 'damageTaken' }) : el('div', { class: 'empty' }, 'No damage from or kills of other players in the live match time.'),
      el('p', { class: 'note' }, 'Self damage (' + O.damageTakenBy.self + ' HP) and damage of other / unknown source (' + O.damageTakenBy.other + ' HP) are listed per weapon below, not per player. ' +
        'Hits by POV: ' + O.impacts + ' own bullet impacts' + (O.impactsNoVictim ? ', ' + O.impactsNoVictim + ' of them without a player near the impact (not assigned)' : '') +
        ' - another source than the ' + (O.hitsDealt == null ? 'hit markers (not sent here)' : O.hitsDealt + ' hit markers') + ' (impacts: bullets only; hit markers: every damage incl. grenades).')));
    const takenCols = [
      { key: 'label', label: 'Weapon / cause', sort: w => w.label, render: w => weaponCell(w.weapon, w.label, w.approx, 'source or weapon derived (' + APPROX_TAKEN + '; or the killer\'s held weapon for a headshot kill)') },
      { key: 'source', label: 'Source', sort: w => w.source, render: w => SOURCE_LABEL[w.source] || w.source || '' },
      { key: 'damage', label: 'Damage taken', num: true },
      { key: 'hits', label: 'Hits', num: true },
      { key: 'kills', label: 'Lethal', num: true, title: 'the POV died by it' }
    ];
    const dealtCols = [
      { key: 'label', label: 'Weapon of the POV', sort: w => w.label, render: w => weaponCell(w.weapon, w.label, w.approx && w.hits > 0, 'hits: the weapon the POV held at the hit marker (when no own bullet impact names it); a hit right at a detonation of an own frag grenade counts as grenade') },
      { key: 'hits', label: 'Hits dealt', num: true, render: w => O.hitsDealt == null ? na(NA_HITS_DEALT) : String(w.hits) },
      { key: 'kills', label: 'Kills', num: true, title: 'kill feed (exact)' },
      { key: 'headshotKills', label: 'HS kills', num: true }
    ];
    pane.append(el('div', { class: 'pd-section pd-weapons' },
      el('div', null, el('h3', { class: 'pd-h' }, 'Damage taken per weapon'),
        P.weapons.taken.length ? sortableTable(takenCols, [{ rows: P.weapons.taken }], { cls: 'pd-table', sortKey: 'damage' }) : el('div', { class: 'empty' }, 'No damage taken.')),
      el('div', null, el('h3', { class: 'pd-h' }, 'Hits and kills per weapon of the POV'),
        P.weapons.dealt.length ? sortableTable(dealtCols, [{ rows: P.weapons.dealt }], { cls: 'pd-table', sortKey: 'hits' }) : el('div', { class: 'empty' }, 'No hits or kills.'))));
  }

  /* ---- view 3: own-kill metrics of all players ---- */
  const METRICS = [
    { key: 'pctEarlyOnTarget', label: '% crosshair ≤3° at -0.5 s', short: '≤3° at -0.5 s', fmt: pct, max: () => 100,
      info: 'share of the own kills whose crosshair was within 3° of the victim 0.5 s before the kill' },
    { key: 'medianErrEarly', label: 'Median crosshair error at -0.5 s', short: 'Median error -0.5 s', fmt: v => (v == null ? null : v.toFixed(1) + '°'),
      info: 'median angle between view direction and victim 0.5 s before the kill (degrees)' },
    { key: 'pctSilent', label: '% target silent', short: 'Target silent', fmt: pct, max: () => 100, info: OK_SILENT },
    { key: 'pctSilentUnseen', label: '% target silent & unseen', short: 'Silent & unseen', fmt: pct, max: () => 100, info: null, optional: true },
    { key: 'medianDistance', label: 'Median distance (units)', short: 'Median distance', fmt: v => (v == null ? null : String(v)),
      info: 'median kill distance in world units (about one inch)' }
  ];

  function ratioBadge(r, rules) {
    if (r == null) return null;
    const cls = r >= rules.highlight[1] ? 'hi' : r <= rules.highlight[0] ? 'lo' : '';
    return el('span', { class: 'ok-ratio ' + cls, title: 'player ÷ ALL' + (cls ? ' - outside ' + rules.highlight[0] + '× … ' + rules.highlight[1] + '×' : '') },
      '×' + r.toFixed(2) + (cls === 'hi' ? ' ▲' : cls === 'lo' ? ' ▼' : ''));
  }

  function buildOwnKills(pane) {
    const { app, OK } = state;
    if (!OK || !OK.teams) { pane.append(el('div', { class: 'empty' }, 'No kills in the live match time.')); return; }
    const R = OK.rules;
    const geo = !!(OK.sight && OK.sight.method === 'geometry');
    OK_UNSEEN = unseenText(OK.sight);
    const METRICS_OK = METRICS.map(m => m.key !== 'pctSilentUnseen' ? m : Object.assign({}, m, { info: OK_UNSEEN, label: m.label + (geo ? '' : ' (rough)') }));
    // the POV's team; a POV without a team (spectator / shoutcaster) picks one
    let key = OK.povTeam;
    if (!key) {
      if (!selectedTeam || !OK.teams[selectedTeam]) selectedTeam = 'A';
      key = selectedTeam;
      const sel = el('select', { title: 'team to evaluate' }, ['A', 'B'].map(k => el('option', { value: k, selected: k === key ? 'selected' : null }, app.teamName(k))));
      sel.addEventListener('change', () => { selectedTeam = sel.value; clear(pane); buildOwnKills(pane); });
      pane.append(el('div', { class: 'banner banner-info ok-spec' },
        'The POV (' + (state.P && state.P.povName ? state.P.povName : 'recording player') + ') plays in no team - spectator or shoutcaster. Choose the team to evaluate: ', sel));
    }
    const TM = OK.teams[key];
    if (!TM || !TM.players.length) { pane.append(el('div', { class: 'empty' }, 'No kills of this team in the live match time.')); return; }
    const A = TM.all, teamLabel = OK.povTeam ? 'POV team' : app.teamName(key);
    const reasonText = ex => Object.entries(ex).filter(([, n]) => n).map(([k, n]) => n + ' ' + OK.reasons[k]).join('; ');
    pane.append(el('div', { class: 'ok-intro' },
      el('div', { class: 'ok-defs' },
        el('div', null, el('strong', null, 'Shown: '), OK.povTeam ? 'the POV and the team mates (' + app.teamName(key) + '; the halftime side swap does not change the team, a player who changed teams counts only while in it).' : 'the chosen team (' + app.teamName(key) + ').'),
        el('div', null, el('strong', null, 'Own kill: '), 'the killer shot in the ' + R.shotWindowMs + ' ms before the victim died with the crosshair within ' + R.ownKillMaxDeg + '° of the victim. Kills of the live match time only, no team kills or suicides.'),
        el('div', null, el('strong', null, 'Data coverage: '), 'evaluated kills / all kills. Excluded instead of estimated: ' + Object.values(OK.reasons).join('; ') + '.'),
        METRICS_OK.map(m => el('div', { class: m.optional ? 'ok-def-optional' : null }, el('strong', null, m.label + (m.optional ? ' - optional' : '') + ': '), m.info.replace(/\.$/, '') + '.')),
        el('div', null, el('strong', null, 'ALL (' + teamLabel + ') / ratio: '), 'the same over the own kills of the players shown; the ratio player ÷ ALL is marked from ' + R.highlight[1] + '× (▲) and up to ' + R.highlight[0] + '× (▼).')),
      el('div', { class: 'banner banner-warn ok-caveat' },
        el('strong', null, 'An indication, no proof. '),
        'Values are derived (≈: ' + OK_APPROX + ') and from small samples: with 20 own kills a share of 54 % varies between about 35 and 70 % by chance alone. Pre-aiming common angles, team callouts and sounds that are not events look the same. Check scenes in the Map tab.')));

    // optional column "silent & unseen" (off by default): with walls from the map geometry, else the cone alone
    const metrics = METRICS_OK.filter(m => !m.optional || showUnseen);
    const cb = el('input', { type: 'checkbox' });
    cb.checked = showUnseen;
    cb.addEventListener('change', () => { showUnseen = cb.checked; clear(pane); buildOwnKills(pane); });
    pane.append(el('div', { class: 'toolbar ok-options' },
      el('label', { class: 'opt', title: OK_UNSEEN }, cb, 'Show "% target silent & unseen" ',
        geo ? el('span', { class: 'ok-geo' }, 'walls from the map geometry - no trees, cars or smoke')
          : el('span', { class: 'ok-rough' }, 'rough approximation - no walls (no map geometry)'))));

    // table: POV on top, team mates, ALL (POV team)
    const cols = [
      { key: 'name', label: 'Player', sort: r => r.name, render: r => r.client == null ? el('strong', null, 'ALL (' + teamLabel + ')')
        // one neutral colour for every player (no name colour codes / team colours), only the POV in the accent colour + badge
        : el('span', { class: 'ok-name' + (r.isPov ? ' pov' : ''), title: r.name }, app.playerLabel(r.client), r.isPov ? el('span', { class: 'badge ok-pov-badge', title: 'recording player' }, 'POV') : null) },
      { key: 'kills', label: 'Kills', num: true, title: 'kills in the live match time (scoreboard rule) while in this team' },
      { key: 'evaluated', label: 'Data coverage', num: true, title: 'evaluated kills / all kills; hover a value for the excluded kills and why',
        render: r => el('span', { class: 'ok-cov', title: r.kills - r.evaluated ? 'excluded: ' + reasonText(r.excluded) : 'all kills evaluated' }, r.evaluated + '/' + r.kills) },
      { key: 'ownKills', label: 'Own kills', num: true, title: 'evaluated kills with the crosshair ≤' + R.ownKillMaxDeg + '° on the victim at the shot',
        render: r => el('span', { title: r.offTarget ? r.offTarget + ' evaluated kill(s) with the crosshair more than ' + R.ownKillMaxDeg + '° off' : null }, String(r.ownKills)) }
    ].concat(metrics.map(m => ({
      key: m.key, label: m.short, num: true, title: m.label + ' - ' + m.info, cls: m.optional ? 'ok-optional' : null,
      render: r => {
        const v = m.fmt(r[m.key]);
        if (v == null) {
          return na(m.key === 'pctSilent' ? 'no own kill whose victim was in the snapshots for the whole 2 s'
            : m.key === 'pctSilentUnseen' ? 'no own kill with a known result: the victim was not silent-checkable or a living team mate of the killer was not in the snapshots for the whole 2 s' : 'no own kill with data');
        }
        const why = m.key === 'pctSilent' ? OK_SILENT : m.key === 'pctSilentUnseen' ? OK_UNSEEN : OK_APPROX;
        const known = m.key === 'pctSilentUnseen' ? r.silentUnseenKnown : null;
        return el('span', { class: 'ok-cell', title: known != null ? 'from ' + known + ' own kills with a known result' : null },
          el('span', null, v, r.client != null && m.key !== 'medianDistance' ? approx(why) : null), r.ratio ? ratioBadge(r.ratio[m.key], R) : null);
      }
    })));
    // groups without a label (no separator rows): sorting applies within each, so the POV stays first and ALL last
    const povRows = TM.players.filter(r => r.isPov), mates = TM.players.filter(r => !r.isPov);
    const allRow = Object.assign({ name: 'ALL', client: null }, A);
    const groups = [{ rows: povRows }, { rows: mates }, { rows: [allRow] }].filter(g => g.rows.length);
    pane.append(el('div', { class: 'pd-section' }, el('h3', { class: 'pd-h' }, 'Own-kill metrics per player'),
      sortableTable(cols, groups, { cls: 'pd-table ok-table', sortKey: 'ownKills',
        rowClass: r => r.client == null ? 'ok-all-row' : ((!r.reliable ? 'ok-unreliable' : '') + (r.isPov ? ' pov' : '')).trim() }),
      el('p', { class: 'note' },
        'These values are hints for a manual review, no proof. Players with fewer than ' + R.reliableMinKills + ' evaluated kills are shown grey: their values say little. ',
        'Excluded kills (' + (A.kills - A.evaluated) + ' of ' + A.kills + '): ' + (reasonText(A.excluded) || 'none') + '. ' +
        (A.offTarget ? A.offTarget + ' evaluated kill(s) had the crosshair more than ' + R.ownKillMaxDeg + '° off (no own kill). ' : '') +
        'Shot source of the evaluated kills: ' + (Object.entries(TM.shotSources).map(([s, n]) => n + ' ' + s).join(', ') || 'none') + '.')));

    // bar charts (small multiples, one per metric; POV first, then the team mates - as in the table)
    const order = TM.players.filter(r => r.kills > 0);
    const grid = el('div', { class: 'ok-charts' });
    grid.append(barChart('Own kills (n)', order, r => r.ownKills, v => String(v), null, null, R, null, false));
    for (const m of metrics) grid.append(barChart(m.label, order, r => r[m.key], m.fmt, A[m.key], r => r.ratio[m.key], R, m.max, m.optional));
    pane.append(el('div', { class: 'pd-section' }, el('h3', { class: 'pd-h' }, 'Compared with ALL (' + teamLabel + ')'),
      el('div', { class: 'legend' },
        povRows.length ? el('span', null, el('span', { class: 'sw ok-sw pov' }), 'POV') : null,
        el('span', null, el('span', { class: 'sw ok-sw' }), OK.povTeam ? 'team mate' : 'player (' + app.teamName(key) + ')'),
        el('span', null, el('span', { class: 'sw ok-sw small' }), 'fewer than ' + R.reliableMinKills + ' evaluated kills'),
        el('span', null, el('span', { class: 'ok-allsw' }), 'ALL (' + teamLabel + ')'),
        el('span', null, '×1.35 ▲ / ×0.60 ▼ = outside ' + R.highlight[0] + '× … ' + R.highlight[1] + '× of ALL')),
      grid));
  }

  function barChart(title, rows, value, fmt, allValue, ratioOf, R, maxFn, rough) {
    const rowH = 22, labelW = 118, valueW = 90, padT = 8, w = 370, plotW = w - labelW - valueW;
    const badgeW = 26;                 // fixed slot for the "POV" badge right of the name
    const h = padT * 2 + rows.length * rowH;
    const vals = rows.map(value).filter(v => v != null);
    const max = maxFn ? maxFn() : Math.max(1, ...(allValue != null ? vals.concat(allValue) : vals)) * 1.08;
    const X = v => labelW + Math.max(0, v) / max * plotW;
    const root = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'ok-svg', role: 'img', 'aria-label': title });
    rows.forEach((r, i) => {
      const y = padT + i * rowH, v = value(r);
      const maxLen = r.isPov ? 12 : 16;
      const name = r.name.length > maxLen ? r.name.slice(0, maxLen - 1) + '…' : r.name;
      root.append(svg('text', { x: labelW - 6 - (r.isPov ? badgeW + 4 : 0), y: y + rowH / 2 + 4, class: 'ok-label' + (r.isPov ? ' pov' : ''), 'text-anchor': 'end' }, name, svgTitle(r.name + (r.isPov ? ' (POV)' : ''))));
      if (r.isPov) {
        const bx = labelW - 6 - badgeW;
        root.append(svg('rect', { x: bx, y: y + 5, width: badgeW, height: rowH - 10, rx: 6, class: 'ok-badge' }));
        root.append(svg('text', { x: bx + badgeW / 2, y: y + rowH / 2 + 3.5, class: 'ok-badge-text', 'text-anchor': 'middle' }, 'POV'));
      }
      if (v == null) {
        root.append(svg('text', { x: labelW + 4, y: y + rowH / 2 + 4, class: 'ok-na' }, 'n/a'));
        return;
      }
      const ratio = ratioOf ? ratioOf(r) : null;
      const out = ratio != null && (ratio >= R.highlight[1] || ratio <= R.highlight[0]);
      const bw = Math.max(2, X(v) - labelW);
      const small = !r.reliable;
      const tip = r.name + ': ' + fmt(v) + (ratio != null ? '  (×' + ratio.toFixed(2) + ' of ALL)' : '') + '  - ' + r.evaluated + '/' + r.kills + ' kills evaluated' +
        (small ? ', fewer than ' + R.reliableMinKills + ': little meaning' : '');
      root.append(svg('rect', { x: labelW, y: y + 5, width: bw, height: rowH - 10, rx: 3, class: 'ok-bar ' + (r.isPov ? 'pov' : 'player') + (small ? ' small' : '') + (out ? ' out' : '') }, svgTitle(tip)));
      root.append(svg('text', { x: labelW + bw + 5, y: y + rowH / 2 + 4, class: 'ok-value' + (out ? ' out' : '') },
        fmt(v) + (out ? (ratio >= R.highlight[1] ? ' ×' + ratio.toFixed(2) + ' ▲' : ' ×' + ratio.toFixed(2) + ' ▼') : '')));
    });
    if (allValue != null) {
      const x = X(allValue);
      root.append(svg('line', { x1: x, x2: x, y1: 2, y2: h - 2, class: 'ok-all' }, svgTitle('ALL: ' + fmt(allValue))));
    }
    return el('div', { class: 'ok-chart' + (rough ? ' rough' : '') }, el('div', { class: 'ok-chart-title' }, title, allValue != null ? el('span', { class: 'muted' }, '  ALL ' + fmt(allValue)) : null,
      rough ? approx(OK_UNSEEN) : null), root);
  }

  /* ---- health chart (SVG, no library) ---- */
  function drawChart() {
    if (!state || !state.box) return;
    const { app, P, box } = state;
    if (!box.clientWidth) return;           // pane hidden: drawn when shown
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
    const phases = d.phases || [];
    phases.forEach((ph, i) => {
      if (ph.phase === 'live') return;
      const a = Math.max(t0, ph.start), b = Math.min(t1, i + 1 < phases.length ? phases[i + 1].start : d.meta.durationMs);
      if (b > a) root.append(svg('rect', { x: X(a), y: padT, width: X(b) - X(a), height: h - padT - padB, class: 'pd-notlive' }, svgTitle(ph.phase + ' (not counted)')));
    });
    for (const hp of [0, 25, 50, 75, 100]) {
      root.append(svg('line', { x1: padL, x2: w - padR, y1: Y(hp), y2: Y(hp), class: 'pd-grid' }));
      root.append(svg('text', { x: padL - 6, y: Y(hp) + 4, class: 'pd-axis', 'text-anchor': 'end' }, String(hp)));
    }
    const span = t1 - t0, steps = [5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5];
    const step = steps.find(s => span / s <= 10) || 18e5;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      root.append(svg('text', { x: X(t), y: h - 6, class: 'pd-axis', 'text-anchor': 'middle' }, fmtTime(t)));
    }
    for (const { r } of rounds) {
      if (r.segStart < t0 - 1 || r.segStart > t1) continue;
      const x = X(Math.max(t0, r.segStart));
      root.append(svg('line', { x1: x, x2: x, y1: padT - 14, y2: h - padB, class: 'pd-round' }));
      root.append(svg('text', { x: x + 3, y: padT - 5, class: 'pd-axis pd-round-label' }, 'R' + r.label, svgTitle('round ' + r.label)));
    }
    const H = P.timeline.health;
    let dPath = '', open = false, lastY = null, i0 = 0;
    while (i0 + 1 < H.t.length && H.t[i0 + 1] <= t0) i0++;
    for (let i = i0; i < H.t.length && H.t[i] <= t1; i++) {
      const hp = H.hp[i];
      const x = X(Math.max(t0, H.t[i]));
      if (hp == null) { if (open) { dPath += 'H' + x.toFixed(1); open = false; } continue; }
      const y = Y(hp);
      if (!open) { dPath += 'M' + x.toFixed(1) + ' ' + y.toFixed(1); open = true; }
      else dPath += 'H' + x.toFixed(1) + 'V' + y.toFixed(1);
      lastY = y;
    }
    if (open && lastY != null) dPath += 'H' + X(t1).toFixed(1);
    if (dPath) root.append(svg('path', { d: dPath, class: 'pd-health' }));
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

  function shown() { if (state && currentView === 'health') drawChart(); }
  function reset() { if (state && state.ro) state.ro.disconnect(); state = null; }

  C4.tabs.pov = { render, shown, reset };
})(window.C4);
