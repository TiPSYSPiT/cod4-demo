/* The map's script models (destructible cars, bomb sites, the gametypes' objects): the script_model
 * entities of the map's entity string (maps3d/<map>/entities.json "scriptModels") and the script
 * entities the demo holds (DemoData.scriptEnts: model, trajectory, angles, flags over time). A demo
 * entity is linked to the map's entity it starts as (same model, first position within LINK_DIST);
 * its state at t is the last one known (the demo records every change while the server sends the
 * entity), unless a round started while it was not sent - then the map's own state until the first
 * state known in the round. Map entities the demo never
 * shows are drawn only when they are destructibles (the gametype scripts delete other ones, e.g. the
 * headquarters' laptops in S&D); entities the scripts spawn (mirrors, the bomb case) only while the
 * demo has them. Models: maps3d/_characters (kind "script"), lit by the light grid like the players,
 * casting the sun's shadow. Their collision (script_coll.bin: the models' XModelCollSurf triangles)
 * stops the bullet and debris traces where the entity stands at that time (trace). */
import * as THREE from 'three';
import { objectLighting, setObjectLighting, gridLit } from './lighting.js';
import { SHADOW_LAYER } from './shadows.js';

const LINK_DIST = 8;                 // units: a demo entity's first position vs. its map entity
const EF_NODRAW = 0x20;              // CG_General / CG_ScriptMover draw nothing then

/** BG_EvaluateTrajectory (bg_misc.cpp): t, trTime in ms; base / delta as arrays -> out */
export function evaluateTrajectory(type, trTime, duration, base, delta, t, out) {
  let dt;
  switch (type) {
    case 2: case 9:                                                   // TR_LINEAR (TR_FIRST_RAGDOLL)
      dt = (t - trTime) / 1000;
      for (let k = 0; k < 3; k++) out[k] = base[k] + delta[k] * dt;
      break;
    case 3:                                                           // TR_LINEAR_STOP
      dt = Math.max(0, (Math.min(t, trTime + duration) - trTime) / 1000);
      for (let k = 0; k < 3; k++) out[k] = base[k] + delta[k] * dt;
      break;
    case 4:                                                           // TR_SINE
      dt = Math.sin((t - trTime) / duration * 2 * Math.PI);
      for (let k = 0; k < 3; k++) out[k] = base[k] + delta[k] * dt;
      break;
    case 5:                                                           // TR_GRAVITY
      dt = (t - trTime) / 1000;
      for (let k = 0; k < 3; k++) out[k] = base[k] + delta[k] * dt;
      out[2] -= 400 * dt * dt;
      break;
    case 6: case 7: {                                                 // TR_ACCELERATE / TR_DECELERATE
      dt = (Math.min(t, trTime + duration) - trTime) / 1000;
      const len = Math.hypot(delta[0], delta[1], delta[2]), phase = duration > 0 ? len / (duration / 1000) : 0;
      const dir = len ? delta.map(v => v / len) : [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        out[k] = type === 6 ? base[k] + phase * 0.5 * dt * dt * dir[k]
          : base[k] + delta[k] * dt - phase * 0.5 * dt * dt * dir[k];
      }
      break;
    }
    default:                                                          // stationary, interpolate, physics
      for (let k = 0; k < 3; k++) out[k] = base[k];
  }
  return out;
}

/** AnglesToAxis (pitch, yaw, roll in degrees) -> the model's placement matrix at origin */
function placement(angles, origin, out) {
  const r = Math.PI / 180, p = angles[0] * r, y = angles[1] * r, rl = angles[2] * r;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(rl), cr = Math.cos(rl);
  const f = [cp * cy, cp * sy, -sp], l = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp], u = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  return out.set(f[0], l[0], u[0], origin[0], f[1], l[1], u[1], origin[1], f[2], l[2], u[2], origin[2], 0, 0, 0, 1);
}

