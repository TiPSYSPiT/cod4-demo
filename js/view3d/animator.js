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
 * death is in the demo, else (dead before the recorder saw it) at its end pose - where the demo has
 * them: their trajectory (the clone drops with TR_GRAVITY from the feet, the server moves it by the
 * animation's delta and drops it again off a ledge; G_RunCorpseMove), simulated like the server once
 * the demo no longer sends them. The animation's delta is the server's movement of the entity, never
 * applied to the model (the game draws a corpse at its origin, yaw only). The game's angle
 * controllers (legs / torso yaw, pitch, lean, prone slope) are in controllers.js.
 *
 * Phase 2 - the fallback when a sample has no animation state or its clip is not exported:
 *   - locomotion: ground speed and direction (relative to the view yaw) from the positions around
 *     t; idle / walk / run / sprint per stance, forward / back / left / right blended by direction.
 *     The cycle phase is the distance walked divided by the clip's stride (its root motion), so the
 *     feet match the ground speed.
 *   - stance changes cross-fade over a short time after the change.
 *   - deaths without a corpse entity: the death animation the game picks for the movetype the victim
 *     died with (mp/playeranim.script DEATH, a stable choice per kill), the body dropped and moved
 *     like the server's (Animator.simulate: gravity, the animation's delta, rays against the world
 *     and the props' collision) until the round ends; bomb plants (S&D): the plant clip of the planter ("planted the bomb"
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
const SV_FRAME_MS = 50;                     // a server frame (sv_fps 20): G_RunCorpseMove moves a corpse once per frame
const CLONE_MAX_VEL = 80;                   // g_clonePlayerMaxVelocity
const CORPSE_R = 15;                        // the corpse's capsule radius (the player's mins / maxs)
const CORPSE_SIM_MS = 10000;                // a simulated corpse rests after this at the latest
const GRAVITY_TR = new Set([5, 10]);        // TR_GRAVITY, TR_RAGDOLL_GRAVITY
const FOOT_RAYS = [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]];   // the capsule's bottom
// mp/playeranim.script DEATH: the first row that matches the movetype (and strafing) the player died with;
// the game picks one of its animations at random
const DEATH_ANIMS = [
  { mt: new Set(['idleprone', 'walkprone', 'walkpronebk']), anims: ['pb_prone_death_quickdeath'] },
  { mt: new Set(['idlecr']), anims: ['pb_crouch_death_headshot_front', 'pb_crouch_death_clutchchest', 'pb_crouch_death_flip', 'pb_crouch_death_fetal', 'pb_crouch_death_falltohands'] },
  { mt: new Set(['runbk']), anims: ['pb_death_run_back'] },
  { mt: new Set(['run', 'runcr']), strafe: 'left', anims: ['pb_death_run_left'] },
  { mt: new Set(['run', 'runcr']), strafe: 'right', anims: ['pb_death_run_right'] },
  { mt: new Set(['runcr']), anims: ['pb_crouchrun_death_drop', 'pb_crouchrun_death_crumple'] },
  { mt: new Set(['run']), anims: ['pb_death_run_forward_crumple', 'pb_death_run_onfront', 'pb_death_run_stumble'] },
  { mt: null, anims: ['pb_stand_death_neckdeath', 'pb_stand_death_headchest_topple', 'pb_stand_death_frontspin', 'pb_stand_death_nervedeath',
    'pb_stand_death_legs', 'pb_stand_death_lowerback', 'pb_stand_death_head_collapse', 'pb_stand_death_neckdeath_thrash'] },
];
const DIRS = ['f', 'b', 'l', 'r'];
const smooth = (a, b, x) => { const f = Math.max(0, Math.min(1, (x - a) / (b - a))); return f * f * (3 - 2 * f); };
const stanceOfFlags = f => f & PF.PRONE ? 'prone' : f & PF.CROUCH ? 'crouch' : 'stand';

