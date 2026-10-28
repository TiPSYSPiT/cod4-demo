/* Which of the game's player animations (maps3d/_characters/anims.*, see characters.js
 * AnimationLibrary) a player plays at a demo time. Everything is derived from the demo's samples,
 * so a time always gives the same frame - also when seeking, paused or at another speed.
 *
 * Phase 3 - the game's own animation state: every player sample carries the entity's legsAnim /
 * torsoAnim (indices into the game's player anim tree, tools/export/animtree.py; bit 0x200 toggles
 * when the same animation restarts). The legs animation plays on the whole body, a torso animation
 * (reload, fire, melee, throw ...) on the upper body over it. An animation starts with the first
 * sample of its run of equal values. Blending follows the game (BG_SetNewAnimation): a change
 * fades in linearly over the animation's blend time from mp/playeranim.script ("blendtime", 30 ms
 * for firing), else 120 ms into a moving animation, 170 ms between standing ones, 250 ms from a
 * moving to a standing one, at least 400 ms while the stance changes; a torso animation that ends
 * fades out over 200 / 250 ms. A looping moving animation that follows another one continues at
 * its normalised time, else it starts at the game's time-based phase; it then plays at the game's
 * rate: measured speed / the animation's move speed, clamped (BG_RunLerpFrameRate). Corpses (entity type 2) play
 * the death animation the server chose until the end of the round - from the start when the
 * death is in the demo, else (dead before the recorder saw it) at its end pose. The game's angle
 * controllers (legs / torso yaw, pitch, lean, prone slope) are in controllers.js.
 *
 * Phase 2 - the fallback when a sample has no animation state or its clip is not exported:
 *   - locomotion: ground speed and direction (relative to the view yaw) from the positions around
 *     t; idle / walk / run / sprint per stance, forward / back / left / right blended by direction.
 *     The cycle phase is the distance walked divided by the clip's stride (its root motion), so the
 *     feet match the ground speed.
 *   - stance changes cross-fade over a short time after the change.
 *   - deaths: a death clip (by stance, running, a stable choice per kill) from the kill on, with
 *     the clip's root motion; bomb plants (S&D): the plant clip of the planter ("planted the bomb"
 *     event) during the plant time before it, while standing still. */
import { upperBound } from '../app/match.js';

const C4 = window.C4;
const CFG = C4.mapConfig;
const PF = C4.collect.PF;
const VEL_MS = 150;                         // velocity from the positions t - VEL_MS .. t + VEL_MS
const BLEND_MS = { stand: 250, crouch: 250, prone: 450 };   // cross-fade into a new stance
const PLANT_MS = 5000;                      // bomb plant time (S&D)
const STANCE_BLEND_MS = 400;                // a change of stance blends at least this long (stanceTransitionTime)
const CROUCH_MT = new Set(['idlecr', 'walkcr', 'walkcrbk', 'stumble_crouch_forward', 'stumble_crouch_backward']);   // BG_IsCrouchingAnim
const PRONE_MT = new Set(['idleprone', 'walkprone', 'walkpronebk']);                                              // BG_IsProneAnim
const CORPSE_MATCH_MS = 1500;               // a corpse belongs to a kill of its client this close in time
const DIRS = ['f', 'b', 'l', 'r'];
const smooth = (a, b, x) => { const f = Math.max(0, Math.min(1, (x - a) / (b - a))); return f * f * (3 - 2 * f); };
const stanceOfFlags = f => f & PF.PRONE ? 'prone' : f & PF.CROUCH ? 'crouch' : 'stand';

export class Animator {
  constructor(match, library) {
    this.M = match;
    this.lib = library;
    this.dist = new Map();                  // client -> cumulative ground distance per sample
    this.runStart = new Map();              // client|field -> first sample index of each run of equal values
  }

  /** names of all game clips the demo plays (legs / torso of every sample, the corpses' deaths) */
  usedClips() {
    const idx = new Set(), lib = this.lib, d = this.M.d;
    for (const P of Object.values(d.positions)) {
      if (!P.legs) continue;
      for (let i = 0; i < P.legs.length; i++) { idx.add(P.legs[i] & 0x1ff); idx.add(P.torso[i] & 0x1ff); }
    }
    for (const c of d.corpses || []) idx.add(c.legs & 0x1ff);
    const names = new Set();
    for (const i of idx) { const n = lib.treeName(i); if (n) names.add(n); }
    return names;
  }