// a demo state: [t, eType, model, trType, trTime, trDuration, base xyz, delta xyz, apos trType, trTime,
// trDuration, base xyz, delta xyz, eFlags, solid] (build.js scriptEnts)
const stModel = s => s[2], stFlags = s => s[21];

const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
/** does the segment a -> b (up to the fraction maxF) touch the box [x0, y0, z0, x1, y1, z1] */
function segmentHitsBox(a, b, box, maxF) {
  let t0 = 0, t1 = maxF;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < box[k] - 1 || a[k] > box[3 + k] + 1) return false; continue; }
    let ta = (box[k] - 1 - a[k]) / d, tb = (box[3 + k] + 1 - a[k]) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}
/** the nearest of count triangles (P: 9 floats each from first) hit by a -> b before maxF -> {f, k, n} */
function triangles(P, first, count, a, b, maxF) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  let best = maxF, hit = -1;
  for (let k = 0; k < count; k++) {
    const o = 9 * (first + k);
    const e1x = P[o + 3] - P[o], e1y = P[o + 4] - P[o + 1], e1z = P[o + 5] - P[o + 2];
    const e2x = P[o + 6] - P[o], e2y = P[o + 7] - P[o + 1], e2z = P[o + 8] - P[o + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-9) continue;
    const inv = 1 / det, sx = a[0] - P[o], sy = a[1] - P[o + 1], sz = a[2] - P[o + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const f = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (f > 1e-6 && f < best) { best = f; hit = k; }
  }
  if (hit < 0) return null;
  const o = 9 * (first + hit);
  const e1 = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]], e2 = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return { f: best, k: hit, n: [n[0] / l, n[1] / l, n[2] / l] };
}

/** a tracer for the moment t: the world's (trace.js WorldTracer) and the script models' (cars) at t,
 *  whichever is hit first - what the bullet and debris traces use */
export function tracerAt(world, scripts, t) {
  if (!scripts || !scripts.coll) return world;
  return {
    worldTriangles: world.worldTriangles, propTriangles: world.propTriangles, built: world.built,
    trace(a, b) {
      const w = world.trace(a, b), s = scripts.trace(a, b, t);
      return s && (!w || s.frac < w.frac) ? s : w;
    }
  };
}

export class ScriptModels {
  /** M: app/match.js Match, spawns: entities.json scriptModels, library: characters.js CharacterLibrary */
  constructor(M, spawns, library, lightGrid, onChange, props = null) {
    this.M = M;
    this.library = library;
    this.props = props;                       // props.js Props: models the map places as props too
    this.lightGrid = lightGrid;
    this.onChange = onChange;
    this.group = new THREE.Group();
    this.group.name = 'script models';
    this.items = this.build(spawns || [], M.d.scriptEnts || []);
    this.meshes = new Map();                  // item -> {name, mesh}
    this.tmpM = new THREE.Matrix4();
    this.rounds = (M.d.rounds || []).map(r => [r.segStart, r.segEnd]);
  }

  /** the drawn entities: map entities (linked to their demo entity where the demo shows them) and the
   *  demo's own -> [{spawn, states (sorted), records: [[t0, t1]]}] */
  build(spawns, ents) {
    const byNum = new Map();
    for (const r of ents) {
      let e = byNum.get(r.num);
      if (!e) byNum.set(r.num, e = { num: r.num, states: [], records: [] });
      e.states.push(...r.states);
      e.records.push([r.t0, r.t1]);
    }
    const items = [], linked = new Set();
    const pos = s => [s[6], s[7], s[8]];
    for (const e of byNum.values()) {
      e.states.sort((a, b) => a[0] - b[0]);
      const first = e.states[0], p = pos(first);
      let spawn = null, best = LINK_DIST;
      spawns.forEach((sp, i) => {
        // the same model, or for a destructible any of its states (a car first seen destroyed)
        const m = stModel(first) || '';
        if (linked.has(i) || (sp.model !== m && !(sp.destructible && m.startsWith(sp.destructible)))) return;
        const d = Math.hypot(sp.origin[0] - p[0], sp.origin[1] - p[1], sp.origin[2] - p[2]);
        if (d < best) { best = d; spawn = i; }
      });
      if (spawn != null) linked.add(spawn);
      items.push({ spawn: spawn != null ? spawns[spawn] : null, states: e.states, records: e.records, num: e.num });
    }
    spawns.forEach((sp, i) => {
      if (!linked.has(i) && (sp.destructible || sp.targetname === 'destructible')) items.push({ spawn: sp, states: [], records: [] });
    });
    this.linkedCount = linked.size;
    return items;
  }

