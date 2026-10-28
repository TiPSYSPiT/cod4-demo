/* The game's sounds, played with the replay (Web Audio) and rendered for the MP4 export.
 *
 * Data (tools/export/sound_export.py): maps3d/_sound/aliases.json (what every map shares: the
 * client code's aliases, the weapons', the gametype scripts', the channel table, the falloff curves)
 * and maps3d/<map>/sounds.json (the map zone's own aliases, the createfx loop sounds, the ambient
 * track); the audio in maps3d/_sound - IMA ADPCM WAV (decoded here) or MP3 (decodeAudioData).
 *
 * What plays, as the game's client does it (CG_EntityEvent, CG_FireWeapon, CG_BulletHitEvent):
 *   - the players' events: shots (fireSound / fireLastSound; the first-person camera's player:
 *     fireSoundPlayer), reload / raise / put away / rechamber / melee, footsteps, jumps and landings
 *     on the surface the event names (step_run_<surface>, quiet with specialty_quieter: qstep_...)
 *     with the gear rattle;
 *   - the bullet impacts: the demo's on players (EV_BULLET_HIT) and the world impacts the 3D view
 *     traces for every shot (fx.js): bullet_small / bullet_large / bullet_ap / bulletspray_small
 *     [_exit]_<surface>;
 *   - explosions: grenade_explode / rocket_explode_<surface> by the weapon's impact type and its
 *     projExplosionSound; grenade bounces (bounceSound_<surface>);
 *   - the server's sounds: EV_SOUND_ALIAS of entities (bomb plant and ticking, quick chat, car
 *     explosions), the entities' loop sounds (burning cars), the POV's local sounds (announcer, hit
 *     marker; server command "s"), the map's createfx loop sounds and the ambient track the server set.
 * Playback (SND_PlaySoundAlias_Internal): an alias of the list picked at random by probability
 * (Com_PickSoundAliasFromList), volume and pitch at random in their ranges, not started beyond
 * distMax, the distance attenuation of the alias's falloff curve between distMin and distMax
 * (SND_Attenuate), 2D channels without; a restricted channel stops the entity's previous sound on
 * it; secondary aliases play along, chain aliases after it; while a master alias plays (the announcer,
 * quick chat) the slave aliases (impacts, footsteps ...) are ducked to their slavePercentage, faded over
 * 500 ms; some aliases start at a random point of their sound. Panned left / right by the listener's
 * (camera's) right vector. The random numbers are seeded per event: seeking and exporting give the
 * same sounds. */
import { loadDataManifest, dataUrl } from './data.js';

const BASE = { dir: 'maps3d/' };            // the exported data (tools: setSoundBase)
const MAX_VOICES = 48;                        // the game mixes 32 3D + 16 2D + streams
const CACHE_SAMPLES = 40e6;                   // decoded samples kept (Float32: ~160 MB)
const PREFETCH_MS = 4000;                     // demo time ahead whose sounds are loaded
const LATE_MS = 250;                          // a sound whose audio arrives later than this is dropped
const RESTART_MS = 2500;                      // on seek / play: sounds started this long before still play (from their middle)
const EV = { FOLIAGE: 1, SOUND_ALIAS: 3, SOUND_ALIAS_MASTER: 4, RELOAD: 15, RELOAD_EMPTY: 16, RELOAD_START: 17, RELOAD_END: 18,
  RAISE: 21, FIRST_RAISE: 22, PUTAWAY: 23, ALT: 24, PULLBACK: 25, FIRE: 26, FIRE_LAST: 27, RECHAMBER: 28, MELEE_SWIPE: 30,
  MELEE_HIT: 35, MELEE_MISS: 36, FIRE_MG42: 38, GRENADE_BOUNCE: 44, FLASHBANG_EXPLODE: 48, SPRINT: 72, RUN: 73, WALK: 74,
  PRONE: 75, JUMP: 76, LAND: 77, LAND_PAIN: 106 };
const WEAPON_EVENT = { [EV.RELOAD]: 'reloadSound', [EV.RELOAD_EMPTY]: 'reloadEmptySound', [EV.RELOAD_START]: 'reloadStartSound',
  [EV.RELOAD_END]: 'reloadEndSound', [EV.RAISE]: 'raiseSound', [EV.FIRST_RAISE]: 'firstRaiseSound', [EV.PUTAWAY]: 'putawaySound',
  [EV.ALT]: 'altSwitchSound', [EV.PULLBACK]: 'pullbackSound', [EV.RECHAMBER]: 'rechamberSound', [EV.MELEE_SWIPE]: 'meleeSwipeSound' };