export class Animator {
  constructor(match, library) {
    this.M = match;
    this.lib = library;
    this.dist = new Map();                  // client -> cumulative ground distance per sample
    this.runStart = new Map();              // client|field -> first sample index of each run of equal values
    this.tracer = null;                     // the map's obstacles for the simulated corpses (setTracer)
    this.sims = new WeakMap();              // corpse record / kill -> its simulated frames
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
    // the deaths of the kills whose corpse the demo does not hold
    for (const f of this.fallbacks()) { const g = this.fallbackOf(f.k); if (g) names.add(g.key); }
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
   *  of the demo where they are (their trajectory) and, for a kill whose corpse the demo does not hold,
   *  the body simulated from the victim's last movement; every one until the round ends (or the game
   *  freed it: its entity number taken by another corpse) */
  corpsesAt(t) {
    const M = this.M, out = [], lib = this.lib;
    if (!lib.meta) return out;
    const C = this.corpseRecords(), epoch = M.epochStart(t);
    for (let n = 0; n < C.length; n++) {
      const c = C[n];
      if (c.t0 > t) break;
      if (t >= c.until || epoch > c.t0) continue;
      const key = lib.treeName(c.legs);
      if (!key || !lib.has(key)) continue;
      const p = this.corpsePos(c, t, key);
      out.push({ id: 'c' + n, cl: c.client, t0: c.t0, source: 'game', key, time: this.animTime(key, c.animT0, t), x: p[0], y: p[1], z: p[2], yaw: p[3] });
    }
    for (const f of this.fallbacks()) {
      if (f.k.t > t) break;
      if (t >= f.until || epoch > f.k.t) continue;
      const d = this.death(f.k, t);
      if (d) out.push(Object.assign(d, { id: 'k' + f.k.t + '|' + f.k.victim, cl: f.k.victim, t0: f.k.t, source: 'movement' }));
    }
    return out;
  }

  /** the map's obstacles for the corpses without demo data (fx.js tracer: the render world and the props'
   *  collision; scripts: scriptModels.js, the cars where they stand); a new one drops the simulated corpses */
  setTracer(tracer, scripts = null) {
    if ((tracer || null) === this.tracer && (scripts || null) === this.scripts) return;
    this.tracer = tracer || null;
    this.scripts = scripts || null;
    this.sims = new WeakMap();
  }

  /** the obstacles at time t (the cars move, burn out, come back), or null */
  traceAt(t) {
    return this.tracer && this.scripts && this.scripts.tracerFor ? this.scripts.tracerFor(this.tracer, t) : this.tracer;
  }

  /** the demo's corpse records, prepared once: until (the end of the round, or the next corpse in its entity
   *  slot - the game frees the farthest of its 8 corpses for a new one), animT0 (when its death animation
   *  started: the clone's drop time; -Infinity = it lay there before the recorder saw it: the end pose) */
  corpseRecords() {
    const M = this.M, C = M.d.corpses || [];
    if (this.preparedCorpses === C) return C;
    const kills = (M.d.kills || []).filter(k => k.victim < 64);
    const lastKill = (cl, t) => { let best = null; for (const k of kills) { if (k.t > t) break; if (k.victim === cl) best = k; } return best; };
    for (let n = 0; n < C.length; n++) {
      const c = C[n], b = upperBound(M.bounds, c.t0);
      c.until = b < M.bounds.length ? M.bounds[b] : Infinity;
      if (c.num !== undefined) for (let m = n + 1; m < C.length; m++) if (C[m].num === c.num) { c.until = Math.min(c.until, C[m].t0); break; }
      const k = lastKill(c.client, c.t0 + 200);
      // the same corpse seen again (it left the recorder's view): its animation goes on
      let prev = null;
      if (c.num !== undefined) for (let m = n - 1; m >= 0 && !prev; m--) if (C[m].num === c.num) prev = C[m];
      if (prev && prev.client === c.client && prev.until === c.t0 && (!k || k.t <= prev.t0 + CORPSE_MATCH_MS)) { c.animT0 = prev.animT0; continue; }
      // a new corpse: the game plays its death from the start only when it is new to the client; a body that
      // was already lying there when it came into view shows the end pose (BG_SetNewAnimation, flag 0x40)
      const s0 = c.states && c.states[0];
      if (k && c.t0 - k.t < CORPSE_MATCH_MS) c.animT0 = s0 && GRAVITY_TR.has(s0[1]) && Math.abs(s0[2] - k.t) < 500 ? s0[2] : k.t;
      else c.animT0 = -Infinity;
    }
    this.preparedCorpses = C;
    this.fallbackList = null;
    return C;
  }

  /** the kills whose corpse the demo does not hold (until it does): [{k, until}], by time */
  fallbacks() {
    const C = this.corpseRecords();
    if (this.fallbackList) return this.fallbackList;
    const M = this.M, out = [];
    const kills = (M.d.kills || []).filter(k => k.victim < 64);
    for (let i = 0; i < kills.length; i++) {
      const k = kills[i], b = upperBound(M.bounds, k.t);
      let until = b < M.bounds.length ? M.bounds[b] : Infinity, next = Infinity;
      for (let j = i + 1; j < kills.length; j++) if (kills[j].victim === k.victim) { next = kills[j].t; break; }
      // its corpse entity (from the moment the recorder sees it)
      for (const c of C) if (c.client === k.victim && c.t0 >= k.t - CORPSE_MATCH_MS && c.t0 < next) { until = Math.min(until, c.t0); break; }
      if (until > k.t) out.push({ k, until });
    }
    this.fallbackList = out;
    return out;
  }

