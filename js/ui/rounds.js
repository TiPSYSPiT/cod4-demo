/* Tab 2 - Round by Round, plus the shared kill renderer. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, fmtRoundTime, na, approx, teamClass } = C4.ui;

  /** "Killer → Victim · Weapon [HS]" with the special cases named */
  function killNodes(app, k) {
    const victim = app.playerNode(k.victim, { team: k.victimTeam || undefined });
    const weapon = [el('span', { class: 'weapon' }, k.weaponLabel), k.weaponHeuristic ? approx('the obituary of a headshot carries no weapon; this is the weapon the killer held at that moment') : null];
    const hs = k.headshot ? [' ', el('span', { class: 'badge hs' }, 'HS')] : null;
    if (k.suicide) {
      const what = k.mod === 'MOD_SUICIDE' ? 'Suicide' : 'Suicide (' + k.weaponLabel + ')';
      return [victim, el('span', { class: 'weapon' }, what)];
    }
    if (k.world) {
      return [victim, el('span', { class: 'weapon', title: 'killed by the world (map, falling, trigger)' }, k.falling ? 'Falling' : 'World / trigger (' + k.weaponLabel + ')')];
    }
    if (k.entityAttacker) {
      return [victim, el('span', { class: 'weapon', title: 'killed by entity ' + k.attacker + ' (not a player)' }, k.car ? 'Car explosion' : 'World entity (' + k.weaponLabel + ')')];
    }
    return [app.playerNode(k.attacker, { team: k.attackerTeam || undefined }), el('span', { class: 'arrow' }, '→'), victim, weapon, hs,
      k.teamkill ? [' ', el('span', { class: 'badge tk', title: 'attacker and victim were on the same side' }, 'Teamkill')] : null,
      k.bomb ? [' ', el('span', { class: 'badge', title: 'killed by the bomb explosion' }, 'Bomb')] : null];
  }
  C4.ui.killNodes = killNodes;

  function sideLabel(side) {
    return el('span', { class: side === 'attack' ? 'side-attack' : 'side-defence' }, side === 'attack' ? 'Attack' : 'Defence');
  }

  function render(root, app) {
    const d = app.data;
    clear(root);
    if (!d.rounds.length) {
      root.append(el('div', { class: 'empty' }, d.meta.isSearchAndDestroy ? 'No rounds detected in this demo.' : 'No rounds detected - the round logic is built for Search & Destroy (this demo: ' + (d.meta.gametypeDisplay || d.meta.gametype) + ').'));
      return;
    }
    const [A, B] = d.teams;
    const bar = el('div', { class: 'toolbar' },
      el('button', { class: 'btn small', onclick: () => root.querySelectorAll('.round-card').forEach(c => { if (c.fill) c.fill(); c.classList.add('open'); }) }, 'Expand all'),
      el('button', { class: 'btn small', onclick: () => root.querySelectorAll('.round-card').forEach(c => c.classList.remove('open')) }, 'Collapse all'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted' }, 'Click a kill or bomb event to open it on the map (2 s before).'));
    const list = el('div', { class: 'rounds' });
    // Only the match rounds are numbered and counted. Rounds before the match (knife round,
    // warm-up) and after the official match end (aftermatch) get their own marked section.
    const idx = d.rounds.map((r, i) => i);
    const before = idx.filter(i => d.rounds[i].kind === 'knife' || d.rounds[i].kind === 'prematch');
    const match = idx.filter(i => d.rounds[i].kind === 'round');
    const after = idx.filter(i => d.rounds[i].kind === 'aftermatch');
    if (before.length) {
      list.append(el('div', { class: 'phase-section' }, 'Before the match — not counted',
        el('small', null, 'knife round / warm-up rounds: no round number, not in the scoreboard')));
      for (const i of before) list.append(roundCard(app, d.rounds[i], i, A, B));
      if (match.length) list.append(el('div', { class: 'phase-section live' }, 'Match — ' + match.length + ' round' + (match.length === 1 ? '' : 's'),
        el('small', null, 'official start ' + fmtTime(d.match.start))));
    }
    // a recording that starts mid-match begins in a later half (d.halfInfo.offset halves not recorded)
    let lastHalf = match.length ? d.rounds[match[0]].half : 1;
    const halftimes = d.halftimes;
    for (const i of match) {
      const r = d.rounds[i];
      if (r.half > lastHalf) {
        const ht = halftimes[r.half - 2 - d.halfInfo.offset];
        list.append(el('div', { class: 'halftime' }, 'Halftime — teams switch sides' + (ht != null ? '  (' + fmtTime(ht) + ')' : '')));
        lastHalf = r.half;
      }
      list.append(roundCard(app, r, i, A, B));
    }
    if (after.length || (d.match.end != null && d.kills.some(k => k.phase === 'aftermatch'))) {
      const final = d.teams.map(t => t.wins).join(':');
      list.append(el('div', { class: 'phase-section after' }, 'Aftermatch — not counted',
        el('small', null, d.match.end != null
          ? 'official match end ' + fmtTime(d.match.end) + ' at ' + final + ' (' + (d.match.endSource === 'win rule' ? 'win condition of ' + (d.meta.ruleset || 'the ruleset') : 'score reset after the last round') + '); everything after it is not in the scoreboard'
          : 'after the last match round')));
      for (const i of after) list.append(roundCard(app, d.rounds[i], i, A, B));
    }
    root.append(bar, list);
  }

  function roundCard(app, r, i, A, B) {
    const d = app.data;
    const winner = r.winnerTeam ? app.team(r.winnerTeam) : null;
    const title = r.kind === 'knife' ? 'Knife' : r.kind === 'prematch' ? 'Pre' : r.kind === 'aftermatch' ? 'After' : 'R' + r.label;
    const sub = r.kind === 'knife' ? ['knife round', r.knifeHeuristic ? approx('no "Knife Round" status line: a round before the match in a knife ruleset with melee kills only') : null]
      : r.kind === 'prematch' ? 'before the match' : r.kind === 'aftermatch' ? 'after the match end'
      : (d.halfInfo.unknown ? 'half ?' : 'half ' + r.half) + (r.end == null ? ' · unfinished' : '');
    const reason = r.reason ? [r.reason, r.reasonHeuristic ? approx(r.reasonSource) : null]
      : na(r.complete ? 'no reason detected' : (r.startedBeforeRecording ? 'round incomplete in the demo' : 'the demo ends before the round is decided'));
    const head = el('div', { class: 'round-head' },
      el('div', { class: 'round-no' }, title, el('small', null, sub)),
      el('div', null, winner ? el('span', { class: teamClass(winner.key), style: { fontWeight: 700 } }, winner.name + ' win') : na('no winner in the demo'),
        r.winnerSide ? el('span', { class: 'dim' }, '  (' + (r.winnerSide === d.meta.attackSide ? 'Attack' : 'Defence') + ')') : null),
      el('div', null, reason),
      el('div', { class: 'muted', title: 'from the start of the round timer to the decision' }, r.duration != null ? fmtTime(r.duration) : na('round not complete')),
      el('div', { class: 'round-score', title: 'score after this round' }, r.kind === 'round'
        ? [el('span', { class: 'team-a' }, r.scoreAfter.A), ' : ', el('span', { class: 'team-b' }, r.scoreAfter.B)]
        : el('span', { class: 'dim' }, 'not counted')),
      el('div', { class: 'muted' }, el('span', { class: 'team-a' }, A.name), ' ', sideLabel(r.sides.A), el('span', { class: 'dim' }, '  /  '), el('span', { class: 'team-b' }, B.name), ' ', sideLabel(r.sides.B)),
      el('div', { class: 'round-toggle' }, '▶'));
    const body = el('div', { class: 'round-body' });
    const card = el('div', { class: 'round-card ' + (r.kind !== 'round' ? 'not-counted ' : '') + (r.winnerTeam === 'A' ? 'win-a' : r.winnerTeam === 'B' ? 'win-b' : '') }, head, body);
    // the kill list is built on the first opening (also by "Expand all")
    let filled = false;
    card.fill = () => { if (!filled) { fillTimeline(app, r, i, body); filled = true; } };
    head.addEventListener('click', () => {
      card.fill();
      card.classList.toggle('open');
    });
    return card;
  }

  function fillTimeline(app, r, i, body) {
    const d = app.data;
    const items = [];
    for (const ki of r.kills) items.push({ t: d.kills[ki].t, kill: d.kills[ki] });
    for (const b of r.bomb) if (b.action === 'planted' || b.action === 'defused') items.push({ t: b.t, bomb: b });
    items.sort((a, b) => a.t - b.t);
    if (!items.length) { body.append(el('div', { class: 'empty' }, 'No kills or bomb events in this round.')); return; }
    const time = t => el('div', { class: 'tl-time', title: 'match time ' + fmtTime(t) }, fmtRoundTime(d, i, t));
    for (const it of items) {
      if (it.kill) {
        body.append(el('div', { class: 'tl-row clickable', onclick: () => app.gotoMap(it.t, i), title: 'show on the map' },
          time(it.t), el('div', { class: 'tl-what' }, killNodes(app, it.kill))));
      } else {
        const b = it.bomb;
        const who = d.players.find(p => p.cleanName === b.name);
        body.append(el('div', { class: 'tl-row bomb clickable', onclick: () => app.gotoMap(it.t, i), title: 'show on the map' },
          time(it.t), el('div', { class: 'tl-what' }, 'Bomb ' + b.action + ' by ', who ? app.playerNode(who.client) : b.name)));
      }
    }
  }

  C4.tabs.rounds = { render };
})(window.C4);
