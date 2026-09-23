/* Heatmap: dwell density of positions on a world grid, accumulated into an
 * offscreen canvas. Mode 'player' = one colour ramp for the selected players,
 * mode 'team' = two ramps (team A / team B) blended. */
(function (C4) {
  'use strict';
  const CFG = C4.mapConfig;

  class Heatmap {
    constructor(rect) {
      this.rect = rect;
      const w = rect.maxX - rect.minX, h = rect.maxY - rect.minY;
      const n = CFG.HEAT_CELLS;
      this.cols = w >= h ? n : Math.max(8, Math.round(n * w / h));
      this.rows = w >= h ? Math.max(8, Math.round(n * h / w)) : n;
      this.cell = { x: w / this.cols, y: h / this.rows };
      this.grids = { A: new Float32Array(this.cols * this.rows), B: new Float32Array(this.cols * this.rows) };
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.cols;
      this.canvas.height = this.rows;
      this.key = null;
      this.until = -1;
    }

    reset(key) {
      this.grids.A.fill(0);
      this.grids.B.fill(0);
      this.key = key;
      this.until = -1;
    }

    /** add samples of one player between t0 (exclusive) and t1 (inclusive), weighted by dwell time */
    add(pos, from, to, bucket) {
      const g = this.grids[bucket];
      const R = this.rect, cols = this.cols, rows = this.rows;
      const t = pos.t;
      let i = lowerBound(t, from + 1);
      for (; i < t.length && t[i] <= to; i++) {
        const dt = i + 1 < t.length ? Math.min(250, t[i + 1] - t[i]) : 50;
        const cx = Math.floor((pos.x[i] - R.minX) / this.cell.x), cy = Math.floor((R.maxY - pos.y[i]) / this.cell.y);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        g[cy * cols + cx] += dt;
      }
    }

    /** colourise into the offscreen canvas */
    paint(mode, colorA) {
      const ctx = this.canvas.getContext('2d');
      const img = ctx.createImageData(this.cols, this.rows);
      const A = this.grids.A, B = this.grids.B;
      let maxA = 0, maxB = 0;
      for (let i = 0; i < A.length; i++) { if (A[i] > maxA) maxA = A[i]; if (B[i] > maxB) maxB = B[i]; }
      const ca = mode === 'team' ? [255, 106, 61] : colorA || [255, 138, 31];
      const cb = [62, 168, 255];
      const lA = Math.log1p(maxA) || 1, lB = Math.log1p(maxB) || 1;
      for (let i = 0; i < A.length; i++) {
        const va = A[i] ? Math.log1p(A[i]) / lA : 0;
        const vb = mode === 'team' && B[i] ? Math.log1p(B[i]) / lB : 0;
        const a = Math.max(va, vb);
        if (!a) continue;
        const wa = va / (va + vb || 1), wb = 1 - wa;
        const p = i * 4;
        img.data[p] = ca[0] * wa + cb[0] * wb;
        img.data[p + 1] = ca[1] * wa + cb[1] * wb;
        img.data[p + 2] = ca[2] * wa + cb[2] * wb;
        img.data[p + 3] = Math.round(40 + 200 * a);
      }
      ctx.putImageData(img, 0, 0);
      return this.canvas;
    }
  }

  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  C4.Heatmap = Heatmap;
  C4.lowerBound = lowerBound;
})(window.C4);
