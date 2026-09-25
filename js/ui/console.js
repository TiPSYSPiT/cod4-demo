/* Tab 5 - Console: everything console-relevant that is in the demo. */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime, fmtRoundTime, virtualList } = C4.ui;

  const TYPES = [
    ['system', 'System', '#9aa4b2'], ['warning', 'Warning', '#ff5f5f'], ['print', 'Print', '#cfd6df'],
    ['message', 'Game message', '#ffb35c'], ['announcement', 'Announcement', '#f5c451'], ['chat', 'Chat', '#58d68d'],
    ['configstring', 'Config string', '#b48cff'], ['dvar', 'Dvar', '#3ea8ff'], ['score', 'Score', '#ff6a3d'],
    ['restart', 'Restart', '#e0e0e0'], ['command', 'Other command', '#8a95a5']
  ];

  function render(root, app) {
    const d = app.data;
    clear(root);
    const on = new Set(TYPES.map(t => t[0]).filter(k => k !== 'dvar' && k !== 'score'));
    let query = '';
    const counts = {};
    for (const c of d.console) counts[c.type] = (counts[c.type] || 0) + 1;
    const chips = el('div', { class: 'toolbar' });
    for (const [key, label, color] of TYPES) {
      if (!counts[key]) continue;
      const chip = el('span', { class: 'chip' + (on.has(key) ? ' on' : ''), style: { '--chip': color }, title: 'show / hide' },
        el('span', { class: 'dot' }), label, el('span', { class: 'count' }, counts[key]));
      chip.addEventListener('click', () => { if (on.has(key)) on.delete(key); else on.add(key); chip.classList.toggle('on'); update(); });
      chips.append(chip);
    }
    const color = Object.fromEntries(TYPES.map(t => [t[0], t[2]]));
    const label = Object.fromEntries(TYPES.map(t => [t[0], t[1]]));
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Search console…', oninput: e => { query = e.target.value.trim().toLowerCase(); update(); } });
    const count = el('span', { class: 'muted' });
    const list = virtualList(c => el('div', { title: c.raw || c.text },
      el('span', { class: 'time' }, fmtTime(c.t)),
      el('span', { class: 'round' }, C4.ui.roundCell(d, c)),
      el('span', { class: 'type' }, el('span', { class: 'ev-badge', style: { '--chip': color[c.type], minWidth: '110px' } }, label[c.type])),
      c.client != null ? el('span', { class: 'who' }, app.playerNode(c.client)) : null,
      el('span', { class: 'text mono' }, c.text)));
    function update() {
      const items = d.console.filter(c => on.has(c.type) && (!query || (c.text + ' ' + (c.raw || '')).toLowerCase().includes(query)));
      count.textContent = items.length.toLocaleString('en') + ' of ' + d.console.length.toLocaleString('en') + ' lines';
      list.setItems(items);
    }
    root.append(
      el('p', { class: 'note' }, 'Everything the server sent to the demo POV: prints, game messages, chat, config string and dvar changes, scores, restarts and menu/sound commands. ',
        'Commands typed by other players are never sent to a client and are therefore not in the demo. Dvar and score updates are hidden by default (many lines).'),
      chips, el('div', { class: 'toolbar' }, search, el('span', { class: 'spacer' }), count), list.node);
    update();
  }

  C4.tabs.console = { render };
})(window.C4);
