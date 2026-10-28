/* The game's model lighting for players, weapons and props: the map's light grid
 * (tools/export/light_grid.py -> maps3d/<map>/lightgrid.bin) and the sun.
 *
 * The game lights a model with the light grid at its lighting origin (players: the origin; static
 * models: the centre of their bounds) - per grid point a cube of 56 colours that the shader looks up
 * with the vertex normal, trilinear between the 8 grid points around the origin
 * (rb_light.cpp R_LightGridLookup) - plus the sun (the primary light) where the grid point sees it.
 * The export reduces each cube to its six faces (+X, -X, +Y, -Y, +Z, -Z); here a normal blends
 * them by its squared components ("ambient cube"); the game's shaders (lp_*.hlsl) use the colours
 * x 2 and add sunDiffuse x visibility x N.L. Gamma-space math, like the game and the rest of the view.
 * Grid points the game checks with a sight trace are traced against the map's collision model
 * (SightModel, maps3d/<map>/sight.bin). Materials with a normal / specular map are lit per pixel and
 * reflect the map's reflection probes (ProbeSet, maps3d/<map>/probes.webp); the world gets the same
 * reflections, all after the game's own shaders (gameWorld). URL options: ?maps=off, ?reflections=off. */
import * as THREE from 'three';
import { fetchData, fetchBinary, dataUrl } from './data.js';

const GRID_SCALE = 2 / 255;            // light grid bytes -> lighting factor (as the lightmaps: x 2)
const OFFSET = 0x20000;

/** The world's sight-blocking collision (tools/export/sight.py -> maps3d/<map>/sight.bin): brushes
 *  and terrain triangles with contents & 0x2001, for the light grid's sight traces
 *  (CM_BoxSightTrace of a point, cm_trace.cpp). Indexed by a uniform grid of 128-unit xy cells. */
export class SightModel {
  static CELL = 128;

  static async load(dir, meta) {
    if (!meta) return null;
    return new SightModel(await fetchBinary(dir + meta.file), meta);
  }

  constructor(buf, meta) {
    this.meta = meta;
    const S = meta.sections, nb = meta.brushes, nt = meta.tris;
    this.brushes = new Float32Array(buf, S.brushes, nb * 8);              // mins, maxs, first, count (u32)
    this.brushPlanes = new Uint32Array(buf, S.brushes, nb * 8);
    this.planes = new Float32Array(buf, S.planes, meta.planes * 4);
    this.tris = new Float32Array(buf, S.tris, nt * 9);
    // item bounds (brushes: 0..nb-1, triangles: nb..)
    const n = nb + nt, B = this.bounds = new Float32Array(n * 6);
    for (let i = 0; i < nb; i++) for (let k = 0; k < 6; k++) B[i * 6 + k] = this.brushes[i * 8 + k];
    for (let i = 0; i < nt; i++) {
      const T = this.tris, o = i * 9, b = (nb + i) * 6;
      for (let k = 0; k < 3; k++) {
        B[b + k] = Math.min(T[o + k], T[o + 3 + k], T[o + 6 + k]);
        B[b + 3 + k] = Math.max(T[o + k], T[o + 3 + k], T[o + 6 + k]);
      }
    }
    // uniform xy grid
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, B[i * 6]); y0 = Math.min(y0, B[i * 6 + 1]);
      x1 = Math.max(x1, B[i * 6 + 3]); y1 = Math.max(y1, B[i * 6 + 4]);
    }
    const C = SightModel.CELL;
    this.x0 = Math.floor(x0 / C); this.y0 = Math.floor(y0 / C);
    this.nx = Math.max(1, Math.floor(x1 / C) - this.x0 + 1); this.ny = Math.max(1, Math.floor(y1 / C) - this.y0 + 1);
    const counts = new Uint32Array(this.nx * this.ny + 1);
    const each = (i, f) => {
      const cx0 = Math.floor(B[i * 6] / C) - this.x0, cx1 = Math.floor(B[i * 6 + 3] / C) - this.x0;
      const cy0 = Math.floor(B[i * 6 + 1] / C) - this.y0, cy1 = Math.floor(B[i * 6 + 4] / C) - this.y0;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) f(cy * this.nx + cx);
    };
    for (let i = 0; i < n; i++) each(i, c => counts[c + 1]++);
    for (let c = 0; c < this.nx * this.ny; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.items = new Uint32Array(counts[this.nx * this.ny]);
    const fill = counts.slice(0, this.nx * this.ny);
    for (let i = 0; i < n; i++) each(i, c => { this.items[fill[c]++] = i; });
    this.stamp = new Uint32Array(n);
    this.stampNow = 0;
    this.traces = 0;
  }

  /** true when the segment a -> b (arrays of 3) is blocked (CM_BoxSightTrace(...) != 0) */
  blocked(a, b) {
    this.traces++;
    const C = SightModel.CELL, B = this.bounds, nb = this.meta.brushes;
    const lo0 = Math.min(a[0], b[0]), lo1 = Math.min(a[1], b[1]), lo2 = Math.min(a[2], b[2]);
    const hi0 = Math.max(a[0], b[0]), hi1 = Math.max(a[1], b[1]), hi2 = Math.max(a[2], b[2]);
    const cx0 = Math.max(0, Math.floor(lo0 / C) - this.x0), cx1 = Math.min(this.nx - 1, Math.floor(hi0 / C) - this.x0);
    const cy0 = Math.max(0, Math.floor(lo1 / C) - this.y0), cy1 = Math.min(this.ny - 1, Math.floor(hi1 / C) - this.y0);
    if (++this.stampNow === 0xFFFFFFFF) { this.stamp.fill(0); this.stampNow = 1; }
    const now = this.stampNow;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * this.nx + cx;
      for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
        const i = this.items[k];
        if (this.stamp[i] === now) continue;
        this.stamp[i] = now;
        const o = i * 6;
        if (B[o] > hi0 || B[o + 3] < lo0 || B[o + 1] > hi1 || B[o + 4] < lo1 || B[o + 2] > hi2 || B[o + 5] < lo2) continue;
        if (i < nb ? this.brushHit(i, a, b) : this.triHit(i - nb, a, b)) return true;
      }
    }
    return false;
  }

  /** CM_SightTraceThroughBrush for a point trace: the segment against the brush's box and side planes */
  brushHit(i, a, b) {
    const R = this.brushes, o = i * 8;
    let enter = 0, leave = 1;
    const clip = (d1, d2) => {                    // d = signed distance outside the plane
      if (d1 > 0) {
        if (d2 > 0) return false;
        const f = d1 / (d1 - d2);
        if (f > enter) enter = f;
      } else if (d2 > 0) {
        const f = d1 / (d1 - d2);
        if (f < leave) leave = f;
      }
      return leave > enter;
    };
    for (let j = 0; j < 3; j++) {
      if (!clip(R[o + j] - a[j], R[o + j] - b[j])) return false;               // mins
      if (!clip(a[j] - R[o + 3 + j], b[j] - R[o + 3 + j])) return false;       // maxs
    }
    const P = this.planes, first = this.brushPlanes[o + 6], count = this.brushPlanes[o + 7];
    for (let k = first; k < first + count; k++) {
      const p = k * 4, d = P[p + 3];
      if (!clip(a[0] * P[p] + a[1] * P[p + 1] + a[2] * P[p + 2] - d, b[0] * P[p] + b[1] * P[p + 1] + b[2] * P[p + 2] - d)) return false;
    }
    return true;
  }

  /** CM_TracePointThroughTriangle (one-sided: only from the front) */
  triHit(i, a, b) {
    const T = this.tris, o = i * 9;
    const v0x = T[o], v0y = T[o + 1], v0z = T[o + 2];
    const e1x = v0x - T[o + 3], e1y = v0y - T[o + 4], e1z = v0z - T[o + 5];       // v0 - v1
    const e2x = v0x - T[o + 6], e2y = v0y - T[o + 7], e2z = v0z - T[o + 8];       // v0 - v2
    const nx = e2y * e1z - e2z * e1y, ny = e2z * e1x - e2x * e1z, nz = e2x * e1y - e2y * e1x;   // e2 x e1
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const proj = dx * nx + dy * ny + dz * nz;
    if (!(proj < 0)) return false;
    const sx = v0x - a[0], sy = v0y - a[1], sz = v0z - a[2];
    const t = sx * nx + sy * ny + sz * nz;
    if (!(t <= 0 && t > proj)) return false;
    const tx = dy * sz - dz * sy, ty = dz * sx - dx * sz, tz = dx * sy - dy * sx;   // delta x (v0 - start)
    const v = tx * e1x + ty * e1y + tz * e1z;
    if (!(v <= 0 && proj <= v)) return false;
    const negU = tx * e2x + ty * e2y + tz * e2z;
    return negU >= 0 && proj <= v - negU;
  }
}

