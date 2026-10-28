/* 2D view: top-down replay on the compass image (cod4-demo's map tab, drawn from the shared
 * Match + Replay state). Renderer, heatmap, heat panel and video export are cod4-demo's
 * modules (js/c4/ui/map). */
import { InfoHint, fadeHint } from '../app/infoHint.js';

const C4 = window.C4;
const { el, icon } = C4.ui;
const CFG = C4.mapConfig;

const BOMB_TEXT = { base: 'Bomb at its start position', dropped: 'Dropped', planted: 'Planted', defused: 'Defused', exploded: 'Exploded' };
const BOMB_SOURCE = { objective: 'compass objective', model: 'bomb model', 'last known': 'last known position', message: 'server message' };

export class View2D {
  constructor(replay, container) {
    this.key = '2d';
    this.R = replay;
    this.M = replay.match;
    const M = this.M, d = M.d, app = replay.app;
    this.stage = el('div', { class: 'view-stage view2d' });
    container.append(this.stage);
    // the background's details (the rail's info popover; a missing background shown as a warning); the
    // controls hint fades after a few seconds (infoHint.js)
    this.info = new InfoHint(this.stage, 'Map image details');
    this.hint = this.info.box;
    this.ctrlHint = el('div', { class: 'cam-hint' }, 'Wheel: zoom · drag: pan · double-click: reset · Q / E: rotate');
    this.renderer = new C4.MapRenderer(this.stage, M.rect);
    this.renderer.setRotation(this.loadRotation());
    this.renderer.onChange = () => replay.invalidate();
    this.renderer.canvas.addEventListener('mousemove', e => {
      const r = this.renderer.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.updateBombTitle();
    });
    this.renderer.canvas.addEventListener('mouseleave', () => { this.mouse = null; this.updateBombTitle(); });
    // heatmap: data points per category, raster layer, options panel
    this.heatPts = {};
    this.heatLayer = new C4.HeatLayer(M.rect);
    this.heatUi = C4.mapHeat.create({ app, data: d, onChange: () => replay.invalidate() });
    // map tools (zoom, rotation) bottom right of the map; the heatmap is a popover of the rail (main.js: panels)
    const tool = (name, title, label, fn) => el('button', { class: 'ib', title, 'aria-label': label, onclick: fn }, icon(name));
    const tools = el('div', { class: 'map-tools glass', role: 'toolbar', 'aria-label': 'Map tools' },
      tool('plus', 'Zoom in', 'Zoom in', () => this.zoomBy(1.25)),
      tool('minus', 'Zoom out', 'Zoom out', () => this.zoomBy(1 / 1.25)),
      tool('rotl', 'Rotate 90° left (Q)', 'Rotate left', () => this.rotate(1)),
      tool('rotr', 'Rotate 90° right (E)', 'Rotate right', () => this.rotate(-1)));
    this.stage.append(tools, this.ctrlHint, this.heatUi.panel, this.heatUi.chip);
    this.panels = [{ key: 'heat', title: 'Heatmap', icon: 'flame', custom: this.heatUi }];
    const img = M.mapEntry && M.mapEntry.image;
    if (img && M.calibrated) {
      const im = new Image();
      im.onload = () => { this.renderer.setImage(im, M.rect); replay.invalidate(); };
      im.onerror = () => { this.info.set('Background image ' + img + ' could not be loaded - neutral grid.', { warn: true }); };
      im.src = C4.maps.IMAGE_DIR + img;
      this.info.set('Background: ' + img + ' (' + M.rectSource + ').');
    } else {
      this.info.set((img ? 'Background ' + img + ' not shown: no calibration for this demo' : 'No background image for ' + (d.meta.map || 'this map')) +
        ' - neutral grid (' + M.rectSource + ').', { warn: true });
    }
    this.onKey = e => {
      if (!this.visible || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' && document.activeElement.type !== 'checkbox' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyQ') { e.preventDefault(); this.rotate(1); }
      else if (e.code === 'KeyE') { e.preventDefault(); this.rotate(-1); }
    };
    window.addEventListener('keydown', this.onKey);
    this.stage.hidden = true;
    this.visible = false;
  }

  show() { this.visible = true; this.stage.hidden = false; this.renderer.resize(); fadeHint(this.ctrlHint); }
  hide() { this.visible = false; this.stage.hidden = true; if (this.heatUi.close) this.heatUi.close(); }
  destroy() { window.removeEventListener('keydown', this.onKey); if (this.heatUi.close) this.heatUi.close(); this.stage.remove(); }

