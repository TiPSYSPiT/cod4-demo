/* 3D view: export a part of the demo as MP4 or GIF.
 *
 * Offline, frame by frame: for every output frame the playback time advances by speed / fps, the
 * view draws that moment (players, animations, effects - all driven by the demo time), the camera
 * moves by one frame of video time, and the scene is rendered at the export size by the view's own
 * renderer (no second copy of the map on the GPU). The frame is copied onto a 2D canvas, the
 * overlays are drawn there (the DOM labels and panels of the page are not part of the WebGL
 * picture) and the canvas goes to the encoder. A slow computer gives the same video, only later.
 *   MP4: WebCodecs VideoEncoder (H.264) + js/c4/ui/map/mp4mux.js. Without WebCodecs / H.264:
 *        MediaRecorder (WebM), recorded in real time - said in the dialog.
 *   GIF: js/c4/ui/map/gifenc.js (own encoder in a worker built from a Blob; colours, dithering).
 *   Sound (MP4): the camera of every frame is kept; after the frames the sounds of the range are
 *        rendered offline for that camera path (sound.js render: OfflineAudioContext) and encoded with
 *        WebCodecs AudioEncoder (AAC, else Opus) into the MP4's audio track. The WebM fallback records
 *        in real time: the live sound (sound.js update per frame, the frame's camera) goes into the
 *        recording's audio track instead of the speakers. GIF has no sound.
 * Before the first frame every model, animation, effect and texture the range needs is loaded (a
 * quick pass over the range triggers the loads). Afterwards - or on cancel - time, play state,
 * camera, selection and display settings are restored. */
import * as THREE from 'three';
import { graphics } from './graphics.js';
import { XRAY_MODES, declutter } from './xray.js';
import '../c4/ui/killfeed.js';                     // C4.killfeed (a classic script, loaded here: see the file)
import { listenerOf } from './sound.js';

const C4 = window.C4;
const { el, clear, fmtTime } = C4.ui;
const CFG = C4.mapConfig, X = CFG.EXPORT;

const SIZES = {
  mp4: [['1920x1080', '1920 × 1080'], ['1280x720', '1280 × 720'], ['854x480', '854 × 480'], ['view', 'Current viewport']],
  gif: [['854x480', '854 × 480'], ['640x360', '640 × 360'], ['480x270', '480 × 270'], ['view', 'Current viewport']]
};
const FPS = { mp4: [60, 30, 15], gif: [15, 10] };
// H.264 bits per pixel and frame (quality presets)
const MP4_QUALITY = [['high', 'High', 0.15], ['medium', 'Medium', 0.09], ['low', 'Low', 0.05]];
// GIF: palette size, dithering; bytes per pixel and frame for the size estimate (measured: a moving
// follow camera 0.34 at 256 colours; a still camera much less - the encoder stores only what changed)
const GIF_QUALITY = [['256d', '256 colours, dithered', 256, true, 0.42], ['256', '256 colours', 256, false, 0.36],
  ['128', '128 colours', 128, false, 0.3], ['64', '64 colours', 64, false, 0.24]];
const MP4_SIZE_FACTOR = 0.9;                  // the encoder's share of the target bit rate (3D scenes: nearly all)
const GIF_WARN_MB = 40;
const WARM_STEP = 250;                        // ms of demo time between the frames of the loading pass

let D = null;                                 // the open dialog

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const fmtMB = b => (b >= 1e6 ? (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB');
const fmtDur = s => (s >= 60 ? Math.floor(s / 60) + ' min ' + String(Math.round(s % 60)).padStart(2, '0') + ' s' : Math.max(0, Math.round(s)) + ' s');
const part = (v, n) => C4.exportName.fileNamePart(String(v), n);

/** the H.264 configuration this browser can encode (null: none -> WebM) */
async function h264Config(width, height, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42E028', 'avc1.42E01F']) {
    const cfg = { codec, width, height, bitrate: Math.round(bitrate), framerate: fps, avc: { format: 'avc' } };
    try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (err) { /* next */ }
  }
  return null;
}
const webmType = () => (typeof MediaRecorder === 'undefined' ? null
  : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || null);

/** the audio configuration this browser can encode for the MP4 (null: none - the video stays silent) */
async function audioConfig() {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || typeof OfflineAudioContext === 'undefined') return null;
  for (const [codec, kind] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return Object.assign(cfg, { kind }); } catch (err) { /* next */ }
  }
  return null;
}

/** a readable message for an export error */
function errorText(err) {
  const m = String(err && err.message || err);
  if (err instanceof RangeError || /memory|allocation|Array buffer/i.test(m)) return 'Out of memory - try a lower resolution or frame rate, or a shorter range.';
  if (/context lost/i.test(m)) return 'The graphics context was lost (GPU reset or out of video memory) - reload the page and try a lower resolution.';
  return 'Export failed: ' + m;
}