// CG_ImpactEffectForWeapon: the bullets' surface tables by impact type
const IMPACT_PREFIX = { bullet_small: 'bullet_small', bullet_large: 'bullet_large', bullet_ap: 'bullet_ap', shotgun: 'bulletspray_small' };
const MUZZLE_Z = 50;                          // a shot sounds at the weapon, not the feet
// WhizbySound: a bullet passing the listener within 140 units, at least 64 units after the muzzle and
// 64 before its end, sounds 16 units before the nearest point
const WHIZ_RADIUS = 140, WHIZ_MIN = 64, WHIZ_BACK = 16;
// alias flags (snd_alias_t.flags): master sounds duck the slave sounds while they play
// (SND_UpdateSlaveLerp, snd_slaveFadeTime 500 ms; a slave's volume x 1 - (1 - slavePercentage) x lerp);
// RANDOM_START: the sound starts at a random point (snd_driver.cpp: random() x length, 128 ms steps)
const FLAG_MASTER = 2, FLAG_SLAVE = 4, FLAG_RANDOM_START = 0x20, SLAVE_FADE = 0.5;
/** the volume factor of a playing sound for the ducking lerp */
const duck = (v, lerp) => (lerp && (v.e.flags & FLAG_SLAVE) && !(v.e.flags & FLAG_MASTER) ? 1 - (1 - (v.e.slave != null ? v.e.slave : 1)) * lerp : 1);

/* ---------- audio files ---------- */
const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

/** a RIFF WAVE file (16-bit PCM or IMA ADPCM) -> {rate, channels: [Float32Array]} or null */
export function decodeWav(buf) {
  const v = new DataView(buf), tag = i => String.fromCharCode(v.getUint8(i), v.getUint8(i + 1), v.getUint8(i + 2), v.getUint8(i + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12, fmt = null, data = null, total = null;
  while (p + 8 <= buf.byteLength) {
    const id = tag(p), size = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { tag: v.getUint16(p + 8, true), ch: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true),
      align: v.getUint16(p + 20, true), bits: v.getUint16(p + 22, true), spb: size >= 20 ? v.getUint16(p + 26, true) : 0 };
    else if (id === 'fact') total = v.getUint32(p + 8, true);
    else if (id === 'data') data = [p + 8, Math.min(size, buf.byteLength - p - 8)];
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) return null;
  const nc = fmt.ch;
  if (fmt.tag === 1 && fmt.bits === 16) {
    const n = Math.floor(data[1] / (2 * nc)), out = [];
    for (let c = 0; c < nc; c++) out.push(new Float32Array(n));
    for (let i = 0, o = data[0]; i < n; i++) for (let c = 0; c < nc; c++, o += 2) out[c][i] = v.getInt16(o, true) / 32768;
    return { rate: fmt.rate, channels: out };
  }
  if (fmt.tag === 0x11 && fmt.bits === 4) {
    const align = fmt.align, spb = fmt.spb || ((align - 4 * nc) * 2 / nc + 1);
    const blocks = Math.floor(data[1] / align), n = total != null ? Math.min(total, blocks * spb) : blocks * spb;
    const out = [];
    for (let c = 0; c < nc; c++) out.push(new Float32Array(n));
    const bytes = new Uint8Array(buf, data[0], blocks * align);
    for (let b = 0; b < blocks; b++) {
      const o0 = b * align, s0 = b * spb;
      for (let c = 0; c < nc; c++) {
        let pred = v.getInt16(data[0] + o0 + 4 * c, true), idx = Math.min(88, bytes[o0 + 4 * c + 2]);
        const ch = out[c];
        if (s0 < n) ch[s0] = pred / 32768;
        let s = s0 + 1;
        // 8 samples (4 bytes) per channel in turn, the low nibble first
        for (let q = o0 + 4 * nc + 4 * c; q < o0 + align && s < s0 + spb; q += 4 * nc) {
          for (let j = 0; j < 4; j++) {
            const byte = bytes[q + j];
            for (let h = 0; h < 2; h++) {
              const code = h ? byte >> 4 : byte & 15, step = IMA_STEP[idx];
              let vd = step >> 3;
              if (code & 4) vd += step;
              if (code & 2) vd += step >> 1;
              if (code & 1) vd += step >> 2;
              pred = code & 8 ? Math.max(-32768, pred - vd) : Math.min(32767, pred + vd);
              idx = Math.min(88, Math.max(0, idx + IMA_INDEX[code & 7]));
              if (s < n) ch[s] = pred / 32768;
              s++;
            }
          }
        }
      }
    }
    return { rate: fmt.rate, channels: out };
  }
  return null;
}

/** fetch with retries (a local server can drop a request under load; a missing file is not retried) */
async function fetchRetry(url, tries = 3) {
  for (let k = 0; ; k++) {
    try {
      await loadDataManifest();
      const r = await fetch(dataUrl(url));
      if (r.ok || r.status === 404 || k >= tries - 1) return r;
    } catch (err) { if (k >= tries - 1) throw err; }
    await new Promise(res => setTimeout(res, 300 * (k + 1)));
  }
}

/* ---------- the game's rules ---------- */
/** the game's random generator (msvcrt rand: 214013 * s + 2531011), seeded per event */
function random(seed) {
  let s = (seed | 0) >>> 0;
  return () => { s = (Math.imul(s, 214013) + 2531011) >>> 0; return ((s >>> 16) & 0x7fff) / 32768; };
}
const seedOf = (t, k) => ((Math.round(t) * 2654435761) ^ (k * 40503)) >>> 0;

/** GraphGetValueFromFraction: the falloff curve's value at fraction f (knots [[x, y], ...]) */
function curveAt(knots, f) {
  if (!knots || knots.length < 2) return 1 - f;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1], b = knots[i];
    if (f <= b[0]) return b[0] > a[0] ? a[1] + (b[1] - a[1]) * (f - a[0]) / (b[0] - a[0]) : b[1];
  }
  return knots[knots.length - 1][1];
}
/** SND_Attenuate */
function attenuate(knots, dist, min, max) {
  const r = dist - min;
  if (r <= 0) return 1;
  if (max <= min) return 0;
  const f = r / (max - min);
  return f < 1 ? Math.max(0, curveAt(knots, f)) : 0;
}