  /* ---------- one frame ---------- */
  draw(t) {
    const R = this.renderer, M = this.M, d = M.d, RP = this.R, o = RP.opts;
    const ep = M.epochStart(t);
    R.begin();
    R.drawBackground();
    const heatInfo = this.drawHeat(t);
    if (!this.exporting) this.heatUi.info(heatInfo);
    if (heatInfo && !this.heatUi.opts.keep) { this.bombHit = null; return; }

    // grenades of the current round
    for (const gr of M.grenades) {
      if (!o.grenadeKinds.has(gr.g.kind) || t < gr.start || t > gr.end || gr.start < ep) continue;
      const det = gr.g.detonation;
      if (!det || t < det.t) {
        const shown = gr.pts.filter(p => p[0] <= t);
        R.drawPath(shown.map(p => [p[1], p[2]]), gr.cfg.color, 0.85, [4, 3]);
        const cur = shown[shown.length - 1];
        if (cur) R.drawDot(cur[1], cur[2], gr.cfg.color, 1, 3);
      } else {
        const age = t - det.t;
        const fadeStart = gr.cfg.duration - gr.cfg.fade;
        const alpha = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / gr.cfg.fade);
        R.drawPath(gr.pts.map(p => [p[1], p[2]]), gr.cfg.color, 0.35 * alpha, [4, 3]);
        R.drawCircle(det.x, det.y, gr.cfg.radius, gr.cfg.color, 0.95 * alpha, gr.g.kind === 'smoke' ? 0.35 : 0.22);
      }
    }

    const shown = RP.shownPlayers();
    const hover = this.exporting ? null : RP.hover;
    const dim = cl => (hover != null && cl !== hover) || (RP.focus != null && cl !== RP.focus && hover == null);
    if (o.trails) for (const cl of shown) R.drawTrail(M.trailOf(cl, t).map(s => s.map(p => [p[0], p[1], p[3]])), M.color(cl), dim(cl) ? 0.45 : 1);

    // kill lines (killer -> victim) and death markers
    for (const k of RP.recentKills(t, CFG.DEATH_MARKER_MS)) {
      if (!shown.has(k.victim) && !shown.has(k.attacker)) continue;
      const age = t - k.t, fade = 1 - age / CFG.DEATH_MARKER_MS;
      const vp = M.deathPos(k);
      if (o.killLines && vp && !k.suicide && !k.world && k.attacker < 64) {
        const ap = M.attackerPos(k);
        if (ap) R.drawPath([[ap[0], ap[1]], [vp[0], vp[1]]], M.color(k.attacker), 0.75 * fade, k.headshot ? null : [6, 4]);
      }
      if (vp && shown.has(k.victim)) R.drawDeath(vp[0], vp[1], M.color(k.victim), 1 - (age / CFG.DEATH_MARKER_MS) * 0.7);
    }

