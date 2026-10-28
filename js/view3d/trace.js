/* Rays against the map's render world, for the bullet impacts the clients trace themselves (fx.js):
 * a bounding volume hierarchy over the world's triangles (median splits along the longest axis, up to
 * LEAF triangles per leaf), with the surface type of every triangle (world.json groups: the material's
 * surfaceTypeBits). The game traces against the collision model (brushes, terrain); the render
 * triangles are the same surfaces for walls, floors and terrain, but also include decals and some
 * detail the collision leaves out. Built on first use (about 0.2-0.5 s for 100-200k triangles). */

const LEAF = 8;

export class WorldTracer {
  /** positions: Float32Array xyz, index: Uint32Array (3 per triangle), surface: Uint8Array per triangle */
  constructor(positions, index, surface) {
    this.P = positions;
    this.I = index;
    this.S = surface;
    this.built = false;
  }

  build() {
    if (this.built) return;
    const n = this.I.length / 3, P = this.P, I = this.I;
    const tris = new Uint32Array(n);
    const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      tris[t] = t;
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      cx[t] = (P[a] + P[b] + P[c]) / 3; cy[t] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3; cz[t] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    }
    const maxNodes = 8 * Math.ceil(n / LEAF) + 64;
    const bmin = new Float32Array(3 * maxNodes), bmax = new Float32Array(3 * maxNodes);
    const child = new Int32Array(2 * maxNodes);         // inner: left, right; leaf: -1 - start, count
    let nodes = 0;
    const C = [cx, cy, cz];
    const stack = [[0, n, nodes++]];
    while (stack.length) {
      const [lo, hi, node] = stack.pop();
      // bounds of the triangles
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = lo; k < hi; k++) {
        const t = tris[k];
        for (let v = 0; v < 3; v++) {
          const o = 3 * I[3 * t + v];
          const x = P[o], y = P[o + 1], z = P[o + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
      }
      bmin[3 * node] = x0; bmin[3 * node + 1] = y0; bmin[3 * node + 2] = z0;
      bmax[3 * node] = x1; bmax[3 * node + 1] = y1; bmax[3 * node + 2] = z1;
      if (hi - lo <= LEAF) { child[2 * node] = -1 - lo; child[2 * node + 1] = hi - lo; continue; }
      // split at the median centroid along the longest axis (quickselect)
      const ex = [x1 - x0, y1 - y0, z1 - z0], ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2, c = C[ax];
      const mid = (lo + hi) >> 1;
      let l = lo, r = hi - 1;
      while (l < r) {
        const pivot = c[tris[(l + r) >> 1]];
        let i = l, j = r;
        while (i <= j) {
          while (c[tris[i]] < pivot) i++;
          while (c[tris[j]] > pivot) j--;
          if (i <= j) { const s = tris[i]; tris[i] = tris[j]; tris[j] = s; i++; j--; }
        }
        if (mid <= j) r = j; else if (mid >= i) l = i; else break;
      }
      const left = nodes++, right = nodes++;
      child[2 * node] = left; child[2 * node + 1] = right;
      stack.push([lo, mid, left], [mid, hi, right]);
    }
    this.tris = tris; this.bmin = bmin; this.bmax = bmax; this.child = child; this.nodes = nodes;
    this.built = true;
  }

  /** the first triangle hit from a towards b -> {frac, point, normal (facing a), surface} or null */
  trace(a, b) {
    this.build();
    const P = this.P, I = this.I, tris = this.tris, bmin = this.bmin, bmax = this.bmax, child = this.child;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = 1, hit = -1, hu = 0, hv = 0;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop();
      // slab test against the node's box; an axis the ray does not move along: the start inside the slab
      // (computed it would be 0 x Infinity = NaN for a ray in a box face - a vertical trace through a vertex
      // column of grid-aligned floors missed them)
      let t0 = 0, t1 = best, out = false;
      for (let k = 0; k < 3 && !out; k++) {
        const lo = bmin[3 * node + k], hi = bmax[3 * node + k];
        if (k === 0 ? dx === 0 : k === 1 ? dy === 0 : dz === 0) { out = a[k] < lo || a[k] > hi; continue; }
        const inv = k === 0 ? ix : k === 1 ? iy : iz;
        let ta = (lo - a[k]) * inv, tb = (hi - a[k]) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (out || !(t0 <= t1)) continue;
      const c0 = child[2 * node];
      if (c0 >= 0) { stack.push(child[2 * node + 1], c0); continue; }
      const start = -1 - c0, count = child[2 * node + 1];
      for (let k = start; k < start + count; k++) {
        const t = tris[k];
        const o0 = 3 * I[3 * t], o1 = 3 * I[3 * t + 1], o2 = 3 * I[3 * t + 2];
        // Möller-Trumbore, both sides
        const e1x = P[o1] - P[o0], e1y = P[o1 + 1] - P[o0 + 1], e1z = P[o1 + 2] - P[o0 + 2];
        const e2x = P[o2] - P[o0], e2y = P[o2 + 1] - P[o0 + 1], e2z = P[o2 + 2] - P[o0 + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        const sx = a[0] - P[o0], sy = a[1] - P[o0 + 1], sz = a[2] - P[o0 + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const f = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (f > 1e-6 && f < best) { best = f; hit = t; hu = u; hv = v; }
      }
    }
    if (hit < 0) return null;
    const o0 = 3 * I[3 * hit], o1 = 3 * I[3 * hit + 1], o2 = 3 * I[3 * hit + 2];
    const e1 = [P[o1] - P[o0], P[o1 + 1] - P[o0 + 1], P[o1 + 2] - P[o0 + 2]];
    const e2 = [P[o2] - P[o0], P[o2 + 1] - P[o0 + 1], P[o2 + 2] - P[o0 + 2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map(x => x / l);
    if (n[0] * dx + n[1] * dy + n[2] * dz > 0) n = n.map(x => -x);
    return { frac: best, point: [a[0] + dx * best, a[1] + dy * best, a[2] + dz * best], normal: n, surface: this.S ? this.S[hit] : 0, tri: hit, u: hu, v: hv };
  }
}