// the 56 colours of a grid entry -> texel of the 4 x 4 x 4 block (x, y, z = world x, y, z; index 3 the
// positive side), R_SetLightGridColors; the inner texels (never sampled) as the game fills them
const BLOCK_OF = (() => {
  const t = new Int8Array(64).fill(-1);
  const put = (x, y, z, c) => { t[z * 16 + y * 4 + x] = c; };
  for (let k = 0; k < 16; k++) put(k % 4, k >> 2, 0, k);
  for (let k = 0; k < 16; k++) put(k % 4, k >> 2, 3, 40 + k);
  const ring = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1], [0, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3]];
  ring.forEach(([x, y], k) => { put(x, y, 1, 16 + k); put(x, y, 2, 28 + k); });
  put(1, 1, 1, 0); put(2, 1, 1, 3); put(1, 2, 1, 12); put(2, 2, 1, 15);
  put(1, 1, 2, 40); put(2, 1, 2, 43); put(1, 2, 2, 52); put(2, 2, 2, 55);
  return t;
})();
// the six faces (+X, -X, +Y, -Y, +Z, -Z) as means of their 16 texels (the export's ambient cube)
const FACE_TEXELS = [[3, 0], [0, 0], [3, 1], [0, 1], [3, 2], [0, 2]].map(([i, axis]) => {
  const list = [];
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    if ([x, y, z][axis] === i) list.push(BLOCK_OF[z * 16 + y * 4 + x]);
  }
  return list;
});

export class LightGrid {
  /** dir: maps3d/<map>/, meta: world.json "lightGrid", sight: world.json "sight" (optional: without
   *  it, flagged grid points count as blocked), lights: world.json "lights" (the primary lights)
   *  -> LightGrid or null */
  static async load(dir, meta, sight = null, lights = null) {
    if (!meta) return null;
    const warn = what => err => { console.warn(what + ' not loaded:', err.message); return null; };
    const [buf, s, colors] = await Promise.all([fetchBinary(dir + meta.file), SightModel.load(dir, sight).catch(warn('sight model')),
      meta.colors ? loadColors(dir + meta.colors.file, meta.colors).catch(warn('light grid colours')) : null]);
    return new LightGrid(buf, meta, s, lights, colors);
  }

  constructor(buf, meta, sight = null, lights = null, colors = null) {
    this.meta = meta;
    this.sight = sight;
    this.lights = lights || [];
    this.colors = colors;                      // Uint8Array, 168 bytes (56 rgb) per palette entry
    this.useSight = true;                      // false: flagged points count as blocked (comparison)
    this.sunIndex = meta.format >= 2 ? meta.sunIndex : 1;
    const S = meta.sections;
    const C = new DataView(buf, S.columns, meta.columns * 12);
    this.columns = new Map();                     // (x << 16 | y) -> [z0, count, first point]
    for (let i = 0; i < meta.columns; i++) {
      const o = i * 12;
      this.columns.set(C.getUint16(o, true) * 65536 + C.getUint16(o + 2, true),
        [C.getUint16(o + 4, true), C.getUint16(o + 6, true), C.getUint32(o + 8, true)]);
    }
    this.points = new DataView(buf, S.points, meta.points * 4);
    this.palette = new Uint8Array(buf, S.palette, meta.palette * 18);
    this.acc = new Float32Array(168);
  }

  /** [palette index, primary light index, needsTrace bits] of grid point (x, y, z), or null */
  point(x, y, z) {
    const c = this.columns.get(x * 65536 + y);
    if (!c || z < c[0] || z >= c[0] + c[1]) return null;
    const o = (c[2] + z - c[0]) * 4, pi = this.points.getUint16(o, true);
    if (pi === 0xFFFF) return null;
    let light = this.points.getUint8(o + 2);
    if (!(this.meta.format >= 2)) light = light === 255 ? this.sunIndex : 0;      // format 1: a sun flag
    return [pi, light, this.points.getUint8(o + 3)];
  }

  /** can primary light `light` reach grid corner c of the sample (R_CanLightInfluenceLightGridCorner,
   *  Com_CanPrimaryLightAffectPoint; the game takes the corner's z from the sample's x - kept) */
  canInfluence(li, x, y, c) {
    const L = this.lights[li];
    if (!L || L.type === 1) return true;
    const p = [Math.floor(x / 32) * 32, Math.floor(y / 32) * 32, Math.floor(x / 64) * 64];
    const ra = this.meta.rowAxis, ca = this.meta.colAxis;
    if (c & 4) p[ra] += 32;
    if (c & 2) p[ca] += 32;
    if (c & 1) p[2] += 64;
    const d = [L.origin[0] - p[0], L.origin[1] - p[1], L.origin[2] - p[2]];
    const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (d2 >= L.radius * L.radius) return false;
    if (L.type === 3 || L.rotationLimit <= -L.cosOuter) return true;
    const dot = d[0] * L.dir[0] + d[1] * L.dir[1] + d[2] * L.dir[2];
    const cos = L.rotationLimit === 1 ? L.cosOuter : L.cosExpanded;
    return dot >= cos * Math.sqrt(d2);
  }

