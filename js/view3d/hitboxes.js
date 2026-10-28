/* The players' hit boxes for the traced shots, as the game tests a player model (xanim/dobj.cpp
 * DObjTraceline): every bone of the body and head models with a hit volume (XBoneInfo, exported as
 * the character's "hitBoxes": the box in the bone's space, the bounding sphere's centre offset and
 * radius^2) - first the sphere around the bone's centre, then the box in the bone's frame (slab test);
 * the nearest entry counts. The bones are placed with the player's animated pose at the shot, as the
 * game does: the animation layers the player plays then (animator.js alive: the game's legs / torso
 * animations of the demo, blended as the game) and the angle controllers (controllers.js), on a
 * skeleton without geometry (characters.js rigModel / Character) at the player's position and yaw.
 * Without the animations: the character's stance pose (stand / crouch / prone) turned by the yaw.
 * Corpses are not hit: MASK_SHOT has no CONTENTS_CORPSE. */
import * as THREE from 'three';
import { stancePose, rigModel, Character } from './characters.js';
import { weaponModelName } from './actors.js';
import { dataUrl } from './data.js';

const NEAR = 80;                              // a ray farther than this from the player's centre misses it
const POSE_CACHE = 4000;                      // posed box sets kept (client + time)

const BASE = { dir: 'maps3d/_characters/' };

/** the body + head model names of client cl at time t (as actors.js modelsAt) */
export function modelsAt(M, cl, t) {
  const list = (M.d.playerModels || {})[cl];
  if (!list || !list.length) return null;
  const pick = e => {
    const names = [e.body, ...e.attach].filter(Boolean);
    const body = names.find(n => n.startsWith('body_'));
    return body ? { body, head: names.find(n => n.startsWith('head_')) || null } : null;
  };
  let best = null;
  for (const e of list) { if (e.t > t) break; best = pick(e) || best; }
  if (!best) for (const e of list) { best = pick(e); if (best) break; }
  return best;
}