/* ---------- dialog ---------- */
export function openExport(view) {
  if (D) { D.box.querySelector('.ex-close').focus(); return; }
  const R = view.R, d = R.d;
  const box = el('div', { class: 'export-dlg export-3d', role: 'dialog', 'aria-label': 'Export 3D video' });
  D = { view, R, box, running: false, cancel: false };
  const sel = (opts, value) => el('select', null, opts.map(o => el('option', { value: String(o[0]), selected: String(o[0]) === String(value) ? 'selected' : null }, o[1])));
  const num = (value, title) => el('input', { type: 'text', size: '3', value: String(value), title });
  const check = (on, title) => el('input', { type: 'checkbox', class: 'tog', checked: on ? 'checked' : null, title });
  const sl = R.selection;
  const f = D.form = {
    range: sel([['selection', 'Timeline selection ([ ] markers)'], ['round', 'Current round'], ['kill', 'Around a kill']],
      sl.a != null && sl.b != null ? 'selection' : killNearby() ? 'kill' : 'round'),
    kill: el('select', { class: 'ex-kill' }),
    before: num(3, 'seconds before the kill'), after: num(2, 'seconds after the kill'),
    format: sel([['mp4', 'MP4'], ['gif', 'GIF']], 'mp4'),
    size: el('select'), fps: el('select'), quality: el('select'),
    speed: sel([[0.5, '0.5×'], [1, '1×'], [2, '2×']], 1),
    // X-Ray: the view's current mode by default, so the video looks like the view
    xray: sel(XRAY_MODES.map(([v, label]) => [v, label + (v === view.xrayMode ? ' (as in the view)' : '')]), view.xrayMode || 'off'),
    labels: check(true, 'player names (as the Names option) and bomb site letters'),
    killfeed: check(true, 'the kills of the last seconds, top right'),
    sound: check(!!view.sound, 'the game\'s sounds at the camera (MP4; the WebM fallback records them in real time): shots, impacts, footsteps, explosions, the announcer'),
    markers: check(true, 'kill lines, death crosses and the bomb in the scene'),
    hud: check(true, 'round, round time and score, top left'),
    title: check(true, 'map, game type and round, bottom left')
  };
  fillKills();
  const fillFormat = () => {
    const fmt = f.format.value;
    clear(f.size); for (const [v, l] of SIZES[fmt]) f.size.append(el('option', { value: v }, l));
    clear(f.fps); for (const v of FPS[fmt]) f.fps.append(el('option', { value: String(v) }, v + ' fps'));
    clear(f.quality); for (const q of fmt === 'gif' ? GIF_QUALITY : MP4_QUALITY) f.quality.append(el('option', { value: q[0] }, q[1]));
    f.size.value = fmt === 'gif' ? '640x360' : '1280x720';
    f.fps.value = fmt === 'gif' ? '15' : '30';
    f.quality.value = fmt === 'gif' ? '256' : 'medium';
  };
  fillFormat();
  D.camera = el('span', { class: 'ex-cam' });
  D.info = el('div', { class: 'ex-info' });
  D.warn = el('div', { class: 'ex-warn' });
  D.note = el('div', { class: 'ex-note' });
  D.bar = el('div', { class: 'ex-bar-fill' });
  D.pct = el('span', { class: 'ex-pct' });
  D.status = el('div', { class: 'ex-status' });
  D.progress = el('div', { class: 'ex-progress', hidden: true }, el('div', { class: 'ex-bar' }, D.bar), D.pct);
  D.startBtn = el('button', { class: 'tb pri', onclick: start }, 'Export');
  D.cancelBtn = el('button', { class: 'tb', hidden: true, onclick: () => { D.cancel = true; D.status.textContent = 'Cancelling …'; } }, 'Cancel');
  const row = (label, ...c) => el('div', { class: 'ex-row' }, el('span', { class: 'ex-label' }, label), ...c);
  const opt = (input, text) => el('label', { class: 'ex-check' }, input, el('span', null, text));
  D.killRow = el('div', { class: 'ex-row ex-sub' }, el('span', { class: 'ex-label' }, ''), f.kill, el('span', { class: 'ex-inline ex-small' }, f.before, ' s before, ', f.after, ' s after'));
  D.selRow = el('div', { class: 'ex-row ex-sub ex-small' }, el('span', { class: 'ex-label' }, ''), el('span', { class: 'ex-sel' }));
  box.append(
    el('div', { class: 'ex-head' }, el('b', null, 'Export 3D video'), el('button', { class: 'ib ex-close', title: 'close (Esc)', 'aria-label': 'Close', onclick: close }, C4.ui.icon('x'))),
    el('div', { class: 'ex-subtitle' }, '3D view · ' + (d.meta.mapDisplay || d.meta.map || 'map') + ' · ' + (d.meta.gametypeDisplay || d.meta.gametype || '')),
    el('div', { class: 'ex-form' },
      row('Range', f.range), D.killRow, D.selRow,
      row('Format', f.format), row('Resolution', f.size), row('Frame rate', f.fps), row('Speed', f.speed), row('Quality', f.quality),
      row('Camera', D.camera),
      row('X-Ray', f.xray),
      el('div', { class: 'ex-row' }, el('span', { class: 'ex-label' }, 'Sound'), opt(f.sound, view.sound ? 'Game sounds (not in GIF)' : 'Game sounds (no sound data for this map)')),
      el('div', { class: 'ex-row ex-opts' }, el('span', { class: 'ex-label' }, 'Overlays'),
        el('div', { class: 'ex-checks' }, opt(f.labels, 'Name labels'), opt(f.killfeed, 'Kill feed'), opt(f.markers, 'Bomb / kill markers'),
          opt(f.hud, 'Score and timer'), opt(f.title, 'Title (map, mode, round)'))),
      D.info, D.warn, D.note, D.progress, D.status),
    el('div', { class: 'ex-actions' }, D.cancelBtn, D.startBtn));
  document.body.append(box);
  for (const k of Object.keys(f)) f[k].addEventListener(f[k].tagName === 'INPUT' && f[k].type === 'text' ? 'input' : 'change', () => { if (k === 'format') fillFormat(); update(); });
  document.addEventListener('keydown', onKey, true);
  D.off = R.on(what => { if (D && !D.running && (what === 'selection-range' || what === 'focus' || what === 'scope')) { if (what === 'scope') fillKills(); update(); } });
  D.timer = setInterval(() => { if (D && !D.running) updateCamera(); }, 500);
  update();

  /** the kill the user is looking at: the one nearest to the current time (a click in the feed jumps
   *  to 2 s before its kill), live kills first */
  function killNearby() {
    let best = null, bd = Infinity;
    for (const k of d.kills) {
      if (k.t < R.pb.range[0] || k.t > R.pb.range[1]) continue;
      const dist = Math.abs(k.t - R.pb.t) + (k.phase === 'live' ? 0 : 1e7);
      if (dist < bd) { bd = dist; best = k; }
    }
    return best;
  }
  function fillKills() {
    const near = killNearby();
    clear(f.kill);
    d.kills.forEach((k, i) => {
      if (k.t < R.pb.range[0] || k.t > R.pb.range[1]) return;
      const a = k.world || k.suicide || k.attacker >= 64 ? '' : R.match.name(k.attacker) + ' ';
      f.kill.append(el('option', { value: String(i), selected: k === near ? 'selected' : null }, fmtTime(k.t - R.base) + '  ' + a + '[' + (k.weaponLabel || '?') + (k.headshot ? ', HS' : '') + '] ' + R.match.name(k.victim)));
    });
    if (!f.kill.options.length) f.kill.append(el('option', { value: '' }, 'no kills in this range'));
  }
}

