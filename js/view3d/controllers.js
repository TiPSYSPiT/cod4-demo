/* The game's player angle controllers: how CoD4 turns the legs, torso, neck and head of a player
 * model towards the view, leans it and tilts it on slopes when prone (KisakCOD
 * bgame/bg_animation_mp.cpp: BG_PlayerAngles, BG_SwingAngles, BG_Player_DoControllersInternal,
 * BG_Player_DoControllersSetup / BG_LerpAngles).
 *
 * Every client frame the game swings three angles towards their goals with a speed that grows with
 * the distance (BG_SwingAngles):
 *   legs yaw    towards view yaw + movement direction; only when they differ by more than 20°
 *               (or while moving), clamped to 150°; strafing animations follow the view itself
 *   torso yaw   towards the view yaw (45° clamp while firing, 90° otherwise)
 *   torso pitch towards twice the view pitch (clamp 45°)
 * The model's root (tag_origin) carries the legs yaw; the spine controller bones (back_low,
 * back_mid, back_up) take the torso's difference to the legs, neck and head the view's difference
 * to the torso; lean rolls the torso and shifts the root sideways; prone, the entity's
 * fTorsoPitch / fWaistPitch tilt root, back and pelvis to the slope. The controller angles follow
 * their goals at most 0.36° per ms (BG_LerpAngles), the root offset 0.1 units per ms.
 *
 * The state depends on its history, so it is simulated along the demo's samples in steps of at
 * most 16 ms (with checkpoints every CHECK samples): the same demo time always gives the same
 * angles, also when seeking. The MP body models have no back_up bone; the game skips it as well. */
import { upperBound } from '../app/match.js';
export { CONTROLLER_BONES } from './characters.js';

const C4 = window.C4;
const CFG = C4.mapConfig;
const PF = C4.collect.PF;
const SWING_SPEED = 0.2, LEG_YAW_TOLERANCE = 20, PITCH_SPEED = 0.15;     // bg_swingSpeed, bg_legYawTolerance
const STEP_MS = 16, CHECK = 10, ANGLE_RATE = 0.36, OFFSET_RATE = 0.1;
const LEAN_SHIFT = { left: 5, right: 2.5, crouchLeft: 12.5, crouchRight: 13 };      // player_lean_shift_*
const LEAN_ROTATE = { left: 1.25, right: 1.25, crouchLeft: 1.25, crouchRight: 1 };  // player_lean_rotate_*
const IDLE_MT = new Set(['idle', 'idlecr']);
const CLIMB_MT = new Set(['climbup', 'climbdown']);

const norm360 = a => ((a % 360) + 360) % 360;
/** AngleDelta(a, b): a - b in -180 .. 180 */
const delta = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; else if (d < -180) d += 360; return d; };
const D2R = Math.PI / 180;

/** BG_SwingAngles on state[key] / state[flag] */
function swing(st, key, flag, dest, tol, clamp, speed, dt) {
  if (!st[flag]) {
    const s = delta(st[key], dest);
    if (s > tol || s < -tol) st[flag] = 1;
  }
  if (!st[flag]) return;
  const s = delta(dest, st[key]);
  const move = dt * Math.max(0.5, Math.abs(s) * 0.05) * speed;
  if (s < 0) {
    if (s < -move) st[key] = norm360(st[key] - move);
    else { st[key] = norm360(st[key] + s); st[flag] = 0; }
  } else if (s > move) st[key] = norm360(st[key] + move);
  else { st[key] = norm360(st[key] + s); st[flag] = 0; }
  const s2 = delta(dest, st[key]);
  if (s2 > clamp) st[key] = norm360(dest - clamp);
  else if (s2 < -clamp) st[key] = norm360(dest + clamp);
}