export class SoundSystem {
  /** the shared aliases and the map's (sounds.json may be missing: only the shared ones) */
  static async load(map) {
    const get = async url => { const r = await fetchRetry(url); if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.json(); };
    const common = await get(BASE.dir + '_sound/aliases.json');
    let own = null;
    try { own = await get(BASE.dir + map + '/sounds.json'); } catch (err) { own = null; }
    return new SoundSystem(common, own);
  }

  constructor(common, own) {
    this.aliases = Object.assign({}, common.aliases, own && own.aliases);
    this.curves = Object.assign({}, common.curves, own && own.curves);
    this.channels = common.channels || [];
    this.surfaces = common.surfaceTypes || [];
    this.weaponSounds = common.weapons || {};
    this.emitters = (own && own.emitters) || [];
    this.ambient = own && own.ambient;
    this.files = new Map();                   // path -> Promise<{rate, channels}> | null
    this.decoded = new Map();                 // path -> {rate, channels} (LRU order)
    this.cachedSamples = 0;
    this.buffers = new WeakMap();             // decoded -> AudioBuffer (live context)
    this.volume = 0.8;
    this.ctx = null;
    this.voices = [];
    this.loops = new Map();                   // key -> voice
    this.pending = [];
    this.lastT = null;
    this.missing = new Set();
  }

  /* ---------- alias helpers ---------- */
  has(name) { return !!(name && this.aliases[name]); }
  /** <prefix>_<surface>, else <prefix>_default (CG_RegisterSurfaceTypeSounds) */
  surface(prefix, surf) {
    const n = prefix + '_' + (this.surfaces[surf] || 'default');
    return this.has(n) ? n : this.has(prefix + '_default') ? prefix + '_default' : null;
  }
  /** Com_PickSoundAliasFromList */
  pick(name, rnd) {
    const list = this.aliases[name];
    if (!list || !list.length) return null;
    let best = list[0], cum = list[0].prob;
    for (let i = 1; i < list.length; i++) {
      cum += list[i].prob;
      if (list[i].prob * 32768 > Math.floor(rnd() * 32768) * cum) best = list[i];
    }
    return best;
  }