const onKey = e => { if (e.key === 'Escape' && D && !D.running) { e.stopPropagation(); close(); } };

function close() {
  if (!D) return;
  if (D.running) { D.cancel = D.closeAfter = true; return; }
  D.box.remove();
  document.removeEventListener('keydown', onKey, true);
  clearInterval(D.timer);
  D.off();
  D.R.timeline.setBand(null);
  D = null;
}

/** the camera the export uses: the view's mode and player */
function cameraText() {
  const v = D.view, mode = v.cams.mode, M = v.M;
  const names = { orbit: 'Orbit', free: 'Free', follow: 'Follow', fp: 'First person' };
  let s = names[mode] || mode;
  if (mode === 'follow' || mode === 'fp') {
    const cl = v.R.focus != null ? v.R.focus : M.followedAt(v.R.pb.t);
    s += cl != null ? ' · ' + M.name(cl) + (v.R.focus == null ? ' (the followed player of the POV)' : '') : ' · no player selected';
  } else s += ' (the current view)';
  return s + ' · players: ' + (v.actors.mode === 'models' ? 'Models' : 'Simple');
}
function updateCamera() { if (D) D.camera.textContent = cameraText(); }

/** the export plan: range, frame times, size, quality, file name */
function plan() {
  const R = D.R, d = R.d, M = R.match, f = D.form, view = D.view;
  const mw = d.meta.mapWindow || { start: 0, end: d.meta.durationMs };
  let a, b, r, kill = null, label = '';
  if (f.range.value === 'selection') {
    const s = R.selection;
    if (s.a == null || s.b == null) return { error: 'Set the start and the end of the range on the timeline: the [ and ] buttons (keys I and O) at the current time.' };
    a = s.a; b = s.b;
    if (b - a < 100) return { error: 'The selection is shorter than 0.1 s.' };
    r = M.roundAtOrBefore(a);
  } else if (f.range.value === 'round') {
    r = R.scope >= 0 ? d.rounds[R.scope] : M.roundAtOrBefore(R.pb.t);
    if (!r) return { error: 'No round at the current position.' };
    a = r.start != null ? r.start : r.segStart;
    b = Math.min(r.segEnd, mw.end);
  } else {
    kill = d.kills[Number(f.kill.value)];
    if (!kill || f.kill.value === '') return { error: 'No kill in this range.' };
    const before = Number(f.before.value), after = Number(f.after.value);
    if (!(before >= 0) || !(after >= 0) || before + after <= 0 || before > 120 || after > 120) return { error: 'Seconds before / after: 0 - 120.' };
    r = M.roundAtOrBefore(kill.t);
    a = kill.t - before * 1000; b = kill.t + after * 1000;
    if (r) { a = Math.max(a, r.segStart); b = Math.min(b, r.segEnd); }
  }
  a = Math.max(a, mw.start); b = Math.min(b, mw.end);
  if (b <= a) return { error: 'The range is empty.' };
  const gif = f.format.value === 'gif', fps = Number(f.fps.value), speed = Number(f.speed.value);
  let W, H;
  if (f.size.value === 'view') { W = Math.round(view.w || 1280); H = Math.round(view.h || 720); }
  else [W, H] = f.size.value.split('x').map(Number);
  W = Math.max(16, Math.round(W / 2) * 2); H = Math.max(16, Math.round(H / 2) * 2);
  // frame times: demo time advances speed / fps per frame; countdowns are skipped as in the playback
  const times = [], step = speed * 1000 / fps;
  for (let t = a; t <= b && times.length < 100000;) {
    const skip = R.pb.skips.find(s => t >= s[0] && t < s[1]);
    if (skip) { t = skip[1]; continue; }
    times.push(t);
    t += step;
  }
  if (!times.length) return { error: 'The range has no frames.' };
  const seconds = times.length / fps;
  const q = (gif ? GIF_QUALITY : MP4_QUALITY).find(x => x[0] === f.quality.value) || (gif ? GIF_QUALITY[1] : MP4_QUALITY[1]);
  const bitrate = Math.min(40e6, W * H * fps * q[2]);
  const bytes = gif ? W * H * times.length * q[4] : bitrate * seconds / 8 * MP4_SIZE_FACTOR;
  // file name: map, game type, round, then the kill / range / followed player
  const mode = view.cams.mode, camCl = mode === 'follow' || mode === 'fp' ? (R.focus != null ? R.focus : M.followedAt(a)) : null;
  const roundPart = r ? (r.kind === 'round' ? 'round' + String(r.label != null ? r.label : r.number).padStart(2, '0') : r.kind) : 'match';
  const live = r ? (r.start != null ? r.start : r.segStart) : 0;
  if (kill) label = (kill.world || kill.suicide || kill.attacker >= 64 ? part(M.name(kill.victim), 24) + '-death' : part(M.name(kill.attacker), 24) + '-kill');
  else if (f.range.value === 'selection') label = mmss(a - live).replace(':', '') + '-' + mmss(b - live).replace(':', '');
  if (camCl != null && !kill) label += (label ? '_' : '') + part(M.name(camCl), 24) + (mode === 'fp' ? '-pov' : '');
  const safe = v => String(v).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = [safe(d.meta.map || 'map').slice(0, 32), part(String(d.meta.gametype || '').toLowerCase() || 'game', 12), roundPart, label].filter(Boolean).join('_') + '.' + (gif ? 'gif' : 'mp4');
  return { a, b, r, kill, gif, fps, speed, W, H, times, seconds, bitrate, q, bytes, name };
}