  /** Phase 3: first sample index of the run of equal legs / torso values each sample belongs to */
  runs(cl, field) {
    const key = cl + '|' + field;
    let R = this.runStart.get(key);
    if (!R) {
      const P = this.M.d.positions[cl], A = P[field];
      R = new Int32Array(P.t.length);
      for (let i = 1; i < R.length; i++) R[i] = A[i] === A[i - 1] && !(P.flags[i - 1] & PF.DEAD) ? R[i - 1] : i;
      this.runStart.set(key, R);
    }
    return R;
  }

  /** the game's data of an animation (anims.json "game") */
  meta(name) { const c = name && this.lib.info(name); return c && c.game || null; }
  moving(name) { const g = this.meta(name); return !!(g && g.moveSpeed > 0); }
  movingLoop(name) { const c = name && this.lib.info(name); return !!(c && c.loop && c.game && c.game.moveSpeed > 0); }
  stanceOf(name) {
    const g = this.meta(name);
    return !g ? null : g.movetypes.some(m => PRONE_MT.has(m)) ? 'prone' : g.movetypes.some(m => CROUCH_MT.has(m)) ? 'crouch' : 'stand';
  }

  /** BG_SetNewAnimation: the blend time (ms) of a change from animation `prev` to `next` (names or
   *  null for none); stanceLeft: ms of a running stance transition */
  blendMs(next, prev, stanceLeft) {
    const g = this.meta(next);
    let time = next ? (g && g.blend > 0 ? g.blend : -1) : 200, min = -1;
    if (!next || time <= 0) min = !next || !this.moving(next) ? (prev && this.moving(prev) ? 250 : 170) : 120;
    if (stanceLeft > min) min = stanceLeft;
    return Math.max(time, min);
  }

  /** ms left of the stance transition running at time t (a legs change between stances started it) */
  stanceLeft(cl, t) {
    const P = this.M.d.positions[cl], L = this.runs(cl, 'legs');
    let i = upperBound(P.t, t) - 1;
    for (let n = 0; i > 0 && n < 4; n++) {
      const s = L[i];
      if (s === 0 || t - P.t[s] >= STANCE_BLEND_MS) return 0;
      const a = this.lib.treeName(P.legs[s]), b = this.lib.treeName(P.legs[s - 1]);
      if (a && b && this.stanceOf(a) !== this.stanceOf(b)) return P.t[s] + STANCE_BLEND_MS - t;
      i = s - 1;
    }
    return 0;
  }

  /** BG_RunLerpFrameRate: the playback scale of a moving animation for a measured speed (units/s):
   *  speed / move speed, at least 0.1; above 2 limited to 3 for slow animations (move speed < 20),
   *  falling to 2 at 150, 2 for faster ones; climbing animations up to 4 */
  rateScale(g, speed, climb) {
    let k = speed / g.moveSpeed;
    if (k < 0.1) return climb && k < 0.01 ? 0 : 0.1;
    if (k > 2) {
      if (climb) return Math.min(k, 4);
      if (g.moveSpeed > 150) return 2;
      return Math.min(k, g.moveSpeed >= 20 ? 3 - (g.moveSpeed - 20) / 130 : 3);
    }
    return k;
  }

  /** the playback scale of legs animation `name` from sample i on: the speed between the snapshots
   *  i - 1 and i (3D; vertical for climbing), 1 at the start of a life or after a gap */
  scaleAt(cl, i, name) {
    const P = this.M.d.positions[cl], g = this.meta(name);
    if (i === 0 || (P.flags[i - 1] & PF.DEAD)) return 1;
    const dt = P.t[i] - P.t[i - 1];
    if (dt <= 0 || dt > CFG.GAP_MS) return 1;
    const climb = g.movetypes.some(m => m === 'climbup' || m === 'climbdown');
    const dx = P.x[i] - P.x[i - 1], dy = P.y[i] - P.y[i - 1], dz = P.z[i] - P.z[i - 1];
    const d = climb ? Math.abs(dz) : Math.hypot(dx, dy, dz);
    if (d > CFG.JUMP_UNITS) return 1;
    return this.rateScale(g, d / dt * 1000, climb);
  }