  /** the model lighting at a world point, as the game computes it (R_LightGridLookup):
   *    out.block  Uint8Array(256): the 4 x 4 x 4 RGBA block (56 colours blended over the usable
   *               corners, alpha = the primary light's visibility) - needs the full colours
   *    out.light  the primary light (index into the map's lights; 0 none), out.vis its visibility
   *    out.cube   Float32Array(18): the six faces x 2 / 255 (lighting factors), out.sun the sun's share
   *  false when no grid point is near and the grid has no defaults */
  sample(x, y, z, out) {
    const fx = (Math.floor(x) + OFFSET) / 32, fy = (Math.floor(y) + OFFSET) / 32, fz = (Math.floor(z) + OFFSET) / 64;
    const px = Math.floor(fx), py = Math.floor(fy), pz = Math.floor(fz);
    const ax = fx - px, ay = fy - py, az = fz - pz;
    // the 8 corners in the game's order (bit 0: z, bit 1: column axis, bit 2: row axis). A corner
    // whose point is flagged "needsTrace" for that corner is suppressed when the sight trace from the
    // sample to the point (nudged 0.01 towards the sample) is blocked (R_IsValidLightGridSample);
    // suppressed corners before the first usable one are kept until a usable one appears
    // (R_GetLightGridSampleEntryQuad), which also picks the primary light.
    const rowX = this.meta.rowAxis === 0, corners = [];
    const sight = this.useSight ? this.sight : null, S = [x, y, z], G = [0, 0, 0];
    let honor = false, below = false, primary = 0, best = 0;
    out.traces = 0; out.suppressed = 0;
    for (let c = 0; c < 8; c++) {
      const dz = c & 1, dcol = (c >> 1) & 1, drow = (c >> 2) & 1;
      const dx = rowX ? drow : dcol, dy = rowX ? dcol : drow;
      const w = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az);
      const col = this.columns.get((px + dx) * 65536 + py + dy);
      if (col && pz + dz < col[0]) below = true;
      const pt = this.point(px + dx, py + dy, pz + dz);
      if (!pt || w < 1e-6) continue;
      let suppress = false;
      if (pt[2] & (1 << c)) {
        if (sight) {
          G[0] = (px + dx) * 32 - OFFSET; G[1] = (py + dy) * 32 - OFFSET; G[2] = (pz + dz) * 64 - OFFSET;
          const tx = S[0] - G[0], ty = S[1] - G[1], tz = S[2] - G[2], l = Math.hypot(tx, ty, tz) || 1;
          G[0] += 0.01 * tx / l; G[1] += 0.01 * ty / l; G[2] += 0.01 * tz / l;
          out.traces++;
          suppress = sight.blocked(S, G);
        } else suppress = true;
      }
      if (suppress) { out.suppressed++; if (honor) continue; }
      else if (!honor) { honor = true; corners.length = 0; best = w; primary = pt[1]; corners.push([pt, w, c]); continue; }
      const li = pt[1];
      const take = primary ? (li !== 0 && (primary === 255 || (li !== 255 && w > best))) : true;
      if (take) { best = w; primary = li; }
      corners.push([pt, w, c]);
    }
    // visibility of the primary light: its corners against the corners it could reach but does not
    let total = 0, visible = 0, occluded = 0;
    for (const [pt, w, c] of corners) {
      total += w;
      if (pt[1] === primary) visible += w;
      else if ((!pt[1] || (pt[1] === 255 && primary)) && primary && this.canInfluence(primary, x, y, c)) occluded += w;
    }
    let vis = !primary ? 0 : occluded === 0 ? (visible ? 1 : 0) : visible / (visible + occluded);
    out.source = total >= 1e-4 ? 'grid' : below ? 'below' : 'default';
    let list = corners;
    if (total < 1e-4) {
      // no grid point around: the game's default colours (R_ExtrapolateLightingAtPoint) - below the
      // grid colour set 0, elsewhere (above it, open sky) colour set 1, both with full sun
      if (this.meta.palette < 2) return false;
      list = [[[below ? 0 : 1, this.sunIndex, 0], 1, 0]];
      total = 1; primary = this.sunIndex; vis = 1;
    }
    out.light = primary === 255 ? 0 : primary;
    out.vis = out.light ? vis : 0;
    out.sun = out.light === this.sunIndex ? vis : 0;
    // the colours: blended over the corners by weight
    const cube = out.cube || (out.cube = new Float32Array(18));
    if (this.colors) {
      const acc = this.acc; acc.fill(0);
      for (const [pt, w] of list) {
        const o = pt[0] * 168, f = w / total;
        for (let k = 0; k < 168; k++) acc[k] += this.colors[o + k] * f;
      }
      const block = out.block || (out.block = new Uint8Array(256));
      const a = Math.round(out.vis * 255);
      for (let t = 0; t < 64; t++) {
        const c = BLOCK_OF[t] * 3;
        block[4 * t] = Math.round(acc[c]); block[4 * t + 1] = Math.round(acc[c + 1]); block[4 * t + 2] = Math.round(acc[c + 2]);
        block[4 * t + 3] = a;
      }
      FACE_TEXELS.forEach((tex, f) => {
        for (let j = 0; j < 3; j++) { let s = 0; for (const c of tex) s += acc[c * 3 + j]; cube[f * 3 + j] = s / tex.length * GRID_SCALE; }
      });
    } else {
      cube.fill(0);
      for (const [pt, w] of list) { const p = pt[0] * 18; for (let k = 0; k < 18; k++) cube[k] += this.palette[p + k] * w / total; }
      for (let k = 0; k < 18; k++) cube[k] *= GRID_SCALE;
      out.block = null;
    }
    return true;
  }
}

/** the full 56 colours of the palette (lightgrid_colors.webp, lossless) -> Uint8Array, 168 bytes per entry */
async function loadColors(url, meta) {
  const r = await fetchData(url);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const cx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  cx.drawImage(bmp, 0, 0);
  const px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
  const per = meta.perRow || 1, out = new Uint8Array(meta.entries * 168);
  for (let e = 0; e < meta.entries; e++) {
    const row = Math.floor(e / per), x0 = (e % per) * 56;
    for (let k = 0; k < 56; k++) {
      const i = (row * bmp.width + x0 + k) * 4;
      out[e * 168 + 3 * k] = px[i]; out[e * 168 + 3 * k + 1] = px[i + 1]; out[e * 168 + 3 * k + 2] = px[i + 2];
    }
  }
  return out;
}

/** the sun of the current map: colour (x sunLight) and the direction towards it (world space);
 *  shared by all grid-lit materials */
export const SUN = { color: { value: new THREE.Color(1, 1, 1) }, dir: { value: new THREE.Vector3(0, 0, 1) }, shadow: { value: 0 } };

/** the reflection probes of the current map (ProbeSet): an atlas of their cube faces; shared by all
 *  materials with a specular map. on: 0 = no reflections (no probes, or switched off) */
export const PROBES = { atlas: { value: null }, count: { value: 1 }, on: { value: 0 } };

/** The map's reflection probes (tools/export/export_maps.py -> maps3d/<map>/probes.webp): per probe
 *  one row of its six 64 x 64 cube faces in the game's order (+X, -X, +Y, -Y, +Z, -Z), read with the
 *  D3D face conventions and the world direction (measured: tools/probes/orient.html); the DPVS cell
 *  tree with each cell's probes (cells.bin) for the probe of moving models. */
export class ProbeSet {
  /** dir: maps3d/<map>/, meta: world.json "probes"; texture: false = only the probe choice (validator) */
  static async load(dir, meta, { texture = true } = {}) {
    if (!meta || !meta.count) return null;
    let tex = null, cells = null;
    const cellsReady = meta.cells ? fetchBinary(dir + meta.cells.file).catch(err => { console.warn('probe cells not loaded:', err.message); return null; }) : null;
    if (texture) {
      tex = await new THREE.TextureLoader().loadAsync(dataUrl(dir + meta.file));
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;               // faces are 64-aligned: the mips never mix two faces
      tex.needsUpdate = true;
    }
    if (cellsReady) cells = await cellsReady;
    return new ProbeSet(tex, meta, cells);
  }
  constructor(tex, meta, cellsBuf = null) {
    this.texture = tex; this.meta = meta; this.origins = meta.origins;
    const C = meta.cells;
    if (cellsBuf && C) {
      const S = C.sections;
      this.nodes = new Uint16Array(cellsBuf, S.nodes, C.nodeCount);
      this.planes = new Float32Array(cellsBuf, S.planes, C.planeCount * 4);
      this.starts = new Uint16Array(cellsBuf, S.starts, C.cellCount + 1);
      this.lists = new Uint8Array(cellsBuf, S.lists, cellsBuf.byteLength - S.lists);
      this.cellCount = C.cellCount;
    }
  }
  /** use for all materials (PROBES) */
  activate(on = true) {
    PROBES.atlas.value = this.texture;
    PROBES.count.value = this.meta.count;
    PROBES.on.value = on ? 1 : 0;
  }
  /** the DPVS cell of a point (R_CellForPoint): index, or -1 outside every cell / no cell tree */
  cellAt(x, y, z) {
    const N = this.nodes, P = this.planes, cc = this.cellCount;
    if (!N) return -1;
    let i = 0;
    for (let guard = 0; guard < 4096; guard++) {
      const v = N[i];
      if (v < cc + 1) return v - 1;
      const p = (v - cc - 1) * 4;
      i += x * P[p] + y * P[p + 1] + z * P[p + 2] - P[p + 3] <= 0 ? N[i + 1] : 2;
    }
    return -1;
  }
  /** the probe of a moving model, as the game picks it (R_CalcReflectionProbeIndex): the nearest probe
   *  of the cell the point is in; outside every cell the nearest probe of all (from probe 1 on -
   *  probe 0 is the game's empty default). out (optional): out.cell = the cell or -1 */
  nearest(x, y, z, out = null) {
    const c = this.cellAt(x, y, z);
    if (out) out.cell = c;
    let best = 0, bestD = Infinity;
    const test = k => {
      const o = this.origins[k];
      if (!o) return;
      const d = (o[0] - x) ** 2 + (o[1] - y) ** 2 + (o[2] - z) ** 2;
      if (bestD > d) { bestD = d; best = k; }
    };
    if (c >= 0) for (let j = this.starts[c]; j < this.starts[c + 1]; j++) test(this.lists[j]);
    else for (let k = 1; k < this.origins.length; k++) test(k);
    return best;
  }
}