async function update() {
  if (!D || D.running) return;
  const tok = D.tok = (D.tok || 0) + 1;
  const f = D.form, p = plan();
  D.killRow.hidden = f.range.value !== 'kill';
  D.selRow.hidden = f.range.value !== 'selection';
  const s = D.R.selection;
  D.selRow.querySelector('.ex-sel').textContent = 'start ' + (s.a != null ? fmtTime(s.a - D.R.base) : '–') + ', end ' + (s.b != null ? fmtTime(s.b - D.R.base) : '–') + ' (the [ ] buttons / keys I, O set them at the current time)';
  updateCamera();
  if (p.error) { D.info.textContent = p.error; D.warn.textContent = ''; D.note.textContent = ''; D.startBtn.disabled = true; D.R.timeline.setBand(null); return; }
  D.plan = p;
  D.R.timeline.setBand([p.a, p.b]);
  D.startBtn.disabled = false;
  D.info.textContent = p.W + ' × ' + p.H + ', ' + p.fps + ' fps, ' + p.times.length + ' frames: ' + p.seconds.toFixed(1) + ' s of video (' + mmss(p.b - p.a) + ' of demo time at ' + p.speed + '×), ≈ ' + fmtMB(p.bytes) + '  ·  ' + p.name;
  const w = [];
  if (p.gif && p.bytes > GIF_WARN_MB * 1e6) w.push('This GIF will be very large (≈ ' + fmtMB(p.bytes) + ') and slow to play - a smaller size, fewer colours, a lower frame rate or MP4 keeps it manageable.');
  else if (p.gif && p.seconds > X.GIF_WARN_SECONDS) w.push('A GIF longer than ' + X.GIF_WARN_SECONDS + ' s gets large - MP4 is better for long scenes.');
  if (!p.gif && p.bytes > X.WARN_MB * 1e6 * 4) w.push('The file will probably be larger than ' + fmtMB(X.WARN_MB * 4e6) + '.');
  D.warn.textContent = w.join(' ');
  D.note.textContent = '';
  if (!p.gif) {
    D.h264 = undefined;
    const cfg = await h264Config(p.W, p.H, p.fps, p.bitrate);
    if (!D || D.tok !== tok) return;
    D.h264 = cfg;
    if (!cfg) D.note.textContent = webmType() ? 'This browser cannot encode H.264 (WebCodecs) at this size: the video is recorded as WebM instead of MP4, in real time (' + fmtDur(p.seconds) + ').' : 'This browser can encode neither MP4 nor WebM - use GIF.';
  }
}