/** BG_Player_DoControllersInternal: goal angles of the controller bones and the root */
function goals(st, inp, out) {
  const torsoP0 = inp.climb ? 0 : st.pitch;
  let torsoP = torsoP0;
  if (inp.prone && !inp.climb) {
    const v = torsoP / 360;
    torsoP = (v - Math.floor(v + 0.5)) * 360;
    torsoP = torsoP <= 0 ? torsoP * 0.25 : torsoP * 0.5;
  }
  const head = [delta(inp.pitch, torsoP), delta(inp.yaw, st.torso), 0];
  const torso = [delta(torsoP, 0), delta(st.torso, st.legs), 0];
  const f = inp.lean * (2 - Math.abs(inp.lean));                      // GetLeanFraction
  torso[2] = f * 50 * 0.925; head[2] = torso[2];
  let offX = 0, offY = 0;
  if (f) offY += inp.crouch ? (f <= 0 ? -f * LEAN_SHIFT.crouchLeft : -f * LEAN_SHIFT.crouchRight) : (f <= 0 ? -f * LEAN_SHIFT.left : -f * LEAN_SHIFT.right);
  const tag = [0, delta(st.legs, inp.yaw), 0];
  const slope = inp.torsoPitch || inp.waistPitch ? delta(inp.torsoPitch, inp.waistPitch) : 0;
  const a = out.angles;
  if (inp.prone) {
    if (f) head[2] *= 0.5;
    tag[0] += inp.torsoPitch;
    const c = Math.cos(torso[1] * D2R), s = Math.sin(torso[1] * D2R);
    offX += (1 - c) * -24;
    offY += s * -12;
    if (f * s > 0) offY += -f * (1 - c) * 16;
    a[0] = slope; a[1] = torso[2] * -1.2; a[2] = torso[2] * 0.3;
    a[3] = 0; a[4] = torso[1] * 0.1 - torso[2] * 0.2; a[5] = torso[2] * 0.2;
    a[6] = torso[0]; a[7] = torso[1] * 0.8 + torso[2]; a[8] = torso[2] * -0.2;
  } else {
    if (f) {
      const r = inp.crouch ? (f <= 0 ? LEAN_ROTATE.crouchLeft : LEAN_ROTATE.crouchRight) : (f <= 0 ? LEAN_ROTATE.left : LEAN_ROTATE.right);
      torso[2] *= r; head[2] *= r;
    }
    tag[2] += f * 50 * 0.075;
    a[0] = torso[0] * 0.2 + slope; a[1] = torso[1] * 0.4; a[2] = torso[2] * 0.5;
    a[3] = torso[0] * 0.3; a[4] = torso[1] * 0.4; a[5] = torso[2] * 0.5;
    a[6] = torso[0] * 0.5; a[7] = torso[1] * 0.2; a[8] = torso[2] * -0.6;
  }
  a[9] = head[0] * 0.3; a[10] = head[1] * 0.3; a[11] = 0;
  a[12] = head[0] * 0.7; a[13] = head[1] * 0.7; a[14] = head[2] * -0.3;
  a[15] = inp.torsoPitch || inp.waistPitch ? delta(inp.waistPitch, inp.torsoPitch) : 0; a[16] = 0; a[17] = 0;
  out.tag[0] = tag[0]; out.tag[1] = tag[1]; out.tag[2] = tag[2];
  out.offset[0] = offX; out.offset[1] = offY;
}

/** one client frame of BG_PlayerAngles + BG_Player_DoControllersSetup */
function step(st, inp, dt, snap) {
  const view = norm360(inp.yaw);
  if (inp.climb || inp.mantle || !st.idle) { st.torsoYawing = 1; st.pitching = 1; st.legsYawing = 1; }
  else if (inp.firing) { st.torsoYawing = 1; st.pitching = 1; }
  let vLegs = view + inp.moveDir;
  if (inp.climb) swing(st, 'torso', 'torsoYawing', vLegs, 0, 0, SWING_SPEED, dt);
  else if (inp.mantle) { vLegs = view; swing(st, 'torso', 'torsoYawing', view, 0, 90, SWING_SPEED, dt); }
  else swing(st, 'torso', 'torsoYawing', view, 0, inp.prone || !inp.firing ? 90 : 45, SWING_SPEED, dt);
  if (inp.prone) { st.legsYawing = 0; st.legs = view; }
  else if (inp.strafe) { st.legsYawing = 0; swing(st, 'legs', 'legsYawing', view, 0, 150, SWING_SPEED, dt); }
  else swing(st, 'legs', 'legsYawing', vLegs, st.legsYawing ? 0 : LEG_YAW_TOLERANCE, 150, SWING_SPEED, dt);
  if (inp.climb) { st.torso = norm360(view + inp.moveDir); st.legs = st.torso; }
  const p = delta(inp.pitch, 0);
  swing(st, 'pitch', 'pitching', inp.climb || inp.mantle ? 0 : p * 2, 0, 45, PITCH_SPEED, dt);
  goals(st, inp, st.goal);
  const max = snap ? Infinity : dt * ANGLE_RATE;
  for (let k = 0; k < 18; k++) st.angles[k] += Math.max(-max, Math.min(max, st.goal.angles[k] - st.angles[k]));
  for (let k = 0; k < 3; k++) st.tag[k] += Math.max(-max, Math.min(max, st.goal.tag[k] - st.tag[k]));
  const dx = st.goal.offset[0] - st.offset[0], dy = st.goal.offset[1] - st.offset[1], len = Math.hypot(dx, dy), mo = snap ? Infinity : dt * OFFSET_RATE;
  if (len <= mo) { st.offset[0] += dx; st.offset[1] += dy; } else { st.offset[0] += dx / len * mo; st.offset[1] += dy / len * mo; }
}

const fresh = () => ({ legs: 0, torso: 0, pitch: 0, legsYawing: 0, torsoYawing: 0, pitching: 0, idle: true,
  angles: new Float32Array(18), tag: new Float32Array(3), offset: new Float32Array(2),
  goal: { angles: new Float32Array(18), tag: new Float32Array(3), offset: new Float32Array(2) } });
