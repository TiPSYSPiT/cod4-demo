/* Tab 4 - Chat. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, fmtRoundTime, approx, virtualList } = C4.ui;
  const { stripColors } = C4.text;

  function render(root, app) {
    const d = app.data;
    clear(root);
    let scope = 'both', query = '';
    const counts = { all: d.chat.filter(c => c.scope === 'all').length, team: d.chat.filter(c => c.scope === 'team').length };
    const seg = el('div', { class: 'seg' });
    for (const [key, label] of [['both', 'All + Team (' + d.chat.length + ')'], ['all', 'All (' + counts.all + ')'], ['team', 'Team (' + counts.team + ')']]) {
      const b = el('button', { class: key === scope ? 'active' : null, onclick: () => { scope = key; seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); update(); } }, label);
      seg.append(b);
    }
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Search chat…', oninput: e => { query = e.target.value.trim().toLowerCase(); update(); } });
    const list = virtualList(row);
    function row(c) {
      const who = c.client != null ? app.playerNode(c.client)
        : el('span', { class: 'dim', title: 'the sender could not be matched to a player' }, stripColors(c.senderRaw || '?'));
      return el('div', { title: stripColors(c.raw) },
        el('span', { class: 'time' }, fmtTime(c.t)),
        el('span', { class: 'round' }, C4.ui.roundCell(d, c)),
        el('span', { class: 'badge ' + (c.scope === 'team' ? 'team' : 'all') }, c.scope === 'team' ? 'Team' : 'All'),
        el('span', { class: 'who' }, who, c.dead ? el('span', { class: 'dim' }, ' (dead)') : null),
        el('span', { class: 'text' }, c.text));
    }
    function update() {
      list.setItems(d.chat.filter(c => (scope === 'both' || c.scope === scope) &&
        (!query || (c.text + ' ' + app.playerLabel(c.client)).toLowerCase().includes(query))));
    }
    root.append(
      el('p', { class: 'note' }, 'Only the chat the demo POV received is in the demo: all chat, and team chat of the POV’s own team. ',
        'Senders are matched by name', approx('the protocol has no sender field; the name at the start of the line is matched to the players'), '.'),
      el('div', { class: 'toolbar' }, seg, search),
      el('div', { class: 'vhead' }, el('span', { style: { width: '58px' } }, 'Time'), el('span', { style: { width: '64px' } }, 'Round'), el('span', { style: { width: '52px' } }, 'Scope'), el('span', null, 'Player / message')),
      list.node);
    update();
  }

  C4.tabs.chat = { render };
})(window.C4);
