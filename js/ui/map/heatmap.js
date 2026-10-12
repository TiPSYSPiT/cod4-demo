/* Map tab heatmap: data points per category (computed once per demo) and the heat raster.
 *
 *   C4.heatPoints.build(d, category) -> {n, t, x, y, cl, team, side}
 *     DOM-free; every point with its metadata, sorted by time. Phase "live" only (the scoreboard rule).
 *     cl -1 = no known causer (grenade without a thrower); x NaN = event without a known position.
 *   new C4.HeatLayer(rect)  - counts on a world grid (padded rect), blurred with a Gaussian of the
 *     radius (world units, so the spots scale with zoom and map), normalised to the maximum of the
 *     data shown and coloured blue -> cyan -> green -> yellow -> red with a transparent background.
 *
 * A float grid instead of radial gradients drawn into an 8-bit canvas: positions give 100,000+
 * points, an 8-bit alpha channel saturates long before that and the maximum would be wrong. The
 * Gaussian (three box blurs) is the same radial fall-off as a gradient stamp. */
(function (C4) {
  'use strict';
  const CFG = C4.mapConfig, H = CFG.HEAT;
  const PF = C4.collect.PF;

  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }
  const upperBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };

  /* ---------- data points ---------- */
  const TEAM = { A: 1, B: 2 }, SIDE = { attack: 1, defence: 2 };
  const LANDING = new Set(['frag', 'flash', 'concussion']);

  /** category: 'positions' | 'kills' | 'deaths' | 'landings' | 'smokes' | 'shots' */
  function build(d, category) {
    // [t, x, y, client, teamKey]; an event without a known position keeps x = NaN (counted, not drawn)
    const rows = [];
    const teamOf = new Map(d.players.map(p => [p.client, p.team]));
    const live = t => C4.rounds.phaseAt(d.phases, t) === 'live';
    const mw = d.meta.mapWindow || { start: 0, end: d.meta.durationMs };
    const inMap = t => t >= mw.start && t <= mw.end;
    /** the position of a living player at t: the last sample at most GAP_MS before, not dead */
    const posAt = (cl, t) => {
      const P = d.positions[cl]; if (!P) return null;
      const i = upperBound(P.t, t) - 1;
      if (i < 0 || t - P.t[i] > CFG.GAP_MS || (P.flags[i] & PF.DEAD)) return null;
      return [P.x[i], P.y[i]];
    };

    if (category === 'positions') {
      // living players, sampled every SAMPLE_MS from the live start of each round (no countdown),
      // so the snapshot rate and the data gaps do not weigh the result; no spectators
      const deaths = new Map();
      for (const k of d.kills) { if (!deaths.has(k.victim)) deaths.set(k.victim, []); deaths.get(k.victim).push(k.t); }
      for (const [clKey, P] of Object.entries(d.positions)) {
        const cl = +clKey, team = teamOf.get(cl);
        if (team !== 'A' && team !== 'B') continue;
        const dl = deaths.get(cl) || [];
        for (const r of d.rounds) {
          const a = r.start != null ? r.start : r.segStart, b = Math.min(r.segEnd, mw.end);
          let i = upperBound(P.t, a) - 1;
          for (let T = a; T < b; T += H.SAMPLE_MS) {
            while (i + 1 < P.t.length && P.t[i + 1] <= T) i++;
            if (i < 0 || P.t[i] < r.segStart || T - P.t[i] > CFG.GAP_MS || (P.flags[i] & PF.DEAD)) continue;
            // no position across a death (the sample belongs to the previous life)
            const j = upperBound(dl, P.t[i]);
            if (j < dl.length && dl[j] <= T) continue;
            if (!live(T)) continue;
            let x = P.x[i], y = P.y[i];
            if (i + 1 < P.t.length) {
              const t1 = P.t[i + 1], dx = P.x[i + 1] - x, dy = P.y[i + 1] - y;
              if (t1 - P.t[i] <= CFG.GAP_MS && Math.hypot(dx, dy) <= CFG.JUMP_UNITS && !(P.flags[i + 1] & PF.DEAD)) {
                const f = (T - P.t[i]) / (t1 - P.t[i]); x += dx * f; y += dy * f;
              }
            }
            rows.push([T, x, y, cl, team]);
          }
        }
      }
    } else if (category === 'kills' || category === 'deaths') {
      for (const k of d.kills) {
        if (k.phase !== 'live' || !inMap(k.t)) continue;
        const rule = C4.build.kdRule(k);
        if (category === 'kills') {
          // the killer's spot; no team kills, suicides, world or entity kills (the scoreboard rule)
          if (!rule.credit) continue;
          const p = k.attackerPos || [NaN, NaN];
          rows.push([k.t, p[0], p[1], k.attacker, k.attackerTeam || teamOf.get(k.attacker)]);
        } else {
          if (!rule.death) continue;
          const p = k.victimPos || [NaN, NaN];
          rows.push([k.t, p[0], p[1], k.victim, k.victimTeam || teamOf.get(k.victim)]);
        }
      }
    } else if (category === 'landings' || category === 'smokes') {
      // detonation points; the thrower is estimated (build.js, ≈) or unknown
      for (const g of d.grenades) {
        if (category === 'smokes' ? g.kind !== 'smoke' : !LANDING.has(g.kind)) continue;
        const det = g.detonation;
        if (!det || !live(det.t) || !inMap(det.t)) continue;
        const cl = g.thrower != null ? g.thrower : -1;
        rows.push([det.t, det.x, det.y, cl, cl >= 0 ? teamOf.get(cl) : null]);
      }
    } else if (category === 'shots') {
      // the shooter's position at every shot seen in the demo
      for (const [clKey, times] of Object.entries(d.shotsSeen || {})) {
        const cl = +clKey, team = teamOf.get(cl);
        for (const t of times) {
          if (!live(t) || !inMap(t)) continue;
          const p = posAt(cl, t) || [NaN, NaN];
          rows.push([t, p[0], p[1], cl, team]);
        }
      }
    }
    rows.sort((a, b) => a[0] - b[0]);
    const n = rows.length;
    const out = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), cl: new Int16Array(n),
      team: new Int8Array(n), side: new Int8Array(n) };
    // the side of the causer's team in the round of the point (sides swap at halftime: rounds.js r.sides)
    let ri = 0;
    for (let k = 0; k < n; k++) {
      const [t, x, y, cl, tk] = rows[k];
      out.t[k] = t; out.x[k] = x; out.y[k] = y; out.cl[k] = cl; out.team[k] = TEAM[tk] || 0;
      while (ri + 1 < d.rounds.length && d.rounds[ri + 1].segStart <= t) ri++;
      const r = d.rounds[ri];
      out.side[k] = r && t >= r.segStart && t <= r.segEnd && r.sides && TEAM[tk] ? SIDE[r.sides[tk]] || 0 : 0;
    }
    return out;
  }

  /** filter of one category: Uint8Array pass[] for team ('both' | 'A' | 'B'), side ('both' | 'attack' |
   *  'defence') and players (null = all, else a Set of clients) - always the causer of the point */
  function mask(pts, team, side, players) {
    const m = new Uint8Array(pts.n), tv = TEAM[team] || 0, sv = SIDE[side] || 0;
    for (let k = 0; k < pts.n; k++) {
      if (tv && pts.team[k] !== tv) continue;
      if (sv && pts.side[k] !== sv) continue;
      if (players && !players.has(pts.cl[k])) continue;
      m[k] = 1;
    }
    return m;
  }

  /* ---------- the raster ---------- */
  /** colour ramp blue -> cyan -> green -> yellow -> red as a 256 entry lookup table [r, g, b] */
  const LUT = (() => {
    const stops = H.STOPS, lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let s = 0; while (s + 1 < stops.length - 1 && stops[s + 1][0] < v) s++;
      const [v0, c0] = stops[s], [v1, c1] = stops[s + 1], f = Math.min(1, Math.max(0, (v - v0) / (v1 - v0 || 1)));
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
    }
    return lut;
  })();

  /** box sizes for a Gaussian of sigma with three box blurs (Kovesi / Kutskir) */
  function boxesForGauss(sigma, n) {
    const wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
  }
  /** one box blur pass along rows (stride 1) or columns (stride w); outside counts as 0 */
  function boxPass(src, dst, w, h, r, vertical) {
    const len = vertical ? h : w, lines = vertical ? w : h, step = vertical ? w : 1, inv = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const o = vertical ? l : l * w;
      let acc = 0;
      for (let x = 0; x < Math.min(r, len); x++) acc += src[o + x * step];
      for (let x = 0; x < len; x++) {
        if (x + r < len) acc += src[o + (x + r) * step];
        dst[o + x * step] = acc * inv;
        if (x - r >= 0) acc -= src[o + (x - r) * step];
      }
    }
  }

  class HeatLayer {
    constructor(world) {
      const pad = H.PAD;
      this.rect = { minX: world.minX - pad, maxX: world.maxX + pad, minY: world.minY - pad, maxY: world.maxY + pad };
      const w = this.rect.maxX - this.rect.minX, h = this.rect.maxY - this.rect.minY;
      this.cellSize = Math.max(w, h) / H.CELLS;
      this.cols = Math.max(8, Math.round(w / this.cellSize));
      this.rows = Math.max(8, Math.round(h / this.cellSize));
      const N = this.cols * this.rows;
      this.counts = new Float32Array(N);
      this.a = new Float32Array(N); this.b = new Float32Array(N);
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.cols; this.canvas.height = this.rows;
      this.img = this.canvas.getContext('2d').createImageData(this.cols, this.rows);
      this.invalidate();
    }
    /** forget the accumulated points (filters, range or category changed) */
    invalidate() { this.key = null; this.counts.fill(0); this.next = 0; this.until = -Infinity; this.n = 0; this.missing = 0; this.unattributed = 0; this.paintKey = null; }

    /**
     * add the points of pts that pass m with from <= t <= to (incremental while to grows; a key change
     * or a smaller `to` starts again) -> number of points drawn (this.missing: without a position,
     * this.unattributed: of those drawn without a known causer)
     */
    accumulate(key, pts, m, from, to) {
      if (key !== this.key || to < this.until) { this.invalidate(); this.key = key; this.next = lowerBound(pts.t, from); }
      const R = this.rect, cs = this.cellSize, cols = this.cols, rows = this.rows;
      let k = this.next;
      for (; k < pts.n && pts.t[k] <= to; k++) {
        if (!m[k]) continue;
        if (Number.isNaN(pts.x[k])) { this.missing++; continue; }
        const cx = Math.floor((pts.x[k] - R.minX) / cs), cy = Math.floor((R.maxY - pts.y[k]) / cs);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        this.counts[cy * cols + cx]++;
        this.n++;
        if (pts.cl[k] < 0) this.unattributed++;
      }
      if (k !== this.next) this.paintKey = null;
      this.next = k; this.until = to;
      return this.n;
    }

    /** blur (radius in world units) and colour -> the canvas covering this.rect */
    paint(radius, intensity) {
      const pk = radius + '|' + intensity;
      if (this.paintKey === pk) return this.canvas;
      this.paintKey = pk;
      const w = this.cols, h = this.rows;
      // the spot reaches about `radius`: sigma = radius / 2
      const sigma = Math.max(0.5, radius / this.cellSize / 2);
      // rows counts|b -> a, columns a -> b; the counts stay (they grow incrementally)
      let src = this.counts;
      for (const size of boxesForGauss(sigma, 3)) {
        const r = (size - 1) / 2;
        boxPass(src, this.a, w, h, r, false);
        boxPass(this.a, this.b, w, h, r, true);
        src = this.b;
      }
      const v = src;
      let max = 0;
      for (let i = 0; i < v.length; i++) if (v[i] > max) max = v[i];
      const px = this.img.data;
      px.fill(0);
      if (max > 0) {
        const lo = H.MIN_VALUE;
        for (let i = 0; i < v.length; i++) {
          if (!v[i]) continue;
          // normalised to the maximum of the data shown; sqrt so that rare spots stay visible;
          // Intensity is the gain
          const s = Math.min(1, intensity * Math.sqrt(v[i] / max));
          if (s < lo * 0.25) continue;
          const c = Math.round(s * 255) * 3, p = i * 4;
          px[p] = LUT[c]; px[p + 1] = LUT[c + 1]; px[p + 2] = LUT[c + 2];
          // low values only faintly visible, so the map stays readable
          const a = H.ALPHA_MIN + (H.ALPHA_MAX - H.ALPHA_MIN) * s;
          px[p + 3] = Math.round(255 * a * (s < lo ? s / lo : 1));
        }
      }
      this.canvas.getContext('2d').putImageData(this.img, 0, 0);
      this.max = max;
      return this.canvas;
    }
  }

  C4.heatPoints = { build, mask, LUT };
  C4.HeatLayer = HeatLayer;
  C4.lowerBound = lowerBound;
})(window.C4);