  /* ---------- the demo's sounds ---------- */
  /** the timeline of sounds (cues) of the demo: {t (demo ms), alias, plr (first-person alias), pos
   *  ([x, y, z] or null: 2D), ent (the entity whose restricted channels it uses), cl, k (seed)} */
  setDemo(M, fx) {
    this.M = M;
    this.fx = fx || null;
    const d = M.d, S = d.sounds3d || {}, cues = [];
    const W = name => this.weaponSounds[name] || {};
    const at = (cl, t, dz = 0) => { const s = M.sampleAt(cl, t); return s && s.age < 1000 ? [s.x, s.y, s.z + dz] : null; };
    const add = (t, alias, pos, ent, cl = null, plr = null) => {
      if (!this.has(alias) && !this.has(plr)) { if (alias) this.missing.add(alias); return; }
      cues.push({ t, alias: this.has(alias) ? alias : null, plr: this.has(plr) ? plr : null, pos, ent, cl, k: cues.length });
    };
    for (const r of S.events || []) {
      const [t, cl, ev, parm, wname, quiet] = r, w = W(wname), q = quiet ? 'q' : '';
      if (ev === EV.FIRE || ev === EV.FIRE_LAST || ev === EV.FIRE_MG42) {
        const last = ev === EV.FIRE_LAST;
        add(t, (last && w.fireLastSound) || w.fireSound, at(cl, t, MUZZLE_Z), cl, cl, (last && w.fireLastSoundPlayer) || w.fireSoundPlayer);
      } else if (WEAPON_EVENT[ev]) {
        const f = WEAPON_EVENT[ev];
        add(t, w[f], at(cl, t, 40), cl, cl, w[f + 'Player'] || null);
      } else if (ev === EV.MELEE_HIT) add(t, parm ? 'melee_knife_hit_body' : w.meleeHitSound || 'melee_hit', at(cl, t, 40), cl, cl);
      else if (ev === EV.MELEE_MISS) add(t, parm ? 'melee_knife_hit_other' : w.meleeMissSound || 'melee_hit_other', at(cl, t, 40), cl, cl);
      else if (ev === EV.FOLIAGE) add(t, 'movement_foliage', at(cl, t), cl, cl);
      else if (ev >= EV.SPRINT && ev <= EV.JUMP) {
        // footsteps: the surface is the event's parameter; the gear rattle with each step
        const kind = { [EV.SPRINT]: 'sprint', [EV.RUN]: 'run', [EV.WALK]: 'walk', [EV.PRONE]: 'prone', [EV.JUMP]: 'run' }[ev];
        const gear = { sprint: 'sprint', run: 'run', walk: 'walk', prone: 'walk' }[kind];
        const pos = at(cl, t);
        add(t, this.surface(q + 'step_' + kind, parm), pos, cl, cl, this.surface(q + 'step_' + kind + '_plr', parm));
        add(t, q + 'gear_rattle_' + gear, pos, -1, cl, q + 'gear_rattle_plr_' + gear);
      } else if (ev >= EV.LAND && ev < EV.LAND_PAIN + 29) {
        const pain = ev >= EV.LAND_PAIN, surf = ev - (pain ? EV.LAND_PAIN : EV.LAND), pos = at(cl, t);
        add(t, this.surface(q + 'land', surf), pos, cl, cl, this.surface(q + 'land_plr', surf));
        if (pain) add(t, 'land_damage', pos, -1, cl);
      }
    }
    for (const r of S.entEvents || []) {
      const [t, ent, ev, , wname, x, y, z, surf, alias] = r;
      if (ev === EV.GRENADE_BOUNCE) { const b = W(wname).bounceSound; if (b) add(t, this.surface(b, surf), [x, y, z], -1); }
      else if (alias) add(t, alias, [x, y, z], ent);
    }
    // explosions (the grenades' detonations): the impact type's surface table and projExplosionSound
    const fxw = (fx && fx.weapons) || {};
    for (const g of d.grenades || []) {
      const det = g.detonation;
      if (!det || det.event == null) continue;
      const pos = [det.x, det.y, det.z], it = fxw[g.weapon] && fxw[g.weapon].impactType;
      if (det.event !== EV.FLASHBANG_EXPLODE && (it === 'grenade_explode' || it === 'rocket_explode')) add(det.t, this.surface(it, det.surf), pos, -1);
      if (W(g.weapon).projExplosionSound) add(det.t, W(g.weapon).projExplosionSound, pos, -1);
    }
    // the demo's bullet impacts (on players): impact flags 4 = exit
    for (const r of (d.fx3d && d.fx3d.impacts) || []) {
      const it = fxw[M.weaponName(r[6], r[0])] && fxw[M.weaponName(r[6], r[0])].impactType, p = IMPACT_PREFIX[it];
      if (p) add(r[0], this.surface(p + (r[7] & 4 ? '_exit' : ''), r[5]), [r[1], r[2], r[3]], -1);
    }
    for (const s of S.local || []) add(s.t, s.name, null, -2);
    cues.sort((a, b) => a.t - b.t || a.k - b.k);
    this.cues = cues;
    // loops: the entities' (burning cars) while sent; the map's emitters always
    this.loopList = (S.loops || []).filter(l => this.has(l.alias)).map((l, i) => ({ key: 'e' + l.num + ':' + l.t0, alias: l.alias,
      pos: [l.x, l.y, l.z], t0: l.t0, t1: l.t1 + 100, k: 900000 + i }));
    this.emitters.forEach((e, i) => { if (this.has(e.alias)) this.loopList.push({ key: 'm' + i, alias: e.alias, pos: e.origin, t0: -Infinity, t1: Infinity, k: 950000 + i }); });
    // the ambient track: the one the server set (CS_AMBIENT); the map's own (sounds.json "ambient") is not
    // played without it - the game's client plays none then (Promod servers set none)
    const amb = S.ambient && String(S.ambient).toLowerCase();
    if (this.has(amb)) this.loopList.push({ key: 'ambient', alias: amb, pos: null, t0: -Infinity, t1: Infinity, k: 990000 });
    // the shots whose world impacts the 3D view traces (fx.js), per client
    this.shots = [];
    for (const [cl, times] of Object.entries(d.shotsSeen || {})) this.shots.push({ cl: +cl, times });
    return { cues: cues.length, loops: this.loopList.length, missing: [...this.missing] };
  }