  /** phase (0..1 cycles, unwrapped) of the moving looping legs animation of run s at its samples:
   *  [phase at sample s, s + 1, ..., phase at the next run's start]. It starts at the phase the
   *  previous run had when that was a moving loop too (BG_SetNewAnimation keeps the normalised
   *  time), else at the game's (time % cycle) / cycle + clientNum * 0.36, and advances with
   *  scale / duration per second (BG_RunLerpFrameRate). Computed iteratively over chained runs. */
  runPhase(cl, s) {
    const key = cl + '|phase';
    let ph = this.runStart.get(key);
    if (!ph) this.runStart.set(key, ph = new Map());
    if (ph.has(s)) return ph.get(s);
    const P = this.M.d.positions[cl], L = this.runs(cl, 'legs');
    const chain = [];
    let k = s, base = null;
    for (;;) {
      if (ph.has(k)) { base = k; break; }
      chain.push(k);
      if (k === 0 || (P.flags[k - 1] & PF.DEAD) || !this.movingLoop(this.lib.treeName(P.legs[k - 1]))) break;
      k = L[k - 1];
    }
    for (let n = chain.length - 1; n >= 0; n--) {
      const r = chain[n], prev = n === chain.length - 1 ? base : chain[n + 1];
      let p0;
      if (prev == null) { const v = (P.t[r] % 1000) / 1000 + cl * 0.36; p0 = v - Math.floor(v); }
      else { const pc = ph.get(prev); p0 = pc[pc.length - 1]; }
      const name = this.lib.treeName(P.legs[r]), dur = this.lib.info(name).duration;
      let e = r;
      while (e + 1 < P.t.length && L[e + 1] === r) e++;
      const cum = new Float64Array(e - r + 2);
      cum[0] = p0;
      for (let j = r; j <= e; j++) {
        const next = j + 1 < P.t.length ? P.t[j + 1] : P.t[j];
        cum[j - r + 1] = cum[j - r] + (next - P.t[j]) / 1000 * this.scaleAt(cl, j, name) / dur;
      }
      ph.set(r, cum);
    }
    return ph.get(s);
  }

  /** time (s) of a game animation of run start s (sample index; legs runs) running since startT */
  clipTime(name, t, startT, dist, cl, s) {
    const c = this.lib.info(name);
    if (cl != null && s != null && this.movingLoop(name)) {
      const P = this.M.d.positions[cl], cum = this.runPhase(cl, s);
      const i = Math.min(Math.max(upperBound(P.t, t) - 1, s), s + cum.length - 2);
      const ph = cum[i - s] + (t - P.t[i]) / 1000 * this.scaleAt(cl, i, name) / c.duration;
      return (ph % 1 + 1) % 1 * c.duration;
    }
    const e = Math.max(0, (t - startT) / 1000);
    return c.loop ? e % c.duration : Math.min(e, c.duration);
  }

  /** the blend of the runs of `field` (legs / torso) at t: [{value, start, s, weight}] (sum 1). Each
   *  change fades in linearly over the game's blend time from the blended state at the moment of
   *  the change - not from the pure previous animation - so changes that follow each other faster
   *  than the fade (the server can switch the legs animation every snapshot) stay continuous. */
  chain(cl, field, i, t) {
    const P = this.M.d.positions[cl], R = this.runs(cl, field), out = [], lib = this.lib;
    let rest = 1, k = i, at = t;
    for (let depth = 0; depth < 8; depth++) {
      const s = R[k], start = P.t[s];
      const first = s === 0 || (P.flags[s - 1] & PF.DEAD);
      let f = 1;
      if (!first) {
        const next = lib.treeName(P[field][s]), prev = lib.treeName(P[field][s - 1]);
        let left = this.stanceLeft(cl, start);
        if (field === 'legs' && next && prev && this.stanceOf(next) !== this.stanceOf(prev)) left = STANCE_BLEND_MS;
        const ms = this.blendMs(next, prev, left);
        f = ms > 0 ? Math.max(0, Math.min(1, (at - start) / ms)) : 1;
      }
      out.push({ value: P[field][k], start, s, weight: rest * f });
      rest *= 1 - f;
      if (rest < 1e-4) break;
      k = s - 1; at = start;                 // the state just before this change, at its moment
    }
    if (rest >= 1e-4) out[out.length - 1].weight += rest;
    return out;
  }

