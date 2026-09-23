/* Map renderer: HiDPI canvas, world <-> screen transform, zoom / pan,
 * background image (or neutral grid) and all drawing primitives. */
(function (C4) {
  'use strict';
  const CFG = C4.mapConfig;

  class MapRenderer {
    /**
     * @param {HTMLElement} stage container
     * @param {{minX, minY, maxX, maxY}} world rectangle the view is fitted to
     */
    constructor(stage, world) {
      this.stage = stage;
      this.canvas = document.createElement('canvas');
      stage.append(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.world = world;
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };      // screen offset in css px
      this.image = null;
      this.imageRect = null;          // world rect the image covers
      this.dpr = 1;
      this.resize();
      new ResizeObserver(() => { this.resize(); if (this.onChange) this.onChange(); }).observe(stage);
      this.bindInput();
    }

    resize() {
      const r = this.stage.getBoundingClientRect();
      this.dpr = Math.min(3, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      const W = this.world;
      const pad = 16;
      this.baseScale = Math.min((this.w - 2 * pad) / (W.maxX - W.minX || 1), (this.h - 2 * pad) / (W.maxY - W.minY || 1));
    }

    get scale() { return this.baseScale * this.zoom; }
    /** world -> css px */
    sx(x) { return this.w / 2 + this.pan.x + (x - (this.world.minX + this.world.maxX) / 2) * this.scale; }
    sy(y) { return this.h / 2 + this.pan.y - (y - (this.world.minY + this.world.maxY) / 2) * this.scale; }
    /** css px -> world */
    wx(px) { return (px - this.w / 2 - this.pan.x) / this.scale + (this.world.minX + this.world.maxX) / 2; }
    wy(py) { return -(py - this.h / 2 - this.pan.y) / this.scale + (this.world.minY + this.world.maxY) / 2; }

    bindInput() {
      const c = this.canvas;
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const wx = this.wx(mx), wy = this.wy(my);
        const f = Math.exp(-e.deltaY * 0.0015);
        this.zoom = Math.min(12, Math.max(0.5, this.zoom * f));
        // keep the point under the mouse fixed
        this.pan.x += mx - this.sx(wx);
        this.pan.y += my - this.sy(wy);
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

    drawBackground() {
      const g = this.ctx;
      if (this.image && this.imageRect) {
        const R = this.imageRect;
        const x0 = this.sx(R.minX), y0 = this.sy(R.maxY), x1 = this.sx(R.maxX), y1 = this.sy(R.minY);
        g.imageSmoothingEnabled = true;
        g.globalAlpha = 0.9;
        g.drawImage(this.image, x0, y0, x1 - x0, y1 - y0);
        g.globalAlpha = 1;
        return;
      }
      // neutral grid over the world rectangle
      const W = this.world;
      g.fillStyle = '#10151c';
      g.fillRect(this.sx(W.minX), this.sy(W.maxY), (W.maxX - W.minX) * this.scale, (W.maxY - W.minY) * this.scale);
      const step = 256;
      g.strokeStyle = 'rgba(120,140,160,0.10)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = Math.ceil(W.minX / step) * step; x <= W.maxX; x += step) { g.moveTo(this.sx(x), this.sy(W.minY)); g.lineTo(this.sx(x), this.sy(W.maxY)); }
      for (let y = Math.ceil(W.minY / step) * step; y <= W.maxY; y += step) { g.moveTo(this.sx(W.minX), this.sy(y)); g.lineTo(this.sx(W.maxX), this.sy(y)); }
      g.stroke();
      g.strokeStyle = 'rgba(120,140,160,0.35)';
      g.strokeRect(this.sx(W.minX), this.sy(W.maxY), (W.maxX - W.minX) * this.scale, (W.maxY - W.minY) * this.scale);
    }

    /** heatmap canvas covering world rect R */
    drawOverlay(canvas, R, alpha = 0.85) {
      const g = this.ctx;
      g.imageSmoothingEnabled = true;
      g.globalAlpha = alpha;
      g.drawImage(canvas, this.sx(R.minX), this.sy(R.maxY), (R.maxX - R.minX) * this.scale, (R.maxY - R.minY) * this.scale);
      g.globalAlpha = 1;
    }

    /** trail: array of [x, y] segments (each segment an array of points) with per-point age 0..1 */
    drawTrail(segments, color) {
      const g = this.ctx;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = 2;
      g.strokeStyle = color;
      for (const seg of segments) {
        for (let i = 1; i < seg.length; i++) {
          const a = seg[i - 1], b = seg[i];
          g.globalAlpha = Math.max(0.05, 1 - b[2]) * 0.9;     // fade out towards the old end
          g.beginPath();
          g.moveTo(this.sx(a[0]), this.sy(a[1]));
          g.lineTo(this.sx(b[0]), this.sy(b[1]));
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    }

    drawPlayer(p, color, opts) {
      const g = this.ctx;
      const x = this.sx(p.x), y = this.sy(p.y);
      const alpha = opts.alpha == null ? 1 : opts.alpha;
      g.globalAlpha = alpha;
      if (!opts.hollow) {
        // view cone from the yaw angle (0 = +x, counter-clockwise; screen y is flipped)
        const len = Math.max(18, CFG.VIEW_LENGTH * this.scale);
        const a = -p.yaw * Math.PI / 180, h = CFG.VIEW_HALF_ANGLE * Math.PI / 180;
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
        g.font = '600 11.5px "Segoe UI", system-ui, sans-serif';
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
      const X = this.sx(x), Y = this.sy(y), s = 6;
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
      g.moveTo(this.sx(points[0][0]), this.sy(points[0][1]));
      for (let i = 1; i < points.length; i++) g.lineTo(this.sx(points[i][0]), this.sy(points[i][1]));
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    drawCircle(x, y, radiusWorld, color, alpha, fill) {
      const g = this.ctx;
      const r = Math.max(3, radiusWorld * this.scale);
      g.globalAlpha = alpha;
      g.beginPath();
      g.arc(this.sx(x), this.sy(y), r, 0, Math.PI * 2);
      if (fill) { g.fillStyle = hexA(color, fill); g.fill(); }
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.stroke();
      g.globalAlpha = 1;
    }

    drawDot(x, y, color, alpha, r = 2.5) {
      const g = this.ctx;
      g.globalAlpha = alpha;
      g.fillStyle = color;
      g.beginPath();
      g.arc(this.sx(x), this.sy(y), r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  }

  function hexA(hex, a) {
    if (hex.startsWith('hsl')) return hex.replace('hsl(', 'hsla(').replace(')', ',' + a + ')');
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  C4.MapRenderer = MapRenderer;
  C4.hexA = hexA;
})(window.C4);