    // players (hovered / selected on top)
    const povFollow = M.followedAt(t);
    const rank = cl => (cl === hover ? 2 : 0) + (cl === RP.focus ? 1 : 0);
    const order = [...shown].sort((a, b) => rank(a) - rank(b));
    for (const cl of order) {
      const s = M.sampleAt(cl, t);
      if (!s) continue;
      const stale = s.age > CFG.STALE_MS;
      if (stale && (!o.lastKnown || s.age > CFG.LAST_KNOWN_MAX_MS)) continue;
      const hi = cl === hover || cl === RP.focus;
      R.drawPlayer(s, M.color(cl), {
        hollow: stale, alpha: stale ? 0.55 : 1, firing: s.firing, highlight: cl === povFollow, hover: hi,
        label: o.labels || hi ? M.name(cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '') : null
      });
    }
    this.drawBomb(t);
    if (!this.exporting) this.updateBombTitle();
  }

  drawHeat(t) {
    const o = this.heatUi.opts, L = this.heatLayer, RP = this.R;
    if (o.cat === 'off') return null;
    const pts = this.heatPts[o.cat] || (this.heatPts[o.cat] = C4.heatPoints.build(this.M.d, o.cat));
    const players = o.players ? [...o.players].sort((x, y) => x - y).join(',') : '*';
    const fkey = o.cat + '|' + o.team + '|' + o.side + '|' + players;
    if (this.heatMaskKey !== fkey) { this.heatMask = C4.heatPoints.mask(pts, o.team, o.side, o.players); this.heatMaskKey = fkey; }
    const [from, end] = RP.pb.range;
    const to = o.upTo ? t : end;
    const key = fkey + '|' + from + '|' + (o.upTo ? 'upto' : end);
    const now = performance.now();
    const throttle = !this.exporting && o.upTo && RP.pb.playing && L.key === key && to >= L.until && now - (this.heatAt || 0) < CFG.HEAT.THROTTLE_MS;
    if (!throttle) { L.accumulate(key, pts, this.heatMask, from, to); this.heatAt = now; }
    this.renderer.drawRaster(L.paint(o.radius, o.intensity), L.rect, 1);
    return { n: L.n, missing: L.missing, unattributed: L.unattributed, filtered: o.team !== 'both' || o.side !== 'both' || !!o.players };
  }

  drawBomb(t) {
    const M = this.M, e = M.bombAt(t), R = this.renderer, B = CFG.BOMB;
    this.bombHit = null;
    if (!e) return;
    let pos = null, opts = {}, text;
    if (e.state === 'carried') {
      const s = M.sampleAt(e.carrier, t);
      if (!s || s.age > CFG.STALE_MS) return;
      R.drawRing(s.x, s.y, B.color, CFG.PLAYER_RADIUS_PX + 3.5, 0.9);
      pos = [s.x, s.y];
      opts = { dx: 8, dy: -8, round: true };
      text = 'Carried by ' + M.name(e.carrier);
    } else if (e.state === 'unknown') {
      if (e.x == null) return;
      pos = [e.x, e.y];
      opts = { alpha: B.unknownAlpha, hollow: true };
      text = 'Bomb position unknown (not visible to POV) - last known position';
    } else if (e.state === 'exploded') {
      const age = t - e.t;
      if (age > B.explodedMs || e.x == null) return;
      pos = [e.x, e.y];
      opts = { burst: age / B.explodedMs, alpha: 1 - 0.6 * age / B.explodedMs };
      text = 'Exploded' + (e.site ? ' - site ' + e.site : '');
    } else {
      if (e.x == null) return;
      pos = [e.x, e.y];
      if (e.state === 'planted') opts = { pulse: ((t - e.t) % B.pulseMs) / B.pulseMs };
      if (e.state === 'defused') opts = { color: B.defusedColor };
      text = BOMB_TEXT[e.state] + (e.site ? ' - site ' + e.site : '');
    }
    const sp = R.drawBomb(pos[0], pos[1], opts);
    if (e.source && BOMB_SOURCE[e.source]) text += ' (position: ' + BOMB_SOURCE[e.source] + ')';
    this.bombHit = { x: sp.x, y: sp.y, text };
  }

  updateBombTitle() {
    const h = this.bombHit, m = this.mouse;
    const on = !!(h && m && Math.hypot(h.x - m.x, h.y - m.y) <= CFG.BOMB.hitPx);
    const title = on ? h.text : '';
    if (this.renderer.canvas.title !== title) this.renderer.canvas.title = title;
  }

  zoomBy(f) {
    const R = this.renderer, cx = R.w / 2, cy = R.h / 2;
    const [wx, wy] = R.inv(cx, cy);
    R.zoom = Math.min(12, Math.max(0.5, R.zoom * f));
    const [nx, ny] = R.pt(wx, wy);
    R.pan.x += cx - nx; R.pan.y += cy - ny;
    this.R.invalidate();
  }

  loadRotation() {
    try {
      const v = localStorage.getItem(CFG.ROTATION_KEY + (this.M.d.meta.map || ''));
      if (v != null && /^[0-3]$/.test(v)) return Number(v);
    } catch (err) { /* storage blocked: the default */ }
    return CFG.ROTATION_DEFAULT;
  }
  rotate(dir) {
    const R = this.renderer;
    R.setRotation(R.rot + dir);
    try { localStorage.setItem(CFG.ROTATION_KEY + (this.M.d.meta.map || ''), String(R.rot)); } catch (err) { /* not stored */ }
    this.R.invalidate();
  }

  /* ---------- video export (cod4-demo's exportVideo.js) ---------- */
  exportVideo() {
    const RP = this.R, view = this;
    const state = {
      get d() { return RP.d; }, get scope() { return RP.scope; }, get pb() { return RP.pb; },
      get base() { return RP.base; }, get timeline() { return RP.timeline; }, get renderer() { return view.renderer; }
    };
    C4.mapExport.open({
      state,
      roundAtOrBefore: t => RP.match.roundAtOrBefore(t),
      drawFrame(renderer, t) {
        const keep = view.renderer;
        view.renderer = renderer; view.exporting = true;
        try { view.draw(t); } finally { view.renderer = keep; view.exporting = false; }
      },
      done() { view.heatLayer.invalidate(); RP.invalidate(); }
    });
  }
}