/** the map's primary lights for the shaders (setLights): a float texture with a row of 4 texels per
 *  light (position, 1 / radius; colour, type; spot direction, spot scale; spot bias, exponent), the
 *  falloff ramps (a row of 32 per light), the sun's index; at most LG_MAX_LIGHTS (mp_carentan: 50) */
export const LG_MAX_LIGHTS = 255;
export const LIGHTS = {
  data: { value: null }, falloff: { value: null }, count: { value: 1 }, sunIndex: { value: 1 },
};
/** world.json "lights" -> LIGHTS (R_SetLightProperties: lightPosition.w = 1 / radius, lightDiffuse =
 *  lightSpecular = colour, spot factors: scale = 1 / (cosInner - cosOuter), bias = -scale x cosOuter,
 *  the light def's exponent) */
export function setLights(lights, sunIndex) {
  const n = Math.min(LG_MAX_LIGHTS, (lights || []).length || 1);
  const D = new Float32Array(16 * n);
  const ramp = new Uint8Array(32 * n * 4);
  (lights || []).slice(0, n).forEach((L, k) => {
    if (!L || L.type < 2) return;
    const scale = L.cosInner > L.cosOuter ? 1 / (L.cosInner - L.cosOuter) : 1e4;
    D.set([L.origin[0], L.origin[1], L.origin[2], L.radius > 0 ? 1 / L.radius : 0,
           L.color[0], L.color[1], L.color[2], L.type,
           L.dir[0], L.dir[1], L.dir[2], scale,
           -scale * L.cosOuter, L.exponent || 0, 0, 0], k * 16);
    const f = L.falloff || Array.from({ length: 32 }, (_, i) => (1 - i / 31) ** 2);
    for (let i = 0; i < 32; i++) { const v = Math.round(255 * f[Math.min(f.length - 1, i)]); ramp.set([v, v, v, 255], (k * 32 + i) * 4); }
  });
  const tex = new THREE.DataTexture(ramp, 32, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  if (LIGHTS.falloff.value) LIGHTS.falloff.value.dispose();
  LIGHTS.falloff.value = tex;
  const data = new THREE.DataTexture(D, 4, n, THREE.RGBAFormat, THREE.FloatType);
  data.magFilter = data.minFilter = THREE.NearestFilter;
  data.needsUpdate = true;
  if (LIGHTS.data.value) LIGHTS.data.value.dispose();
  LIGHTS.data.value = data;
  LIGHTS.count.value = n;
  LIGHTS.sunIndex.value = sunIndex != null ? sunIndex : 1;
}
/** the effects' dynamic lights (fx.js: the omniLight elements of fires and explosions,
 *  R_AddOmniLightToScene): up to DL_MAX omni lights, light def "light_dynamic" = the falloff_linear
 *  ramp; added like the game's light pass (l_omni_*): colour x falloff(distance / radius) x sat(N.L),
 *  no shadow */
export const DL_MAX = 4;
export const DLIGHTS = {
  pos: { value: Array.from({ length: DL_MAX }, () => new THREE.Vector4(0, 0, 0, 0)) },     // xyz, 1 / radius
  color: { value: Array.from({ length: DL_MAX }, () => new THREE.Vector3()) },
  count: { value: 0 },
  ramp: { value: new Float32Array(32).map((_, i) => 1 - i / 31) },                       // falloff_linear
};
const DLIGHT_GLSL = `
#define DL_MAX ${DL_MAX}
uniform vec4 uDlPos[DL_MAX];
uniform vec3 uDlColor[DL_MAX];
uniform int uDlCount;
uniform float uDlRamp[32];
vec3 lgDynamic(vec3 P, vec3 N) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < DL_MAX; i++) {
    if (i >= uDlCount) break;
    vec3 D = uDlPos[i].xyz - P;
    float dist = length(D);
    float t = clamp(dist * uDlPos[i].w, 0.0, 1.0) * 31.0;
    int k = int(floor(t));
    float fall = mix(uDlRamp[k], uDlRamp[min(k + 1, 31)], t - float(k));
    sum += uDlColor[i] * fall * clamp(dot(N, D / max(dist, 0.001)), 0.0, 1.0);
  }
  return sum;
}
`;
function lightUniforms(shader) {
  shader.uniforms.uDlPos = DLIGHTS.pos;
  shader.uniforms.uDlColor = DLIGHTS.color;
  shader.uniforms.uDlCount = DLIGHTS.count;
  shader.uniforms.uDlRamp = DLIGHTS.ramp;
  shader.uniforms.uLgLightData = LIGHTS.data;
  shader.uniforms.uLgFalloff = LIGHTS.falloff;
  shader.uniforms.uLgLightCount = LIGHTS.count;
  shader.uniforms.uLgSunIndex = LIGHTS.sunIndex;
  shader.uniforms.uLgSunColor = SUN.color;
  shader.uniforms.uLgSunDir = SUN.dir;
}

/** GLSL shared by the world and the models, after the game's own shaders (lm_*.hlsl / lp_*.hlsl in the
 *  fast files, read with tools/export/d3dshader.py; docs/findings.md) */
const LIGHTS_GLSL = `
uniform highp sampler2D uLgLightData;
uniform sampler2D uLgFalloff;
uniform float uLgLightCount;
uniform float uLgSunIndex;
uniform vec3 uLgSunColor;
uniform vec3 uLgSunDir;
// primary light k at world point P: L = direction to the light, C = its colour x attenuation (the
// sun: sunDiffuse; a lamp: lightDiffuse x falloff ramp(distance / radius) x spot cone - lm_spot_*);
// 0 when there is none
float lgPrimary(float k, vec3 P, out vec3 L, out vec3 C) {
  L = vec3(0.0, 0.0, 1.0); C = vec3(0.0);
  if (k < 0.5) return 0.0;
  if (abs(k - uLgSunIndex) < 0.5) { L = uLgSunDir; C = uLgSunColor; return 1.0; }
  int i = int(k + 0.5);
  if (k >= uLgLightCount) return 0.0;
  vec4 a = texelFetch(uLgLightData, ivec2(0, i), 0), b = texelFetch(uLgLightData, ivec2(1, i), 0),
       c = texelFetch(uLgLightData, ivec2(2, i), 0), d = texelFetch(uLgLightData, ivec2(3, i), 0);
  if (b.w < 1.5) return 0.0;
  vec3 D = a.xyz - P;
  float dist = length(D);
  L = D / max(dist, 0.001);
  float t = clamp(dist * a.w, 0.0, 1.0);
  float fall = textureLod(uLgFalloff, vec2((t * 31.0 + 0.5) / 32.0, (k + 0.5) / uLgLightCount), 0.0).r;
  float spot = 1.0;
  if (b.w < 2.5) {                                                  // spot (type 2); omni (3): none
    float s = clamp(dot(L, c.xyz) * c.w + d.x, 0.0, 1.0);
    spot = s > 0.0 ? pow(s, d.y) : 0.0;
  }
  C = b.rgb * fall * spot;
  return 1.0;
}
${DLIGHT_GLSL}`;

export const SURFACE_GLSL = `
uniform sampler2D uProbeAtlas;
uniform float uProbeCount;
uniform float uProbeOn;
${LIGHTS_GLSL}
// a probe's cube read with the D3D face conventions (s right, t down) and the world direction; the
// game's value: rgb x alpha of its RGBM texels = the decoded colour / 4 (probes.webp holds colour / 2)
vec3 lgProbe(vec3 c, float probe, float lod) {
  vec3 a = abs(c);
  float ma, sc, tc, f;
  if (a.x >= a.y && a.x >= a.z) { ma = a.x; if (c.x > 0.0) { f = 0.0; sc = -c.z; tc = -c.y; } else { f = 1.0; sc = c.z; tc = -c.y; } }
  else if (a.y >= a.z) { ma = a.y; if (c.y > 0.0) { f = 2.0; sc = c.x; tc = c.z; } else { f = 3.0; sc = c.x; tc = -c.z; } }
  else { ma = a.z; if (c.z > 0.0) { f = 4.0; sc = c.x; tc = -c.y; } else { f = 5.0; sc = -c.x; tc = -c.y; } }
  lod = clamp(lod, 0.0, 6.0);
  float m = (0.5 * exp2(lod) + 0.5) / 64.0;                       // stay inside the face at this mip
  vec2 uv = clamp(vec2(sc, tc) / ma * 0.5 + 0.5, m, 1.0 - m);
  return textureLod(uProbeAtlas, vec2((f + uv.x) / 6.0, (probe + uv.y) / uProbeCount), lod).rgb * 0.5;
}
// the game's tangent-space vectors (normal maps: x = alpha, y = green; the lightmap direction: the
// alpha channels of the two secondary layers): v x (4.08, 4.0645) - (2.08, 2.0645), z = 1
vec2 lgDecode2(vec2 t) { return t * vec2(4.08, 4.06452) - vec2(2.08, 2.06452); }
// the world normal from the normal map: normalize(normal + x tangent + y binormal), tangent / binormal
// along +u / +v of the texture coordinates (here from the screen-space derivatives)
vec3 lgWorldNormal(vec3 n, vec3 p, vec2 uv, vec2 nm) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  if (dot(T, T) <= 0.0 || dot(B, B) <= 0.0) return n;
  return normalize(n + nm.x * normalize(T) + nm.y * normalize(B));
}
// the specular part: (probe at mip 6 - 8 gloss + the primary light's highlight) x specular colour x
// fresnel (lrp(pow(1 - |N.V|, envMapParms.z), envMapParms.y, envMapParms.x)); V from the eye to the
// point, L / C the primary light (direction, colour x attenuation), vis its visibility
vec3 lgSpecular(vec3 N, vec3 V, vec4 spec, vec4 env, float probe, vec3 L, vec3 C, float vis) {
  float nv = dot(V, N);
  vec3 R = V - 2.0 * nv * N;
  vec3 s = vec3(0.0);
  if (uProbeOn > 0.5 && probe > 0.5) s = lgProbe(R, probe, 6.0 - 8.0 * spec.a);
  if (vis > 0.0) {
    float lobe = clamp(exp((dot(R, L) - 0.99925) * (exp2(9.37752 * spec.a) + 7.0)), 0.0, 1.0);
    s += vis * lobe * C * env.w;
  }
  float f = pow(1.0 - abs(nv), env.z);
  return s * spec.rgb * mix(env.x, env.y, f);
}
`;

/** material maps of a material entry (world.json group, props.json / character materials):
 *  {normalMap, specularMap, detailMap: THREE.Texture or null, env: [min, max, exponent, sun
 *  intensity], detailScale} or null */
const NO_MAPS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('maps') === 'off';
export function materialShading(entry, texture) {
  if (NO_MAPS || !entry || (!entry.normalMap && !entry.specularMap && !entry.detailMap)) return null;   // ?maps=off: comparison
  return { normalMap: entry.normalMap ? texture(entry.normalMap) : null,
           specularMap: entry.specularMap ? texture(entry.specularMap) : null,
           detailMap: entry.detailMap ? texture(entry.detailMap) : null,
           detailScale: entry.detailScale || [1, 1, 0, 0],
           env: entry.envMapParms || [0.2, 0.5, 5, 2] };            // without constants: the r_envMap* defaults
}

/** the lightmapped world as the game draws it (lm_*.hlsl): a MeshBasicMaterial with the colour map (no
 *  three.js lightMap) whose output is replaced by
 *    (albedo [+ detail - 0.5]) x vertex colour x (A x N.z + B x sat(N.L) [+ primary x light x sat(N.Lp)])
 *    + specular
 *  A / B: the two layers of the secondary lightmap, L: their alpha channels (the light direction in the
 *  texture's tangent space), N: the normal map (or (0, 0, 1)), both decoded like the game; the
 *  surface's primary light (attribute "light": the sun - lm_sun_* - or a lamp - lm_spot_* / lm_omni_*)
 *  with the primary lightmap as its visibility, the sun's through the shadow map. lm: {secondary,
 *  primary} textures. vertexAlpha: the alpha-tested shaders (lm_*_t0*) - drawn where colour map alpha x
 *  vertex alpha >= 0.5, opaque there (they write alpha 1 or 0): the decals fade by the vertex alpha. */
export function gameWorld(material, lm, shading, vertexAlpha = false) {
  const defs = { LG_WORLD: '' };
  if (vertexAlpha) defs.LG_VERTEX_ALPHA = '';
  if (shading && shading.normalMap) defs.LG_NORMALMAP = '';
  if (shading && shading.specularMap) defs.LG_SPECULAR = '';
  if (shading && shading.detailMap) defs.LG_DETAIL = '';
  if (lm.primary) defs.LG_PRIMARY = '';
  material.defines = Object.assign({}, material.defines, defs);
  material.onBeforeCompile = shader => {
    shader.uniforms.uProbeAtlas = PROBES.atlas;
    shader.uniforms.uProbeCount = PROBES.count;
    shader.uniforms.uProbeOn = PROBES.on;
    lightUniforms(shader);
    shader.uniforms.uLmSecondary = { value: lm.secondary };
    shader.uniforms.uLmPrimary = { value: lm.primary };
    shader.uniforms.uLgSpecMap = { value: shading && shading.specularMap };
    shader.uniforms.uLgNormalMap = { value: shading && shading.normalMap };
    shader.uniforms.uLgDetailMap = { value: shading && shading.detailMap };
    shader.uniforms.uLgDetailScale = { value: new THREE.Vector2(...(shading ? shading.detailScale.slice(0, 2) : [1, 1])) };
    shader.uniforms.uLgEnv = { value: new THREE.Vector4(...(shading ? shading.env : [0, 0, 1, 0])) };
    SHADOW_HOOK.vertexUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 color;
attribute float probe;
attribute float light;
attribute vec2 uv1;
varying vec3 vLgPos;
varying vec3 vLgN;
varying vec2 vLgUv;
varying vec2 vLgUv1;
varying vec3 vLgColor;
varying float vLgAlpha;
flat varying float vLgProbe;
flat varying float vLgLight;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vLgPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vLgN = normalize(mat3(modelMatrix) * normal);
vLgUv = uv;
vLgUv1 = uv1;
vLgColor = color.rgb;
vLgAlpha = color.a;
vLgProbe = probe;
vLgLight = light;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uLmSecondary;
uniform sampler2D uLmPrimary;
uniform sampler2D uLgSpecMap;
uniform sampler2D uLgNormalMap;
uniform sampler2D uLgDetailMap;
uniform vec2 uLgDetailScale;
uniform vec4 uLgEnv;
varying vec3 vLgPos;
varying vec3 vLgN;
varying vec2 vLgUv;
varying vec2 vLgUv1;
varying vec3 vLgColor;
varying float vLgAlpha;
flat varying float vLgProbe;
flat varying float vLgLight;
${SURFACE_GLSL}
${SHADOW_HOOK.fragmentDecl}`)
      .replace('#include <opaque_fragment>', `{
#ifdef LG_VERTEX_ALPHA
  if (diffuseColor.a * vLgAlpha < 0.5) discard;
  diffuseColor.a = 1.0;
#endif
  vec4 lmA = texture2D(uLmSecondary, vLgUv1 * vec2(1.0, 0.5));
  vec4 lmB = texture2D(uLmSecondary, vLgUv1 * vec2(1.0, 0.5) + vec2(0.0, 0.5));
  vec2 d = lgDecode2(vec2(lmA.a, lmB.a));
  vec3 Ng = normalize(vLgN) * (gl_FrontFacing ? 1.0 : -1.0);
#ifdef LG_NORMALMAP
  vec2 n = lgDecode2(texture2D(uLgNormalMap, vLgUv).rg);
  float invN = inversesqrt(dot(n, n) + 1.0);
  float nl = clamp((dot(d, n) + 1.0) * invN * inversesqrt(dot(d, d) + 1.0), 0.0, 1.0);
  vec3 light = lmA.rgb * invN + lmB.rgb * nl;
  vec3 N = lgWorldNormal(Ng, vLgPos, vLgUv, n);
#else
  vec3 light = lmA.rgb + lmB.rgb * clamp(inversesqrt(dot(d, d) + 1.0), 0.0, 1.0);
  vec3 N = Ng;
#endif
  vec3 Lp = vec3(0.0, 0.0, 1.0), Cp = vec3(0.0);
  float vis = 0.0;
#ifdef LG_PRIMARY
  // (texture reads outside the branch: implicit derivatives in divergent flow are undefined on D3D)
  float primVis = texture2D(uLmPrimary, vLgUv1).r;
  if (lgPrimary(vLgLight, vLgPos, Lp, Cp) > 0.0) {
    vis = primVis;
    { float sunVis = vis; ${SHADOW_HOOK.worldSun} vis = abs(vLgLight - uLgSunIndex) < 0.5 ? sunVis : lgSpotShadow(vLgLight, vLgPos, vis); }
    light += vis * Cp * clamp(dot(Lp, N), 0.0, 1.0);
  }
#endif
  light += lgDynamic(vLgPos, N);
  vec3 albedo = diffuseColor.rgb;
#ifdef LG_DETAIL
  albedo += texture2D(uLgDetailMap, vLgUv * uLgDetailScale).rgb - 0.5;
#endif
  outgoingLight = albedo * vLgColor * light;
#ifdef LG_SPECULAR
  outgoingLight += lgSpecular(N, normalize(vLgPos - cameraPosition), texture2D(uLgSpecMap, vLgUv), uLgEnv, vLgProbe, Lp, Cp, vis);
#endif
}
#include <opaque_fragment>`);
  };
  material.needsUpdate = true;
  return material;
}

/** the sun shadow maps (shadows.js renders them): per partition the depth maps of the static and the
 *  moving casters and the world -> map matrix; params (x: on, y: near texel size, z: near depth bias,
 *  w: far partition on), farParams (x: far texel size, y: far depth bias) */
export const SHADOW = { map: { value: null }, dynMap: { value: null }, matrix: { value: new THREE.Matrix4() },
                        farMap: { value: null }, farDynMap: { value: null }, farMatrix: { value: new THREE.Matrix4() },
                        params: { value: new THREE.Vector4(0, 0, 0, 0) }, farParams: { value: new THREE.Vector4(0, 0, 0, 0) } };
/** the lamps' spot shadow maps (shadows.js): one atlas of 4 tiles (static and moving casters), per tile
 *  the world -> atlas matrix, the light it belongs to (-1 none) and its fade */
export const SPOT = { map: { value: null }, dynMap: { value: null },
                      matrices: { value: Array.from({ length: 4 }, () => new THREE.Matrix4()) },
                      lights: { value: new THREE.Vector4(-1, -1, -1, -1) }, fades: { value: new THREE.Vector4(0, 0, 0, 0) },
                      texel: { value: new THREE.Vector2(1 / 2048, 1 / 512) } };
/** the game's lookups (lm_sm_sun / lp_sm_sun, lm_sm_spot / lp_sm_spot): 4 taps half a texel apart, each
 *  lit when the stored depth is not in front, averaged. Sun: the near partition, fading into the far
 *  one towards its edge, the far one into the fallback (the baked / light grid visibility). Lamps:
 *  lrp(fade, shadow map, fallback). All lookups with textureLod (no implicit derivatives in branches). */
const SHADOW_GLSL = `
uniform sampler2D uShadowMap;
uniform sampler2D uShadowDynMap;
uniform mat4 uShadowMatrix;
uniform sampler2D uShadowFarMap;
uniform sampler2D uShadowFarDynMap;
uniform mat4 uShadowFarMatrix;
uniform vec4 uShadowParams;
uniform vec4 uShadowFarParams;
uniform sampler2D uSpotMap;
uniform sampler2D uSpotDynMap;
uniform mat4 uSpotMatrix[4];
uniform vec4 uSpotLights;
uniform vec4 uSpotFades;
uniform vec2 uSpotTexel;
float lgTaps(sampler2D a, sampler2D b, vec2 uv, float z, vec2 t) {
  #define LG_TAP(o) step(z, min(textureLod(a, uv + o, 0.0).r, textureLod(b, uv + o, 0.0).r))
  return 0.25 * (LG_TAP(vec2(-t.x, -t.y)) + LG_TAP(vec2(t.x, -t.y)) + LG_TAP(vec2(-t.x, t.y)) + LG_TAP(vec2(t.x, t.y)));
}
float lgSunShadow(vec3 wp, float fallback) {
  if (uShadowParams.x < 0.5) return fallback;
  // the far partition (or the fallback)
  float far = fallback;
  if (uShadowParams.w > 0.5) {
    vec3 f = (uShadowFarMatrix * vec4(wp, 1.0)).xyz;
    vec2 ef = abs(f.xy - 0.5) * 2.0;
    float edgeF = max(ef.x, ef.y);
    if (edgeF < 1.0 && f.z < 1.0 && f.z > 0.0) {
      float sf = lgTaps(uShadowFarMap, uShadowFarDynMap, f.xy, f.z - uShadowFarParams.y, vec2(0.5 * uShadowFarParams.x));
      far = mix(sf, fallback, clamp((edgeF - 0.75) * 4.0, 0.0, 1.0));
    }
  }
  vec3 c = (uShadowMatrix * vec4(wp, 1.0)).xyz;
  vec2 e = abs(c.xy - 0.5) * 2.0;
  float edge = max(e.x, e.y);
  if (edge >= 1.0 || c.z >= 1.0 || c.z <= 0.0) return far;
  float s = lgTaps(uShadowMap, uShadowDynMap, c.xy, c.z - uShadowParams.z, vec2(0.5 * uShadowParams.y));
  return mix(s, far, clamp((edge - 0.75) * 4.0, 0.0, 1.0));
}
float lgSpotShadow(float k, vec3 wp, float fallback) {
  for (int i = 0; i < 4; i++) {
    if (abs(uSpotLights[i] - k) < 0.5 && k > 0.5) {
      vec4 c = uSpotMatrix[i] * vec4(wp, 1.0);
      if (c.w <= 0.0) return fallback;
      vec3 p = c.xyz / c.w;
      float x0 = float(i) * 0.25;
      if (p.x < x0 || p.x > x0 + 0.25 || p.y < 0.0 || p.y > 1.0 || p.z >= 1.0) return fallback;
      float s = lgTaps(uSpotMap, uSpotDynMap, p.xy, p.z - 0.00015, 0.5 * uSpotTexel);
      return mix(fallback, s, uSpotFades[i]);
    }
  }
  return fallback;
}
`;
export const SHADOW_HOOK = {
  vertexUniforms(shader) {
    shader.uniforms.uShadowMap = SHADOW.map;
    shader.uniforms.uShadowDynMap = SHADOW.dynMap;
    shader.uniforms.uShadowMatrix = SHADOW.matrix;
    shader.uniforms.uShadowFarMap = SHADOW.farMap;
    shader.uniforms.uShadowFarDynMap = SHADOW.farDynMap;
    shader.uniforms.uShadowFarMatrix = SHADOW.farMatrix;
    shader.uniforms.uShadowParams = SHADOW.params;
    shader.uniforms.uShadowFarParams = SHADOW.farParams;
    shader.uniforms.uSpotMap = SPOT.map;
    shader.uniforms.uSpotDynMap = SPOT.dynMap;
    shader.uniforms.uSpotMatrix = SPOT.matrices;
    shader.uniforms.uSpotLights = SPOT.lights;
    shader.uniforms.uSpotFades = SPOT.fades;
    shader.uniforms.uSpotTexel = SPOT.texel;
  },
  vertexDecl: '', vertexMain: '', fragmentDecl: SHADOW_GLSL,
  // world (lm_sm_sun): baked shadow stays shadow, else the shadow map
  worldSun: 'if (sunVis > 0.0) sunVis = lgSunShadow(vLgPos, sunVis);',
  // models (lp_sm_sun): the shadow map instead of the light grid's sun visibility
  modelSun: 'sunVis = lgSunShadow(vLgPos, sunVis);',
};

/** the 4 x 4 x 4 block of a light grid sample (out.block of LightGrid.sample); without the full
 *  colours (old exports) one is built from the six faces: each shell texel the mean of its faces */
function blockOf(s, into) {
  if (s.block) { into.set(s.block); return into; }
  const a = Math.round((s.vis != null ? s.vis : s.sun) * 255);
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const faces = [];
    if (x === 3) faces.push(0); if (x === 0) faces.push(1); if (y === 3) faces.push(2); if (y === 0) faces.push(3);
    if (z === 3) faces.push(4); if (z === 0) faces.push(5);
    const t = (z * 16 + y * 4 + x) * 4;
    for (let j = 0; j < 3; j++) {
      let v = 0; for (const f of faces) v += s.cube[f * 3 + j];
      into[t + j] = faces.length ? Math.min(255, Math.round(v / faces.length / GRID_SCALE)) : 0;
    }
    into[t + 3] = a;
  }
  return into;
}

