/* Map tab: export the current view as MP4 or GIF.
 *
 * Frame by frame from demo time (deterministic, independent of the computer and of the playback):
 * a second MapRenderer with the view's rotation, zoom, pan and image draws every frame at the
 * export resolution (fixed pixel ratio - everything scales alike); the map tab's frame() draws the
 * same content as on screen (players shown, mode, grenades, bomb), without the page controls or the
 * statistics popup. Optional overlay: round, round time, score and the kill feed.
 *   MP4: WebCodecs VideoEncoder (H.264) + mp4mux.js. Without WebCodecs / H.264: MediaRecorder,
 *        WebM (said in the dialog; recorded in real time).
 *   GIF: gifenc.js (own encoder in a worker).
 * Cancel at any time; the page stays usable (one frame per task). */
(function (C4) {
  'use strict';
  const { el, clear, fmtTime } = C4.ui;
  const CFG = C4.mapConfig, X = CFG.EXPORT;

  let D = null;              // the open dialog: {api, box, form, ...}

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const parseMmss = v => { const m = /^\s*(\d{1,3}):([0-5]?\d)\s*$/.exec(v || ''); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null; };
  const fmtMB = b => (b >= 1e6 ? (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB');

  /** which H.264 configuration the browser can encode (null: none -> WebM fallback) */
  async function h264Config(width, height, fps, bitrate) {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
    for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42E028', 'avc1.42E01F']) {
      const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (err) { /* next */ }
    }
    return null;
  }
  const webmType = () => (typeof MediaRecorder === 'undefined' ? null
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || null);

  /* ---------- dialog ---------- */
  function open(api) {
    if (D) { D.box.querySelector('.ex-close').focus(); return; }
    const S = api.state, d = S.d;
    const box = el('div', { class: 'export-dlg', role: 'dialog', 'aria-label': 'Export video' });
    D = { api, box, running: false, cancel: false };
    const sel = (opts, value) => el('select', null, opts.map(o => el('option', { value: String(o[0]), selected: String(o[0]) === String(value) ? 'selected' : null }, o[1])));
    const f = D.form = {
      range: sel([['round', 'Whole round'], ['custom', 'Custom range']], 'round'),
      start: el('input', { type: 'text', size: '6', placeholder: 'mm:ss', title: 'start (' + (S.scope >= 0 ? 'round time' : 'match time') + ')' }),
      end: el('input', { type: 'text', size: '6', placeholder: 'mm:ss', title: 'end (' + (S.scope >= 0 ? 'round time' : 'match time') + ')' }),
      format: sel([['mp4', 'MP4'], ['gif', 'GIF']], 'mp4'),
      height: el('select'), fps: el('select'),
      speed: sel(X.SPEEDS.map(s => [s, s + '×']), 1),
      overlay: el('input', { type: 'checkbox', checked: 'checked' })
    };
    f.start.value = mmss(S.pb.t - S.base);
    f.end.value = mmss(Math.min(S.pb.range[1], S.pb.t + 15000) - S.base);
    const setFrom = which => el('button', { class: 'btn small', title: 'take the current position of the timeline', onclick: () => { f[which].value = mmss(S.pb.t - S.base); f.range.value = 'custom'; update(); } }, 'Set from slider');
    const fillFormat = () => {
      const gif = f.format.value === 'gif';
      const hs = gif ? X.GIF_HEIGHTS : X.MP4_HEIGHTS, fs = gif ? X.GIF_FPS : X.MP4_FPS;
      clear(f.height); for (const h of hs) f.height.append(el('option', { value: String(h) }, h + 'p'));
      clear(f.fps); for (const v of fs) f.fps.append(el('option', { value: String(v) }, v + ' fps'));
      f.height.value = String(hs[0]); f.fps.value = String(fs[gif ? 1 : 0]);
    };
    fillFormat();
    D.info = el('div', { class: 'ex-info' });
    D.warn = el('div', { class: 'ex-warn' });
    D.note = el('div', { class: 'ex-note' });
    D.bar = el('div', { class: 'ex-bar-fill' });
    D.pct = el('span', { class: 'ex-pct' });
    D.status = el('div', { class: 'ex-status' });
    D.progress = el('div', { class: 'ex-progress', hidden: true }, el('div', { class: 'ex-bar' }, D.bar), D.pct);
    D.startBtn = el('button', { class: 'btn primary', onclick: start }, 'Export');
    D.cancelBtn = el('button', { class: 'btn', hidden: true, onclick: () => { D.cancel = true; D.status.textContent = 'Cancelling …'; } }, 'Cancel');
    const row = (label, ...c) => el('div', { class: 'ex-row' }, el('span', { class: 'ex-label' }, label), ...c);
    box.append(
      el('div', { class: 'ex-head' }, el('strong', null, 'Export video'), el('button', { class: 'rp-close ex-close', title: 'close (Esc)', onclick: close }, '×')),
      row('Range', f.range),
      el('div', { class: 'ex-row ex-custom' }, el('span', { class: 'ex-label' }, ''), 'from ', f.start, setFrom('start'), ' to ', f.end, setFrom('end')),
      row('Format', f.format), row('Resolution', f.height), row('Frame rate', f.fps), row('Speed', f.speed),
      el('label', { class: 'ex-row ex-opt', title: 'round number, round time, score and the kill feed in the video' }, el('span', { class: 'ex-label' }, 'Overlay'), f.overlay, ' round, time, score, kill feed'),
      D.info, D.warn, D.note, D.progress, D.status,
      el('div', { class: 'ex-actions' }, D.cancelBtn, D.startBtn));
    document.body.append(box);
    for (const k of Object.keys(f)) f[k].addEventListener(f[k].tagName === 'INPUT' && f[k].type === 'text' ? 'input' : 'change', () => { if (k === 'format') fillFormat(); update(); });
    document.addEventListener('keydown', onKey, true);
    update();
  }

  const onKey = e => { if (e.key === 'Escape' && D && !D.running) { e.stopPropagation(); close(); } };

  function close() {
    if (!D) return;
    if (D.running) { D.cancel = D.closeAfter = true; return; }   // closes once the export stopped
    D.box.remove();
    document.removeEventListener('keydown', onKey, true);
    D.api.state.timeline.setBand(null);
    D = null;
  }

  /** the export plan from the form: range, frame times, size, file name */
  function plan() {
    const S = D.api.state, d = S.d, f = D.form;
    const mw = d.meta.mapWindow || { start: 0, end: d.meta.durationMs };
    let a, b, r;
    if (f.range.value === 'round') {
      r = S.scope >= 0 ? d.rounds[S.scope] : D.api.roundAtOrBefore(S.pb.t);
      if (!r) return { error: 'No round at the current position.' };
      a = r.start != null ? r.start : r.segStart;
      b = Math.min(r.segEnd, mw.end);
    } else {
      const s = parseMmss(f.start.value), e = parseMmss(f.end.value);
      if (s == null || e == null) return { error: 'Start and end as mm:ss.' };
      a = S.base + s; b = S.base + e;
      if (b <= a) return { error: 'The end must be after the start.' };
      a = Math.max(a, S.pb.range[0]); b = Math.min(b, S.pb.range[1]);
      if (b <= a) return { error: 'The range is outside the replay range.' };
      r = D.api.roundAtOrBefore(a);
    }
    const gif = f.format.value === 'gif', fps = Number(f.fps.value), speed = Number(f.speed.value), H = Number(f.height.value);
    // frame times: demo time advances speed / fps per frame; countdowns are skipped as in the playback
    const times = [], step = speed * 1000 / fps;
    for (let t = a; t <= b && times.length < 200000;) {
      const skip = S.pb.skips.find(s => t >= s[0] && t < s[1]);
      if (skip) { t = skip[1]; continue; }
      times.push(t);
      t += step;
    }
    const R = S.renderer, dpr = H / R.h, W = Math.max(2, Math.round(R.w * dpr / 2) * 2);
    const seconds = times.length / fps;
    const bytes = gif ? W * H * times.length * X.GIF_BYTES_PER_PIXEL : X.MP4_BITRATE[H] * (fps >= 60 ? 1.5 : 1) * X.MP4_SIZE_FACTOR * seconds / 8;
    // file name: the export scheme + round + range (round time)
    const base = C4.exportName.buildExportFileName(d, { ext: 'x' }).replace(/\.x$/, '');
    const live = r ? (r.start != null ? r.start : r.segStart) : 0;
    const rl = r ? '_R' + C4.exportName.fileNamePart(String(r.label != null ? r.label : r.number), 8) : '';
    const range = f.range.value === 'custom' ? '_' + mmss(a - live).replace(':', '') + '-' + mmss(b - live).replace(':', '') : '';
    return { a, b, r, gif, fps, speed, H, W, dpr, times, seconds, bytes, name: base + rl + range + '.' + (gif ? 'gif' : 'mp4') };
  }

  async function update() {
    if (!D || D.running) return;
    const tok = D.tok = (D.tok || 0) + 1;         // only the newest update sets the H.264 result
    const f = D.form, p = plan();
    D.box.querySelector('.ex-custom').hidden = f.range.value !== 'custom';
    if (p.error) { D.info.textContent = p.error; D.warn.textContent = ''; D.startBtn.disabled = true; D.api.state.timeline.setBand(null); return; }
    D.plan = p;
    D.api.state.timeline.setBand([p.a, p.b]);
    D.startBtn.disabled = false;
    D.info.textContent = p.W + ' × ' + p.H + ', ' + p.times.length + ' frames, ' + p.seconds.toFixed(1) + ' s of video (' + mmss(p.b - p.a) + ' of demo time at ' + p.speed + '×), ≈ ' + fmtMB(p.bytes) + '  ·  ' + p.name;
    const w = [];
    if (p.gif && p.seconds > X.GIF_WARN_SECONDS) w.push('A GIF longer than ' + X.GIF_WARN_SECONDS + ' s gets large and slow to play - MP4 is better for long scenes.');
    if (p.bytes > X.WARN_MB * 1e6) w.push('The file will probably be larger than ' + X.WARN_MB + ' MB.');
    D.warn.textContent = w.join(' ');
    D.note.textContent = '';
    if (!p.gif) {
      D.h264 = undefined;                          // unknown until checked (start() waits for it)
      const cfg = await h264Config(p.W, p.H, p.fps, X.MP4_BITRATE[p.H] * (p.fps >= 60 ? 1.5 : 1));
      if (!D || D.tok !== tok) return;
      D.h264 = cfg;
      if (!cfg) D.note.textContent = webmType() ? 'This browser cannot encode H.264 (WebCodecs): the video is recorded as WebM instead of MP4, in real time (' + p.seconds.toFixed(0) + ' s).' : 'This browser can encode neither MP4 nor WebM.';
    }
  }

  /* ---------- export ---------- */
  async function start() {
    if (!D || D.running || !D.plan) return;
    const p = D.plan, api = D.api, S = api.state;
    D.running = true; D.cancel = false;
    if (!p.gif && D.h264 === undefined) D.h264 = await h264Config(p.W, p.H, p.fps, X.MP4_BITRATE[p.H] * (p.fps >= 60 ? 1.5 : 1));
    for (const x of Object.values(D.form)) x.disabled = true;
    D.startBtn.hidden = true; D.cancelBtn.hidden = false; D.progress.hidden = false;
    D.status.textContent = 'Rendering …';
    const view = S.renderer;
    // the export renderer: the view's size in css px, drawn at the export resolution
    const stage = { getBoundingClientRect: () => ({ width: view.w, height: view.h }), append() {} };
    const R = new C4.MapRenderer(stage, view.world, { dpr: p.dpr, noInput: true });
    R.rot = view.rot; R.zoom = view.zoom; R.pan = { x: view.pan.x, y: view.pan.y };
    R.image = view.image; R.imageRect = view.imageRect;
    R.resize();
    R.canvas.width = p.W; R.canvas.height = p.H;
    const progress = (i, n) => { const v = Math.min(100, Math.floor(100 * i / n)); D.bar.style.width = v + '%'; D.pct.textContent = v + ' %'; };
    const drawAt = t => { api.drawFrame(R, t); if (D.form.overlay.checked) drawOverlay(R, S.d, t); };
    let result = null, kind = p.gif ? 'gif' : 'mp4';
    try {
      if (p.gif) result = await exportGif(p, R, drawAt, progress);
      else if (D.h264) result = await exportMp4(p, R, drawAt, progress, D.h264);
      else { result = await exportWebm(p, R, drawAt, progress); kind = 'webm'; }
    } catch (err) {
      if (!D.cancel) { console.error(err); D.status.textContent = 'Export failed: ' + err.message; }
      result = null;
    }
    api.done();
    if (!D) return;
    D.running = false;
    for (const x of Object.values(D.form)) x.disabled = false;
    D.startBtn.hidden = false; D.cancelBtn.hidden = true;
    if (D.cancel) {
      D.status.textContent = 'Export cancelled.'; D.progress.hidden = true; D.cancel = false;
      if (D.closeAfter) close();
      return;
    }
    if (!result) return;
    const name = kind === 'webm' ? p.name.replace(/\.mp4$/, '.webm') : p.name;
    const a = el('a', { href: URL.createObjectURL(result), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    progress(1, 1);
    D.status.textContent = 'Saved ' + name + ' (' + fmtMB(result.size) + ')' + (kind === 'webm' ? ' - WebM instead of MP4 (no H.264 encoder in this browser)' : '') + '.';
    D.lastBlob = result;
  }

  async function exportMp4(p, R, drawAt, progress, cfg) {
    const samples = [];
    let avcC = null, failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (desc && !avcC) avcC = desc instanceof ArrayBuffer ? new Uint8Array(desc.slice(0)) : new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, key: chunk.type === 'key' });
      },
      error: e => { failure = e; }
    });
    encoder.configure(cfg);
    const n = p.times.length, frameUs = 1e6 / p.fps;
    try {
      for (let i = 0; i < n; i++) {
        if (D.cancel) return null;
        if (failure) throw failure;
        drawAt(p.times[i]);
        const vf = new VideoFrame(R.canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
        encoder.encode(vf, { keyFrame: i % (p.fps * 2) === 0 });
        vf.close();
        while (encoder.encodeQueueSize > 6) await sleep(4);
        progress(i + 1, n + 2);
        if (i % 2 === 0) await sleep(0);                   // keep the page responsive
      }
      D.status.textContent = 'Encoding …';
      await encoder.flush();
    } finally {
      try { if (encoder.state !== 'closed') encoder.close(); } catch (err) { /* closed */ }
    }
    if (failure) throw failure;
    if (!avcC) throw new Error('the encoder gave no decoder configuration');
    return C4.mp4Mux({ width: p.W, height: p.H, fps: p.fps, avcC, samples });
  }

  async function exportGif(p, R, drawAt, progress) {
    const gif = C4.gifEncoder.create(p.W, p.H, Math.round(100 / p.fps));
    const n = p.times.length;
    try {
      for (let i = 0; i < n; i++) {
        if (D.cancel) { gif.cancel(); return null; }
        drawAt(p.times[i]);
        // GIF delays are in 1/100 s: 15 fps alternates 7 / 7 / 6, so the speed stays exact
        const delay = Math.round((i + 1) * 100 / p.fps) - Math.round(i * 100 / p.fps);
        await gif.add(R.ctx.getImageData(0, 0, p.W, p.H), delay);
        progress(i + 1, n + 1);
        await sleep(0);
      }
      D.status.textContent = 'Encoding …';
      return await gif.finish();
    } catch (err) {
      gif.cancel();
      if (D.cancel) return null;
      throw err;
    }
  }

  /** fallback without WebCodecs: MediaRecorder (WebM), one frame per frame period in real time */
  async function exportWebm(p, R, drawAt, progress) {
    const type = webmType();
    if (!type) throw new Error('no video encoder in this browser');
    const stream = R.canvas.captureStream(0), track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: X.MP4_BITRATE[p.H] * (p.fps >= 60 ? 1.5 : 1) });
    const parts = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(1000);
    const n = p.times.length, period = 1000 / p.fps, t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (D.cancel) break;
      drawAt(p.times[i]);
      if (track.requestFrame) track.requestFrame();
      progress(i + 1, n);
      const wait = t0 + (i + 1) * period - performance.now();
      await sleep(Math.max(0, wait));
    }
    rec.stop();
    track.stop();
    await stopped;
    return D.cancel ? null : new Blob(parts, { type: 'video/webm' });
  }

  /* ---------- overlay: round, round time, score, kill feed ---------- */
  function drawOverlay(R, d, t) {
    const g = R.ctx, app = C4.app;
    g.save();
    g.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    const ri = C4.events.roundAt(d.rounds, t), r = ri >= 0 ? d.rounds[ri] : null;
    let score = d.initialScore || { A: 0, B: 0 };
    for (const x of d.rounds) if (x.kind === 'round' && x.end != null && x.end <= t && x.scoreAfter) score = x.scoreAfter;
    const shown = d.teams.filter(tm => d.players.some(p => p.team === tm.key));
    const font = (w, s) => w + ' ' + s + 'px "Segoe UI", system-ui, sans-serif';
    // top left: round / round time, score
    const line1 = r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : '') + '  ·  ' + C4.ui.fmtRoundTime(d, ri, t) : fmtTime(t);
    const parts = [];
    shown.forEach((tm, i) => { if (i) parts.push([' : ', '#c9d1db']); parts.push([tm.name + ' ' + (score[tm.key] != null ? score[tm.key] : 0), app.teamColor(tm.key)]); });
    g.font = font('700', 13);
    const w2 = parts.reduce((s, x) => s + g.measureText(x[0]).width, 0);
    g.font = font('600', 12);
    const w1 = g.measureText(line1).width;
    const bw = Math.max(w1, w2) + 16;
    g.fillStyle = 'rgba(8,10,14,0.78)'; g.fillRect(8, 8, bw, 42);
    g.textBaseline = 'middle';
    g.fillStyle = '#dde3ea'; g.fillText(line1, 16, 20);
    g.font = font('700', 13);
    let x = 16;
    for (const [txt, col] of parts) { g.fillStyle = col; g.fillText(txt, x, 38); x += g.measureText(txt).width; }
    // top right: kill feed (kills of the last seconds)
    const feed = d.kills.filter(k => k.t <= t && t - k.t < X.KILLFEED_MS && k.t >= (r ? r.segStart : -Infinity)).slice(-X.KILLFEED_LINES);
    g.font = font('600', 12);
    let y = 14;
    for (const k of feed) {
      const pl = cl => (d.players.find(p => p.client === cl) || {});
      const a = k.world || k.entityAttacker ? null : pl(k.attacker), v = pl(k.victim);
      const segs = [];
      if (a && !k.suicide) segs.push([a.cleanName || '?', app.teamColor(a.team)]);
      segs.push(['  [' + (k.weaponLabel || '?') + (k.headshot ? ', headshot' : '') + ']  ', '#c9d1db']);
      segs.push([v.cleanName || '?', app.teamColor(v.team)]);
      const w = segs.reduce((s, q) => s + g.measureText(q[0]).width, 0);
      const x0 = R.w - 8 - w - 12;
      g.globalAlpha = Math.min(1, (X.KILLFEED_MS - (t - k.t)) / 800);
      g.fillStyle = 'rgba(8,10,14,0.78)'; g.fillRect(x0, y - 9, w + 12, 18);
      let xx = x0 + 6;
      for (const [txt, col] of segs) { g.fillStyle = col; g.fillText(txt, xx, y); xx += g.measureText(txt).width; }
      g.globalAlpha = 1;
      y += 21;
    }
    g.restore();
  }

  C4.mapExport = { open, close, get dialog() { return D; } };
})(window.C4);