  /** the world impacts of the shots in (a, b] (traced by fx.js, the same hits as the bullet holes) */
  impactCues(a, b) {
    const fx = this.fx, out = [];
    if (!fx || !fx.tracer || !this.shots) return out;
    for (const { cl, times } of this.shots) {
      let lo = 0, hi = times.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] <= a) lo = m + 1; else hi = m; }
      for (let i = lo; i < times.length && times[i] <= b; i++) {
        const key = cl * 1e7 + times[i];
        let hits = fx.impactCache && fx.impactCache.get(key);
        if (hits === undefined) { hits = fx.traceShot(cl, times[i]); if (fx.impactCache) fx.impactCache.set(key, hits); for (const h of hits || []) fx.addMarks(h); fx.marksSorted = false; }
        const list = (hits && hits.sounds) || [];
        // the bullet passing by (the listener decides: resolve)
        if (hits && hits.line && this.has('whizby')) out.push({ t: times[i], alias: 'whizby', plr: null, pos: null, line: hits.line, ent: -1, cl, k: 700000 + cl * 977 + i * 13 });
        list.forEach((h, j) => {
          const p = IMPACT_PREFIX[h.impactType];
          const alias = p && this.surface(p + (h.exit ? '_exit' : ''), h.surface);
          if (alias) out.push({ t: times[i], alias, plr: null, pos: h.point, ent: -1, cl: null, k: 500000 + cl * 977 + i * 13 + j });
        });
      }
    }
    return out;
  }

  /** the cues with a < t <= b, the world impacts included (impacts = false: without), in time order */
  cuesBetween(a, b, impacts = true) {
    const C = this.cues || [];
    let lo = 0, hi = C.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (C[m].t <= a) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < C.length && C[i].t <= b; i++) out.push(C[i]);
    const imp = impacts ? this.impactCues(a, b) : [];
    if (imp.length) { out.push(...imp); out.sort((x, y) => x.t - y.t || x.k - y.k); }
    return out;
  }

  /* ---------- audio data ---------- */
  /** the decoded audio of a file (cached, least recently used dropped beyond CACHE_SAMPLES) */
  decode(path) {
    const hit = this.decoded.get(path);
    if (hit) { this.decoded.delete(path); this.decoded.set(path, hit); return Promise.resolve(hit); }
    if (this.files.has(path)) return this.files.get(path);
    const p = fetchRetry(BASE.dir + '_sound/' + path).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(async buf => {
      let a = /\.wav$/i.test(path) ? decodeWav(buf) : null;
      if (!a) {
        // MP3 (the browsers decode it): at its own rate where the browser allows, else the context's
        const C = typeof OfflineAudioContext !== 'undefined' ? new OfflineAudioContext(2, 1, 48000) : null;
        if (!C) return null;
        const ab = await C.decodeAudioData(buf);
        a = { rate: ab.sampleRate, channels: Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c)) };
      }
      this.decoded.set(path, a);
      this.cachedSamples += a.channels.reduce((n, c) => n + c.length, 0);
      while (this.cachedSamples > CACHE_SAMPLES && this.decoded.size > 1) {
        const [k, old] = this.decoded.entries().next().value;
        this.decoded.delete(k); this.files.delete(k);
        this.cachedSamples -= old.channels.reduce((n, c) => n + c.length, 0);
      }
      this.files.delete(path);
      return a;
    }).catch(err => { console.warn('sound not loaded:', path, err.message); this.files.delete(path); this.decoded.set(path, null); return null; });
    this.files.set(path, p);
    return p;
  }
  ready(path) { return this.decoded.get(path); }
  audioBuffer(ctx, a) {
    if (!a) return null;
    let byCtx = this.buffers.get(a);
    if (!byCtx) this.buffers.set(a, byCtx = new Map());
    let b = byCtx.get(ctx);
    if (!b) {
      b = ctx.createBuffer(a.channels.length, a.channels[0].length, a.rate);
      a.channels.forEach((c, i) => b.copyToChannel(c, i));
      byCtx.set(ctx, b);
    }
    return b;
  }

  /** what a cue plays for a listener: [{entry, alias, delay (s), vol, pitch, pos, chain}] incl. the
   *  secondary aliases; null when out of range (or nothing) */
  resolve(cue, listener, fpClient) {
    if (cue.line) {
      // WhizbySound (cg_weapons.cpp): not the shooter's own (the first-person camera's player), only
      // when the listener is beside the bullet's path
      if (!listener || cue.cl === fpClient) return null;
      const p = whizbyAt(cue.line[0], cue.line[1], listener.pos);
      if (!p) return null;
      cue = Object.assign({}, cue, { pos: p, line: null });
    }
    const rnd = random(seedOf(cue.t, cue.k));
    const name = cue.cl != null && cue.cl === fpClient && cue.plr ? cue.plr : cue.alias || cue.plr;
    const out = [];
    const one = (alias, depth) => {
      const e = this.pick(alias, rnd);
      if (!e) return;
      const is3d = e.is3d !== false && cue.pos && !(cue.cl != null && cue.cl === fpClient && name === cue.plr);
      if (is3d && listener && dist(cue.pos, listener.pos) > e.dist[1]) return;
      out.push({ e, alias, is3d, vol: e.vol[0] + (e.vol[1] - e.vol[0]) * rnd(), pitch: e.pitch[0] + (e.pitch[1] - e.pitch[0]) * rnd(),
        delay: (e.delay || 0) / 1000, ch: e.ch, randomStart: e.flags & FLAG_RANDOM_START ? rnd() : null });
      if (e.secondary && depth < 3 && this.has(e.secondary)) one(e.secondary, depth + 1);
    };
    one(name, 0);
    return out.length ? out : null;
  }
  /** gain and pan of a playing sound for the listener */
  mix(v, pos, listener, lerp = this.slaveLerp || 0) {
    if (!v.is3d || !pos || !listener) return [v.vol * duck(v, lerp), 0];
    const dx = pos[0] - listener.pos[0], dy = pos[1] - listener.pos[1], dz = pos[2] - listener.pos[2], d = Math.hypot(dx, dy, dz);
    const g = v.vol * duck(v, lerp) * attenuate(this.curves[v.e.curve] || this.curves.default, d, v.e.dist[0], v.e.dist[1]);
    const pan = d > 1 ? Math.max(-1, Math.min(1, (dx * listener.right[0] + dy * listener.right[1] + dz * listener.right[2]) / d)) * 0.8 : 0;
    return [g, pan];
  }

  /* ---------- live playback ---------- */
  /** switch the sound on (needs a user gesture: the browsers start an AudioContext only then) */
  enable(on) {
    this.enabled = on;
    if (on && !this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.out = this.ctx.createGain();
      this.out.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();     // many sounds at once must not clip
      comp.threshold.value = -6; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.15;
      this.out.connect(comp).connect(this.ctx.destination);
      this.comp = comp;
    }
    if (!on) this.stopAll();
    if (this.ctx) (on ? this.ctx.resume() : this.ctx.suspend()).catch(() => null);
    this.lastT = null;
    return true;
  }
  setVolume(v) { this.volume = v; if (this.out) this.out.gain.value = v; }

  /** the live sound into a MediaStream instead of the speakers (the WebM export records it) -> the
   *  stream's audio track and a function that switches back, or null */
  capture() {
    if (!this.ctx || !this.comp || !this.ctx.createMediaStreamDestination) return null;
    const dest = this.ctx.createMediaStreamDestination(), comp = this.comp, ctx = this.ctx;
    const gain = this.out.gain.value;
    this.out.gain.value = 1;
    comp.disconnect();
    comp.connect(dest);
    return { track: dest.stream.getAudioTracks()[0], release: () => {
      try { comp.disconnect(); } catch (err) { /* not connected */ }
      comp.connect(ctx.destination);
      this.out.gain.value = gain;
    } };
  }

  stopAll() {
    for (const v of this.voices) try { v.src.stop(); } catch (err) { /* stopped */ }
    for (const v of this.loops.values()) try { v.src.stop(); } catch (err) { /* stopped */ }
    this.voices = []; this.loops.clear(); this.pending = [];
  }

  /** per frame: t (demo ms), the camera, the playback (playing, speed), the first-person camera's player */
  update(t, camera, pb, fpClient = null) {
    if (!this.enabled || !this.ctx || !this.cues) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const playing = !!(pb && pb.playing && pb.active !== false), speed = pb ? pb.speed || 1 : 1;
    const audible = playing && speed >= 0.25 && speed <= 4;
    if (!audible) {
      if (ctx.state === 'running') ctx.suspend().catch(() => null);
      if (this.lastT != null && Math.abs(t - this.lastT) > 1) { this.stopAll(); this.lastT = null; }
      return;
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => null);
    const L = listenerOf(camera);
    // a jump (seek, round skip) or a restart: the sounds of the last moments that still last, from their middle
    let from = this.lastT;
    if (from == null || t < from - 1 || t - from > 1000) { this.stopAll(); from = t - RESTART_MS; }
    this.fp = fpClient;
    for (const cue of this.cuesBetween(from, t)) this.startCue(cue, t, speed, L);
    // sounds whose audio was still loading
    if (this.pending.length) {
      const keep = [];
      for (const p of this.pending) { if (this.ready(p.path) !== undefined) this.startCue(p.cue, t, speed, L, true); else if (t - p.cue.t < LATE_MS * speed) keep.push(p); }
      this.pending = keep;
    }
    // loops
    const want = new Set();
    for (const l of this.loopList) {
      if (t < l.t0 || t > l.t1) continue;
      const cur = this.loops.get(l.key);
      if (cur) { want.add(l.key); continue; }
      const r = this.resolve(l, l.pos ? L : null, null);
      if (!r) continue;
      const v = r[0], path = v.e.f, a = this.ready(path);
      if (a === undefined) { this.decode(path); continue; }
      if (!a) continue;
      want.add(l.key);
      this.loops.set(l.key, this.play(a, v, l.pos, L, 1, 0, true));
    }
    for (const [k, v] of this.loops) {
      const l = this.loopList.find(x => x.key === k);
      const far = l && l.pos && v.is3d && dist(l.pos, L.pos) > v.e.dist[1] * 1.05;
      if (!want.has(k) || far) { try { v.src.stop(); } catch (err) { /* stopped */ } this.loops.delete(k); }
      else this.place(v, l.pos, L);
    }
    // the ducking: towards 1 while a master sound plays, towards 0 else, over SLAVE_FADE (real time)
    this.voices = this.voices.filter(v => v.end > now);
    const master = this.voices.some(v => v.e.flags & FLAG_MASTER) || [...this.loops.values()].some(v => v.e.flags & FLAG_MASTER);
    const dtReal = this.lastNow != null ? Math.max(0, now - this.lastNow) : 0;
    this.lastNow = now;
    this.slaveLerp = Math.max(0, Math.min(1, (this.slaveLerp || 0) + (master ? 1 : -1) * dtReal / SLAVE_FADE));
    // the playing sounds follow the listener
    for (const v of this.voices) this.place(v, v.pos, L);
    for (const v of this.voices) v.src.playbackRate.value = v.pitch * speed;
    // load what comes next
    for (const cue of this.cuesBetween(t, t + PREFETCH_MS, false)) {
      const name = cue.cl != null && cue.cl === fpClient && cue.plr ? cue.plr : cue.alias || cue.plr;
      for (const e of this.aliases[name] || []) if (this.ready(e.f) === undefined) this.decode(e.f);
    }
    this.lastT = t;
  }

  startCue(cue, t, speed, L, late = false) {
    const r = this.resolve(cue, L, this.fp);
    if (!r) return;
    for (const v of r) {
      const a = this.ready(v.e.f);
      if (a === undefined) { this.decode(v.e.f); if (!late) this.pending.push({ cue, path: v.e.f }); continue; }
      if (!a) continue;
      // seconds of real time since the cue; the buffer's position then (its rate: pitch x replay speed)
      const elapsed = (t - cue.t) / 1000 / speed;
      const offset = Math.max(0, (elapsed - v.delay) * v.pitch * speed), wait = Math.max(0, v.delay - elapsed);
      const dur = a.channels[0].length / a.rate;
      if (offset >= dur) continue;
      // a restricted channel: the entity's previous sound on it stops (SND_StopEntityChannel)
      const chan = this.channels[v.ch];
      if (cue.ent >= 0 && chan && chan.restricted) {
        for (const o of this.voices) if (o.ent === cue.ent && o.ch === v.ch) { try { o.src.stop(); } catch (err) { /* stopped */ } o.end = 0; }
      }
      if (this.voices.length >= MAX_VOICES) {
        // the quietest goes
        this.voices.sort((x, y) => y.gain.gain.value - x.gain.gain.value);
        const q = this.voices.pop();
        try { q.src.stop(); } catch (err) { /* stopped */ }
      }
      const voice = this.play(a, v, cue.pos, L, speed, offset, false, wait);
      voice.ent = cue.ent; voice.ch = v.ch;
      this.voices.push(voice);
      if (v.e.chain && this.has(v.e.chain)) {
        // the chain alias after this one
        const next = { t: cue.t + (dur / v.pitch + v.delay) * 1000, alias: v.e.chain, plr: null, pos: cue.pos, ent: cue.ent, cl: null, k: cue.k + 7 };
        setTimeout(() => { if (this.enabled && this.lastT != null) this.startCue(next, this.lastT, speed, listenerOf(null, this.lastListener)); }, Math.max(0, next.t - t) / speed);
      }
    }
    this.lastListener = L;
  }

  /** where a sound starts in its buffer (s): offset, or for RANDOM_START aliases a random point (whole
   *  128 ms steps, as the game) */
  startOffset(v, a, offset) {
    if (v.randomStart == null || offset > 0) return offset;
    const ms = a.channels[0].length / a.rate * 1000;
    return (Math.floor(v.randomStart * ms) & ~127) / 1000;
  }

  play(a, v, pos, L, speed, offset, loop, wait = 0) {
    offset = this.startOffset(v, a, offset);
    const ctx = this.ctx, src = ctx.createBufferSource(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
    src.buffer = this.audioBuffer(ctx, a);
    src.loop = loop;
    src.playbackRate.value = v.pitch * speed;
    const [g, p] = this.mix(v, pos, L);
    gain.gain.value = g; pan.pan.value = p;
    src.connect(gain).connect(pan).connect(this.out);
    const when = ctx.currentTime + wait;
    src.start(when, offset);
    const dur = src.buffer.duration;
    return Object.assign({}, v, { src, gain, pan, pos, end: loop ? Infinity : when + (dur - offset) / (v.pitch * speed) + 0.05 });
  }
  place(v, pos, L) {
    const [g, p] = this.mix(v, pos, L);
    v.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
    v.pan.pan.setTargetAtTime(p, this.ctx.currentTime, 0.02);
  }

  /* ---------- offline (the MP4 export) ---------- */
  /** the sound of an exported range: times = the demo time of each video frame, fps, speed, path =
   *  the camera of each frame [{pos, right}], fp = the first-person camera's player per frame (or
   *  null) -> AudioBuffer (stereo, 48 kHz) of the video's length */
  async render({ times, fps, speed, path, fp = null, rate = 48000, onProgress = null }) {
    if (!this.cues || !times.length) return null;
    const n = times.length, len = Math.ceil(n / fps * rate), ctx = new OfflineAudioContext(2, Math.max(1, len), rate);
    const out = ctx.createGain();
    out.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.15;
    out.connect(comp).connect(ctx.destination);
    const step = speed * 1000 / fps;
    // demo time -> video time (s); the skipped countdowns have no video time
    const videoTime = t => {
      let lo = 0, hi = n - 1;
      if (t < times[0]) return (t - times[0]) / speed / 1000;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; }
      const gap = t - times[lo];
      if (gap > step * 1.5 && lo < n - 1) return null;
      return (lo + gap / step) / fps;
    };
    const frameAt = vt => Math.max(0, Math.min(n - 1, Math.floor(vt * fps)));
    const L = i => path[i] || path[path.length - 1];
    // the cues of the range (and the ones just before that last into it), with their sounds resolved
    const cues = this.cuesBetween(times[0] - RESTART_MS, times[n - 1]);
    const plans = [], need = new Set();
    for (const cue of cues) {
      const vt = videoTime(cue.t);
      if (vt == null) continue;
      const i = frameAt(vt), r = this.resolve(cue, L(i), fp ? fp[i] : null);
      if (!r) continue;
      for (const v of r) { plans.push({ cue, v, vt: vt + v.delay }); need.add(v.e.f); }
    }
    const loops = [];
    for (const l of this.loopList) {
      const a = Math.max(l.t0, times[0]), b = Math.min(l.t1, times[n - 1]);
      if (b <= a) continue;
      const r = this.resolve(l, null, null);
      if (!r) continue;
      loops.push({ l, v: r[0], va: Math.max(0, videoTime(a) || 0), vb: videoTime(b) == null ? n / fps : videoTime(b) });
      need.add(r[0].e.f);
    }
    let done = 0;
    await Promise.all([...need].map(p => this.decode(p).then(() => { done++; if (onProgress) onProgress(done / need.size); })));
    // restricted channels: a new sound stops the entity's previous one
    const lastOn = new Map();
    const AUTO = 0.05;                                        // s between the gain / pan steps
    // the ducking over the video: master sounds' intervals -> the lerp at every gain step
    const masters = [];
    const lerpAt = s => {
      if (!lerps) {
        lerps = new Float32Array(Math.ceil(n / fps / AUTO) + 2);
        let l = 0;
        for (let k = 0; k < lerps.length; k++) {
          const t = k * AUTO, on = masters.some(([a, b]) => t >= a && t < b);
          l = Math.max(0, Math.min(1, l + (on ? 1 : -1) * AUTO / SLAVE_FADE));
          lerps[k] = l;
        }
      }
      return lerps[Math.max(0, Math.min(lerps.length - 1, Math.round(s / AUTO)))];
    };
    let lerps = null;
    const schedule = (a, v, pos, start, offset, stop, loop) => {
      const src = ctx.createBufferSource(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
      offset = this.startOffset(v, a, offset);
      src.buffer = this.audioBuffer(ctx, a);
      src.loop = loop;
      src.playbackRate.value = v.pitch * speed;
      src.connect(gain).connect(pan).connect(out);
      const end = Math.min(stop, n / fps);
      for (let s = Math.max(0, start); s <= end + AUTO; s += AUTO) {
        const [g, p] = this.mix(v, pos, L(frameAt(s)), lerpAt(s));
        gain.gain.setValueAtTime(g, s); pan.pan.setValueAtTime(Math.max(-1, Math.min(1, p)), s);
      }
      src.start(Math.max(0, start), offset);
      if (stop < Infinity) src.stop(Math.max(0, stop));
      return src;
    };
    for (const pl of plans) {
      const a = this.ready(pl.v.e.f);
      if (!a) continue;
      const dur = a.channels[0].length / a.rate / (pl.v.pitch * speed);
      const offset = pl.vt < 0 ? -pl.vt * pl.v.pitch * speed : 0;
      if (pl.vt + dur <= 0) continue;
      const item = { start: Math.max(0, pl.vt), stop: pl.vt + dur, a, pl, offset };
      const chan = this.channels[pl.v.ch];
      if (pl.cue.ent >= 0 && chan && chan.restricted) {
        const key = pl.cue.ent + ':' + pl.v.ch, prev = lastOn.get(key);
        if (prev && prev.stop > item.start) prev.stop = item.start;
        lastOn.set(key, item);
      }
      pl.item = item;
    }
    for (const pl of plans) if (pl.item && pl.item.stop > pl.item.start && (pl.v.e.flags & FLAG_MASTER)) masters.push([pl.item.start, pl.item.stop]);
    for (const lp of loops) if (lp.v.e.flags & FLAG_MASTER) masters.push([lp.va, lp.vb]);
    for (const pl of plans) if (pl.item && pl.item.stop > pl.item.start) schedule(pl.item.a, pl.v, pl.cue.pos, pl.item.start, pl.item.offset, pl.item.stop, false);
    for (const lp of loops) { const a = this.ready(lp.v.e.f); if (a) schedule(a, lp.v, lp.l.pos, lp.va, 0, lp.vb, true); }
    return ctx.startRendering();
  }

  dispose() {
    this.stopAll();
    if (this.ctx) this.ctx.close().catch(() => null);
    this.ctx = null;
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** WhizbySound: where a bullet from start to end sounds for a listener at view, or null */
function whizbyAt(start, end, view) {
  const d = [end[0] - start[0], end[1] - start[1], end[2] - start[2]], len = Math.hypot(d[0], d[1], d[2]);
  if (!len) return null;
  const dir = d.map(x => x / len), vd = (view[0] - start[0]) * dir[0] + (view[1] - start[1]) * dir[1] + (view[2] - start[2]) * dir[2];
  if (vd < WHIZ_MIN || len < vd + WHIZ_MIN) return null;
  const proj = [0, 1, 2].map(k => start[k] + dir[k] * vd);
  if (dist(proj, view) > WHIZ_RADIUS) return null;
  return proj.map((v, k) => v - dir[k] * WHIZ_BACK);
}
/** the listener: the camera's position and right vector (scene = game units, Z up) */
export function listenerOf(camera, fallback = null) {
  if (!camera) return fallback || { pos: [0, 0, 0], right: [1, 0, 0] };
  camera.updateMatrixWorld();
  const m = camera.matrixWorld.elements;
  return { pos: [m[12], m[13], m[14]], right: [m[0], m[1], m[2]] };
}
/** where maps3d is, for pages outside the project's root (tools/validate) */
export function setSoundBase(dir) { BASE.dir = dir; }