/** quaternion [x, y, z, w] -> rows of the 3x3 rotation (bone -> model) */
function quatMat(q) {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

export class HitBoxes {
  constructor(dir = BASE.dir) {
    this.dir = dir;
    this.meta = new Map();                    // model name -> meta (JSON) or null
    this.sets = new Map();                    // body|head|stance -> [box]
    this.index = null;
  }

  /** where the client starts client cl's shot at t: the weapon's tag_flash in the animated pose, or null */
  muzzle(cl, t, s) {
    if (!this.M) return null;
    const models = modelsAt(this.M, cl, t);
    const set = models && s ? this.posed(cl, t, s, models) : null;
    return set && set.muzzle || null;
  }

  /** the animation sources (actors.js: animator, anims, controllers; loaded = anims ready) */
  setAnimation(src) { this.anim = src; this.posedCache = new Map(); this._ads = null; }

  /** BG_IsAds as the client asks it for another player's shot (CG_IsPlayerADS): the movetypes of the
   *  legs animation he plays at t include a walk (mask 0x3F0: walk, walkbk, walkcr, walkcrbk,
   *  walkprone, walkpronebk) - aiming down the sights the player walks. null: no animation data */
  adsTest() {
    if (this._ads) return this._ads;
    const A = this.anim;
    if (!A || !A.ready || !A.ready() || !A.anims || !A.anims.meta) return null;
    const lib = A.anims, M = A.animator.M, cache = new Map();
    const WALKS = new Set(['walk', 'walkbk', 'walkcr', 'walkcrbk', 'walkprone', 'walkpronebk']);
    return (this._ads = (cl, t) => {
      const P = M.d.positions[cl];
      if (!P || !P.legs) return false;
      let lo = 0, hi = P.t.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] <= t) lo = m + 1; else hi = m; }
      const i = lo - 1;
      if (i < 0) return false;
      const legs = P.legs[i] & ~0x200;
      if (!cache.has(legs)) {
        const name = lib.treeName(legs), c = name && lib.meta.clips[lib.name(name)];
        cache.set(legs, !!(c && c.game && (c.game.movetypes || []).some(m => WALKS.has(m))));
      }
      return cache.get(legs);
    });
  }

  /** a geometry-free character for a body + head (shared by the players wearing them) */
  rig(models) {
    const key = models.body + '|' + models.head;
    this.rigs = this.rigs || new Map();
    if (!this.rigs.has(key)) {
      const mb = this.meta.get(models.body), mh = models.head && this.meta.get(models.head);
      this.rigs.set(key, mb ? new Character(rigModel(mb), mh ? rigModel(mh) : null) : null);
    }
    return this.rigs.get(key);
  }

  /** the boxes of client cl at t in world space, in the animated pose (null: no animation) */
  posed(cl, t, s, models) {
    const A = this.anim;
    if (!A || !A.ready || !A.ready()) return null;
    const key = cl + ':' + t;
    if (this.posedCache.has(key)) return this.posedCache.get(key);
    const ch = this.rig(models), mb = this.meta.get(models.body), mh = models.head && this.meta.get(models.head);
    if (!ch || !mb || !mb.hitBoxes) return null;
    const st = s.prone ? 'prone' : s.crouch ? 'crouch' : 'stand';
    const layers = A.animator.alive(cl, t, s, st);
    const ctrl = layers && layers.length && A.animator.source === 'game' ? A.controllers.at(cl, t) : null;
    const list = (layers || []).map(l => ({ clip: A.anims.clip(l.key, ch, !!l.torso), weight: l.weight, time: l.time })).filter(l => l.clip);
    if (list.length) ch.animate(list, ctrl ? 0 : s.pitch, st); else ch.pose(st, s.pitch);
    if (ctrl) ch.applyControllers(ctrl);
    ch.group.position.set(s.x, s.y, s.z);
    ch.group.rotation.set(0, 0, s.yaw * Math.PI / 180);
    ch.group.updateMatrixWorld(true);
    const out = [];
    const add = (meta, bones) => {
      for (const h of meta.hitBoxes || []) {
        const bone = bones[h.bone];
        if (!bone) continue;
        const e = bone.matrixWorld.elements;
        const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]], p = [e[12], e[13], e[14]], o = h.offset;
        const c = [0, 1, 2].map(k => p[k] + R[3 * k] * o[0] + R[3 * k + 1] * o[1] + R[3 * k + 2] * o[2]);
        out.push({ R, p, mins: h.mins, maxs: h.maxs, c, r2: h.radius2 });
      }
    };
    add(mb, ch.bones);
    if (mh && ch.headMesh) add(mh, ch.headMesh.skeleton.bones);
    // the muzzle: the held weapon's tag_flash on tag_weapon_right (actors.js muzzle)
    const wm = this.weaponTable && this.M ? weaponModelName(this.weaponTable, this.M.weaponName(s.weapon, t)) : null;
    const wmeta = wm && this.meta.get(wm), hand = ch.byName.get('tag_weapon_right');
    const tag = wmeta && hand && wmeta.bones.find(b => b.name === 'tag_flash');
    if (tag) {
      const m4 = new THREE.Matrix4().compose(new THREE.Vector3(...tag.pos), new THREE.Quaternion(...tag.quat), new THREE.Vector3(1, 1, 1)).premultiply(hand.matrixWorld);
      out.muzzle = [m4.elements[12], m4.elements[13], m4.elements[14]];
    }
    if (this.posedCache.size > POSE_CACHE) this.posedCache.clear();
    this.posedCache.set(key, out);
    return out;
  }

  /** load the body and head models every client of the demo wears -> Promise */
  loadFor(M) {
    const names = new Set();
    for (const list of Object.values(M.d.playerModels || {})) for (const e of list) {
      for (const n of [e.body, ...(e.attach || [])]) if (n && (n.startsWith('body_') || n.startsWith('head_'))) names.add(n);
    }
    this.ready = (async () => {
      try { this.index = await (await fetch(dataUrl(this.dir + 'index.json'))).json(); } catch (err) { this.index = {}; }
      // the weapons the players hold (their tag_flash: where the client starts another player's shot)
      try { this.weaponTable = (await (await fetch(dataUrl(this.dir + 'weapons.json'))).json()).weapons; } catch (err) { this.weaponTable = null; }
      this.M = M;
      if (this.weaponTable && M.weaponName) {
        for (const P of Object.values(M.d.positions || {})) {
          let last = -1;
          for (let i = 0; i < P.t.length; i++) {
            if (P.weapon[i] === last) continue;
            last = P.weapon[i];
            const m = weaponModelName(this.weaponTable, M.weaponName(last, P.t[i]));
            if (m) names.add(m);
          }
        }
      }
      await Promise.all([...names].map(async n => {
        const e = this.index[n];
        if (!e) { this.meta.set(n, null); return; }
        for (let k = 0; k < 3; k++) {
          try { const r = await fetch(dataUrl(this.dir + e.file)); if (r.ok) { this.meta.set(n, await r.json()); return; } } catch (err) { /* retried */ }
          await new Promise(res => setTimeout(res, 300 * (k + 1)));
        }
        this.meta.set(n, null);
      }));
      this.loaded = true;
    })();
    return this.ready;
  }

  /** the boxes of body + head in a stance, in model space (X forward, Z up, origin at the feet):
   *  [{R (bone -> model rows), p (bone origin), mins, maxs, c (sphere centre), r2}] or null */
  boxes(body, head, stance) {
    const key = body + '|' + head + '|' + stance;
    if (this.sets.has(key)) return this.sets.get(key);
    const mb = this.meta.get(body);
    if (!mb || !mb.hitBoxes) { this.sets.set(key, null); return null; }
    const world = stancePose(mb.bones, stance);                   // {p: Vector3, q: Quaternion} per bone
    const byName = new Map(mb.bones.map((b, i) => [b.name, world[i]]));
    const out = [];
    const add = (meta, poseOf) => {
      for (const h of meta.hitBoxes || []) {
        const w = poseOf(h.bone);
        if (!w) continue;
        const R = quatMat([w.q.x, w.q.y, w.q.z, w.q.w]), p = [w.p.x, w.p.y, w.p.z];
        const o = h.offset, c = [0, 1, 2].map(k => p[k] + R[3 * k] * o[0] + R[3 * k + 1] * o[1] + R[3 * k + 2] * o[2]);
        out.push({ R, p, mins: h.mins, maxs: h.maxs, c, r2: h.radius2 });
      }
    };
    add(mb, i => world[i]);
    const mh = head && this.meta.get(head);
    // the head shares the body's bones by name; a bone of its own (eyes, jaw, helmet, fingers) hangs off
    // its nearest ancestor the body has: the body's posed ancestor x the bone's bind transform relative
    // to that ancestor (the head model's bind pose is in its own space)
    if (mh) {
      const bind = mh.bones.map(b => ({ p: new THREE.Vector3(...b.pos), q: new THREE.Quaternion(...b.quat).normalize() }));
      const placed = new Map();
      const poseOf = i => {
        if (placed.has(i)) return placed.get(i);
        let w = byName.get(mh.bones[i].name) || null;
        if (!w) {
          let a = mh.bones[i].parent;
          while (a >= 0 && !byName.has(mh.bones[a].name)) a = mh.bones[a].parent;
          if (a >= 0) {
            const A = byName.get(mh.bones[a].name), ai = bind[a].q.clone().invert();
            const relP = bind[i].p.clone().sub(bind[a].p).applyQuaternion(ai), relQ = ai.multiply(bind[i].q);
            w = { p: relP.applyQuaternion(A.q).add(A.p), q: A.q.clone().multiply(relQ) };
          }
        }
        placed.set(i, w);
        return w;
      };
      add(mh, poseOf);
    }
    this.sets.set(key, out.length ? out : null);
    return this.sets.get(key);
  }

  /** the first hit of a -> b (world) on the boxes of a player sample s (position, yaw, stance) wearing
   *  models -> {frac, point, normal} or null; null as well when the models are not loaded (caller: capsule) */
  trace(a, b, s, models, maxFrac = 1, cl = null, t = null) {
    if (!models) return undefined;
    // far from the player: no box can be hit (the pose is not needed)
    const cz = s.z + (s.prone ? 12 : s.crouch ? 26 : 36);
    const dd = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dl2 = dd[0] * dd[0] + dd[1] * dd[1] + dd[2] * dd[2];
    const ao = [a[0] - s.x, a[1] - s.y, a[2] - cz], tt = dl2 ? Math.max(0, Math.min(1, -(ao[0] * dd[0] + ao[1] * dd[1] + ao[2] * dd[2]) / dl2)) : 0;
    if (Math.hypot(ao[0] + dd[0] * tt, ao[1] + dd[1] * tt, ao[2] + dd[2] * tt) > NEAR && this.meta.get(models.body)) return null;
    // the animated pose (world space boxes) when the animations are there
    const posed = cl != null && t != null ? this.posed(cl, t, s, models) : null;
    if (posed) return this.traceSet(a, b, posed, maxFrac, null);
    const set = this.boxes(models.body, models.head, s.prone ? 'prone' : s.crouch ? 'crouch' : 'stand');
    if (!set) return undefined;
    return this.traceSet(a, b, set, maxFrac, s);
  }

  /** a -> b against a box set: world space (s null) or the model space of sample s (position, yaw) */
  traceSet(a, b, set, maxFrac, s) {
    // into the model's frame: minus the origin, turned by -yaw (world space boxes: as they are)
    const y = s ? -s.yaw * Math.PI / 180 : 0, cy = Math.cos(y), sy = Math.sin(y);
    const loc = s ? p => { const x = p[0] - s.x, yy = p[1] - s.y; return [x * cy - yy * sy, x * sy + yy * cy, p[2] - s.z]; } : p => p;
    const la = loc(a), lb = loc(b), d = [lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]];
    const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (!L2) return null;
    let best = maxFrac, hit = null;
    for (const bx of set) {
      // the sphere first (DObjTraceline): the segment's nearest point to the centre
      const so = [la[0] - bx.c[0], la[1] - bx.c[1], la[2] - bx.c[2]];
      const f = Math.max(0, Math.min(1, -(so[0] * d[0] + so[1] * d[1] + so[2] * d[2]) / L2));
      const off = [so[0] + d[0] * f, so[1] + d[1] * f, so[2] + d[2] * f];
      if (off[0] * off[0] + off[1] * off[1] + off[2] * off[2] >= bx.r2) continue;
      // the box in the bone's frame: R^T (p - origin)
      const R = bx.R, inv = p => { const q = [p[0] - bx.p[0], p[1] - bx.p[1], p[2] - bx.p[2]];
        return [R[0] * q[0] + R[3] * q[1] + R[6] * q[2], R[1] * q[0] + R[4] * q[1] + R[7] * q[2], R[2] * q[0] + R[5] * q[1] + R[8] * q[2]]; };
      const s0 = inv(la), s1 = inv(lb);
      let enter = 0, leave = best, axis = -1, sign = 0, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const dk = s1[k] - s0[k];
        if (Math.abs(dk) < 1e-9) { if (s0[k] < bx.mins[k] || s0[k] > bx.maxs[k]) ok = false; continue; }
        let t0 = (bx.mins[k] - s0[k]) / dk, t1 = (bx.maxs[k] - s0[k]) / dk, sg = -1;
        if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; sg = 1; }
        if (t0 > enter) { enter = t0; axis = k; sign = sg; }
        if (t1 < leave) leave = t1;
        if (enter > leave) ok = false;
      }
      if (!ok || axis < 0 || enter >= best) continue;                // (starting inside a box: no hit, as a trace from inside)
      best = enter;
      // the normal: the box face's axis, bone -> model -> world
      const n = [R[axis] * sign, R[3 + axis] * sign, R[6 + axis] * sign];
      const c = Math.cos(-y), sn = Math.sin(-y);
      hit = [n[0] * c - n[1] * sn, n[0] * sn + n[1] * c, n[2]];
    }
    if (!hit) return null;
    return { frac: best, point: [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * best), normal: hit, posed: !s };
  }
}

export function setHitBoxBase(dir) { BASE.dir = dir; }
