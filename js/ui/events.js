/* Tab 6 - Events: chronological list with search, type chips and player filter. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, fmtRoundTime, approx, virtualList } = C4.ui;

  const COLORS = {
    ready: '#58d68d', connected: '#7fd1b9', disconnected: '#9aa4b2', joined: '#3ea8ff', left: '#ff8f8f',
    attack_eliminated: '#ff9f9f', defence_eliminated: '#9fd4ff', bomb_planted: '#f5c451', bomb_defused: '#b0e57c',
    kill: '#ff6a3d', halftime: '#ffb35c', timeout: '#b48cff', team_join: '#8a95a5', bomb_pickup: '#d9c27a', bomb_drop: '#c9a45a'
  };

  function render(root, app) {
    const d = app.data;
    clear(root);
    const labels = Object.fromEntries(d.eventTypes.map(t => [t[0], t[1]]));
    const on = new Set(d.eventTypes.filter(t => t[2]).map(t => t[0]));
    let query = '', player = '';
    const counts = {};
    for (const e of d.events) counts[e.type] = (counts[e.type] || 0) + 1;
    const chips = el('div', { class: 'toolbar' });
    for (const [key, label] of d.eventTypes) {
      const chip = el('span', { class: 'chip' + (on.has(key) ? ' on' : ''), style: { '--chip': COLORS[key] } },
        el('span', { class: 'dot' }), label, el('span', { class: 'count' }, counts[key] || 0));
      if (key === 'ready') chip.title = 'Per-player ready status is not in a client demo: shown are the POV’s own status, anonymous "a player is ready" steps and "All Players are Ready!"';
      chip.addEventListener('click', () => { if (on.has(key)) on.delete(key); else on.add(key); chip.classList.toggle('on'); update(); });
      chips.append(chip);
    }
    const sel = el('select', { onchange: e => { player = e.target.value; update(); } }, el('option', { value: '' }, 'All players'));
    for (const t of [...d.teams.map(t => t.key), 'spectator']) {
      const ps = d.players.filter(p => p.team === t);
      if (!ps.length) continue;
      const g = el('optgroup', { label: app.teamName(t) });
      for (const p of ps) g.append(el('option', { value: String(p.client) }, p.cleanName));
      sel.append(g);
    }
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Search events…', oninput: e => { query = e.target.value.trim().toLowerCase(); update(); } });
    const count = el('span', { class: 'muted' });

    const describe = e => {
      if (e.type === 'kill') return C4.ui.killNodes(app, d.kills[e.kill]);
      const nodes = [e.text];
      if (e.type === 'ready' && e.anonymous) nodes.push(approx('the demo only has the count of players still not ready, not who readied up'));
      if (e.type === 'halftime' && e.heuristic) nodes.push(approx('no halftime announcement; detected from all players switching sides'));
      return nodes;
    };
    const searchText = e => {
      if (e.type !== 'kill') return (e.text + ' ' + labels[e.type]).toLowerCase();
      const k = d.kills[e.kill];
      return (app.playerLabel(k.attacker) + ' ' + app.playerLabel(k.victim) + ' ' + k.weaponLabel + ' kill' + (k.headshot ? ' headshot' : '')).toLowerCase();
    };
    const clickable = e => e.type === 'kill' || e.type === 'bomb_planted' || e.type === 'bomb_defused';
    const list = virtualList(e => {
      const row = el('div', { class: clickable(e) ? 'clickable' : null, title: clickable(e) ? 'show on the map (2 s before)' : null },
        el('span', { class: 'time' }, fmtTime(e.t)),
        el('span', { class: 'round' }, C4.ui.roundCell(d, e)),
        el('span', { class: 'type' }, el('span', { class: 'ev-badge', style: { '--chip': COLORS[e.type] } }, labels[e.type])),
        el('span', { class: 'text tl-what' }, describe(e)));
      if (clickable(e)) row.addEventListener('click', () => app.gotoMap(e.t, e.round));
      return row;
    });
    function update() {
      const pl = player === '' ? null : Number(player);
      const items = d.events.filter(e => on.has(e.type) && (pl == null || e.clients.includes(pl)) && (!query || searchText(e).includes(query)));
      count.textContent = items.length.toLocaleString('en') + ' of ' + d.events.length.toLocaleString('en') + ' events';
      list.setItems(items);
    }
    root.append(
      el('p', { class: 'note' }, 'Connected / disconnected = the player’s client slot appears / disappears; joined / left the server = the server’s messages. ',
        'Players already connected when the recording started have no "connected" event.'),
      chips, el('div', { class: 'toolbar' }, search, sel, el('span', { class: 'spacer' }), count),
      el('div', { class: 'vhead' }, el('span', { style: { width: '58px' } }, 'Time'), el('span', { style: { width: '64px' } }, 'Round'), el('span', { style: { width: '150px' } }, 'Event'), el('span', null, 'Description')),
      list.node);
    update();
  }

  C4.tabs.events = { render };
})(window.C4);