  /** Phase 3: layers from the sample's legsAnim / torsoAnim, or null (no state / clip not ready) */
  game(cl, t, dist) {
    const P = this.M.d.positions[cl], lib = this.lib;
    if (!P || !P.legs || !lib.tree) return null;
    const i = upperBound(P.t, t) - 1;
    if (i < 0) return null;
    const legs = lib.treeName(P.legs[i]);
    if (!legs || !lib.has(legs)) return null;
    // legs: whole body; the same animation in several entries (restarts) counts once, newest time
    const byKey = new Map();
    let sum = 0;
    for (const e of this.chain(cl, 'legs', i, t)) {
      const name = lib.treeName(e.value);
      if (!name || !lib.has(name)) continue;
      const l = byKey.get(name);
      if (l) l.weight += e.weight;
      else byKey.set(name, { key: name, weight: e.weight, time: this.clipTime(name, t, e.start, dist, cl, e.s) });
      sum += e.weight;
    }
    const out = [...byKey.values()];
    for (const l of out) l.weight /= sum;
    // torso over the upper body (only the upper-body tracks, also of a full-body clip the game plays
    // as the torso animation, e.g. during a stance change). Shares p of the torso entries and the rest
    // for the legs' own upper body; with the legs layers summing to 1 a torso weight p / pLegs gives
    // the share p (the mixer normalises the weights per bone).
    const tor = new Map();
    let pLegs = 0;
    for (const e of this.chain(cl, 'torso', i, t)) {
      const name = lib.treeName(e.value);
      if (!name || name === legs || !lib.has(name)) { pLegs += e.weight; continue; }
      const l = tor.get(name);
      if (l) l.weight += e.weight;
      else tor.set(name, { key: name, weight: e.weight, time: this.clipTime(name, t, e.start, dist), torso: true });
    }
    for (const l of tor.values()) { l.weight = l.weight / Math.max(pLegs, 1e-3); out.push(l); }
    return out;
  }

  /** ground velocity (units/s) of client cl around t - from the interpolated positions */
  velocity(cl, t, s) {
    const M = this.M;
    let a = M.sampleAt(cl, t - VEL_MS), b = M.sampleAt(cl, t + VEL_MS), dt = 2 * VEL_MS;
    if (!b || b.age > VEL_MS) { b = s; dt = VEL_MS; }
    if (!a || a.age > VEL_MS) { a = s; dt -= VEL_MS; }
    if (!a || !b || dt <= 0) return { vx: 0, vy: 0, speed: 0 };
    const vx = (b.x - a.x) / dt * 1000, vy = (b.y - a.y) / dt * 1000;
    const speed = Math.hypot(vx, vy);
    return speed > 400 ? { vx: 0, vy: 0, speed: 0 } : { vx, vy, speed };   // a teleport / spawn
  }