/* ---------- export ---------- */
async function start() {
  if (!D || D.running || !D.plan) return;
  const p = D.plan, view = D.view, R = D.R, f = D.form;
  if (!p.gif && D.h264 === undefined) D.h264 = await h264Config(p.W, p.H, p.fps, p.bitrate);
  if (!p.gif && !D.h264 && !webmType()) { D.status.textContent = 'This browser has no video encoder (neither WebCodecs H.264 nor MediaRecorder) - use GIF.'; return; }
  D.running = true; D.cancel = false;
  for (const x of Object.values(f)) x.disabled = true;
  D.startBtn.hidden = true; D.cancelBtn.hidden = false; D.progress.hidden = false;
  const progress = (i, n) => { const v = Math.min(100, Math.floor(100 * i / n)); D.bar.style.width = v + '%'; D.pct.textContent = v + ' %'; };
  progress(0, 1);
  const saved = saveState(view);
  const opts = { labels: f.labels.checked, killfeed: f.killfeed.checked, markers: f.markers.checked, hud: f.hud.checked, title: f.title.checked, xray: f.xray.value,
    sound: f.sound.checked && !!view.sound && !p.gif };
  let result = null, kind = p.gif ? 'gif' : D.h264 ? 'mp4' : 'webm';
  const t0 = performance.now();
  try {
    enterExport(view, p, opts);
    D.status.textContent = 'Loading what the range needs (models, animations, effects, textures) …';
    await prepare(view, p, progress);
    if (D.cancel) throw new Error('cancelled');
    const C = document.createElement('canvas');
    C.width = p.W; C.height = p.H;
    const g = C.getContext('2d', { willReadFrequently: p.gif });
    // the kill feed's icons are drawn into the frame (js/c4/ui/killfeed.js): all loaded before the first
    const kfImgs = opts.killfeed || opts.markers ? await C4.killfeed.images() : null;
    const ctx = { view, p, opts, C, g, kfImgs, t0: performance.now(), path: [], fp: [] };
    D.status.textContent = 'Rendering …';
    if (p.gif) result = await exportGif(ctx, progress);
    else if (D.h264) { result = await exportMp4(ctx, progress, D.h264); D.lastAudio = ctx.audio || null; }
    else { result = await exportWebm(ctx, progress); D.lastWebmSound = !!ctx.webmSound; }
  } catch (err) {
    if (!D.cancel) { console.error(err); D.status.textContent = errorText(err); }
    result = null;
  } finally {
    leaveExport(view, saved);
  }
  if (!D) return;
  D.running = false;
  for (const x of Object.values(f)) x.disabled = false;
  D.startBtn.hidden = false; D.cancelBtn.hidden = true;
  if (D.cancel) {
    D.status.textContent = 'Export cancelled - the replay is back where it was.'; D.progress.hidden = true; D.cancel = false;
    if (D.closeAfter) close();
    return;
  }
  if (!result) return;
  const name = kind === 'webm' ? p.name.replace(/\.mp4$/, '.webm') : p.name;
  if (!window.__exportNoDownload) {             // (tests keep the file in D.lastBlob only)
    const a = el('a', { href: URL.createObjectURL(result), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  progress(1, 1);
  D.status.textContent = 'Saved ' + name + ' (' + fmtMB(result.size) + ', ' + p.times.length + ' frames' +
    (kind === 'mp4' && D.lastAudio ? ', sound ' + D.lastAudio.codec.toUpperCase() : '') + (kind === 'webm' && D.lastWebmSound ? ', sound' : '') + ' in ' + fmtDur((performance.now() - t0) / 1000) + ')' +
    (kind === 'webm' ? ' - WebM instead of MP4: this browser has no H.264 encoder (WebCodecs).' : '.');
  D.lastBlob = result;
  D.lastKind = kind;
  D.lastName = name;
}

/* ---------- the view during the export ---------- */
function saveState(view) {
  const R = view.R, cams = view.cams, cam = view.camera;
  return {
    t: R.pb.t, playing: R.pb.playing, active: R.pb.active, hover: R.hover,
    mode: cams.mode, pos: cam.position.clone(), quat: cam.quaternion.clone(), target: cams.orbit.target.clone(),
    yaw: cams.yaw, pitch: cams.pitch, followLast: cams.followLast ? cams.followLast.clone() : null, fov: cam.fov,
    pixelRatio: view.renderer.getPixelRatio(), markers: view.effects.markers, xray: view.xrayMode,
    simPerFrame: view.fx ? view.fx.simPerFrame : null
  };
}

function enterExport(view, p, opts) {
  const R = view.R;
  R.pb.playing = false;
  R.pb.active = false;                       // the page's playback clock stops; the export sets the time
  R.hover = null;
  view.exporting = true;
  view.labels.style.visibility = 'hidden';   // the labels go into the frames instead
  view.effects.markers = opts.markers;
  view.setXray(opts.xray);                   // (not remembered: the view's own mode comes back afterwards)
  if (view.fx) view.fx.simPerFrame = Infinity;   // every colliding element complete in every frame
  // the renderer at the export size; the page shows the frames scaled into the view as a preview
  view.renderer.setPixelRatio(1);
  view.renderer.setSize(p.W, p.H, false);
  view.renderer.domElement.style.objectFit = 'contain';
  view.camera.aspect = p.W / p.H;
  view.camera.updateProjectionMatrix();
}

function leaveExport(view, s) {
  const R = view.R, cams = view.cams, cam = view.camera;
  view.exporting = false;
  view.labels.style.visibility = '';
  view.effects.markers = s.markers;
  view.setXray(s.xray);
  if (view.fx && s.simPerFrame != null) view.fx.simPerFrame = s.simPerFrame;
  view.renderer.domElement.style.objectFit = '';
  view.renderer.setPixelRatio(s.pixelRatio);
  cam.position.copy(s.pos); cam.quaternion.copy(s.quat); cam.fov = s.fov;
  cams.orbit.target.copy(s.target);
  cams.yaw = s.yaw; cams.pitch = s.pitch; cams.followLast = s.followLast;
  if (cams.mode === 'orbit') cams.orbit.update();
  view.resize();
  R.hover = s.hover;
  R.pb.active = s.active;
  R.pb.seek(s.t);
  R.pb.playing = s.playing;
  R.pb.last = null;
  view.needsRender = true;
  R.invalidate();
}

/** one pass over the range (every WARM_STEP ms) draws each moment once, so that the models,
 *  animations and effect models it needs start loading; then wait for them and for the textures */
async function prepare(view, p, progress) {
  const R = view.R, deadline = performance.now() + 60000;
  const waitFor = async (cond, ms = 30000) => { const end = performance.now() + ms; while (!cond() && performance.now() < end && !D.cancel) await sleep(100); };
  // the map and the effects (fx.js loads after the world; its traces run when the page is idle)
  await waitFor(() => view.world || view.hint.classList.contains('warn'));
  const fxOff = graphics().fx === 'off';                // (graphics.js: the Graphics popover or ?fx=off)
  if (view.world && !fxOff) await waitFor(() => view.fx, 15000);
  if (view.fx && view.fx.tracer) await waitFor(() => view.fx.ready, 30000);
  // character models and animations
  const A = view.actors;
  if (A.mode === 'models') { if (A.animLoading) await A.animLoading; if (A.weaponLoading) await A.weaponLoading; }
  const fst = R.d.meta.firstServerTime || 0;
  const warm = [];
  for (let t = p.a; t <= p.b; t += WARM_STEP) warm.push(t);
  warm.push(p.b);
  for (let i = 0; i < warm.length; i++) {
    if (D.cancel) return;
    R.pb.t = warm[i];
    R.frame(warm[i]);
    if (view.fx) view.fx.update(warm[i] + fst, view.camera, cl => A.muzzle(cl), view.fxOpts);
    if (i % 8 === 0) { progress(i, warm.length * 4); await sleep(0); }
  }
  // everything that started loading (models: CharacterLibrary promises)
  for (let round = 0; round < 3 && performance.now() < deadline; round++) {
    const pending = [...view.characters.models.values()];
    await Promise.race([Promise.allSettled(pending), sleep(20000)]);
    await sleep(50);                         // the callbacks that build the characters
    R.frame(p.a);
    if (view.fx) view.fx.update(p.a + fst, view.camera, cl => A.muzzle(cl), view.fxOpts);
    if (view.characters.models.size === pending.length) break;
  }
  // textures still loading (image not there yet)
  await waitFor(() => pendingTextures(view.scene) === 0, Math.max(1000, deadline - performance.now()));
  const left = pendingTextures(view.scene);
  if (left) D.note.textContent = left + ' texture(s) did not finish loading - they may appear late in the video.';
  progress(1, 4);
}

function pendingTextures(scene) {
  const seen = new Set();
  let n = 0;
  const check = tex => {
    if (!tex || !tex.isTexture || seen.has(tex) || tex.isRenderTargetTexture || tex.isDataTexture || tex.isData3DTexture || tex.isCanvasTexture) return;
    seen.add(tex);
    if (tex.source && tex.source.data == null && tex.isCubeTexture !== true) n++;
  };
  scene.traverse(o => {
    if (!o.material || !o.visible) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) check(v); }
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) check(u.value);
    }
  });
  return n;
}

