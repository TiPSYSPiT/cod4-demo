/* Playback clock (requestAnimationFrame) and the timeline slider with markers. */
(function (C4) {
  'use strict';

  class Playback {
    constructor(onFrame) {
      this.t = 0;
      this.range = [0, 1];
      this.playing = false;
      this.speed = 1;
      this.onFrame = onFrame;
      this.last = null;
      this.loop = this.loop.bind(this);
      this.dirty = true;
      this.active = false;
      this.skips = [];            // [[a, b), ...] intervals that are never shown (strat time / countdown)
      requestAnimationFrame(this.loop);
    }
    setRange(a, b) { this.range = [a, Math.max(a + 1, b)]; this.seek(this.t); }
    skipAt(t) {
      for (const s of this.skips) if (t >= s[0] && t < s[1]) return s;
      return null;
    }
    /** dir < 0: seeking backwards - a skipped interval is left towards its start
     * (end of the previous segment), otherwise towards its end (live start) */
    seek(t, dir) {
      const clamp = v => Math.min(this.range[1], Math.max(this.range[0], v));
      t = clamp(t);
      const s = this.skipAt(t);
      if (s) t = clamp(dir < 0 && s[0] - 1 >= this.range[0] ? s[0] - 1 : s[1]);
      this.t = t;
      this.dirty = true;
    }
    toggle() {
      if (!this.playing && this.t >= this.range[1] - 1) this.seek(this.range[0]);
      this.playing = !this.playing;
      this.last = null;
      this.dirty = true;
    }
    invalidate() { this.dirty = true; }
    loop(now) {
      // schedule first: an error in one frame must never stop the playback loop
      requestAnimationFrame(this.loop);
      try { this.step(now); } catch (err) { console.error('Map frame failed:', err); }
    }
    step(now) {
      if (this.playing && this.active) {
        if (this.last != null) {
          // cap the frame step: after a paused / hidden tab the clock must not leap
          this.t += Math.min(250, now - this.last) * this.speed;
          const s = this.skipAt(this.t);
          if (s) this.t = s[1];
          if (this.t >= this.range[1]) { this.t = this.range[1]; this.playing = false; }
          this.dirty = true;
        }
        this.last = now;
      } else this.last = null;
      if (this.dirty && this.active) { this.dirty = false; this.onFrame(this.t); }
    }
  }

  /** the timeline's colours: the CSS custom properties --tl-* (css/styles.css), read once per set() */
  function palette() {
    const cs = getComputedStyle(document.documentElement), v = (k, d) => cs.getPropertyValue(k).trim() || d;
    return { track: v('--tl-track', '#1f1f23'), seg: v('--tl-seg', '#2c2c31'), done: v('--tl-done', '#45454c'), live: v('--tl-live', '#5a5a62'),
      head: v('--tl-head', '#ffffff'), halo: v('--tl-halo', 'rgba(255,255,255,.18)'), bomb: v('--accent', '#ff8a1f'), defuse: v('--tl-defuse', '#5dd39e'),
      half: v('--muted', '#8d8d95'), sel: v('--tl-sel', 'rgba(255,255,255,.85)'), band: v('--tl-defuse', '#5dd39e') };
  }
  const PAD = 9;                   // room for the head at both ends of the bar (draw and pointer agree)

  class Timeline {
    /** markers: [{t, kind: 'seg' (t..t1, end: decided, color: winner) | 'kill' (color, up) | 'bomb' | 'defuse' | 'half'}] */
    constructor(container, onSeek) {
      this.box = container;
      this.canvas = document.createElement('canvas');
      // a slider for assistive technology (the keys: Space, ← / →, handled by the page)
      this.canvas.setAttribute('role', 'slider');
      this.canvas.setAttribute('tabindex', '0');
      this.canvas.setAttribute('aria-label', 'Timeline (← / → seek 5 s)');
      this.tip = document.createElement('div');
      this.tip.className = 'tl-tip';
      this.tip.setAttribute('aria-hidden', 'true');
      container.append(this.canvas, this.tip);
      this.onSeek = onSeek;
      this.range = [0, 1];
      this.markers = [];
      this.skips = [];
      this.base = 0;              // time shown as 00:00 (round view: live start of the round)
      this.t = 0;
      this.pal = palette();
      let down = false, lastAt = null;
      const at = e => {
        const r = this.canvas.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / Math.max(1, r.width - 2 * PAD)));
        return this.range[0] + f * (this.range[1] - this.range[0]);
      };
      this.canvas.addEventListener('pointerdown', e => { down = true; this.canvas.setPointerCapture(e.pointerId); lastAt = at(e); this.onSeek(lastAt, 0); });
      this.canvas.addEventListener('pointermove', e => {
        const t = at(e);
        if (down) { this.onSeek(t, Math.sign(t - lastAt)); lastAt = t; }
        this.canvas.title = C4.ui.fmtTime(t - this.base);
      });
      this.canvas.addEventListener('pointerup', () => { down = false; });
      new ResizeObserver(() => this.draw()).observe(container);
    }
    /** opts: {skips: [[a, b), ...] cut out of the bar, base: time shown as 00:00} */
    set(range, markers, opts) {
      this.range = range;
      this.markers = markers;
      this.skips = (opts && opts.skips) || [];
      this.base = (opts && opts.base) || 0;
      this.pal = palette();
      this.draw();
    }
    setTime(t) { this.t = t; this.draw(); }
    /** the range of a video export [a, b] (marked on the bar), or null */
    setBand(band) { this.band = band; this.draw(); }
    /** the user's export selection {a, b} (start / end markers, either may be null), or null */
    setSelection(sel) { this.selection = sel; this.draw(); }
    draw() {
      const r = this.box.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const W = Math.max(1, r.width), H = Math.max(1, r.height);
      if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
      const g = this.canvas.getContext('2d'), P = this.pal;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const [a, b] = this.range;
      const pad = PAD;
      const X = t => pad + (t - a) / (b - a) * (W - 2 * pad);
      const mid = Math.round(H / 2), now = this.t;
      const pill = (x0, x1, y, h, color) => {
        const w = Math.max(2, x1 - x0), rr = Math.min(h / 2, w / 2);
        g.fillStyle = color; g.beginPath();
        if (g.roundRect) g.roundRect(x0, y, w, h, rr); else g.rect(x0, y, w, h);
        g.fill();
      };
      // the track, the rounds as segments, the played part brighter
      pill(pad, W - pad, mid - 1, 2, P.track);
      const segs = this.markers.filter(m => m.kind === 'seg' && m.t1 > a && m.t < b);
      for (const m of segs) {
        const x0 = X(Math.max(a, m.t)) + 1, x1 = X(Math.min(b, m.t1)) - 1;
        const decided = now >= m.end, inside = now >= m.t && now < m.t1;
        pill(x0, x1, mid - 3, 6, inside ? P.live : decided || now >= m.t1 ? P.done : P.seg);
        if ((decided || now >= m.t1) && m.color) { g.fillStyle = m.color; g.fillRect(x0 + 1, mid + 1, Math.max(1, x1 - x0 - 2), 2); }
      }
      if (!segs.length) pill(pad, W - pad, mid - 3, 6, P.seg);
      // skipped intervals (strat time / countdown): cut out of the bar
      for (const [s0, s1] of this.skips) {
        if (s1 <= a || s0 >= b) continue;
        const x0 = X(Math.max(a, s0)), x1 = X(Math.min(b, s1));
        g.clearRect(x0, mid - 4, Math.max(1, x1 - x0), 8);
      }
      const xt = X(Math.min(b, Math.max(a, now)));
      const grad = g.createLinearGradient(pad, 0, xt, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(255,255,255,0.25)');
      if (xt > pad + 2) pill(pad, xt, mid - 3, 6, grad);
      // the export band (green frame) and the user's selection (brackets, a light band between them)
      if (this.band) {
        const x0 = X(Math.max(a, this.band[0])), x1 = X(Math.min(b, this.band[1]));
        g.globalAlpha = 0.18; g.fillStyle = P.band; g.fillRect(x0, 2, Math.max(2, x1 - x0), H - 4); g.globalAlpha = 1;
        g.strokeStyle = P.band; g.lineWidth = 1.5; g.strokeRect(x0 + 0.5, 2.5, Math.max(2, x1 - x0) - 1, H - 5);
      }
      const sel = this.selection;
      if (sel && (sel.a != null || sel.b != null)) {
        const xa = sel.a != null ? X(Math.min(b, Math.max(a, sel.a))) : null, xb = sel.b != null ? X(Math.min(b, Math.max(a, sel.b))) : null;
        if (xa != null && xb != null && xb > xa) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(xa, 3, xb - xa, H - 6); }
        g.strokeStyle = P.sel; g.lineWidth = 2;
        const bracket = (x, dir) => { g.beginPath(); g.moveTo(x + 5 * dir, 3); g.lineTo(x, 3); g.lineTo(x, H - 3); g.lineTo(x + 5 * dir, H - 3); g.stroke(); };
        if (xa != null) bracket(xa, 1);
        if (xb != null) bracket(xb, -1);
      }
      // kills as ticks (above / below the bar), future ones faint; halftimes; bomb plants and defuses
      for (const m of this.markers) {
        if (m.kind === 'seg' || m.t < a || m.t > b) continue;
        const x = X(m.t);
        g.globalAlpha = m.t > now ? 0.3 : 1;
        if (m.kind === 'kill') pill(x - 1, x + 1, m.up ? mid - 13 : mid + 7, 6, m.color);
        else if (m.kind === 'half') { g.globalAlpha = 1; g.fillStyle = P.half; g.fillRect(Math.round(x) - 0.5, mid - 8, 1, 16); }
        else { g.globalAlpha = m.t > now ? 0.55 : 1; pill(x - 3, x + 3, mid - 5, 10, m.kind === 'defuse' ? P.defuse : P.bomb); }
      }
      g.globalAlpha = 1;
      // the head: a white dot with a halo, the time above it (DOM tip)
      g.fillStyle = P.halo; g.beginPath(); g.arc(xt, mid, 9 + 4, 0, Math.PI * 2); g.fill();
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8; g.shadowOffsetY = 2;
      g.fillStyle = P.head; g.beginPath(); g.arc(xt, mid, 9, 0, Math.PI * 2); g.fill();
      g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
      const tip = C4.ui.fmtTime(Math.max(0, now - this.base));
      if (this.tip.textContent !== tip) {
        this.tip.textContent = tip;
        this.canvas.setAttribute('aria-valuetext', tip + ' of ' + C4.ui.fmtTime(Math.max(0, b - this.base)));
      }
      this.tip.style.left = Math.round(xt) + 'px';
    }
  }

  C4.Playback = Playback;
  C4.Timeline = Timeline;
})(window.C4);
