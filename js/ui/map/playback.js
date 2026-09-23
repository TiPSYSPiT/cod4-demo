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

  class Timeline {
    /** markers: [{t, color, kind: 'kill'|'bomb'|'round'}] */
    constructor(container, onSeek) {
      this.box = container;
      this.canvas = document.createElement('canvas');
      container.append(this.canvas);
      this.onSeek = onSeek;
      this.range = [0, 1];
      this.markers = [];
      this.skips = [];
      this.base = 0;              // time shown as 00:00 (round view: live start of the round)
      this.t = 0;
      let down = false, lastAt = null;
      const at = e => {
        const r = this.canvas.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
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
    /** opts: {skips: [[a, b), ...] drawn dimmed, base: time shown as 00:00} */
    set(range, markers, opts) {
      this.range = range;
      this.markers = markers;
      this.skips = (opts && opts.skips) || [];
      this.base = (opts && opts.base) || 0;
      this.draw();
    }
    setTime(t) { this.t = t; this.draw(); }
    draw() {
      const r = this.box.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const W = Math.max(1, r.width), H = Math.max(1, r.height);
      if (this.canvas.width !== Math.round(W * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
      const g = this.canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const [a, b] = this.range;
      const X = t => (t - a) / (b - a) * W;
      const mid = H / 2;
      g.fillStyle = '#1f2530';
      g.fillRect(0, mid - 3, W, 6);
      g.fillStyle = 'rgba(255,138,31,0.55)';
      g.fillRect(0, mid - 3, X(this.t), 6);
      // skipped intervals (strat time / countdown): cut out of the bar
      g.fillStyle = 'rgba(0,0,0,0.7)';
      for (const [s0, s1] of this.skips) {
        if (s1 <= a || s0 >= b) continue;
        const x0 = X(Math.max(a, s0)), x1 = X(Math.min(b, s1));
        g.fillRect(x0, mid - 4, Math.max(1, x1 - x0), 8);
      }
      for (const m of this.markers) {
        if (m.t < a || m.t > b) continue;
        const x = X(m.t);
        if (m.kind === 'round') { g.fillStyle = 'rgba(200,210,225,0.45)'; g.fillRect(x - 0.5, 2, 1, H - 4); }
        else if (m.kind === 'bomb') { g.fillStyle = m.color; g.beginPath(); g.moveTo(x, mid - 12); g.lineTo(x + 5, mid - 5); g.lineTo(x - 5, mid - 5); g.closePath(); g.fill(); }
        else { g.fillStyle = m.color; g.fillRect(x - 1, mid + 5, 2, 9); }
      }
      const x = X(this.t);
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(x, mid, 6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#ff8a1f'; g.lineWidth = 2; g.stroke();
    }
  }

  C4.Playback = Playback;
  C4.Timeline = Timeline;
})(window.C4);
