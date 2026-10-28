/* The kill feed overlay shared by the 3D view (DOM rows over the canvas) and the video exports (drawn
 * into the frame): the kills and bomb plants / defuses of the last seconds of the round, newest at the
 * bottom, fading out like the game's obituaries. A pure function of the replay time, so pause, seeking
 * and the playback speed need no state. Icons, texts and their order come from the side panel's rules:
 * C4.weapons.killIcons (the weapon -> icon mapping) and the sequence of C4.ui.killNodes.
 * Loaded by the modules that use it (`import '../c4/ui/killfeed.js'`: main.js, view3d.js, effects.js,
 * exportVideo3d.js) - not by a script tag, so a view module never depends on the page's script list
 * (a page cached from before a new script tag would lack it). It needs the classic scripts C4.ui,
 * C4.weapons and C4.mapConfig, which the page loads before any module. */
(function (C4) {
  'use strict';
  if (C4.killfeed) return;                     // (a page that also loads it as a classic script)
  const X = C4.mapConfig.EXPORT;
  const FADE_MS = 800;                         // the last 0.8 s of an entry fade out
  const WARN = '#f5c451', MUTED = '#c8c8ce', DIM = '#8d8d95';

  /** the entries shown at t: [{t, kill | ev, alpha}] - kills and bomb plants / defuses of the last
   *  KILLFEED_MS of the round at t (none from before its start), at most KILLFEED_LINES, oldest first */
  function itemsAt(d, t) {
    const ri = C4.events.roundAt(d.rounds, t), since = ri >= 0 ? d.rounds[ri].segStart : -Infinity;
    const on = x => x <= t && t - x < X.KILLFEED_MS && x >= since;
    const out = [];
    for (const k of d.kills) if (on(k.t)) out.push({ t: k.t, kill: k });
    for (const e of d.events) if ((e.type === 'bomb_planted' || e.type === 'bomb_defused') && on(e.t)) out.push({ t: e.t, ev: e });
    out.sort((a, b) => a.t - b.t);
    for (const it of out) it.alpha = Math.max(0, Math.min(1, (X.KILLFEED_MS - (t - it.t)) / FADE_MS));
    return out.slice(-X.KILLFEED_LINES);
  }

  /** the parts of one entry, in the side panel's order: [{text, color} | {icon, heuristic} | {badge, color}]
   *  "Killer [weapon] [headshot] Victim [Teamkill] [Bomb]"; suicides, world and entity kills without the
   *  killer; a weapon without an icon as its name (and listed in missing) */
  function parts(app, d, it) {
    if (it.ev) return [{ text: it.ev.text || it.ev.type, color: WARN }];
    const k = it.kill, icons = C4.weapons.killIcons(k);
    const name = (cl, team) => {
      if (cl === 1022) return { text: 'World', color: DIM };
      if (cl == null || cl >= 64) return { text: cl == null ? '?' : 'Entity ' + cl, color: DIM };
      const p = d.players.find(x => x.client === cl);
      return { text: p ? p.cleanName : 'Client ' + cl, color: app.teamColor(team || (p && p.team)) };
    };
    const out = [];
    if (!k.suicide && !k.world && !k.entityAttacker) out.push(name(k.attacker, k.attackerTeam));
    if (icons.weapon) out.push({ icon: icons.weapon, heuristic: icons.weapon.heuristic });
    else {
      out.push({ text: icons.text || '?', color: MUTED });
      noteMissing(k);
    }
    if (icons.headshot) out.push({ icon: icons.headshot });
    out.push(name(k.victim, k.victimTeam));
    if (k.suicide) out.push({ text: 'suicide', color: DIM, small: true });
    if (k.teamkill && !k.suicide) out.push({ badge: 'Teamkill', color: WARN });
    if (k.bomb) out.push({ badge: 'Bomb', color: WARN });
    return out;
  }

  /** weapons of kills that have no icon (shown as text): weapon or means of death -> count */
  const missing = new Map();
  function noteMissing(k) {
    const key = k.weaponName && k.weaponName !== 'none' ? k.weaponName : (k.mod || 'unknown');
    if (!missing.has(key)) console.info('kill feed: no icon for', key, '- shown as "' + (C4.weapons.killIcons(k).text || '?') + '"');
    missing.set(key, (missing.get(key) || 0) + 1);
  }

  /* ---------- canvas (video export) ---------- */
  let loading = null;
  /** all icon images, loaded once -> Promise<Map file -> HTMLImageElement> (a file that fails to load
   *  is left out: that entry is drawn as text) */
  function images() {
    if (!loading) {
      loading = Promise.all(Object.keys(C4.weapons.ICONS).map(file => new Promise(res => {
        const img = new Image();
        img.onload = () => res([file, img]);
        img.onerror = () => { console.warn('kill feed icon not loaded:', file); res(null); };
        img.src = C4.weapons.ICON_DIR + file;
      }))).then(list => new Map(list.filter(Boolean)));
    }
    return loading;
  }

  /** draw the feed at t into a 2D context: right-aligned at `right`, the first row centred at `top`;
   *  sizes x scale (1 = the page at 720 lines); imgs from images() */
  function draw(g, app, d, t, { right, top, scale = 1, imgs }) {
    const s = scale, ICON_H = 16 * s, ROW_H = 21 * s, PAD = 6 * s, GAP = 5 * s;
    const font = (w, px) => w + ' ' + (px * s).toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
    g.save();
    g.textBaseline = 'middle'; g.textAlign = 'left';
    let y = top;
    for (const it of itemsAt(d, t)) {
      // measure: an icon is its visible content box scaled to ICON_H (aspect ratio kept)
      const segs = parts(app, d, it).map(p => {
        if (p.icon) {
          const img = imgs && imgs.get(p.icon.file);
          if (img) return Object.assign({ w: p.icon.box[2] * ICON_H / p.icon.box[3], img }, p);
          p = { text: p.icon.title, color: MUTED };
        }
        g.font = p.badge ? font('700', 10.5) : font(p.small ? '400' : '600', p.small ? 11 : 12);
        return Object.assign({ w: g.measureText(p.badge || p.text).width + (p.badge ? 10 * s : 0), font: g.font }, p);
      });
      const w = segs.reduce((a, q) => a + q.w, 0) + GAP * (segs.length - 1) + 2 * PAD;
      const x0 = right - w;
      g.globalAlpha = it.alpha;
      g.fillStyle = 'rgba(16,16,18,0.72)';
      roundRect(g, x0, y - ROW_H / 2 + s, w, ROW_H - 2 * s, 3 * s); g.fill();
      let x = x0 + PAD;
      for (const q of segs) {
        if (q.img) {
          const b = q.icon.box;
          g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 2 * s;
          g.drawImage(q.img, b[0], b[1], b[2], b[3], x, y - ICON_H / 2, q.w, ICON_H);
          g.shadowBlur = 0;
          if (q.heuristic) { g.font = font('700', 10); g.fillStyle = DIM; g.fillText('≈', x + q.w - 2 * s, y - 5 * s); }
        } else if (q.badge) {
          g.font = q.font;
          g.strokeStyle = q.color; g.lineWidth = Math.max(1, s);
          roundRect(g, x + 0.5, y - 7 * s, q.w - 1, 14 * s, 7 * s); g.stroke();
          g.fillStyle = q.color; g.fillText(q.badge, x + 5 * s, y + 0.5 * s);
        } else {
          g.font = q.font;
          g.shadowColor = '#000'; g.shadowBlur = 2 * s;
          g.fillStyle = q.color; g.fillText(q.text, x, y + 0.5 * s);
          g.shadowBlur = 0;
        }
        x += q.w + GAP;
      }
      g.globalAlpha = 1;
      y += ROW_H;
    }
    g.restore();
  }
  /** the icons of a kill (weapon, headshot) centred at x above y - the marker over a death position */
  function drawMark(g, k, x, y, { scale = 1, imgs, alpha = 1 }) {
    const s = scale, H = 16 * s, PAD = 4 * s, GAP = 3 * s;
    const ic = C4.weapons.killIcons(k), list = [ic.weapon, ic.headshot].filter(i => i && imgs && imgs.get(i.file));
    g.save();
    g.globalAlpha = alpha;
    g.font = '600 ' + (11 * s).toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
    const text = ic.weapon ? null : ic.text || '?';
    const w = (text ? g.measureText(text).width : 0) + list.reduce((a, i) => a + i.box[2] * H / i.box[3], 0) + GAP * Math.max(0, list.length - 1 + (text ? 1 : 0)) + 2 * PAD;
    const top = y - H - 2 * PAD;
    g.fillStyle = 'rgba(11,11,12,0.6)';
    roundRect(g, x - w / 2, top, w, H + 2 * PAD, 3 * s); g.fill();
    let xx = x - w / 2 + PAD;
    if (text) { g.textBaseline = 'middle'; g.fillStyle = MUTED; g.fillText(text, xx, top + PAD + H / 2); xx += g.measureText(text).width + GAP; }
    g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 2 * s;
    for (const i of list) {
      const iw = i.box[2] * H / i.box[3];
      g.drawImage(imgs.get(i.file), i.box[0], i.box[1], i.box[2], i.box[3], xx, top + PAD, iw, H);
      xx += iw + GAP;
    }
    g.restore();
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
  }

  /* ---------- DOM (3D view) ---------- */
  /** the feed as rows over a view: update(t) rebuilds the rows only when the entries change, and sets
   *  their fade every call */
  class Overlay {
    constructor(parent, app, d) {
      this.app = app; this.d = d;
      this.box = C4.ui.el('div', { class: 'kf-overlay', 'aria-live': 'off' });
      parent.append(this.box);
      this.key = '';
      this.rows = [];
    }
    set visible(on) { this.box.hidden = !on; }
    get visible() { return !this.box.hidden; }
    update(t) {
      if (this.box.hidden) return;
      const items = itemsAt(this.d, t);
      const key = items.map(it => it.t + (it.kill ? 'k' + it.kill.victim : 'e')).join(',');
      if (key !== this.key) {
        this.key = key;
        this.box.textContent = '';
        this.rows = items.map(it => {
          const row = C4.ui.el('div', { class: 'kf-row' + (it.ev ? ' kf-bomb' : '') }, parts(this.app, this.d, it).map(p => this.node(p)));
          this.box.append(row);
          return row;
        });
      }
      items.forEach((it, i) => { const o = it.alpha.toFixed(2); if (this.rows[i].style.opacity !== o) this.rows[i].style.opacity = o; });
    }
    node(p) {
      const el = C4.ui.el;
      if (p.icon) return el('span', { class: 'kf-weapon' }, C4.ui.iconNode(p.icon, p.icon.title),
        p.heuristic ? C4.ui.approx('the obituary of a headshot carries no weapon; this is the weapon the killer held at that moment') : null);
      if (p.badge) return el('span', { class: 'badge tk' }, p.badge);
      return el('span', { class: p.small ? 'kf-note' : 'kf-name', style: { color: p.color } }, p.text);
    }
    dispose() { this.box.remove(); }
  }

  /** the DOM marker of a kill for the 3D view's label layer: weapon (+ headshot) icon, else its text */
  function markNode(k) {
    const el = C4.ui.el, ic = C4.weapons.killIcons(k);
    return el('div', { class: 'p3-label kf-mark' },
      ic.weapon ? C4.ui.iconNode(ic.weapon, ic.text) : el('span', { class: 'kf-name', style: { color: MUTED } }, ic.text || '?'),
      ic.headshot ? C4.ui.iconNode(ic.headshot, 'HS') : null);
  }

  C4.killfeed = { FADE_MS, itemsAt, parts, missing, images, draw, drawMark, markNode, Overlay };
})(window.C4);
