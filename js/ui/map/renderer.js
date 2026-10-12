/* Map renderer: HiDPI canvas, world <-> screen transform, zoom / pan / rotation,
 * background image (or neutral grid) and all drawing primitives.
 *
 * ONE transform for everything: the affine matrix of matrix() maps world units to css px
 * (scale, pan and the rotation in quarter turns counter-clockwise). Points, lines and circles go
 * through pt(); the background image and the heatmap raster are drawn with the same matrix as
 * canvas transform; view directions use dirAngle(). Texts are drawn at the transformed point,
 * so they always stay upright. */
(function (C4) {
  'use strict';
  const CFG = C4.mapConfig;

  class MapRenderer {
    /**
     * @param {HTMLElement} stage container
     * @param {{minX, minY, maxX, maxY}} world rectangle the view is fitted to
     * @param {{dpr?: number, noInput?: boolean}} opts dpr: fixed pixel ratio (video export: the view
     *        drawn at another resolution, everything scaled alike); noInput: no mouse handling
     */
    constructor(stage, world, opts = {}) {
      this.fixedDpr = opts.dpr || null;
      this.stage = stage;
      this.canvas = document.createElement('canvas');
      stage.append(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.world = world;
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };      // screen offset in css px
      this.rot = 0;                   // quarter turns counter-clockwise (0..3)
      this.image = null;
      this.imageRect = null;          // world rect the image covers
      this.dpr = 1;
      this.resize();
      if (!opts.noInput) {
        new ResizeObserver(() => { this.resize(); if (this.onChange) this.onChange(); }).observe(stage);
        this.bindInput();
      }
    }

    resize() {
      const r = this.stage.getBoundingClientRect();
      this.dpr = this.fixedDpr || Math.min(3, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      const W = this.world, pad = 16;
      // a quarter turn swaps the world extents on the screen
      const ew = this.rot % 2 ? W.maxY - W.minY : W.maxX - W.minX;
      const eh = this.rot % 2 ? W.maxX - W.minX : W.maxY - W.minY;
      this.baseScale = Math.min((this.w - 2 * pad) / (ew || 1), (this.h - 2 * pad) / (eh || 1));
      this.mKey = null;           // the matrix depends on the size and the rotation
    }

    get scale() { return this.baseScale * this.zoom; }

    /** rotation in quarter turns counter-clockwise; the view turns around the screen centre
     * (the pan offset turns with it, the zoom is kept) */
    setRotation(q) {
      q = ((q % 4) + 4) % 4;
      let steps = (q - this.rot + 4) % 4;
      while (steps--) this.pan = { x: this.pan.y, y: -this.pan.x };     // one quarter turn ccw on the screen
      this.rot = q;
      this.resize();
      if (this.onChange) this.onChange();
    }

    /** world -> css px: X = a*x + c*y + e, Y = b*x + d*y + f (canvas setTransform order) */
    matrix() {
      const key = this.scale + '|' + this.pan.x + '|' + this.pan.y + '|' + this.rot + '|' + this.w + '|' + this.h;
      if (this.mKey === key) return this.m;
      this.mKey = key;
      return (this.m = this.computeMatrix());
    }
    computeMatrix() {
      const s = this.scale, W = this.world;
      const cx = (W.minX + W.maxX) / 2, cy = (W.minY + W.maxY) / 2;
      // screen y points down; each quarter turn ccw maps the screen vector (u, v) to (v, -u)
      const M = [[s, 0, 0, -s], [0, -s, -s, 0], [-s, 0, 0, s], [0, s, s, 0]][this.rot];
      const [a, b, c, d] = M;
      return { a, b, c, d, e: this.w / 2 + this.pan.x - (a * cx + c * cy), f: this.h / 2 + this.pan.y - (b * cx + d * cy) };
    }
    /** world -> css px */
    pt(x, y) { const m = this.matrix(); return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; }
    /** css px -> world */
    inv(px, py) {
      const m = this.matrix(), det = m.a * m.d - m.b * m.c;
      const X = px - m.e, Y = py - m.f;
      return [(m.d * X - m.c * Y) / det, (-m.b * X + m.a * Y) / det];
    }
    /** screen angle (radians) of the world direction yaw (degrees; 0 = +x, counter-clockwise) */
    dirAngle(yawDeg) {
      const m = this.matrix(), r = yawDeg * Math.PI / 180, dx = Math.cos(r), dy = Math.sin(r);
      return Math.atan2(m.b * dx + m.d * dy, m.a * dx + m.c * dy);
    }
    /** draw callback fn() in world units (the matrix as canvas transform) */
    inWorld(fn) {
      const g = this.ctx, m = this.matrix(), k = this.dpr;
      g.save();
      g.setTransform(k * m.a, k * m.b, k * m.c, k * m.d, k * m.e, k * m.f);
      fn(g);
      g.restore();
    }

    bindInput() {
      const c = this.canvas;
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const [wx, wy] = this.inv(mx, my);
        const f = Math.exp(-e.deltaY * 0.0015);
        this.zoom = Math.min(12, Math.max(0.5, this.zoom * f));
        // keep the point under the mouse fixed
        const [nx, ny] = this.pt(wx, wy);
        this.pan.x += mx - nx;
        this.pan.y += my - ny;
        if (this.onChange) this.onChange();
      }, { passive: false });
      let drag = null;
      c.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y }; c.style.cursor = 'grabbing'; });
      window.addEventListener('mousemove', e => {
        if (!drag) return;
        this.pan.x = drag.px + e.clientX - drag.x;
        this.pan.y = drag.py + e.clientY - drag.y;
        if (this.onChange) this.onChange();
      });
      window.addEventListener('mouseup', () => { drag = null; c.style.cursor = ''; });
      c.addEventListener('dblclick', () => { this.zoom = 1; this.pan = { x: 0, y: 0 }; if (this.onChange) this.onChange(); });
    }

    setImage(img, rect) { this.image = img; this.imageRect = rect; }

    begin() {
      const g = this.ctx;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.fillStyle = '#07090c';
      g.fillRect(0, 0, this.w, this.h);
      return g;
    }

    /** a raster (image / heatmap) covering world rect R: top-left pixel at (minX, maxY) */
    drawRaster(src, R, alpha) {
      this.inWorld(g => {
        g.imageSmoothingEnabled = true;
        g.globalAlpha = alpha;
        g.translate(R.minX, R.maxY);
        g.scale((R.maxX - R.minX) / src.width, -(R.maxY - R.minY) / src.height);
        g.drawImage(src, 0, 0);
      });
    }

    drawBackground() {
      const g = this.ctx;
      if (this.image && this.imageRect) { this.drawRaster(this.image, this.imageRect, 0.9); return; }
      // neutral grid over the world rectangle
      const W = this.world;
      const corners = [[W.minX, W.minY], [W.maxX, W.minY], [W.maxX, W.maxY], [W.minX, W.maxY]].map(p => this.pt(p[0], p[1]));
      const poly = () => { g.beginPath(); corners.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); };
      g.fillStyle = '#10151c';
      poly(); g.fill();
      const step = 256;
      g.strokeStyle = 'rgba(120,140,160,0.10)';
      g.lineWidth = 1;
      g.beginPath();
      const line = (x0, y0, x1, y1) => { const a = this.pt(x0, y0), b = this.pt(x1, y1); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); };
      for (let x = Math.ceil(W.minX / step) * step; x <= W.maxX; x += step) line(x, W.minY, x, W.maxY);
      for (let y = Math.ceil(W.minY / step) * step; y <= W.maxY; y += step) line(W.minX, y, W.maxX, y);
      g.stroke();
      g.strokeStyle = 'rgba(120,140,160,0.35)';
      poly(); g.stroke();
    }


    /** trail: array of [x, y] segments (each segment an array of points) with per-point age 0..1 */
    drawTrail(segments, color, alphaScale = 1) {
      const g = this.ctx;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = 2;
      g.strokeStyle = color;
      for (const seg of segments) {
        for (let i = 1; i < seg.length; i++) {
          const a = this.pt(seg[i - 1][0], seg[i - 1][1]), b = this.pt(seg[i][0], seg[i][1]);
          g.globalAlpha = Math.max(0.05, 1 - seg[i][2]) * 0.9 * alphaScale;     // fade out towards the old end
          g.beginPath();
          g.moveTo(a[0], a[1]);
          g.lineTo(b[0], b[1]);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    }

    /** opts: {hollow, alpha, firing, highlight (POV follow: white ring), hover (from the player table), label} */
    drawPlayer(p, color, opts) {
      const g = this.ctx;
      const [x, y] = this.pt(p.x, p.y);
      const alpha = opts.alpha == null ? 1 : opts.alpha;
      g.globalAlpha = alpha;
      if (!opts.hollow) {
        // view cone from the yaw angle, through the same transform as the positions
        const len = Math.max(18, CFG.VIEW_LENGTH * this.scale);
        const a = this.dirAngle(p.yaw), h = CFG.VIEW_HALF_ANGLE * Math.PI / 180;
        const grad = g.createRadialGradient(x, y, 2, x, y, len);
        grad.addColorStop(0, hexA(color, 0.45));
        grad.addColorStop(1, hexA(color, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(x, y);
        g.arc(x, y, len, a - h, a + h);
        g.closePath();
        g.fill();
      }
      const r = CFG.PLAYER_RADIUS_PX * (p.crouch ? 0.9 : 1) * (p.prone ? 0.8 : 1);
      if (opts.hover) {
        g.beginPath();
        g.arc(x, y, r + 6, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fill();
        g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
      }
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      if (opts.hollow) {
        g.lineWidth = 1.6;
        g.strokeStyle = color;
        g.setLineDash([2, 2]);
        g.stroke();
        g.setLineDash([]);
      } else {
        g.fillStyle = color;
        g.fill();
        g.lineWidth = opts.highlight ? 2.4 : 1.3;
        g.strokeStyle = opts.highlight ? '#ffffff' : 'rgba(0,0,0,0.85)';
        g.stroke();
      }
      if (opts.firing && !opts.hollow) {
        g.beginPath();
        g.arc(x, y, r + 3.5, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(255,240,180,0.9)';
        g.lineWidth = 1.2;
        g.stroke();
      }
      if (opts.label) {
        g.font = (opts.hover ? '700 12.5px' : '600 11.5px') + ' "Segoe UI", system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(0,0,0,0.85)';
        g.strokeText(opts.label, x + r + 5, y - 1);
        g.fillStyle = opts.hollow ? '#9aa4b2' : '#f2f5f8';
        g.fillText(opts.label, x + r + 5, y - 1);
      }
      g.globalAlpha = 1;
    }

    drawDeath(x, y, color, alpha) {
      const g = this.ctx;
      const [X, Y] = this.pt(x, y), s = 6;
      g.globalAlpha = alpha;
      g.lineWidth = 2.6;
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.beginPath(); g.moveTo(X - s, Y - s); g.lineTo(X + s, Y + s); g.moveTo(X + s, Y - s); g.lineTo(X - s, Y + s); g.stroke();
      g.lineWidth = 1.8;
      g.strokeStyle = color;
      g.beginPath(); g.moveTo(X - s, Y - s); g.lineTo(X + s, Y + s); g.moveTo(X + s, Y - s); g.lineTo(X - s, Y + s); g.stroke();
      g.globalAlpha = 1;
    }

    drawPath(points, color, alpha, dash) {
      if (points.length < 2) return;
      const g = this.ctx;
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      if (dash) g.setLineDash(dash);
      g.beginPath();
      for (let i = 0; i < points.length; i++) {
        const [X, Y] = this.pt(points[i][0], points[i][1]);
        if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
      }
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    drawCircle(x, y, radiusWorld, color, alpha, fill) {
      const g = this.ctx;
      const r = Math.max(3, radiusWorld * this.scale);
      const [X, Y] = this.pt(x, y);
      g.globalAlpha = alpha;
      g.beginPath();
      g.arc(X, Y, r, 0, Math.PI * 2);
      if (fill) { g.fillStyle = hexA(color, fill); g.fill(); }
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.stroke();
      g.globalAlpha = 1;
    }

    /** the bomb: small diamond with a light border (carried: a small round dot); opts {color, alpha,
     *  hollow, round, pulse 0..1 (planted ring), burst 0..1 (explosion), dx, dy (screen offset, e.g.
     *  next to the carrier)} -> screen position */
    drawBomb(x, y, opts) {
      const g = this.ctx, B = CFG.BOMB;
      const p = this.pt(x, y);
      const X = p[0] + (opts.dx || 0), Y = p[1] + (opts.dy || 0), s = B.size;
      const color = opts.color || B.color;
      g.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
      if (opts.burst != null) {
        const r = 6 + 26 * opts.burst;
        g.beginPath(); g.arc(X, Y, r, 0, Math.PI * 2);
        g.fillStyle = hexA(color, 0.35 * (1 - opts.burst)); g.fill();
        g.strokeStyle = hexA(color, 1 - opts.burst); g.lineWidth = 2; g.stroke();
      }
      if (opts.pulse != null) {
        g.beginPath(); g.arc(X, Y, s + 3 + 9 * opts.pulse, 0, Math.PI * 2);
        g.strokeStyle = hexA(color, 0.9 * (1 - opts.pulse)); g.lineWidth = 2; g.stroke();
      }
      g.beginPath();
      if (opts.round) {
        // carried: small round dot with a dark outline and the light border (next to the carrier)
        g.arc(X, Y, B.carriedRadius + 1.2, 0, Math.PI * 2);
        g.fillStyle = 'rgba(0,0,0,0.85)'; g.fill();
        g.beginPath(); g.arc(X, Y, B.carriedRadius, 0, Math.PI * 2);
      } else {
        g.moveTo(X, Y - s - 1); g.lineTo(X + s + 1, Y); g.lineTo(X, Y + s + 1); g.lineTo(X - s - 1, Y); g.closePath();
      }
      if (opts.hollow) {
        // last known position: faint fill, dashed light edge and a "?" - clearly not a current position
        g.fillStyle = hexA(color, 0.3); g.fill();
        g.setLineDash([2, 2]); g.lineWidth = 1.6; g.strokeStyle = B.edge; g.stroke(); g.setLineDash([]);
        g.font = '700 11px "Segoe UI", system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText('?', X + s + 4, Y);
        g.fillStyle = B.edge; g.fillText('?', X + s + 4, Y);
      } else {
        g.fillStyle = color; g.fill();
        g.lineWidth = 1.6; g.strokeStyle = B.edge; g.stroke();
      }
      g.globalAlpha = 1;
      return { x: X, y: Y };
    }

    /** ring around a player dot (the bomb carrier) */
    drawRing(x, y, color, radiusPx, alpha) {
      const g = this.ctx;
      const [X, Y] = this.pt(x, y);
      g.globalAlpha = alpha == null ? 1 : alpha;
      g.beginPath(); g.arc(X, Y, radiusPx, 0, Math.PI * 2);
      g.strokeStyle = color; g.lineWidth = 1.8; g.stroke();
      g.globalAlpha = 1;
    }

    drawDot(x, y, color, alpha, r = 2.5) {
      const g = this.ctx;
      const [X, Y] = this.pt(x, y);
      g.globalAlpha = alpha;
      g.fillStyle = color;
      g.beginPath();
      g.arc(X, Y, r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  }

  function hexA(hex, a) {
    if (hex.startsWith('hsl')) return hex.replace('hsl(', 'hsla(').replace(')', ',' + a + ')');
    if (hex.startsWith('rgb')) return hex.replace(/rgba?\(([^)]+?)(?:,\s*[\d.]+)?\)/, (m0, c) => 'rgba(' + c.split(',').slice(0, 3).join(',') + ',' + a + ')');
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  C4.MapRenderer = MapRenderer;
  C4.hexA = hexA;
})(window.C4);