  /** the time (s) into a death animation that started at animT0 (ms; -Infinity: the end pose) */
  animTime(key, animT0, t) {
    const d = this.lib.info(key).duration;
    return animT0 === -Infinity ? d : Math.max(0, Math.min(d, (t - animT0) / 1000));
  }

  /** the snapshot interval (ms): the client interpolates an entity between two snapshots */
  snapMs() {
    if (!this.snap) {
      const T = this.M.d.psCommandTime && this.M.d.psCommandTime.t, d = [];
      if (T) for (let i = 1; i < T.length && d.length < 2000; i++) if (T[i] > T[i - 1]) d.push(T[i] - T[i - 1]);
      d.sort((a, b) => a - b);
      this.snap = d.length ? Math.max(25, Math.min(100, d[d.length >> 1])) : 50;
    }
    return this.snap;
  }

  /** a corpse record's position at t: [x, y, z, yaw] - its trajectory (CG_CalcEntityLerpPositions: TR_GRAVITY
   *  evaluated, TR_INTERPOLATE interpolated between the snapshots); once the demo no longer sends it, the
   *  server's frames simulated from its last state on */
  corpsePos(c, t, key) {
    const S = c.states;
    if (!S || !S.length) return [c.x, c.y, c.z, c.yaw];
    const last = S[S.length - 1];
    if (t > c.t1) {
      let sim = this.sims.get(c);
      if (!sim) {
        const pos = stateAt(last, c.t1), falling = GRAVITY_TR.has(last[1]);
        sim = this.simulate({ t: c.t1, pos, falling, base: last.slice(3, 6), delta: last.slice(6, 9), trTime: last[2] }, key, last[9], c.animT0);
        this.sims.set(c, sim);
      }
      const p = simAt(sim, t);
      return [p[0], p[1], p[2], last[9]];
    }
    let lo = 0, hi = S.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m][0] <= t) lo = m + 1; else hi = m; }
    const s = S[Math.max(0, lo - 1)], n = S[lo];
    let p = stateAt(s, t);
    if (n) {
      const ta = n[0] - Math.min(this.snapMs(), n[0] - s[0]);
      if (t > ta) {
        const a = stateAt(s, ta), b = stateAt(n, n[0]), f = (t - ta) / (n[0] - ta);
        p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      } else if (GRAVITY_TR.has(s[1]) && !GRAVITY_TR.has(n[1])) {
        // it lands there: not below the landing, never above where this state was sent
        p[2] = Math.max(p[2], Math.min(n[5], stateAt(s, s[0])[2]));
      }
    }
    return [p[0], p[1], p[2], s[9]];
  }

  /** G_RunCorpseMove, frame by frame, for a corpse without (more) demo data, from st = {t, pos, falling, base, delta,
   *  trTime}: a falling corpse follows its TR_GRAVITY trajectory until it hits a floor (a wall pushes it off and it
   *  drops on: G_BounceCorpse); a lying one moves by its death animation's delta of each frame - only where that is
   *  more than a unit, like the game - stopped by walls, and drops again where no floor is under it any more. The
   *  traces are rays against the map's render world and the props' collision (fx.js) standing in for the corpse's
   *  capsule. -> {T, X, Y, Z}: the positions at the server's frames until it rests */
  simulate(st, key, yaw, animT0) {
    const clip = key ? this.lib.info(key) : null;
    // (no floor at all under it: the exported map lacks what it stands on - the corpse stays at that height)
    let tr = this.traceAt(st.t);
    if (tr && !tr.trace([st.pos[0], st.pos[1], st.pos[2] + 2], [st.pos[0], st.pos[1], st.pos[2] - 4000])) tr = null;
    const r = yaw * Math.PI / 180, cy = Math.cos(r), sy = Math.sin(r);
    const dur = clip ? clip.duration : 0;
    const root = s => (clip && clip.rootTrans ? sampleKeys(clip.rootTrans, Math.max(0, Math.min(dur, s)) * clip.framerate, 3) : [0, 0, 0]);
    const T = [st.t], X = [st.pos[0]], Y = [st.pos[1]], Z = [st.pos[2]];
    let pos = st.pos.slice(), falling = !!(st.falling && tr), base = st.base, delta = st.delta, trTime = st.trTime;
    const animEnd = animT0 === -Infinity ? -Infinity : animT0 + dur * 1000;
    for (let t = st.t + SV_FRAME_MS; t < st.t + CORPSE_SIM_MS; t += SV_FRAME_MS) {
      let target = null, d = null;
      if (falling) target = gravityAt(base, delta, trTime, t);
      else if (t - SV_FRAME_MS < animEnd) {
        const a = root((t - SV_FRAME_MS - animT0) / 1000), b = root((t - animT0) / 1000);
        d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > 1) target = [pos[0] + cy * d[0] - sy * d[1], pos[1] + sy * d[0] + cy * d[1], pos[2]];
      } else break;
      if (!target) continue;
      const trt = tr && this.traceAt(t);
      if (falling) {
        const h = this.fallTrace(trt, pos, target);
        pos = h.pos;
        if (h.hit) {
          if (h.nz > 0) falling = false;                                              // lands
          else { pos = [pos[0] + h.n[0], pos[1] + h.n[1], pos[2] + h.n[2]]; base = pos.slice(); delta = [0, 0, 0]; trTime = t; }
        }
      } else {
        pos = this.slideTrace(trt, pos, target);
        if (trt && !this.grounded(trt, pos)) { falling = true; base = pos.slice(); delta = [cy * d[0] - sy * d[1], sy * d[0] + cy * d[1], 0]; trTime = t; }
      }
      T.push(t); X.push(pos[0]); Y.push(pos[1]); Z.push(pos[2]);
      if (pos[2] < st.pos[2] - 4000) break;                                              // (out of the map)
    }
    return { T, X, Y, Z };
  }

  /** a falling corpse from a to b: rays at the centre and around (the capsule's bottom) -> {pos, hit, nz, n} */
  fallTrace(tr, a, b) {
    let best = null;
    for (const [ox, oy] of FOOT_RAYS) {
      const h = tr.trace([a[0] + ox, a[1] + oy, a[2] + 2], [b[0] + ox, b[1] + oy, b[2]]);
      if (h && (!best || h.frac < best.frac)) best = h;
    }
    if (!best) return { pos: b, hit: false };
    const A = [a[0], a[1], a[2] + 2], f = best.frac;
    return { pos: [A[0] + (b[0] - A[0]) * f, A[1] + (b[1] - A[1]) * f, A[2] + (b[2] - A[2]) * f], hit: true, nz: best.normal[2], n: best.normal };
  }

  /** a lying corpse moved from a towards b, stopped short of a wall (the capsule's radius) */
  slideTrace(tr, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (!tr || !len) return b;
    let f = 1;
    for (const h of [8, 30]) {
      const e = (len + CORPSE_R) / len;
      const hit = tr.trace([a[0], a[1], a[2] + h], [a[0] + dx * e, a[1] + dy * e, a[2] + h]);
      if (hit && Math.abs(hit.normal[2]) < 0.7) f = Math.min(f, Math.max(0, (hit.frac * (len + CORPSE_R) - CORPSE_R) / len));
    }
    return [a[0] + dx * f, a[1] + dy * f, a[2]];
  }

  /** a floor under the corpse's capsule (G_RunCorpseMove's trace one unit down) */
  grounded(tr, p) {
    for (const [ox, oy] of FOOT_RAYS) if (tr.trace([p[0] + ox, p[1] + oy, p[2] + 2], [p[0] + ox, p[1] + oy, p[2] - 5])) return true;
    return false;
  }

  /** the death animation the game picks for the movetype the victim died with (mp/playeranim.script DEATH: by
   *  movetype and strafing only, one of a set at random - here a stable choice per kill). The movetype is the
   *  living player's legs animation's (Phase 3), else from his stance and movement. */
  deathKey(k, P, j, v, yaw) {
    const lib = this.lib;
    let mt = null, strafe = null;
    const leg = P.legs ? lib.treeName(P.legs[j]) : null, g = leg && lib.info(leg).game;
    if (g && g.movetypes && g.movetypes.length) { mt = g.movetypes[0]; strafe = g.strafe || null; }
    else {
      const stance = stanceOfFlags(P.flags[j]), r = yaw * Math.PI / 180;
      const fwd = v.vx * Math.cos(r) + v.vy * Math.sin(r), side = -v.vx * Math.sin(r) + v.vy * Math.cos(r);
      if (stance === 'prone') mt = 'idleprone';
      else if (v.speed < 20) mt = stance === 'crouch' ? 'idlecr' : 'idle';
      else if (stance === 'crouch') mt = v.speed > 60 ? 'runcr' : 'walkcr';
      else mt = v.speed > 150 ? (fwd < -0.5 * v.speed ? 'runbk' : 'run') : 'walk';
      if (fwd > -0.5 * v.speed && Math.abs(side) > Math.abs(fwd)) strafe = side > 0 ? 'left' : 'right';
    }
    for (const row of DEATH_ANIMS) {
      if (row.mt && !row.mt.has(mt)) continue;
      if (row.strafe && strafe !== row.strafe) continue;
      const keys = row.anims.filter(n => lib.exists(n));
      if (keys.length) return keys[(Math.round(k.t) + k.victim * 7) % keys.length];
    }
    return null;
  }

  /** a kill whose corpse the demo does not hold: the death animation the game would pick and the body dropped
   *  and moved like the server's (simulate) from the victim's last position and movement -> {key, yaw, sim} or null */
  fallbackOf(k) {
    let f = this.sims.get(k);
    if (f !== undefined) return f;
    f = null;
    const M = this.M, vp = M.deathPos(k), P = M.d.positions[k.victim];
    const i = P && vp && vp[2] != null ? upperBound(P.t, k.t) - 1 : -1;
    if (i >= 0) {
      let j = i;
      while (j > 0 && (P.flags[j] & PF.DEAD)) j--;
      // the last living movement (PlayerCmd_ClonePlayer: the clone drops with the player's velocity, each
      // horizontal axis at most g_clonePlayerMaxVelocity - only upwards, like the game)
      let h = j;
      while (h > 0 && P.t[j] - P.t[h - 1] <= 200) h--;
      const dt = (P.t[j] - P.t[h]) / 1000;
      const v = dt > 0 ? { vx: (P.x[j] - P.x[h]) / dt, vy: (P.y[j] - P.y[h]) / dt, vz: (P.z[j] - P.z[h]) / dt } : { vx: 0, vy: 0, vz: 0 };
      if (Math.hypot(v.vx, v.vy) > 400 || Math.abs(v.vz) > 1000) { v.vx = 0; v.vy = 0; v.vz = 0; }   // (a teleport)
      v.speed = Math.hypot(v.vx, v.vy);
      const yaw = P.yaw[j], key = this.deathKey(k, P, j, v, yaw);
      if (key) {
        const pos = [vp[0], vp[1], vp[2]];
        const sim = this.simulate({ t: k.t, pos, falling: true, base: pos, delta: [Math.min(v.vx, CLONE_MAX_VEL), Math.min(v.vy, CLONE_MAX_VEL), v.vz], trTime: k.t }, key, yaw, k.t);
        f = { key, yaw, sim };
      }
    }
    this.sims.set(k, f);
    return f;
  }

  /** the corpse of kill k without demo data at time t: {key, time, x, y, z, yaw} or null */
  death(k, t) {
    if (!this.lib.meta) return null;
    const f = this.fallbackOf(k);
    if (!f || !this.lib.has(f.key)) return null;
    const p = simAt(f.sim, t);
    return { key: f.key, time: this.animTime(f.key, k.t, t), x: p[0], y: p[1], z: p[2], yaw: f.yaw };
  }
}

