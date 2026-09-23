/* Tab 3 - Kills per Round: players x rounds matrix. */
(function (C4) {
  'use strict';
  const { el, clear, approx } = C4.ui;

  function render(root, app) {
    const d = app.data;
    clear(root);
    const rounds = d.rounds.map((r, i) => ({ r, i })).filter(x => x.r.kind === 'round');
    if (!rounds.length) { root.append(el('div', { class: 'empty' }, 'No rounds in this demo.')); return; }
    // credited kills: no suicides, team kills, world or entity kills
    const cnt = new Map();
    for (const { r, i } of rounds) {
      for (const ki of r.kills) {
        const k = d.kills[ki];
        if (k.suicide || k.teamkill || k.world || k.entityAttacker || k.attacker >= 64) continue;
        const key = k.attacker + ':' + i;
        cnt.set(key, (cnt.get(key) || 0) + 1);
      }
    }
    const table = el('table', { class: 'data kpr' });
    const head = el('tr', null, el('th', null, 'Player'));
    for (const { r } of rounds) head.append(el('th', { class: 'rcol', title: 'round ' + r.label + (r.winnerTeam ? ' - won by ' + app.teamName(r.winnerTeam) : '') }, r.label));
    head.append(el('th', { class: 'num', title: 'kills in the rounds shown' }, 'Total'));
    table.append(el('thead', null, head));
    const tbody = el('tbody');
    const rgb = { A: '255,106,61', B: '62,168,255' };
    for (const t of d.teams) {
      const players = d.players.filter(p => p.team === t.key);
      if (!players.length) continue;
      tbody.append(el('tr', { class: 'team-head ' + (t.key === 'A' ? 'a' : 'b') }, el('td', { colspan: rounds.length + 2 }, t.name)));
      const rows = players.map(p => {
        const per = rounds.map(({ i }) => cnt.get(p.client + ':' + i) || 0);
        return { p, per, total: per.reduce((a, b) => a + b, 0) };
      }).sort((a, b) => b.total - a.total);
      for (const { p, per, total } of rows) {
        const tr = el('tr', { class: p.isPov ? 'pov' : null }, el('td', null, app.playerNode(p.client)));
        per.forEach((n, j) => {
          const td = el('td', { class: 'cell ' + (n ? '' : 'k0') + (n >= 3 ? ' multi' : '') + (n >= 5 ? ' multi5' : ''), title: n + ' kill(s) in round ' + rounds[j].r.label + (n >= 3 ? ' (' + n + 'K)' : '') }, n || '·');
          if (n) td.style.background = 'rgba(' + rgb[t.key] + ',' + Math.min(0.85, 0.14 + n * 0.15).toFixed(2) + ')';
          tr.append(td);
        });
        tr.append(el('td', { class: 'num', style: { fontWeight: 700 } }, total));
        tbody.append(tr);
      }
    }
    table.append(tbody);
    const initial = d.initialScore.A + d.initialScore.B;
    C4.ui.append(root, [
      initial ? el('p', { class: 'note' }, 'The recording starts in round ' + (initial + 1) + '; earlier rounds are not in the demo.') : null,
      el('div', { class: 'table-wrap' }, table),
      el('div', { class: 'legend' },
        el('span', null, 'Kills counted from the kill feed (no suicides, team kills or world kills).'),
        el('span', null, el('span', { class: 'sw', style: { outline: '2px solid var(--accent)', outlineOffset: '-2px' } }), '3K / 4K'),
        el('span', null, el('span', { class: 'sw', style: { outline: '2px solid #ff4a4a', outlineOffset: '-2px' } }), '5K (ace)'))]);
  }

  C4.tabs.kpr = { render };
})(window.C4);