  /** the state of an item at t: {model, origin, angles} or null (not there / hidden) */
  stateAt(it, t) {
    const S = it.states;
    if (S.length) {
      const r = this.rounds.find(x => t >= x[0] && t < x[1]) || [-Infinity, Infinity];
      let pick = null;
      if (it.spawn) {
        // a map entity: its last known state - the demo records every change while the server sends the
        // entity - unless a round started (map_restart: everything restored) while it was not sent; then
        // the first state known in the round, else the map's own
        for (const s of S) { if (s[0] <= t) pick = s; else break; }
        const seenAtStart = it.records.some(([a, b]) => a <= r[0] && b >= r[0]);
        if (!pick || (pick[0] < r[0] && !seenAtStart)) {
          pick = null;
          for (const s of S) { if (s[0] >= r[0] && s[0] < r[1]) { pick = s; break; } }
          // nothing known yet at t (first seen later in the round): the map's own state
          if (!pick || pick[0] > t) return this.spawnState(it.spawn);
        }
      } else {
        // an entity the scripts spawn: only while the demo has it
        if (!it.records.some(([a, b]) => t >= a && t <= b + 100)) return null;
        for (const s of S) { if (s[0] <= t) pick = s; else break; }
      }
      if (!pick || (stFlags(pick) & EF_NODRAW) || !stModel(pick) || stModel(pick)[0] === '*') return null;
      const o = evaluateTrajectory(pick[3], pick[4], pick[5], [pick[6], pick[7], pick[8]], [pick[9], pick[10], pick[11]], t, [0, 0, 0]);
      const a = evaluateTrajectory(pick[12], pick[13], pick[14], [pick[15], pick[16], pick[17]], [pick[18], pick[19], pick[20]], t, [0, 0, 0]);
      // solid: what is drawn (the entity state's solid field is the client's prediction box, 0 for the
      // cars, which the server's traces hit with their model's collision)
      return { model: stModel(pick), origin: o, angles: a, solid: true };
    }
    return it.spawn ? this.spawnState(it.spawn) : null;
  }
  spawnState(sp) { return { model: sp.model, origin: sp.origin, angles: sp.angles, solid: true }; }

  /** the collision triangles of the models (mapLoader scriptCollision: {models: {name: [first, count]},
   *  P: Float32Array 9 per triangle, S: surface types}) */
  setCollision(coll) {
    this.coll = coll || null;
    this.collBounds = new Map();
  }