/** a corpse state [t, trType, trTime, base xyz, delta xyz, yaw] at t: TR_GRAVITY evaluated, else its base */
function stateAt(s, t) {
  return GRAVITY_TR.has(s[1]) ? gravityAt([s[3], s[4], s[5]], [s[6], s[7], s[8]], s[2], t) : [s[3], s[4], s[5]];
}

/** BG_EvaluateTrajectory TR_GRAVITY (g_gravity 800) */
function gravityAt(base, delta, trTime, t) {
  const dt = (t - trTime) / 1000;
  return [base[0] + delta[0] * dt, base[1] + delta[1] * dt, base[2] + delta[2] * dt - 400 * dt * dt];
}

/** a simulated corpse (Animator.simulate) at t: interpolated between the server's frames */
function simAt(sim, t) {
  const { T, X, Y, Z } = sim;
  if (t <= T[0]) return [X[0], Y[0], Z[0]];
  let lo = 0, hi = T.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m + 1; else hi = m; }
  const i = lo - 1, j = Math.min(lo, T.length - 1);
  if (i === j) return [X[i], Y[i], Z[i]];
  const f = (t - T[i]) / (T[j] - T[i]);
  return [X[i] + (X[j] - X[i]) * f, Y[i] + (Y[j] - Y[i]) * f, Z[i] + (Z[j] - Z[i]) * f];
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