/** draw output frame i: demo time t, one frame of camera motion, render, copy, overlays */
function drawFrame(ctx, i) {
  const { view, p, g, C } = ctx, R = view.R, t = p.times[i];
  if (view.renderer.getContext().isContextLost()) throw new Error('WebGL context lost');
  R.pb.t = t;
  R.frame(t);                                 // panels, timeline (progress) and view.draw(t)
  const r = view.renderFrame(1 / p.fps, p.speed / p.fps, true);
  ctx.path[i] = listenerOf(view.camera);       // the sound's listener in this frame
  ctx.fp[i] = r && r.hideClient != null ? r.hideClient : null;
  g.drawImage(view.renderer.domElement, 0, 0, C.width, C.height);
  drawOverlays(ctx, t, r ? r.hideClient : null);
  if (window.__exportProbe) probe(ctx, i);
}

/** tests (tools/validate/export3d.html): the mean change of a small copy of each frame against the
 *  previous one, in 0..255 - a frame that jumps (flicker, a missing model) stands out */
function probe(ctx, i) {
  const w = 96, h = 54;
  const c = ctx.probeC || (ctx.probeC = Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(ctx.C, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let diff = 0, sum = 0;
  for (let k = 0; k < px.length; k += 4) sum += px[k] + px[k + 1] + px[k + 2];
  if (ctx.probePrev) for (let k = 0; k < px.length; k += 4) diff += Math.abs(px[k] - ctx.probePrev[k]) + Math.abs(px[k + 1] - ctx.probePrev[k + 1]) + Math.abs(px[k + 2] - ctx.probePrev[k + 2]);
  ctx.probePrev = px;
  window.__exportProbe.push({ i, t: ctx.p.times[i], diff: i ? diff / (w * h * 3) : 0, mean: sum / (w * h * 3) });
}

/* ---------- encoders ---------- */
function eta(ctx, i, n) {
  const secs = (performance.now() - ctx.t0) / 1000, rate = i / Math.max(0.001, secs);
  return 'Rendering frame ' + i + ' / ' + n + ' · ' + rate.toFixed(1) + ' frames/s · about ' + fmtDur((n - i) / Math.max(0.01, rate)) + ' left';
}

async function exportMp4(ctx, progress, cfg) {
  const { p, C } = ctx;
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
      drawFrame(ctx, i);
      const vf = new VideoFrame(C, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(vf, { keyFrame: i % (p.fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 4) await sleep(2);
      progress(i + 1, n + 2);
      if (i % 4 === 0) D.status.textContent = eta(ctx, i + 1, n);
      await sleep(0);                          // the page stays responsive (Cancel)
    }
    D.status.textContent = 'Encoding …';
    await encoder.flush();
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch (err) { /* closed */ }
  }
  if (failure) throw failure;
  if (!avcC) throw new Error('the encoder gave no decoder configuration');
  let audio = null;
  if (ctx.opts.sound && !D.cancel) {
    try { audio = await encodeSound(ctx); } catch (err) { console.warn('sound not exported:', err); D.note.textContent = 'The sound could not be exported (' + (err.message || err) + ') - the video is silent.'; }
    if (D.cancel) return null;
  }
  ctx.audio = audio;
  return C4.mp4Mux({ width: p.W, height: p.H, fps: p.fps, avcC, samples, audio });
}

/** the sounds of the range for the frames' camera path (sound.js render), encoded -> the muxer's audio
 *  track or null (no encoder) */
async function encodeSound(ctx) {
  const { view, p } = ctx;
  const cfg = await audioConfig();
  if (!cfg) { D.note.textContent = 'This browser cannot encode audio (WebCodecs AudioEncoder) - the video is silent.'; return null; }
  D.status.textContent = 'Rendering the sound …';
  const buf = await view.sound.render({ times: p.times, fps: p.fps, speed: p.speed, path: ctx.path, fp: ctx.fp,
    onProgress: f => { D.status.textContent = 'Loading the sounds … ' + Math.round(f * 100) + ' %'; } });
  if (!buf || D.cancel) return null;
  D.status.textContent = 'Encoding the sound …';
  const samples = [];
  let config = null, failure = null, frameUs = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (desc && !config) config = desc instanceof ArrayBuffer ? new Uint8Array(desc.slice(0)) : new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
      if (frameUs == null && chunk.duration) frameUs = chunk.duration;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data });
    },
    error: e => { failure = e; }
  });
  enc.configure({ codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels, bitrate: cfg.bitrate });
  const L = buf.getChannelData(0), Rc = buf.getChannelData(1), STEP = 4800;
  try {
    for (let i = 0; i < buf.length; i += STEP) {
      if (failure) throw failure;
      const n = Math.min(STEP, buf.length - i), data = new Float32Array(2 * n);
      data.set(L.subarray(i, i + n), 0); data.set(Rc.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round(i / buf.sampleRate * 1e6), data });
      enc.encode(ad);
      ad.close();
      if (enc.encodeQueueSize > 16) await sleep(1);
    }
    await enc.flush();
  } finally {
    try { if (enc.state !== 'closed') enc.close(); } catch (err) { /* closed */ }
  }
  if (failure) throw failure;
  if (!samples.length) return null;
  const frame = frameUs ? Math.round(frameUs * buf.sampleRate / 1e6) : (cfg.kind === 'aac' ? 1024 : 960);
  if (cfg.kind === 'aac' && !config) {
    // no description: the AudioSpecificConfig of AAC-LC, 48 kHz, stereo
    config = new Uint8Array([0x11, 0x90]);
  }
  return { codec: cfg.kind, sampleRate: buf.sampleRate, channels: 2, config, frame, samples };
}

