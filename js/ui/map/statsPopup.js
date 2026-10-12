/* Map tab: player statistics popup (opened from the statistics icon of the round table).
 * One popup at a time, next to its icon and always inside the window; closes with ×, Escape or a
 * click outside. "Match" = the whole match, phase "live" only (the scoreboard rule); "This round" =
 * the round at the playback time. (The heatmap players are chosen in the heatmap panel, heatPanel.js.) */
(function (C4) {
  'use strict';
  const { el, clear, approx } = C4.ui;
  const W = C4.weapons;

  /** the statistics icon: a small bar chart with axes (inline SVG, currentColor) */
  function statsIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 14 12'); svg.setAttribute('width', '14'); svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'stats-ico');
    const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); };
    add('path', { d: 'M1.5 1v10h11.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round' });
    add('rect', { x: '3.5', y: '6', width: '2', height: '4.5', fill: 'currentColor' });
    add('rect', { x: '7', y: '2.5', width: '2', height: '8', fill: 'currentColor' });
    add('rect', { x: '10.5', y: '5', width: '2', height: '5.5', fill: 'currentColor' });
    return svg;
  }

  /**
   * statistics of one player over [from, to) - DOM-free.
   * live: count only kills / grenades / shots of phase "live" (Match); else everything in the range.
   * K / D with the scoreboard rule (C4.build.kdRule); weapons = the kills by their real weapon
   * (C4.weapons.killWeapon - a headshot is no weapon); grenades thrown ≈ (thrower estimated, build.js).
   */
  function statsFor(d, cl, from, to, live) {
    const inRange = t => t >= from && t < to && (!live || C4.rounds.phaseAt(d.phases, t) === 'live');
    let kills = 0, deaths = 0, hs = 0;
    const weapons = new Map();
    for (const k of d.kills) {
      if (k.t < from || k.t >= to || (live && k.phase !== 'live')) continue;
      const { credit, death } = C4.build.kdRule(k);
      if (death && k.victim === cl) deaths++;
      if (!credit || k.attacker !== cl) continue;
      kills++;
      if (k.headshot) hs++;
      const w = W.killWeapon(k), key = w ? W.baseWeapon(w) + '|' + W.label(w) : '?';
      if (!weapons.has(key)) weapons.set(key, { weapon: w, label: w ? W.label(w) : 'Unknown weapon', kills: 0, heuristic: 0 });
      const row = weapons.get(key);
      row.kills++;
      if (k.weaponHeuristic) row.heuristic++;
    }
    const nades = { frag: 0, flash: 0, smoke: 0, concussion: 0 };
    let nadesUnknown = 0;
    for (const g of d.grenades) {
      if (!inRange(g.first) || !(g.kind in nades)) continue;
      if (g.thrower === cl) nades[g.kind]++;
      else if (g.thrower == null && g.launch != null) nadesUnknown++;
    }
    const st = (d.shotsSeen || {})[cl] || [];
    let shots = 0;
    for (const t of st) if (inRange(t)) shots++;
    return { kills, deaths, hs, nades, nadesUnknown, shots,
      weapons: [...weapons.values()].sort((a, b) => b.kills - a.kills || a.label.localeCompare(b.label)) };
  }

  /* ---------- the popup ---------- */
  let P = null;          // {box, client, anchor, ctx, mode}
  let lastMode = 'match'; // kept for the next popup

  /** ctx: {app, data, time() -> playback time, roundAt(t) -> round, onChange()} */
  function open(anchor, client, ctx) {
    if (P && P.client === client) { close(); return; }
    close();
    const box = el('div', { class: 'stats-pop', role: 'dialog', 'aria-label': 'Player stats' });
    document.body.append(box);
    P = { box, client, anchor, ctx, mode: lastMode, key: null };
    anchor.classList.add('open');
    render();
    place();
    setTimeout(() => { document.addEventListener('mousedown', outside, true); }, 0);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
  }

  function close() {
    if (!P) return;
    P.anchor.classList.remove('open');
    P.box.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    const ctx = P.ctx;
    P = null;
    if (ctx && ctx.onChange) ctx.onChange();
  }

  const outside = e => { if (P && !P.box.contains(e.target) && !P.anchor.contains(e.target) && !e.target.closest('.rp-stats')) close(); };
  const onKey = e => { if (e.key === 'Escape' && P) { e.stopPropagation(); close(); } };

  /** next to the icon: right of it if there is room, else left; always fully inside the window */
  function place() {
    if (!P) return;
    const a = P.anchor.getBoundingClientRect(), b = P.box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, m = 6;
    let x = a.right + m;
    if (x + b.width > vw - m) x = a.left - m - b.width;
    x = Math.max(m, Math.min(x, vw - m - b.width));
    let y = a.top - 8;
    y = Math.max(m, Math.min(y, vh - m - b.height));
    P.box.style.left = Math.round(x) + 'px';
    P.box.style.top = Math.round(y) + 'px';
  }

  /** re-render when the round at the playback time changes ("This round") - called by the map frame */
  function refresh() {
    if (!P || P.mode !== 'round') return;
    const r = P.ctx.roundAt(P.ctx.time());
    const key = r ? r.segStart : null;
    if (key !== P.key) { render(); place(); }
  }

  function render() {
    const { app, data: d } = P.ctx, cl = P.client;
    const p = d.players.find(x => x.client === cl) || { cleanName: 'Client ' + cl, team: null };
    clear(P.box);
    const r = P.ctx.roundAt(P.ctx.time());
    P.key = r ? r.segStart : null;
    const live = P.mode === 'match';
    const s = live ? statsFor(d, cl, -Infinity, Infinity, true) : r ? statsFor(d, cl, r.segStart, r.segEnd, false) : null;
    const seg = el('div', { class: 'seg small' });
    for (const [key, label] of [['match', 'Match'], ['round', 'This round']]) {
      seg.append(el('button', { class: P.mode === key ? 'active' : null, title: key === 'match' ? 'the whole match, phase "live" only (as the scoreboard)' : 'the round at the playback time',
        onclick: () => { P.mode = lastMode = key; render(); place(); } }, label));
    }
    P.box.append(
      el('div', { class: 'stats-head' },
        el('span', { class: 'rp-dot', style: { '--tc': app.teamColor(p.team) } }),
        el('span', { class: 'stats-name', title: p.cleanName }, p.cleanName),
        el('button', { class: 'rp-close', title: 'close (Esc)', onclick: close }, '×')),
      el('div', { class: 'stats-mode' }, seg, el('span', { class: 'muted' }, live ? '' : r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : '') : '')));
    if (!s) { P.box.append(el('div', { class: 'empty' }, 'No round at the playback time.')); }
    else {
      const kd = s.deaths ? s.kills / s.deaths : s.kills;
      const nade = (n, kind) => el('span', { class: 'stats-nade', title: kind }, el('span', { class: 'stats-nade-dot ' + kind }), String(n));
      const rows = [
        ['Kills', String(s.kills), live && p.kills != null && p.kills !== s.kills ? 'scoreboard ' + p.kills + ' (the server count; this is the kill feed)' : null],
        ['Deaths', String(s.deaths), live && p.deaths != null && p.deaths !== s.deaths ? 'scoreboard ' + p.deaths : null],
        ['K/D', kd.toFixed(2), null],
        ['Headshots', s.hs + (s.kills ? '  (' + Math.round(100 * s.hs / s.kills) + ' %)' : ''), null],
        ['Frags / flashes / smokes', [nade(s.nades.frag, 'frag'), ' ', nade(s.nades.flash, 'flash'), ' ', nade(s.nades.smoke, 'smoke'),
          approx('thrown grenades: the demo names no thrower - the nearest player when the grenade was seen from its launch (within 96 units, clearly the nearest; right for ≈ 96 % of 600 checked frag kills). ' +
            (s.nadesUnknown ? s.nadesUnknown + ' grenade(s) in this range could not be given to a player.' : ''))], null],
        ['Shots fired (seen)', [String(s.shots), approx('only shots visible in the demo: fire events of this player - every shot of the recording player (and of the player he follows), others only while they were in the POV\'s snapshots')], null]
      ];
      const tb = el('tbody');
      for (const [k, v, note] of rows) tb.append(el('tr', { title: note || null }, el('td', null, k), el('td', { class: 'num' }, v, note ? el('span', { class: 'stats-note' }, ' *') : null)));
      P.box.append(el('table', { class: 'stats-table' }, tb));
      // kills per weapon (the real weapon; a headshot is no weapon)
      const wl = el('div', { class: 'stats-weapons' }, el('div', { class: 'stats-sub' }, 'Kills per weapon'));
      if (!s.weapons.length) wl.append(el('div', { class: 'muted' }, 'No kills.'));
      for (const w of s.weapons) {
        const ic = w.weapon ? W.weaponIcon(w.weapon) : null;
        wl.append(el('div', { class: 'stats-wrow', title: w.label + (w.heuristic ? ' - ' + w.heuristic + ' headshot kill(s): the weapon the killer held (the obituary of a headshot names no weapon and no lethal impact was seen)' : '') },
          el('span', { class: 'stats-wicon' }, ic ? el('img', { src: ic.src, alt: '', style: { height: '14px' } }) : null),
          el('span', { class: 'stats-wname' }, w.label, w.heuristic ? approx('weapon held by the killer') : null),
          el('span', { class: 'num' }, String(w.kills))));
      }
      P.box.append(wl);
    }
  }

  C4.mapStats = { statsIcon, statsFor, open, close, refresh, get openClient() { return P ? P.client : null; } };
})(window.C4);