  /** cumulative ground distance of client cl per sample */
  distTable(cl) {
    let D = this.dist.get(cl);
    if (!D) {
      const P = this.M.d.positions[cl];
      D = new Float64Array(P.t.length);
      for (let i = 1; i < D.length; i++) {
        const d = Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]);
        D[i] = D[i - 1] + (d <= CFG.JUMP_UNITS ? d : 0);
      }
      this.dist.set(cl, D);
    }
    return D;
  }

  /** distance walked by client cl up to its position s at time t (only differences matter) */
  distance(cl, t, s) {
    const P = this.M.d.positions[cl];
    const D = this.distTable(cl);
    const i = upperBound(P.t, t) - 1;
    return i < 0 ? 0 : D[i] + Math.hypot(s.x - P.x[i], s.y - P.y[i]);
  }

  /** the stance before the last change and the time of that change (within the blend time) */
  stanceChange(cl, t, stance) {
    const P = this.M.d.positions[cl];
    let i = upperBound(P.t, t) - 1;
    for (; i > 0 && t - P.t[i] < BLEND_MS[stance]; i--) {
      const prev = stanceOfFlags(P.flags[i - 1]);
      if (prev !== stance && !(P.flags[i - 1] & PF.DEAD)) return { from: prev, at: P.t[i] };
      if (prev !== stance) return null;
    }
    return null;
  }

  time(key, phase) { const c = this.lib.info(key); return phase * c.duration; }

  /** the clips of one stance for a speed and direction, appended to out with weight w */
  locomotion(stance, v, yaw, dist, tSec, w, out) {
    const lib = this.lib, add = (key, weight, time) => { if (weight > 0.002 && lib.has(key)) out.push({ key, weight: w * weight, time }); };
    const cyc = (key) => { const c = lib.info(key); return c && c.stride ? (dist / c.stride % 1) * c.duration : (tSec % (c ? c.duration : 1)); };
    const idle = stance + '_idle', c = lib.info(idle);
    const sp = v.speed;
    const move = stance === 'prone' ? smooth(3, 12, sp) : stance === 'crouch' ? smooth(8, 30, sp) : smooth(10, 40, sp);
    add(idle, 1 - move, c ? tSec % c.duration : 0);
    if (move <= 0) return;
    // direction relative to the view: forward / back / left / right weights (sum 1)
    const a = Math.atan2(v.vy, v.vx) - yaw * Math.PI / 180, fw = Math.cos(a), lf = Math.sin(a);
    const dw = { f: Math.max(0, fw) ** 2, b: Math.max(0, -fw) ** 2, l: Math.max(0, lf) ** 2, r: Math.max(0, -lf) ** 2 };
    if (stance === 'stand') {
      const run = smooth(100, 165, sp), sprint = smooth(215, 260, sp) * dw.f;
      for (const d of DIRS) {
        add('stand_walk_' + d, move * (1 - run) * dw[d], cyc('stand_walk_' + d));
        add('stand_run_' + d, move * run * dw[d] * (d === 'f' ? 1 - sprint / Math.max(dw.f, 1e-6) : 1), cyc('stand_run_' + d));
      }
      add('sprint', move * run * sprint, cyc('sprint'));
    } else {
      const base = stance === 'prone' ? 'prone_crawl_' : 'crouch_run_';
      for (const d of DIRS) add(base + d, move * dw[d], cyc(base + d));
    }
  }

  /** layers [{key, weight, time}] of a living player (sample s at t), or null without animations;
   *  this.source: 'game' (Phase 3) or 'movement' (Phase 2) */
  alive(cl, t, s, stance) {
    if (!this.lib.meta) return null;
    const dist = this.distance(cl, t, s);
    const g = this.game(cl, t, dist);
    if (g) { this.source = 'game'; return g; }
    this.source = 'movement';
    const v = this.velocity(cl, t, s), tSec = t / 1000, out = [];
    // bomb plant: the carrier, standing still during the plant time
    const plant = this.plantAt(cl, t);
    if (plant != null && v.speed < 20) {
      const key = 'plant_' + stance;
      if (this.lib.has(key)) return [{ key, weight: 1, time: Math.min(this.lib.info(key).duration, (t - plant) / 1000) }];
    }
    const ch = this.stanceChange(cl, t, stance);
    if (ch) {
      const f = smooth(0, 1, (t - ch.at) / BLEND_MS[stance]);
      this.locomotion(ch.from, v, s.yaw, dist, tSec, 1 - f, out);
      this.locomotion(stance, v, s.yaw, dist, tSec, f, out);
    } else this.locomotion(stance, v, s.yaw, dist, tSec, 1, out);
    return out;
  }

  /** start of a bomb plant by cl that is in progress at t (from the "planted the bomb" events), or null */
  plantAt(cl, t) {
    if (!this.plants) {
      this.plants = (this.M.d.events || []).filter(e => e.type === 'bomb_planted' && e.clients && e.clients.length)
        .map(e => ({ cl: e.clients[0], t: e.t }));
    }
    for (const p of this.plants) if (p.cl === cl && t >= p.t - PLANT_MS && t < p.t) return p.t - PLANT_MS;
    return null;
  }

  /** the corpses to draw at t: [{id, cl, key, time, x, y, z, yaw, t0, source}] - the corpse entities
   *  of the demo (Phase 3) and, for recent kills without one, the Phase 2 choice (kills = the
   *  recent kills shown with death markers) */
  corpsesAt(t, kills) {
    const M = this.M, out = [], lib = this.lib;
    if (!lib.meta) return out;
    const C = M.d.corpses || [];
    for (let n = 0; n < C.length; n++) {
      const c = C[n];
      if (c.t0 > t) break;
      const b = upperBound(M.bounds, c.t0), end = b < M.bounds.length ? M.bounds[b] : Infinity;
      if (t >= end || M.epochStart(t) > c.t0) continue;
      const name = lib.treeName(c.legs);
      if (!name || !lib.has(name)) continue;
      // the game plays a death from the start only for a new corpse; a body that was already lying
      // there when it came into view shows the end pose (BG_SetNewAnimation, flag 0x40)
      if (c.fresh === undefined) c.fresh = (M.d.kills || []).some(k => k.victim === c.client && Math.abs(k.t - c.t0) < CORPSE_MATCH_MS);
      const d = this.place(name, c.fresh ? (t - c.t0) / 1000 : Infinity, [c.x, c.y, c.z], c.yaw);
      out.push(Object.assign(d, { id: 'c' + n, cl: c.client, t0: c.t0, source: 'game' }));
    }
    for (const k of kills || []) {
      if (k.victim >= 64) continue;
      if (C.some(c => c.client === k.victim && Math.abs(c.t0 - k.t) < CORPSE_MATCH_MS && c.t0 <= t)) continue;
      const d = this.death(k, t);
      if (d) out.push(Object.assign(d, { id: 'k' + k.t + '|' + k.victim, cl: k.victim, t0: k.t, source: 'movement' }));
    }
    return out;
  }

  /** a death clip at `time` (s) placed at origin / yaw, moved by the clip's root motion */
  place(key, time, origin, yaw) {
    const c = this.lib.info(key);
    time = Math.max(0, Math.min(c.duration, time));
    const frame = time * c.framerate, r = yaw * Math.PI / 180;
    const tr = c.rootTrans ? sampleKeys(c.rootTrans, frame, 3) : [0, 0, 0];
    const turn = c.rootYaw ? sampleKeys(c.rootYaw, frame, 1)[0] : 0;
    return {
      key, time, yaw: yaw + turn,
      x: origin[0] + Math.cos(r) * tr[0] - Math.sin(r) * tr[1],
      y: origin[1] + Math.sin(r) * tr[0] + Math.cos(r) * tr[1],
      z: origin[2] + tr[2]
    };
  }

  /** Phase 2: the death of kill k at time t: {key, time, x, y, z, yaw} (position incl. root motion) or null */
  death(k, t) {
    if (!this.lib.meta) return null;
    const M = this.M, vp = M.deathPos(k);
    if (!vp || vp[2] == null) return null;
    const P = M.d.positions[k.victim];
    const i = P ? upperBound(P.t, k.t) - 1 : -1;
    if (i < 0) return null;
    // the last living sample: stance, view yaw, running
    let j = i;
    while (j > 0 && (P.flags[j] & PF.DEAD)) j--;
    const stance = stanceOfFlags(P.flags[j]), yaw = P.yaw[j];
    const s = M.sampleAt(k.victim, P.t[j]);
    const v = s ? this.velocity(k.victim, P.t[j], s) : { speed: 0 };
    const pick = prefix => { const keys = this.lib.keys(prefix); return keys.length ? keys[(Math.round(k.t) + k.victim * 7) % keys.length] : null; };
    const key = stance === 'prone' ? pick('death_prone_') : stance === 'crouch' ? pick('death_crouch_')
      : v.speed > 150 ? pick('death_run_') : pick('death_stand_');
    if (!key || !this.lib.has(key)) return null;
    return this.place(key, (t - k.t) / 1000, vp, yaw);
  }
}

/** linear interpolation of root-motion keys {frames, values} at a (fractional) frame */
function sampleKeys(k, frame, n) {
  const F = k.frames, V = k.values, val = i => n === 1 ? [V[i]] : V[i];
  if (F.length === 1 || frame <= F[0]) return val(0);
  for (let i = 1; i < F.length; i++) {
    if (frame <= F[i]) {
      const f = (frame - F[i - 1]) / (F[i] - F[i - 1]), a = val(i - 1), b = val(i);
      return a.map((x, c) => x + (b[c] - x) * f);
    }
  }
  return val(F.length - 1);
}
