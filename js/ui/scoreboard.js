/* Tab 1 - Scoreboard: per team, sortable, totals; spectators below. */
(function (C4) {
  'use strict';
  const { el, fmtTime, na, approx, sortableTable, teamClass } = C4.ui;

  const kd = p => (p.kills == null || p.deaths == null ? null : p.deaths === 0 ? p.kills : p.kills / p.deaths);
  const fmtPct = v => Math.round(v) + ' %';
  const round2 = v => v == null ? null : Math.round(v * 100) / 100;
  const byScore = (a, b) => (b.score == null ? -Infinity : b.score) - (a.score == null ? -Infinity : a.score);

  /** team totals as numbers (shared by the table and the JSON download) */
  function teamTotals(rows) {
    const sum = k => rows.reduce((a, p) => a + (p[k] || 0), 0);
    const K = sum('kills'), D = sum('deaths'), ownK = sum('ownKills'), HS = sum('headshots');
    return { score: sum('score'), kills: K, assists: sum('assists'), deaths: D, kd: D ? K / D : K,
      tk: sum('teamkills'), hsPercent: ownK ? HS / ownK * 100 : null, plants: sum('plants'), defuses: sum('defuses') };
  }

  /** the scoreboard as plain JSON: teams (in table order), players by score, team totals */
  function scoreJson(d) {
    const teams = [];
    for (const t of d.teams) {
      const rows = d.players.filter(p => p.team === t.key);
      if (!rows.length) continue;
      const tot = teamTotals(rows);
      teams.push({
        clan: t.name,
        roundsWon: t.wins,
        players: rows.slice().sort(byScore).map(p => Object.assign({
          name: p.cleanName,
          score: p.score,
          kills: p.kills,
          assists: p.assists,
          deaths: p.deaths,
          kd: round2(kd(p)),
          tk: p.teamkills,
          hsPercent: p.headshotPct == null ? null : Math.round(p.headshotPct),
          plants: p.plants,
          defuses: p.defuses
        }, p.isPov ? { pov: true } : null)),
        teamTotal: Object.assign(tot, { kd: round2(tot.kd), hsPercent: tot.hsPercent == null ? null : Math.round(tot.hsPercent) })
      });
    }
    return { teams };
  }

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
      { key: 'kd', label: 'K/D', num: true, sort: kd, title: 'kills / deaths; with 0 deaths K/D = kills', render: p => kd(p) == null ? '' : kd(p).toFixed(2) },
      {
        key: 'teamkills', label: 'TK', num: true,
        title: 'team kills in the running match only: live phase of the match rounds (from the kill feed). Warm-up, pauses / timeouts, strat mode and the knife round are not counted.'
      },
      {
        key: 'headshotPct', label: 'HS %', num: true,
        title: 'headshot kills / kills, both counted from the kill feed of this demo (match rounds; no team kills or suicides). The game scoreboard has no headshots.',
        render: p => p.headshotPct == null
          ? el('span', { class: 'dim', title: 'no kills in the kill feed' }, '–')
          : el('span', { title: p.headshots + ' of ' + p.ownKills + ' kills (kill feed)' }, fmtPct(p.headshotPct))
      },
      { key: 'plants', label: 'Plants', num: true, title: 'bomb plants (server message "planted the bomb", match rounds only)' },
      { key: 'defuses', label: 'Defuses', num: true, title: 'bomb defuses (server message "defused the bomb", match rounds only)' }
    ];
    const groups = [];
    for (const t of d.teams) {
      const rows = d.players.filter(p => p.team === t.key);
      if (!rows.length) continue;
      const tot = teamTotals(rows);
      groups.push({
        label: el('span', null, t.name, t.nameHeuristic ? approx('team name from the common name prefix') : null, el('span', { class: 'dim' }, '  —  ' + t.wins + ' rounds won')),
        cls: t.key === 'A' ? 'a' : 'b', rows,
        totals: { player: 'Team total', score: tot.score, kills: tot.kills, assists: tot.assists, deaths: tot.deaths, kd: tot.kd.toFixed(2),
          teamkills: tot.tk, headshotPct: tot.hsPercent == null ? '–' : fmtPct(tot.hsPercent), plants: tot.plants, defuses: tot.defuses }
      });
    }
    const specs = d.players.filter(p => p.team === 'spectator');
    if (specs.length) groups.push({ label: 'Spectators', cls: 'spec', rows: specs });
    root.append(
      el('div', { class: 'toolbar' },
        el('button', {
          class: 'btn', title: 'teams, players (by score) and team totals as JSON',
          onclick: () => app.download(app.fileBase + '.scoreboard.json', JSON.stringify(scoreJson(d), null, 2))
        }, '⬇ Download score (JSON)')),
      el('p', { class: 'note' }, 'Values from the game’s scoreboard (last scoreboard each player appears in). ',
        'Click a column header to sort. ', el('span', { class: 'approx' }, '≈'), ' marks values completed from the kill feed. ',
        'TK, HS %, Plants and Defuses are not in the game’s scoreboard - they are counted from the kill feed and the bomb messages of this demo (only the recorded rounds; ',
        'team kills only while a match round is live, not in warm-up, pauses or the knife round).'),
      sortableTable(columns, groups, { sortKey: 'score', asc: false, cls: 'scoreboard', rowClass: p => (p.isPov ? 'pov ' : '') })
    );
  }

  C4.tabs.scoreboard = { render, scoreJson };
})(window.C4);
