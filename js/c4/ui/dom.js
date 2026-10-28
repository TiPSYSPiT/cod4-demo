/* UI helpers: element creation, CoD colour codes, time formats, n/a and
 * heuristic markers, sortable tables and a virtual list for long lists. */
(function (C4) {
  'use strict';
  const { stripColors } = C4.text;

  /** el('div', {class: 'x', title: '..', onclick}, child, 'text', ...) */
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style' && typeof v === 'object') {
          // custom properties (--name) need setProperty
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith('--')) e.style.setProperty(sk, sv);
            else e.style[sk] = sv;
          }
        }
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    append(e, children);
    return e;
  }
  function append(parent, children) {
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(parent, c);
      else parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return parent;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /** Render a CoD name with ^0-^9 colour codes. Control bytes are dropped. */
  function coloured(raw, cls) {
    const span = el('span', { class: cls || null, title: stripColors(raw) });
    const s = String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]/g, '');
    const re = /\^([0-9:;<=>?])/g;
    let last = 0, color = null, m;
    const push = text => {
      if (!text) return;
      span.append(color == null ? document.createTextNode(text) : el('span', { class: 'c' + color }, text));
    };
    while ((m = re.exec(s))) {
      push(s.slice(last, m.index));
      color = /[0-9]/.test(m[1]) ? m[1] : null;     // ^: ^; ... (Promod) render in the default colour
      last = re.lastIndex;
    }
    push(s.slice(last));
    return span;
  }

  /** mm:ss (h:mm:ss from one hour) - common/text.js */
  const fmtTime = C4.text.fmtTime;

  /** "R7 · 01:23" (time since the live start of the round) */
  function fmtRoundTime(data, roundIndex, t) {
    const r = data.rounds[roundIndex];
    if (!r) return '';
    const base = r.start != null ? r.start : r.segStart;
    const d = t - base;
    const label = r.kind === 'knife' ? 'Knife' : r.kind === 'prematch' ? 'Pre' : r.kind === 'aftermatch' ? 'After' : 'R' + r.label;
    return label + ' · ' + (d < 0 ? '-' + fmtTime(-d) : fmtTime(d));
  }

  /** game phases (DemoData.phases): only "live" counts for the scoreboard */
  const PHASES = {
    live: { label: 'Live', title: 'regular match time - counted' },
    warmup: { label: 'Warmup', title: 'warm-up / ready-up before the match - not counted in the scoreboard' },
    knife: { label: 'Knife', title: 'knife round - not counted in the scoreboard' },
    halftime: { label: 'Halftime', title: 'halftime break - not counted in the scoreboard' },
    timeout: { label: 'Timeout', title: 'timeout / break between rounds - not counted in the scoreboard' },
    aftermatch: { label: 'After', title: 'after the official match end - not counted in the scoreboard' }
  };
  /** small badge for a phase other than "live" (null for live) */
  function phaseBadge(phase) {
    if (!phase || phase === 'live') return null;
    const p = PHASES[phase] || { label: phase, title: phase };
    return el('span', { class: 'badge phase phase-' + phase, title: p.title }, p.label);
  }
  /** round cell of a list row: round label while live, otherwise the phase badge */
  function roundCell(data, item) {
    if (item.phase && item.phase !== 'live') return phaseBadge(item.phase);
    return item.round >= 0 ? fmtRoundTime(data, item.round, item.t).split(' · ')[0] : '';
  }

  /** n/a with the reason as tooltip */
  function na(reason) { return el('span', { class: 'na', title: reason || 'not available in the demo' }, 'n/a'); }

  /** "≈" marker for heuristic values */
  function approx(reason) { return el('span', { class: 'approx', title: 'Heuristic: ' + reason }, '≈'); }

  function teamClass(key) { return key === 'A' ? 'team-a' : key === 'B' ? 'team-b' : 'team-spec'; }

  /**
   * Sortable table. columns: [{key, label, num, sort(row) -> value, render(row) -> node|string, title,
   *   cls (class of th / td and of the <col>, for column widths), cellTitle(row) -> tooltip of the cell}]
   * groups: [{label, cls, rows, totals}] ; sorting applies within each group.
   */
  function sortableTable(columns, groups, opts = {}) {
    let sortKey = opts.sortKey || null, asc = !!opts.asc;
    const table = el('table', { class: 'data ' + (opts.cls || '') });
    const cellClass = c => ((c.num ? 'num ' : '') + (c.cls || '')).trim() || null;
    // <colgroup>: one <col> per column, so CSS can size the columns (table-layout: fixed)
    if (columns.some(c => c.cls)) table.append(el('colgroup', null, columns.map(c => el('col', { class: c.cls || null }))));
    const thead = el('thead');
    const tbody = el('tbody');
    const headRow = el('tr');
    for (const c of columns) {
      const th = el('th', { class: (c.num ? 'num ' : '') + (c.cls ? c.cls + ' ' : '') + (c.sort !== false ? 'sortable' : ''), title: c.title || null }, c.label);
      if (c.sort !== false) th.addEventListener('click', () => {
        if (sortKey === c.key) asc = !asc; else { sortKey = c.key; asc = !c.num; }
        render();
      });
      c.th = th;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead, tbody);
    function value(c, row) { return c.sort ? c.sort(row) : row[c.key]; }
    function render() {
      clear(tbody);
      for (const c of columns) { c.th.classList.toggle('sorted', c.key === sortKey); c.th.classList.toggle('asc', c.key === sortKey && asc); }
      for (const g of groups) {
        if (g.label != null) tbody.append(el('tr', { class: 'team-head ' + (g.cls || '') }, el('td', { colspan: columns.length }, g.label)));
        const rows = g.rows.slice();
        const col = columns.find(c => c.key === sortKey);
        if (col) {
          rows.sort((a, b) => {
            const va = value(col, a), vb = value(col, b);
            const na_ = va == null || va === '', nb = vb == null || vb === '';
            if (na_ !== nb) return na_ ? 1 : -1;
            const r = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
            return asc ? r : -r;
          });
        }
        for (const row of rows) {
          const tr = el('tr', { class: (opts.rowClass ? opts.rowClass(row) : '') || null });
          for (const c of columns) tr.append(el('td', { class: cellClass(c), title: c.cellTitle ? c.cellTitle(row) : null }, c.render ? c.render(row) : (row[c.key] == null ? '' : String(row[c.key]))));
          if (opts.onRowClick) { tr.classList.add('clickable'); tr.addEventListener('click', () => opts.onRowClick(row)); }
          tbody.append(tr);
        }
        if (g.totals) {
          const tr = el('tr', { class: 'total' });
          for (const c of columns) tr.append(el('td', { class: cellClass(c) }, g.totals[c.key] == null ? '' : g.totals[c.key]));
          tbody.append(tr);
        }
      }
    }
    render();
    return el('div', { class: 'table-wrap' }, table);
  }

  /**
   * Virtual list with fixed row height: renders only the visible rows.
   * returns {node, setItems(items), scrollToIndex(i), refresh()}
   */
  function virtualList(renderRow, rowHeight = 28) {
    const outer = el('div', { class: 'vlist' });
    const inner = el('div', { class: 'vlist-inner' });
    outer.append(inner);
    let items = [];
    const pool = new Map();
    function paint() {
      const top = outer.scrollTop, h = outer.clientHeight || 600;
      const first = Math.max(0, Math.floor(top / rowHeight) - 10);
      const last = Math.min(items.length, Math.ceil((top + h) / rowHeight) + 10);
      const keep = new Set();
      for (let i = first; i < last; i++) {
        keep.add(i);
        if (!pool.has(i)) {
          const row = renderRow(items[i], i);
          row.classList.add('vrow');
          row.style.top = (i * rowHeight) + 'px';
          inner.append(row);
          pool.set(i, row);
        }
      }
      for (const [i, row] of pool) if (!keep.has(i)) { row.remove(); pool.delete(i); }
    }
    outer.addEventListener('scroll', () => requestAnimationFrame(paint));
    const api = {
      node: outer,
      setItems(list) {
        items = list;
        for (const row of pool.values()) row.remove();
        pool.clear();
        inner.style.height = (items.length * rowHeight) + 'px';
        if (!items.length) inner.append(el('div', { class: 'empty' }, 'Nothing to show.'));
        else for (const e of inner.querySelectorAll('.empty')) e.remove();
        paint();
      },
      refresh() { for (const row of pool.values()) row.remove(); pool.clear(); paint(); },
      scrollToIndex(i) { outer.scrollTop = Math.max(0, i * rowHeight - outer.clientHeight / 2); paint(); },
      get items() { return items; }
    };
    new ResizeObserver(() => paint()).observe(outer);
    return api;
  }

  /** line icons (Lucide style, 24 x 24, 1.6 px stroke in currentColor; css: .i) */
  const ICONS = {
    layers: 'M12 2 2 7l10 5 10-5-10-5z|m2 17 10 5 10-5|m2 12 10 5 10-5',
    camera: 'm22 8-6 4 6 4V8z|M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z|M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
    flame: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z',
    sound: 'M11 5 6 9H2v6h4l5 4V5z|M15.5 8.5a5 5 0 0 1 0 7',
    info: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z|M12 16v-4M12 8h.01',
    chart: 'M3 3v18h18|M7 15l4-4 3 3 5-6',
    json: 'M14 3v4a1 1 0 0 0 1 1h4|M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z|M10 13l-1 2 1 2|M14 13l1 2-1 2',
    folder: 'M5 19a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 3h7a2 2 0 0 1 2 2v1|M5 19h14l3-8H8z',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    rotl: 'M1 4v6h6|M3.5 15a9 9 0 1 0 2.1-9.4L1 10',
    rotr: 'M23 4v6h-6|M20.5 15a9 9 0 1 1-2.1-9.4L23 10',
    panel: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z|M15 3v18',
    chev: 'm6 9 6 6 6-6',
    play: 'M6 4l15 8-15 8z',
    pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
    back: 'M11 19 2 12l9-7v14z|M22 19l-9-7 9-7v14z',
    fwd: 'M13 19l9-7-9-7v14z|M2 19l9-7-9-7v14z',
    download: 'M12 3v12|m7 10 5 5 5-5|M5 21h14',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
    x: 'M18 6 6 18M6 6l12 12',
    reset: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    upload: 'M12 15V3|m7 8 5-5 5 5|M5 21h14'
  };
  /** icon('layers', 's') -> <svg class="i s">; cls 's': the small size */
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name].split('|')) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }

  /** a switch row: "label [small] ..... (switch)" around a checkbox (css: .sw, input.tog); opts {small, dot, title} */
  function switchRow(label, input, opts = {}) {
    input.classList.add('tog');
    return el('label', { class: 'sw', title: opts.title || null },
      el('span', { class: 'sw-l' }, opts.dot ? el('i', { class: 'dotc', style: { background: opts.dot } }) : null, label,
        opts.small ? el('small', null, opts.small) : null), input);
  }
  /** a select row: "label ..... value ⌄" (css: .sel) */
  function selectRow(label, select, title) {
    return el('label', { class: 'sel', title: title || null }, el('small', null, label), select);
  }
  /** segmented control: items [[value, label, title]], onChange(value); the element's .value gets / sets */
  function segmented(items, onChange, cls) {
    const box = el('div', { class: 'mseg' + (cls ? ' ' + cls : ''), role: 'radiogroup', style: { '--n': items.length } });
    let value = null;
    const btns = items.map(([v, label, title]) => el('button', { type: 'button', role: 'radio', title: title || null, dataset: { v: String(v) },
      onclick: () => { if (String(v) !== String(value)) onChange(v); } }, label));
    box.append(...btns);
    Object.defineProperty(box, 'value', {
      get: () => value,
      set: v => { value = v; for (const b of btns) { const on = b.dataset.v === String(v); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } }
    });
    return box;
  }

  C4.ui = { el, append, clear, coloured, fmtTime, fmtRoundTime, na, approx, teamClass, sortableTable, virtualList, PHASES, phaseBadge, roundCell,
    icon, switchRow, selectRow, segmented };
  C4.tabs = C4.tabs || {};       // tab modules register here
})(window.C4);