function volumeTexture(data, w, h, d) {
  const t = new THREE.Data3DTexture(data, w, h, d);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** per-object lighting of a character: its own 4 x 4 x 4 block (a 3D texture), the primary light and
 *  the reflection probe */
export function objectLighting() {
  const data = new Uint8Array(256).fill(128);
  return { uLgVolume: { value: volumeTexture(data, 4, 4, 4) }, uLgVolSize: { value: new THREE.Vector3(4, 4, 4) },
           uLgBlock: { value: new THREE.Vector3(0, 0, 0) }, uLgLight: { value: 0 }, uLgProbe: { value: 0 } };
}
export function setObjectLighting(L, s) {
  const tex = L.uLgVolume.value;
  const before = L._key;
  blockOf(s, tex.image.data);
  const key = tex.image.data.join(',');
  if (key !== before) { L._key = key; tex.needsUpdate = true; }
  L.uLgLight.value = s.light != null ? s.light : (s.sun > 0 ? LIGHTS.sunIndex.value : 0);
  if (s.probe !== undefined) L.uLgProbe.value = s.probe;
}

/** the blocks of many placements (props) in one 3D texture: 64 blocks per row (256 texels), 4 deep.
 *  samples: LightGrid samples -> {texture, size: Vector3, origin(k) -> [x, y, 0] in texels} */
export function lightingAtlas(samples) {
  const n = Math.max(1, samples.length), rows = Math.ceil(n / 64);
  const W = 256, H = rows * 4, D = 4, data = new Uint8Array(W * H * D * 4), block = new Uint8Array(256);
  samples.forEach((s, k) => {
    blockOf(s, block);
    const bx = (k % 64) * 4, by = Math.floor(k / 64) * 4;
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const src = (z * 16 + y * 4 + x) * 4, dst = ((z * H + by + y) * W + bx + x) * 4;
      data[dst] = block[src]; data[dst + 1] = block[src + 1]; data[dst + 2] = block[src + 2]; data[dst + 3] = block[src + 3];
    }
  });
  return { texture: volumeTexture(data, W, H, D), size: new THREE.Vector3(W, H, D),
           origin: k => [(k % 64) * 4, Math.floor(k / 64) * 4, 0] };
}

