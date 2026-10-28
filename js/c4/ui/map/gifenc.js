/* GIF encoder for the map tab export - own code (GIF89a, LZW), runs in a worker built from a Blob
 * (works on file:// as well, no external library).
 *
 *   const enc = C4.gifEncoder.create(width, height, delayCs, {colors, dither})   // worker; options:
 *       colors: palette size per frame (2-256, default 256), dither: Floyd-Steinberg (default off)
 *   enc.add(imageData, delayCs) -> returns once the worker accepted the frame (transfer)
 *   enc.finish()        -> Promise<Blob>
 *   enc.cancel()
 *
 * Every frame gets its own palette (median cut over a sample of its pixels); only the rectangle that
 * changed since the previous frame is stored (disposal "do not dispose"), its unchanged pixels are
 * transparent. */
(function (C4) {
  'use strict';

  /* ---------- worker side (serialised with Function.prototype.toString) ---------- */
  function workerMain(self) {
    let W = 0, H = 0, delay = 10, parts = [], prev = null, frames = 0, maxColors = 256, dither = false;
    const bytes = [];
    const flush = () => { if (bytes.length) { parts.push(new Uint8Array(bytes)); bytes.length = 0; } };
    const w16 = v => { bytes.push(v & 255, (v >> 8) & 255); };

    /** median cut over 15-bit colours of a pixel sample -> palette [[r, g, b] x <= max] */
    function palette(px, x0, y0, w, h, max) {
      const hist = new Uint32Array(32768);
      const step = Math.max(1, Math.floor(Math.sqrt(w * h / 40000)));
      for (let y = y0; y < y0 + h; y += step) for (let x = x0; x < x0 + w; x += step) {
        const i = (y * W + x) * 4;
        hist[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
      }
      let colors = [];
      for (let c = 0; c < 32768; c++) if (hist[c]) colors.push(c);
      const boxes = [colors];
      while (boxes.length < max) {
        // split the box with the largest channel range
        let bi = -1, bestRange = 0, bestCh = 0;
        for (let b = 0; b < boxes.length; b++) {
          const bx = boxes[b]; if (bx.length < 2) continue;
          for (let ch = 0; ch < 3; ch++) {
            const sh = 10 - ch * 5; let lo = 31, hi = 0;
            for (const c of bx) { const v = (c >> sh) & 31; if (v < lo) lo = v; if (v > hi) hi = v; }
            if (hi - lo > bestRange) { bestRange = hi - lo; bi = b; bestCh = ch; }
          }
        }
        if (bi < 0) break;
        const sh = 10 - bestCh * 5, bx = boxes[bi].sort((a, b) => ((a >> sh) & 31) - ((b >> sh) & 31));
        // weighted median
        let total = 0; for (const c of bx) total += hist[c];
        let acc = 0, cut = 1;
        for (let k = 0; k < bx.length - 1; k++) { acc += hist[bx[k]]; if (acc >= total / 2) { cut = k + 1; break; } }
        boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
      }
      return boxes.filter(b => b.length).map(bx => {
        let r = 0, g = 0, b = 0, n = 0;
        for (const c of bx) { const k = hist[c]; r += ((c >> 10) & 31) * k; g += ((c >> 5) & 31) * k; b += (c & 31) * k; n += k; }
        return [Math.round(r / n * 8.226), Math.round(g / n * 8.226), Math.round(b / n * 8.226)];
      });
    }

    /** GIF LZW of the index stream (min code size 8) -> sub-blocks into bytes */
    function lzw(indices) {
      const minCode = 8, clear = 256, eoi = 257;
      let codeSize = minCode + 1, next = 258;
      const dict = new Map();
      let cur = 0, curBits = 0;
      const out = [];
      const emit = code => { cur |= code << curBits; curBits += codeSize; while (curBits >= 8) { out.push(cur & 255); cur >>>= 8; curBits -= 8; } };
      emit(clear);
      let prefix = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const k = indices[i], key = prefix * 256 + k;
        const v = dict.get(key);
        if (v !== undefined) { prefix = v; continue; }
        emit(prefix);
        if (next < 4096) { dict.set(key, next++); if (next > (1 << codeSize) && codeSize < 12) codeSize++; }
        else { emit(clear); dict.clear(); codeSize = minCode + 1; next = 258; }
        prefix = k;
      }
      emit(prefix); emit(eoi);
      if (curBits > 0) out.push(cur & 255);
      bytes.push(minCode);
      for (let i = 0; i < out.length; i += 255) { const n = Math.min(255, out.length - i); bytes.push(n); for (let j = 0; j < n; j++) bytes.push(out[i + j]); }
      bytes.push(0);
    }

    function addFrame(px) {
      // the rectangle that changed since the previous frame
      let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
      if (prev) {
        x0 = W; y0 = H; x1 = -1; y1 = -1;
        for (let y = 0; y < H; y++) {
          const row = y * W * 4;
          for (let x = 0; x < W; x++) {
            const i = row + x * 4;
            if (px[i] !== prev[i] || px[i + 1] !== prev[i + 1] || px[i + 2] !== prev[i + 2]) {
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) { x0 = y0 = x1 = y1 = 0; }       // nothing changed: one unchanged pixel keeps the frame time
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      // after the first frame index 255 is transparent: pixels that did not change keep what is shown
      // (no seams at the rectangle's edge from a different palette, and better compression)
      const trans = prev ? 255 : -1, nPal = Math.min(prev ? 255 : 256, maxColors);
      const pal = palette(px, x0, y0, w, h, nPal);
      while (pal.length < 256) pal.push([0, 0, 0]);
      // nearest palette colour, cached per 15-bit colour
      const cache = new Int16Array(32768).fill(-1);
      const idx = new Uint8Array(w * h);
      // Floyd-Steinberg: the quantisation error of a pixel spreads to its right and lower neighbours
      const err = dither ? [new Float32Array((w + 2) * 3), new Float32Array((w + 2) * 3)] : null;
      for (let y = 0; y < h; y++) {
        if (err) { const t = err[0]; err[0] = err[1]; err[1] = t; err[1].fill(0); }
        for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * W + x0 + x) * 4;
        let r = px[i], g = px[i + 1], b = px[i + 2];
        if (trans >= 0 && r === prev[i] && g === prev[i + 1] && b === prev[i + 2]) { idx[y * w + x] = trans; continue; }
        if (err) {
          const e = (x + 1) * 3;
          r = Math.max(0, Math.min(255, Math.round(r + err[0][e]))); g = Math.max(0, Math.min(255, Math.round(g + err[0][e + 1]))); b = Math.max(0, Math.min(255, Math.round(b + err[0][e + 2])));
        }
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let c = cache[key];
        if (c < 0) {
          let best = 0, bd = Infinity;
          for (let k = 0; k < nPal; k++) { const p = pal[k], dr = p[0] - r, dg = p[1] - g, db = p[2] - b, dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; best = k; } }
          c = cache[key] = best;
        }
        idx[y * w + x] = c;
        if (err) {
          const p = pal[c], e = (x + 1) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const q = [r, g, b][ch] - p[ch];
            err[0][e + 3 + ch] += q * 7 / 16; err[1][e - 3 + ch] += q * 3 / 16; err[1][e + ch] += q * 5 / 16; err[1][e + 3 + ch] += q / 16;
          }
        }
        }
      }
      // graphic control extension (disposal 1 = keep, transparent index), image descriptor with a local colour table
      bytes.push(0x21, 0xf9, 4, trans >= 0 ? 0x05 : 0x04); w16(delay); bytes.push(trans >= 0 ? trans : 0, 0);
      bytes.push(0x2c); w16(x0); w16(y0); w16(w); w16(h); bytes.push(0x87);
      for (const p of pal) bytes.push(p[0], p[1], p[2]);
      lzw(idx);
      flush();
      prev = px;
      frames++;
    }

    self.onmessage = e => {
      const m = e.data;
      if (m.type === 'start') {
        W = m.width; H = m.height; delay = m.delay;
        if (m.colors) maxColors = Math.max(2, Math.min(256, m.colors));
        dither = !!m.dither;
        for (const ch of 'GIF89a') bytes.push(ch.charCodeAt(0));
        w16(W); w16(H); bytes.push(0x70, 0, 0);                     // no global colour table
        bytes.push(0x21, 0xff, 11); for (const ch of 'NETSCAPE2.0') bytes.push(ch.charCodeAt(0));
        bytes.push(3, 1, 0, 0, 0);                                   // loop forever
        flush();
      } else if (m.type === 'frame') {
        if (m.delay != null) delay = m.delay;
        addFrame(new Uint8Array(m.rgba));
        self.postMessage({ type: 'frame', frames });
      } else if (m.type === 'finish') {
        bytes.push(0x3b); flush();
        self.postMessage({ type: 'done', parts }, parts.map(p => p.buffer));
      }
    };
  }

  /* ---------- main thread ---------- */
  function create(width, height, delayCs, opts = {}) {
    const src = '(' + workerMain.toString() + ')(self);';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    let pending = 0, waiters = [], doneResolve = null, failed = null;
    worker.onmessage = e => {
      if (e.data.type === 'frame') { pending--; const w = waiters; waiters = []; w.forEach(f => f()); }
      else if (e.data.type === 'done' && doneResolve) doneResolve(new Blob(e.data.parts, { type: 'image/gif' }));
    };
    worker.onerror = e => { failed = new Error('GIF worker: ' + e.message); const w = waiters; waiters = []; w.forEach(f => f()); };
    worker.postMessage({ type: 'start', width, height, delay: delayCs, colors: opts.colors || 256, dither: !!opts.dither });
    return {
      /** queue one frame (ImageData of width x height; delay in 1/100 s, optional); waits while more
       *  than 4 frames are pending */
      async add(img, delay) {
        if (failed) throw failed;
        while (pending > 4) { await new Promise(r => waiters.push(r)); if (failed) throw failed; }
        pending++;
        const buf = img.data.buffer.slice(0);
        worker.postMessage({ type: 'frame', rgba: buf, delay }, [buf]);
      },
      async finish() {
        while (pending > 0) { await new Promise(r => waiters.push(r)); if (failed) throw failed; }
        const blob = await new Promise(r => { doneResolve = r; worker.postMessage({ type: 'finish' }); });
        worker.terminate();
        return blob;
      },
      cancel() { worker.terminate(); const w = waiters; waiters = []; failed = new Error('cancelled'); w.forEach(f => f()); }
    };
  }

  C4.gifEncoder = { create };
})(window.C4);
