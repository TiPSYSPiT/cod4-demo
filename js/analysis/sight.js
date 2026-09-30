/* Sight lines through the map geometry (geometry/<map>/sight.js, docs/GEOMETRY.md).
 *
 *   C4.sight.load(map, base)      -> Promise<bvh | null>   (main thread: loads <base><map>/sight.js)
 *   C4.sight.read(arrayBuffer)    -> bvh                   (format C4BV v1)
 *   C4.sight.blocked(bvh, a, b, skip) -> true if the segment a -> b hits a triangle (flags & skip ignored)
 *
 * The geometry files are JavaScript (base64 of the C4BV bytes) because fetch() is blocked on file://;
 * each one calls C4.sight.register(map, base64). DOM-free except load(). */
C4.define('sight', function (C4) {
  'use strict';

  const FLAG = { glass: 1, brushmodel: 2, terrain: 4 };

  function read(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'C4BV' || dv.getUint32(4, true) !== 1) throw new Error('not a C4BV v1 geometry file');
    const nv = dv.getUint32(8, true), nt = dv.getUint32(12, true), nn = dv.getUint32(16, true);
    const ov = dv.getUint32(20, true), oi = dv.getUint32(24, true), of = dv.getUint32(28, true), on = dv.getUint32(32, true);
    return {
      vertices: nv, triangles: nt, nodes: nn, bytes: buf.byteLength,
      V: new Float32Array(buf, ov, nv * 3), I: new Uint32Array(buf, oi, nt * 3), F: new Uint8Array(buf, of, nt),
      NF: new Float32Array(buf, on, nn * 8), NU: new Uint32Array(buf, on, nn * 8), NS: new Uint16Array(buf, on, nn * 16)
    };
  }

  const stack = new Uint32Array(256);
  /** does the segment a -> b hit a triangle? (any hit, triangles with flags & skip are ignored) */
  function blocked(B, a, b, skip) {
    const sx = a[0], sy = a[1], sz = a[2], dx = b[0] - sx, dy = b[1] - sy, dz = b[2] - sz;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const { V, I, F, NF, NU, NS } = B;
    let sp = 0, n = 0;
    for (;;) {
      const o = n * 8;
      let t0 = 0, t1 = 1, p, q;
      p = (NF[o] - sx) * ix; q = (NF[o + 3] - sx) * ix; if (p > q) { const t = p; p = q; q = t; } if (p > t0) t0 = p; if (q < t1) t1 = q;
      if (t0 <= t1) { p = (NF[o + 1] - sy) * iy; q = (NF[o + 4] - sy) * iy; if (p > q) { const t = p; p = q; q = t; } if (p > t0) t0 = p; if (q < t1) t1 = q; }
      if (t0 <= t1) { p = (NF[o + 2] - sz) * iz; q = (NF[o + 5] - sz) * iz; if (p > q) { const t = p; p = q; q = t; } if (p > t0) t0 = p; if (q < t1) t1 = q; }
      if (t0 <= t1) {
        const cnt = NS[o * 2 + 14];
        if (!cnt) {                                   // inner node: near child first
          const axis = NS[o * 2 + 15], right = NU[o + 6], left = n + 1;
          const neg = axis === 0 ? dx < 0 : axis === 1 ? dy < 0 : dz < 0;
          if (neg) { stack[sp++] = left; n = right; } else { stack[sp++] = right; n = left; }
          continue;
        }
        for (let t = NU[o + 6], end = t + cnt; t < end; t++) {
          if (F[t] & skip) continue;
          const i0 = I[t * 3] * 3, i1 = I[t * 3 + 1] * 3, i2 = I[t * 3 + 2] * 3;
          const ax = V[i0], ay = V[i0 + 1], az = V[i0 + 2];
          const e1x = V[i1] - ax, e1y = V[i1 + 1] - ay, e1z = V[i1 + 2] - az, e2x = V[i2] - ax, e2y = V[i2 + 1] - ay, e2z = V[i2 + 2] - az;
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-9 && det < 1e-9) continue;
          const inv = 1 / det, tx = sx - ax, ty = sy - ay, tz = sz - az;
          const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const w = (dx * qx + dy * qy + dz * qz) * inv; if (w < 0 || u + w > 1) continue;
          const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (s >= 0 && s <= 1) return true;
        }
      }
      if (!sp) return false;
      n = stack[--sp];
    }
  }

  function decodeBase64(b64) {
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // ---- loading (main thread) ----
  const registered = new Map();          // map -> base64, set by the geometry script
  let cache = null;                      // { map, bvh } - only the last map is kept
  function register(map, b64) { registered.set(map, b64); }

  /** load geometry/<map>/sight.js; resolves the geometry or null (no file / not a valid map name) */
  function load(map, base) {
    if (cache && cache.map === map) return Promise.resolve(cache.bvh);
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(map || '') || typeof document === 'undefined') return Promise.resolve(null);
    return new Promise(resolve => {
      const s = document.createElement('script');
      const done = () => {
        s.remove();
        const b64 = registered.get(map);
        registered.delete(map);
        if (!b64) return resolve(null);
        try { cache = { map, bvh: read(decodeBase64(b64)) }; resolve(cache.bvh); }
        catch (err) { console.warn('Map geometry ' + map + ' could not be read:', err.message); resolve(null); }
      };
      s.onload = done;
      s.onerror = () => { s.remove(); resolve(null); };
      s.src = (base || 'geometry/') + map + '/sight.js';
      document.head.append(s);
    });
  }

  C4.sight = { FLAG, read, blocked, decodeBase64, register, load };
});