/** per-instance lighting of an InstancedMesh: the block of each placement in the atlas (lgBlock),
 *  its reflection probe and primary light (lgInfo). keys: the placements' indices into the atlas */
export function setInstanceLighting(geo, atlas, keys, samples, probes = null) {
  const B = new Float32Array(keys.length * 3), I = new Float32Array(keys.length * 2);
  keys.forEach((k, j) => {
    B.set(atlas.origin(k), j * 3);
    const s = samples[k];
    I[j * 2] = probes ? probes[j] : 0;
    I[j * 2 + 1] = s && s.light != null ? s.light : (s && s.sun > 0 ? LIGHTS.sunIndex.value : 0);
  });
  geo.setAttribute('lgBlock', new THREE.InstancedBufferAttribute(B, 3));
  geo.setAttribute('lgInfo', new THREE.InstancedBufferAttribute(I, 2));
}

/** turn a Lambert material into the game's model lighting (lp_*.hlsl):
 *    (albedo [+ detail - 0.5]) x (2 x grid(N) + grid.a x light x sat(N.L)) + specular
 *  grid(N): the 4 x 4 x 4 block of the light grid at the model's lighting origin, read like the game
 *  (trilinear, at the block centre + 1.5 texels x N / max|N|), its alpha the primary light's
 *  visibility (the sun's from the shadow map near the view); light: the primary light (the sun or a
 *  lamp, with falloff and cone at the pixel); specular as on the world where the material has a
 *  specular map; N from the normal map. Without normal / specular map per vertex, with them per pixel.
 *  objectUniforms: from objectLighting() (players), or null for placements (props: the attributes of
 *  setInstanceLighting and the atlas `atlas` of lightingAtlas).
 *  shading: materialShading() of the material entry, or null */