async function exportGif(ctx, progress) {
  const { p, g } = ctx;
  const gif = C4.gifEncoder.create(p.W, p.H, Math.round(100 / p.fps), { colors: p.q[2], dither: p.q[3] });
  const n = p.times.length;
  try {
    for (let i = 0; i < n; i++) {
      if (D.cancel) { gif.cancel(); return null; }
      drawFrame(ctx, i);
      // GIF delays are in 1/100 s: 15 fps alternates 7 / 7 / 6, so the speed stays exact
      const delay = Math.round((i + 1) * 100 / p.fps) - Math.round(i * 100 / p.fps);
      await gif.add(g.getImageData(0, 0, p.W, p.H), delay);
      progress(i + 1, n + 1);
      if (i % 2 === 0) D.status.textContent = eta(ctx, i + 1, n) + ' (encoding in a worker)';
      await sleep(0);
    }
    D.status.textContent = 'Encoding the last frames …';
    return await gif.finish();
  } catch (err) {
    gif.cancel();
    if (D.cancel) return null;
    throw err;
  }
}

/** fallback without WebCodecs H.264: MediaRecorder (WebM), one frame per frame period in real time */
async function exportWebm(ctx, progress) {
  const { p, C, view } = ctx;
  let type = webmType();
  const stream = C.captureStream(0), track = stream.getVideoTracks()[0];
  // the sound: the live engine, played frame by frame at the export's speed, into the recording
  let snd = ctx.opts.sound && view.sound && view.sound.enable(true) ? view.sound : null;
  if (snd) {
    // a recorder with a stopped audio context writes nothing: only with a running one (the click on
    // Export lets the page start audio)
    await Promise.race([snd.ctx.resume().catch(() => null), sleep(500)]);
    if (snd.ctx.state !== 'running') {
      D.note.textContent = 'The browser did not start the audio - the WebM is silent.';
      if (!view.soundWanted) snd.enable(false);
      snd = null;
    }
  }
  const cap = snd ? snd.capture() : null;
  if (cap && cap.track) {
    stream.addTrack(cap.track);
    const withAudio = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    if (withAudio) type = withAudio;
    snd.stopAll(); snd.lastT = null;
  }
  ctx.webmSound = !!(cap && cap.track);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.round(p.bitrate) });
  const parts = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(1000);
  const n = p.times.length, period = 1000 / p.fps, t0 = performance.now();
  for (let i = 0; i < n; i++) {
    if (D.cancel) break;
    drawFrame(ctx, i);
    if (snd) snd.update(p.times[i], view.camera, { playing: true, active: true, speed: p.speed }, ctx.fp[i]);
    if (track.requestFrame) track.requestFrame();
    progress(i + 1, n);
    if (i % 4 === 0) D.status.textContent = 'Recording WebM in real time: frame ' + (i + 1) + ' / ' + n;
    await sleep(Math.max(0, t0 + (i + 1) * period - performance.now()));
  }
  rec.stop();
  track.stop();
  await stopped;
  if (snd) { snd.stopAll(); snd.lastT = null; if (cap) cap.release(); if (!view.soundWanted) snd.enable(false); }
  return D.cancel ? null : new Blob(parts, { type: 'video/webm' });
}