  /** the first hit of the segment a -> b on a solid script model at t (ms, relative to the demo start),
   *  as the game's traces hit an entity's model (XModelTraceLine on its collision surfaces, in the
   *  entity's frame) -> {frac, point, normal, surface, script: model name} or null */
  trace(a, b, t) {
    const C = this.coll;
    if (!C) return null;
    let best = null, bestF = 1;
    for (const it of this.items) {
      const st = this.stateAt(it, t);
      if (!st || !st.solid) continue;
      const r = C.models[st.model];
      if (!r) continue;
      const box = this.boundsOf(st.model, r);
      // into the model's frame: the placement is a rotation (AnglesToAxis) and the origin
      const m = placement(st.angles, st.origin, this.tmpM).elements;
      const f = [m[0], m[1], m[2]], l = [m[4], m[5], m[6]], u = [m[8], m[9], m[10]], o = st.origin;
      const loc = p => { const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; return [dot(f, d), dot(l, d), dot(u, d)]; };
      const la = loc(a), lb = loc(b);
      if (!segmentHitsBox(la, lb, box, bestF)) continue;
      const hit = triangles(C.P, r[0], r[1], la, lb, bestF);
      if (!hit) continue;
      bestF = hit.f;
      const n = hit.n, wn = [f[0] * n[0] + l[0] * n[1] + u[0] * n[2], f[1] * n[0] + l[1] * n[1] + u[1] * n[2], f[2] * n[0] + l[2] * n[1] + u[2] * n[2]];
      const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      if (dot(wn, dir) > 0) { wn[0] = -wn[0]; wn[1] = -wn[1]; wn[2] = -wn[2]; }
      best = { frac: hit.f, point: [a[0] + dir[0] * hit.f, a[1] + dir[1] * hit.f, a[2] + dir[2] * hit.f], normal: wn,
        surface: C.S[r[0] + hit.k], script: st.model, tri: -2 - (r[0] + hit.k) };   // (penetration: the same triangle?)
    }
    return best;
  }
  /** the tracer for the demo time t: the world's and these models' (tracerAt) */
  tracerFor(world, t) { return tracerAt(world, this, t); }
  boundsOf(name, r) {
    let b = this.collBounds.get(name);
    if (!b) {
      b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      const P = this.coll.P;
      for (let k = 9 * r[0]; k < 9 * (r[0] + r[1]); k += 3) for (let j = 0; j < 3; j++) { b[j] = Math.min(b[j], P[k + j]); b[3 + j] = Math.max(b[3 + j], P[k + j]); }
      this.collBounds.set(name, b);
    }
    return b;
  }

  /** place every entity for time t (ms, relative to the demo start) */
  update(t) {
    let n = 0;
    for (const it of this.items) {
      const st = this.stateAt(it, t);
      let entry = this.meshes.get(it);
      if (!st) { if (entry) entry.mesh.visible = false; continue; }
      if (!entry || entry.name !== st.model) {
        const model = this.library.loaded(st.model) || (this.props && this.props.modelFor(st.model));
        if (!model) {
          if (entry) entry.mesh.visible = false;
          this.load(st.model);
          continue;
        }
        if (entry) { this.group.remove(entry.mesh); }
        entry = this.mesh(model, st.model);
        this.meshes.set(it, entry);
      }
      const mesh = entry.mesh;
      mesh.matrix.copy(placement(st.angles, st.origin, this.tmpM));
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
      n++;
      // the light grid at the origin (+ a little up), re-sampled when the model moved
      const at = entry.at, o = st.origin;
      if (this.lightGrid && (!at || Math.abs(at[0] - o[0]) + Math.abs(at[1] - o[1]) + Math.abs(at[2] - o[2]) > 8)) {
        const s = {};
        if (this.lightGrid.sample(o[0], o[1], o[2] + 24, s)) setObjectLighting(entry.lg, s);
        entry.at = o.slice();
      }
    }
    this.visible = n;
  }

  load(name) {
    if (this.library.models.has(name)) return;
    this.library.available().then(idx => {
      if (idx[name]) this.library.load(name).then(() => this.onChange && this.onChange()).catch(() => null);
    });
  }

  mesh(model, name) {
    const lg = objectLighting();
    const mesh = new THREE.Mesh(model.geo, model.mats.map((m, k) => gridLit(m.clone(), lg, model.shadings && model.shadings[k])));
    mesh.name = 'script model ' + name;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.layers.enable(SHADOW_LAYER);           // casts the sun's shadow (moving: the dynamic map)
    this.group.add(mesh);
    return { name, mesh, lg, at: null };
  }

  /** the models whose state the demo changes (destroyed cars ...) and the drawn count, for the hint */
  counts() { return { entities: this.items.length, linked: this.linkedCount, visible: this.visible || 0 }; }

  dispose() {
    for (const { mesh } of this.meshes.values()) for (const m of mesh.material) m.dispose();
  }
}