export function gridLit(material, objectUniforms, shading = null, atlas = null) {
  const perPixel = !!(shading && (shading.normalMap || shading.specularMap));
  const defs = objectUniforms ? { LG_OBJECT: '' } : { LG_INSTANCED: '' };
  if (perPixel) {
    defs.LG_PIXEL = '';
    if (shading.normalMap) defs.LG_NORMALMAP = '';
    if (shading.specularMap) defs.LG_SPECULAR = '';
  }
  if (shading && shading.detailMap) defs.LG_DETAIL = '';
  material.defines = Object.assign({}, material.defines, defs);
  material.onBeforeCompile = shader => {
    lightUniforms(shader);
    shader.uniforms.uProbeAtlas = PROBES.atlas;
    shader.uniforms.uProbeCount = PROBES.count;
    shader.uniforms.uProbeOn = PROBES.on;
    shader.uniforms.uLgSpecMap = { value: shading && shading.specularMap };
    shader.uniforms.uLgNormalMap = { value: shading && shading.normalMap };
    shader.uniforms.uLgDetailMap = { value: shading && shading.detailMap };
    shader.uniforms.uLgDetailScale = { value: new THREE.Vector2(...(shading ? shading.detailScale.slice(0, 2) : [1, 1])) };
    shader.uniforms.uLgEnv = { value: new THREE.Vector4(...(shading ? shading.env : [0, 0, 1, 0])) };
    if (objectUniforms) Object.assign(shader.uniforms, objectUniforms);
    else { shader.uniforms.uLgVolume = { value: atlas && atlas.texture }; shader.uniforms.uLgVolSize = { value: atlas ? atlas.size : new THREE.Vector3(4, 4, 4) }; }
    SHADOW_HOOK.vertexUniforms(shader);
    const gridGLSL = `
uniform highp sampler3D uLgVolume;
uniform vec3 uLgVolSize;
// the grid's block at the model: centre + 1.5 texels x N / max|N| (lightingLookupScale), trilinear
vec4 lgGrid(vec3 origin, vec3 N) {
  vec3 a = abs(N);
  float m = max(a.x, max(a.y, a.z));
  return textureLod(uLgVolume, (origin + 2.0 + 1.5 * N / max(m, 1e-4)) / uLgVolSize, 0.0);
}`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
${gridGLSL}
${LIGHTS_GLSL}
#ifdef LG_OBJECT
uniform vec3 uLgBlock;
uniform float uLgLight;
uniform float uLgProbe;
#else
attribute vec3 lgBlock;
attribute vec2 lgInfo;
#endif
varying vec3 vLgPos;
flat varying vec3 vLgOrigin;
flat varying float vLgLight;
flat varying float vLgProbe;
#ifdef LG_PIXEL
varying vec3 vLgN;
varying vec2 vLgUv;
#else
varying vec3 vLgAmb;
varying vec3 vLgDirect;
varying float vLgVis;
varying vec3 vLgDyn;
#endif
#ifdef LG_DETAIL
varying vec2 vLgDUv;
#endif`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
{
  vec3 n = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);   // world space
  vLgPos = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);      // world space
#ifdef LG_OBJECT
  vLgOrigin = uLgBlock; vLgLight = uLgLight; vLgProbe = uLgProbe;
#else
  vLgOrigin = lgBlock; vLgLight = lgInfo.y; vLgProbe = lgInfo.x;
#endif
#ifdef LG_DETAIL
  vLgDUv = uv;
#endif
#ifdef LG_PIXEL
  vLgN = n;
  vLgUv = uv;
#else
  vec4 g = lgGrid(vLgOrigin, n);
  vec3 L, C;
  lgPrimary(vLgLight, vLgPos, L, C);
  vLgAmb = 2.0 * g.rgb;
  vLgDirect = C * max(dot(n, L), 0.0);
  vLgVis = g.a;
  vLgDyn = lgDynamic(vLgPos, n);
#endif
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${gridGLSL}
uniform sampler2D uLgDetailMap;
uniform vec2 uLgDetailScale;
varying vec3 vLgPos;
flat varying vec3 vLgOrigin;
flat varying float vLgLight;
flat varying float vLgProbe;
#ifdef LG_PIXEL
uniform sampler2D uLgSpecMap;
uniform sampler2D uLgNormalMap;
uniform vec4 uLgEnv;
varying vec3 vLgN;
varying vec2 vLgUv;
${SURFACE_GLSL}
#else
${LIGHTS_GLSL}
varying vec3 vLgAmb;
varying vec3 vLgDirect;
varying float vLgVis;
varying vec3 vLgDyn;
#endif
#ifdef LG_DETAIL
varying vec2 vLgDUv;
#endif
${SHADOW_HOOK.fragmentDecl}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  vec3 albedo = diffuseColor.rgb;
#ifdef LG_DETAIL
  albedo += texture2D(uLgDetailMap, vLgDUv * uLgDetailScale).rgb - 0.5;
#endif
  bool isSun = abs(vLgLight - uLgSunIndex) < 0.5;
#ifdef LG_PIXEL
  vec3 N = normalize(vLgN) * (gl_FrontFacing ? 1.0 : -1.0);
#ifdef LG_NORMALMAP
  N = lgWorldNormal(N, vLgPos, vLgUv, lgDecode2(texture2D(uLgNormalMap, vLgUv).rg));
#endif
  vec4 g = lgGrid(vLgOrigin, N);
  vec3 L, C;
  lgPrimary(vLgLight, vLgPos, L, C);
  float sunVis = g.a;
  { float gridVis = sunVis; ${SHADOW_HOOK.modelSun} sunVis = isSun ? sunVis : lgSpotShadow(vLgLight, vLgPos, gridVis); }
  reflectedLight.indirectDiffuse = albedo * 2.0 * g.rgb;
  reflectedLight.directDiffuse = albedo * (C * sunVis * max(dot(N, L), 0.0) + lgDynamic(vLgPos, N));
#ifdef LG_SPECULAR
  // (Lambert's output is directDiffuse + indirectDiffuse: the specular part is added there)
  reflectedLight.indirectDiffuse += lgSpecular(N, normalize(vLgPos - cameraPosition), texture2D(uLgSpecMap, vLgUv), uLgEnv, vLgProbe, L, C, sunVis);
#endif
#else
  float sunVis = vLgVis;
  { float gridVis = sunVis; ${SHADOW_HOOK.modelSun} sunVis = isSun ? sunVis : lgSpotShadow(vLgLight, vLgPos, gridVis); }
  reflectedLight.indirectDiffuse = albedo * vLgAmb;
  reflectedLight.directDiffuse = albedo * (sunVis * vLgDirect + vLgDyn);
#endif
}`);
  };
  material.needsUpdate = true;
  return material;
}

/** the game's fog (R_SetFrameFog, the vertex shaders' fogConsts): visibility = clamp(exp(-density x
 *  (distance - start))), colour = mix(fogColor, colour, visibility); distance from the eye. Installed
 *  into three.js's fog chunks: a THREE.Fog with far < 0 is the game's fog (near = start, far =
 *  -density); otherwise three.js's linear fog, also by distance. */
let gameFogInstalled = false;
export function installGameFog() {
  if (gameFogInstalled) return;
  gameFogInstalled = true;
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = length( mvPosition.xyz );
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = fogFar < 0.0 ? 1.0 - clamp( exp( fogFar * ( vFogDepth - fogNear ) ), 0.0, 1.0 )
                                   : smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}
