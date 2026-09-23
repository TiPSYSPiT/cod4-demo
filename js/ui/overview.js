/* Quick Overview: final score, map, mode, ruleset, server, POV, length, date, protocol. */
(function (C4) {
  'use strict';
  const { el, clear, coloured, fmtTime, na, approx } = C4.ui;

  function card(label, value, sub, cls) {
    return el('div', { class: 'ov-card ' + (cls || '') },
      el('div', { class: 'ov-label' }, label),
      el('div', { class: 'ov-value' }, value),
      sub ? el('div', { class: 'ov-sub' }, sub) : null);
  }

  function render(root, app) {
    const d = app.data, m = d.meta;
    clear(root);

    // final score
    const [A, B] = d.teams;
    const played = d.rounds.filter(r => r.kind === 'round');
    let scoreCard;
    if (played.length) {
      const teamLabel = (t, cls) => el('div', { class: 'score-team ' + cls, title: t.nameHeuristic ? '' : 'no common clan tag found' },
        t.name, t.nameHeuristic ? approx('team name from the common name prefix of the players') : null);
      const halves = [];
      const hi = d.halfInfo;
      const n = Math.max(A.halves.length, B.halves.length);
      const first = A.halves.findIndex((v, i) => v != null || B.halves[i] != null);
      for (let i = Math.max(0, first); i < n; i++) {
        const label = hi.unknown ? 'half ?' : (i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : (i + 1) + 'th') + ' half';
        const partial = i === first && hi.firstPartial;
        halves.push([label + ' ' + (A.halves[i] || 0) + ':' + (B.halves[i] || 0),
          partial ? [' ', approx('this half started before the recording - only its recorded rounds' + (hi.heuristic ? '; half number from the ruleset (MR/OT) and the start score' : ''))] : null]);
      }
      const initial = d.initialScore.A + d.initialScore.B;
      scoreCard = el('div', { class: 'ov-card ov-score' },
        el('div', { class: 'ov-label' }, 'Final score' + (m.isSearchAndDestroy ? ' (rounds won)' : '')),
        el('div', { class: 'score-line' }, teamLabel(A, 'a'),
          el('div', { class: 'score-num' }, el('span', { class: 'team-a' }, A.wins), el('span', { class: 'sep' }, ':'), el('span', { class: 'team-b' }, B.wins)),
          teamLabel(B, 'b')),
        el('div', { class: 'score-halves' }, halves.map((h, i) => [i ? '  ·  ' : '', h]), initial ? '  ·  recording started at ' + d.initialScore.A + ':' + d.initialScore.B : ''));
    } else {
      scoreCard = el('div', { class: 'ov-card ov-score' }, el('div', { class: 'ov-label' }, 'Final score'),
        el('div', { class: 'ov-value' }, na(m.isSearchAndDestroy ? 'no complete round in the demo' : 'no rounds detected - round logic is built for Search & Destroy')));
    }

    const ruleset = m.ruleset
      ? [m.ruleset, el('span', { class: 'dim' }, m.mod ? '  (' + m.mod + ')' : '')]
      : (m.mod ? m.mod : na('no ruleset announced and no mod (fs_game) set'));
    const date = m.recordDate
      ? [m.recordDate.text, ' ', m.recordDate.fileDate ? el('span', { class: 'dim' }, '(file date)') : approx(m.recordDate.source + ' - the demo stores no recording date')]
      : na('the demo stores no date and the file date is unknown');

    root.append(
      scoreCard,
      card('Map', m.mapDisplay || na('no map name'), m.map),
      card('Mode', m.gametypeDisplay || na('no game type'), m.gametype),
      card('Ruleset', ruleset, m.promodVersion || null),
      card('Protocol', m.protocolLabel, m.gameVersion ? m.gameVersion.split(' ')[0] : null),
      card('Server name', m.hostname ? coloured(m.hostname) : na('no sv_hostname in the serverinfo'), m.serverVersion || null),
      card('Demo POV', m.povClient != null ? app.playerNode(m.povClient) : na('no recording client number'), m.povClient != null ? 'client ' + m.povClient : null),
      card('Length', fmtTime(m.durationMs), (m.stats ? m.stats.snapshots.toLocaleString('en') + ' snapshots' : '')),
      card('Record date', date, null)
    );
  }

  C4.tabs.overview = { render };
})(window.C4);