/* ---------- overlays (the page's DOM labels and panels, drawn into the frame) ---------- */
function drawOverlays(ctx, t, hideClient) {
  const { view, p, g, opts } = ctx, R = view.R, d = R.d, app = R.app;
  const s = p.H / 720;                        // the page's sizes at 720 lines
  const font = (w, px) => w + ' ' + (px * s).toFixed(1) + 'px Inter, "Segoe UI", system-ui, sans-serif';
  g.save();
  g.textBaseline = 'middle';
  // name labels (actors.js projectLabels) and bomb site letters (effects.js)
  if (opts.labels) {
    const v = new THREE.Vector3(), cam = view.camera;
    // text at the bottom centre (px, py); badge: X-Ray "Players + names", a player out of sight - white on a
    // badge in the team colour with the team shape (styles.css .p3-label.xray-hidden)
    const text2d = (px, py, text, f, color, badge) => {
      g.font = f; g.textAlign = 'center'; g.textBaseline = 'bottom';
      if (badge) {
        const w = g.measureText(text).width + 12 * s, h = 17 * s;
        g.globalAlpha = 0.75; g.fillStyle = badge;
        g.beginPath(); g.roundRect(px - w / 2, py - 4 * s - h + 2 * s, w, h, 5 * s); g.fill();
        g.globalAlpha = 1; color = '#ffffff';
      }
      // a dark outline and a soft shadow, as the page's labels (styles.css .p3-label)
      g.shadowColor = '#000'; g.shadowBlur = 3 * s;
      g.lineJoin = 'round'; g.lineWidth = 2 * s; g.strokeStyle = '#000';
      g.strokeText(text, px, py - 4 * s);
      g.shadowBlur = 0;
      g.fillStyle = color;
      g.fillText(text, px, py - 4 * s);
    };
    const label = (x, y, z, text, f, color) => {
      v.set(x, y, z).project(cam);
      if (!(v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1)) return;
      text2d((v.x + 1) / 2 * p.W, (1 - v.y) / 2 * p.H, text, f, color, null);
    };
    // the names: the view's own list (actors.js labelSpots) - with X-Ray "Players + names" the badges of
    // the players out of sight and the overlapping names moved apart, as in the view
    const spots = view.actors.labelSpots(cam, p.W, p.H, hideClient);
    for (const sp of spots) {
      const it = sp.it, focus = it.label.classList.contains('focus'), stale = it.label.classList.contains('stale');
      const badge = it.xrayHidden && !stale;
      sp.text = badge && it.label.dataset.mark ? it.label.dataset.mark + ' ' + it.labelText : it.labelText;
      sp.font = font(focus ? '700' : '600', 11.5);
      // the name in the team colour (actors.js), the selected player orange, a last known position grey
      sp.color = stale ? '#a3a3ab' : focus ? '#ff8a1f' : '#' + it.color.getHexString();
      sp.badge = badge ? '#' + it.color.getHexString() : null;
      g.font = sp.font;
      Object.assign(sp, { w: g.measureText(sp.text).width + (badge ? 12 * s : 4 * s), h: (badge ? 17 : 15) * s + 4 * s, rank: (focus ? -2 : 0) + sp.depth });
    }
    if (view.actors.declutter && spots.length > 1) declutter(spots);
    for (const sp of spots) text2d(sp.x, sp.y, sp.text, sp.font, sp.color, sp.badge);
    if (opts.markers) for (const st of view.effects.siteLabels) label(st.pos.x, st.pos.y, st.pos.z, st.el.textContent, font('700', 22), '#ffc47a');
    g.textAlign = 'left'; g.textBaseline = 'middle';
  }
  const ri = C4.events.roundAt(d.rounds, t), r = ri >= 0 ? d.rounds[ri] : null;
  const box = (x, y, w, h) => { g.fillStyle = 'rgba(16,16,18,0.78)'; g.fillRect(x, y, w, h); };
  // score and timer, top left
  if (opts.hud) {
    let score = d.initialScore || { A: 0, B: 0 };
    for (const x of d.rounds) if (x.kind === 'round' && x.end != null && x.end <= t && x.scoreAfter) score = x.scoreAfter;
    const shown = d.teams.filter(tm => d.players.some(pl => pl.team === tm.key));
    const line1 = r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : '') + '  ·  ' + C4.ui.fmtRoundTime(d, ri, t) : fmtTime(t);
    const parts = [];
    shown.forEach((tm, i) => { if (i) parts.push([' : ', '#c8c8ce']); parts.push([tm.name + ' ' + (score[tm.key] != null ? score[tm.key] : 0), app.teamColor(tm.key)]); });
    g.font = font('700', 13);
    const w2 = parts.reduce((a, x) => a + g.measureText(x[0]).width, 0);
    g.font = font('600', 12);
    const w1 = g.measureText(line1).width;
    box(8 * s, 8 * s, Math.max(w1, w2) + 16 * s, 42 * s);
    g.fillStyle = '#f3f3f4'; g.fillText(line1, 16 * s, 20 * s);
    g.font = font('700', 13);
    let x = 16 * s;
    for (const [txt, col] of parts) { g.fillStyle = col; g.fillText(txt, x, 38 * s); x += g.measureText(txt).width; }
  }
  // weapon icons over the death markers (3D Display popover: Kill icons), as effects.js shows them
  if (opts.markers && view.effects.killIcons) {
    const v = new THREE.Vector3();
    for (const [k, m] of view.effects.killMarks) {
      v.copy(m.pos).project(view.camera);
      if (!(v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1)) continue;
      C4.killfeed.drawMark(g, k, (v.x + 1) / 2 * p.W, (1 - v.y) / 2 * p.H - 4 * s, { scale: s, imgs: ctx.kfImgs, alpha: m.alpha });
    }
  }
  // kill feed, top right: the kills and bomb events of the last seconds of this round, with the icons
  if (opts.killfeed) C4.killfeed.draw(g, app, d, t, { right: p.W - 8 * s, top: 18 * s, scale: s, imgs: ctx.kfImgs });
  // title, bottom left: map, game type, round
  if (opts.title) {
    const m = d.meta;
    const text = [m.mapDisplay || m.map, m.gametypeDisplay || m.gametype, r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : '') : ''].filter(Boolean).join('  ·  ');
    g.font = font('600', 12);
    const w = g.measureText(text).width;
    g.globalAlpha = 0.85;
    box(8 * s, p.H - 30 * s, w + 16 * s, 22 * s);
    g.fillStyle = '#f3f3f4'; g.fillText(text, 16 * s, p.H - 19 * s);
    g.globalAlpha = 1;
  }
  g.restore();
}

/** for tests (tools/validate/export3d.html): open, the dialog's state, the plan, start */
C4.export3d = { open: openExport, get dialog() { return D; }, plan: () => plan(), update: () => update(), start: () => start() };
