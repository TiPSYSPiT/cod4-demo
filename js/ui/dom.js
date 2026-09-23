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

  /** mm:ss (h:mm:ss from one hour) */
  function fmtTime(ms) {
    if (ms == null || !Number.isFinite(ms)) return 'n/a';
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  /** "R7 · 01:23" (time since the live start of the round) */
  function fmtRoundTime(data, roundIndex, t) {
    const r = data.rounds[roundIndex];
    if (!r) return '';
    const base = r.start != null ? r.start : r.segStart;
    const d = t - base;
    const label = r.kind === 'knife' ? 'Knife' : r.kind === 'prematch' ? 'Pre' : 'R' + r.label;
    return label + ' · ' + (d < 0 ? '-' + fmtTime(-d) : fmtTime(d));
  }

  /** n/a with the reason as tooltip */
  function na(reason) { return el('span', { class: 'na', title: reason || 'not available in the demo' }, 'n/a'); }

  /** "≈" marker for heuristic values */
  function approx(reason) { return el('span', { class: 'approx', title: 'Heuristic: ' + reason }, '≈'); }

  function teamClass(key) { return key === 'A' ? 'team-a' : key === 'B' ? 'team-b' : 'team-spec'; }

  /**
   * Sortable table. columns: [{key, label, num, sort(row) -> value, render(row) -> node|string, title}]
   * groups: [{label, cls, rows, totals}] ; sorting applies within each group.
   */
  function sortableTable(columns, groups, opts = {}) {
    let sortKey = opts.sortKey || null, asc = !!opts.asc;
    const table = el('table', { class: 'data ' + (opts.cls || '') });
    const thead = el('thead');
    const tbody = el('tbody');
    const headRow = el('tr');
    for (const c of columns) {
      const th = el('th', { class: (c.num ? 'num ' : '') + (c.sort !== false ? 'sortable' : ''), title: c.title || null }, c.label);
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
          for (const c of columns) tr.append(el('td', { class: c.num ? 'num' : null }, c.render ? c.render(row) : (row[c.key] == null ? '' : String(row[c.key]))));
          if (opts.onRowClick) { tr.classList.add('clickable'); tr.addEventListener('click', () => opts.onRowClick(row)); }
          tbody.append(tr);
        }
        if (g.totals) {
          const tr = el('tr', { class: 'total' });
          for (const c of columns) tr.append(el('td', { class: c.num ? 'num' : null }, g.totals[c.key] == null ? '' : g.totals[c.key]));
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

  C4.ui = { el, append, clear, coloured, fmtTime, fmtRoundTime, na, approx, teamClass, sortableTable, virtualList };
  C4.tabs = C4.tabs || {};       // tab modules register here
})(window.C4);