const copy = s => ({ legs: s.legs, torso: s.torso, pitch: s.pitch, legsYawing: s.legsYawing, torsoYawing: s.torsoYawing, pitching: s.pitching,
  idle: s.idle, angles: s.angles.slice(), tag: s.tag.slice(), offset: s.offset.slice(),
  goal: { angles: new Float32Array(18), tag: new Float32Array(3), offset: new Float32Array(2) } });

export class Controllers {
  /** match: Match, lib: AnimationLibrary (clip metadata of the legs animation) */
  constructor(match, lib) { this.M = match; this.lib = lib; this.cache = new Map(); }

  /** inputs of sample i of client cl (the view angles interpolated towards sample i + 1 at time t) */
  input(P, i, t) {
    const lib = this.lib, name = lib.treeName(P.legs[i]), g = name && lib.info(name).game;
    let yaw = P.yaw[i], pitch = P.pitch[i];
    if (i + 1 < P.t.length && t > P.t[i] && P.t[i + 1] - P.t[i] <= CFG.GAP_MS && !(P.flags[i + 1] & PF.DEAD)) {
      const f = (t - P.t[i]) / (P.t[i + 1] - P.t[i]);
      yaw += delta(P.yaw[i + 1], yaw) * f; pitch += delta(P.pitch[i + 1], pitch) * f;
    }
    const fl = P.flags[i];
    return {
      yaw, pitch, moveDir: P.moveDir ? P.moveDir[i] : 0, lean: P.lean ? P.lean[i] : 0,
      torsoPitch: P.torsoPitch ? P.torsoPitch[i] : 0, waistPitch: P.waistPitch ? P.waistPitch[i] : 0,
      crouch: !!(fl & PF.CROUCH), prone: !!(fl & PF.PRONE), firing: !!(fl & PF.FIRING),
      movetypes: g ? g.movetypes : null, climb: !!(g && g.movetypes.some(m => CLIMB_MT.has(m))),
      mantle: !!(name && name.startsWith('mp_mantle')), strafe: !!(g && g.strafe)
    };
  }

  /** a new life / a gap / a new round restarts the simulation at sample i */
  restartsAt(P, i) {
    if (i === 0 || (P.flags[i - 1] & PF.DEAD)) return true;
    if (P.t[i] - P.t[i - 1] > 1000) return true;
    return this.M.epochStart(P.t[i]) > P.t[i - 1];
  }

  /** advance state st over sample i's interval up to time t (exclusive of sample i + 1) */
  run(P, i, st, from, to) {
    for (let t = from; t < to;) {
      const dt = Math.min(STEP_MS, to - t);
      t += dt;
      const inp = this.input(P, i, t);
      if (inp.movetypes && inp.movetypes.length) st.idle = inp.movetypes.some(m => IDLE_MT.has(m));
      step(st, inp, dt, false);
    }
  }

  start(P, i) {
    const st = fresh(), inp = this.input(P, i, P.t[i]);
    st.legs = st.torso = norm360(inp.yaw);
    st.pitch = norm360(Math.max(-45, Math.min(45, delta(inp.pitch, 0) * 2)));
    if (inp.movetypes && inp.movetypes.length) st.idle = inp.movetypes.some(m => IDLE_MT.has(m));
    step(st, inp, 0, true);
    return st;
  }

  /** controller state of client cl at time t: {angles: 6 × [pitch, yaw, roll], tag: [pitch, yaw,
   *  roll] of the root relative to the view yaw, offset: [forward, left]} or null */
  at(cl, t) {
    const P = this.M.d.positions[cl];
    if (!P || !P.legs) return null;
    const i = upperBound(P.t, t) - 1;
    if (i < 0 || (P.flags[i] & PF.DEAD)) return null;
    let C = this.cache.get(cl);
    if (!C) {
      // per sample the latest restart at or before it; checkpoint sample index -> state at that sample
      const R = new Int32Array(P.t.length);
      for (let j = 1; j < R.length; j++) R[j] = this.restartsAt(P, j) ? j : R[j - 1];
      this.cache.set(cl, C = { restart: R, states: new Map() });
    }
    const r = C.restart[i], S = C.states;
    let k = i - ((i - r) % CHECK), st;
    for (let c = k; c >= r; c -= CHECK) {
      if (S.has(c)) { st = copy(S.get(c)); k = c; break; }
    }
    if (!st) { st = this.start(P, r); k = r; S.set(r, copy(st)); }
    for (let j = k; j < i; j++) {
      this.run(P, j, st, P.t[j], P.t[j + 1]);
      if ((j + 1 - r) % CHECK === 0 && !S.has(j + 1)) S.set(j + 1, copy(st));
    }
    this.run(P, i, st, P.t[i], t);
    return { angles: st.angles, tag: st.tag, offset: st.offset };
  }
}
