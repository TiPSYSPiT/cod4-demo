/* Tab 1 - Scoreboard: per team, sortable, totals; spectators below. */
(function (C4) {
  'use strict';
  const { el, fmtTime, na, approx, sortableTable, teamClass } = C4.ui;

  const kd = p => (p.kills == null || p.deaths == null ? null : p.deaths === 0 ? p.kills : p.kills / p.deaths);

  function render(root, app) {
    const d = app.data;
    const approxStats = p => p.statsSource === 'killfeed'
      ? approx('no scoreboard entry for this player - counted from the kill feed')
      : p.statsSource === 'scoreboard+killfeed'
        ? approx('the last scoreboard is older than the last round - kills/deaths after it (' + p.killsAfterScoreboard + '/' + p.deathsAfterScoreboard + ') added from the kill feed')
        : null;
    const columns = [
      { key: 'clan', label: 'Clan', sort: p => p.clan || '', render: p => p.clan ? [p.clan, p.clanHeuristic ? approx('clan tag taken from the name') : null] : '' },
      {
        key: 'player', label: 'Player', sort: p => p.cleanName.toLowerCase(), render: p => [
          app.playerNode(p.client),
          p.isPov ? [' ', el('span', { class: 'badge pov', title: 'the player who recorded the demo' }, 'POV')] : null,
          p.leftEarly ? [' ', el('span', { class: 'badge left', title: 'left the server at ' + fmtTime(p.leftAt) }, 'left ' + fmtTime(p.leftAt))] : null
        ]
      },
      { key: 'score', label: 'Score', num: true, render: p => p.score == null ? na('not in any scoreboard of the demo') : String(p.score) },
      { key: 'kills', label: 'K', num: true, render: p => [String(p.kills), approxStats(p)] },
      { key: 'assists', label: 'A', num: true, render: p => p.assists == null ? na('assists only come from the scoreboard') : String(p.assists) },
      { key: 'deaths', label: 'D', num: true, render: p => [String(p.deaths), approxStats(p)] },
      { key: 'kd', label: 'K/D', num: true, sort: kd, title: 'kills / deaths; with 0 deaths K/D = kills', render: p => kd(p) == null ? '' : kd(p).toFixed(2) }
    ];
    const groups = [];
    for (const t of d.teams) {
      const rows = d.players.filter(p => p.team === t.key);
      if (!rows.length) continue;
      const sum = k => rows.reduce((a, p) => a + (p[k] || 0), 0);
      const K = sum('kills'), D = sum('deaths');
      groups.push({
        label: el('span', null, t.name, t.nameHeuristic ? approx('team name from the common name prefix') : null, el('span', { class: 'dim' }, '  —  ' + t.wins + ' rounds won')),
        cls: t.key === 'A' ? 'a' : 'b', rows,
        totals: { player: 'Team total', score: sum('score'), kills: K, assists: sum('assists'), deaths: D, kd: (D ? K / D : K).toFixed(2) }
      });
    }
    const specs = d.players.filter(p => p.team === 'spectator');
    if (specs.length) groups.push({ label: 'Spectators', cls: 'spec', rows: specs });
    root.append(
      el('p', { class: 'note' }, 'Values from the game’s scoreboard (last scoreboard each player appears in). ',
        'Click a column header to sort. ', el('span', { class: 'approx' }, '≈'), ' marks values completed from the kill feed.'),
      sortableTable(columns, groups, { sortKey: 'score', asc: false, rowClass: p => (p.isPov ? 'pov ' : '') })
    );
  }

  C4.tabs.scoreboard = { render };
})(window.C4);
