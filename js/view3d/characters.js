/* Player character models (maps3d/_characters, written by tools/export/characters_export.py):
 * a body and a head XModel per player, skinned to one skeleton. Geometry and materials are loaded
 * once per model name and shared; every player gets its own bones (its own pose).
 *
 * Model space as in the game: X forward, Y left, Z up, feet at z 0. The head model has its own
 * space (root j_spine4 at the origin) and shares the body's bones by name - like the game, which
 * attaches the head without a tag. Poses (Phase 1, no animation data): built from the bind pose
 * per stance (stand / crouch / prone) with torso rotations and two-bone IK for arms and legs;
 * the view pitch bends spine, neck and head. */
import * as THREE from 'three';
import { blendOptions } from './blend.js';
import { gridLit, objectLighting, materialShading } from './lighting.js';
import { SHADOW_LAYER } from './shadows.js';
import { loadDataManifest, dataUrl } from './data.js';

const BASE = 'maps3d/_characters/';
const D2R = Math.PI / 180;
/** the game's controller bones in the order of its controller_names (g_active_mp.cpp); controllers.js */
export const CONTROLLER_BONES = ['back_low', 'back_mid', 'back_up', 'neck', 'head', 'pelvis'];
const IDENTITY = new THREE.Matrix4();
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/* ---------- stance poses ----------
 * All in model space (X forward, Y left, Z up). Hands relative to the chest (j_spine4): rifle grip
 * in front of the chest, support hand forward; feet stay where they are in the bind pose. */
const POSES = {
  stand: { torso: [], hands: { ri: [14, -6, -6], le: [29, 2, -2] } },
  crouch: {
    drop: 19,                                                     // pelvis down: eye height 60 -> ~40
    lift: 3,
    torso: [['j_spinelower', 'y', 14]],
    knees: { le: [1, 0.15, 0], ri: [1, -0.15, 0] },               // knee bend direction (pole)
    feet: { le: [7, 1], ri: [-5, -1] },                           // foot shift x / y from the bind pose
    hands: { ri: [15, -6, -7], le: [30, 2, -3] }
  },
  // face down along the view direction, chest raised on the elbows, rifle forward on the ground
  prone: {
    root: 90,
    torso: [['j_spineupper', 'y', -14], ['j_spine4', 'y', -10], ['j_neck', 'y', -42], ['j_head', 'y', -12],
      ['j_hip_le', 'z', 8], ['j_hip_ri', 'z', -8], ['j_ankle_le', 'y', 55], ['j_ankle_ri', 'y', 55]],
    handsPelvis: { ri: [42, -7, 7], le: [56, 3, 8] },            // relative to the pelvis, near the ground
    elbowPole: [0, 0, -1]
  }
};
const PRONE_BONE_Z = 7.5;                                          // lowest joint (knees, chest) above the ground
const ARM = { le: ['j_shoulder_le', 'j_elbow_le', 'j_wrist_le'], ri: ['j_shoulder_ri', 'j_elbow_ri', 'j_wrist_ri'] };
const LEG = { le: ['j_hip_le', 'j_knee_le', 'j_ankle_le'], ri: ['j_hip_ri', 'j_knee_ri', 'j_ankle_ri'] };
// share of the view pitch per bone (sums to 1)
const PITCH_BONES = [['j_spinelower', 0.2], ['j_spineupper', 0.25], ['j_spine4', 0.25], ['j_neck', 0.15], ['j_head', 0.15]];

/** world (model space) bind transforms of a bone list -> arrays of {p: Vector3, q: Quaternion} */
function bindWorld(bones) {
  return bones.map(b => ({ p: new THREE.Vector3(...b.pos), q: new THREE.Quaternion(...b.quat).normalize() }));
}

/** rotate bone i and its branch by the quaternion r about the bone's position */
function rotateBy(world, children, i, r) {
  const pivot = world[i].p.clone(), stack = [i];
  while (stack.length) {
    const k = stack.pop();
    world[k].q.premultiply(r);
    world[k].p.sub(pivot).applyQuaternion(r).add(pivot);
    for (const c of children[k]) stack.push(c);
  }
}
function rotateBranch(world, children, i, axis, deg) {
  rotateBy(world, children, i, new THREE.Quaternion().setFromAxisAngle(axis, deg * D2R));
}
/** turn bone i (with its branch) so that the direction to bone `child` points at `target` */
function aim(world, children, i, child, target) {
  const from = world[child].p.clone().sub(world[i].p).normalize();
  const to = target.clone().sub(world[i].p).normalize();
  rotateBy(world, children, i, new THREE.Quaternion().setFromUnitVectors(from, to));
}
/** two-bone IK: root -> mid -> end reaches `target`, the middle joint bends towards `pole` */
function ik(world, children, [a, b, c], target, pole) {
  const S = world[a].p.clone(), la = world[b].p.distanceTo(S), lb = world[c].p.distanceTo(world[b].p);
  const toT = target.clone().sub(S);
  const d = Math.min(Math.max(toT.length(), Math.abs(la - lb) + 0.01), la + lb - 0.01);
  const u = toT.normalize();
  const cosA = (la * la + d * d - lb * lb) / (2 * la * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const v = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u)));
  if (v.lengthSq() < 1e-6) v.set(0, 0, 1).sub(u.clone().multiplyScalar(u.z));
  v.normalize();
  const mid = S.clone().add(u.clone().multiplyScalar(la * cosA)).add(v.multiplyScalar(la * sinA));
  aim(world, children, a, b, mid);
  aim(world, children, b, c, S.add(u.multiplyScalar(d)));
}

/** pose of a skeleton for one stance: world transforms (model space), feet on the ground */
function stancePose(bones, stance) {
  const world = bindWorld(bones), bind = bindWorld(bones);
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const I = n => index.get(n);
  const has = list => list.every(n => index.has(n));
  const children = bones.map(() => []);
  bones.forEach((b, i) => { if (b.parent >= 0) children[b.parent].push(i); });
  const def = POSES[stance];
  const root = I('j_mainroot');
  if (root == null) return world;
  const pelvis0 = world[root].p.clone();
  if (def.root) rotateBranch(world, children, root, AX.y, def.root);
  if (def.drop) {
    const stack = [root];
    while (stack.length) { const k = stack.pop(); world[k].p.z -= def.drop; for (const c of children[k]) stack.push(c); }
  }
  for (const [name, axis, deg] of def.torso) if (I(name) != null) rotateBranch(world, children, I(name), AX[axis], deg);
  // legs (crouch): the feet back to the ground, knees forward, the feet flat as in the bind pose
  if (def.feet) for (const side of ['le', 'ri']) {
    if (!has(LEG[side])) continue;
    const ankle = I(LEG[side][2]), f = bind[ankle].p, sh = def.feet[side];
    ik(world, children, LEG[side].map(I), new THREE.Vector3(f.x + sh[0], f.y + sh[1], f.z), new THREE.Vector3(...def.knees[side]));
    rotateBy(world, children, ankle, bind[ankle].q.clone().multiply(world[ankle].q.clone().invert()));
  }
  // prone: the body (without the arms, which reach for the rifle below) onto the ground, the hips
  // over the origin - before the arm IK, whose hand targets are on the ground
  if (stance === 'prone') {
    const arm = new Set();
    for (const side of ['le', 'ri']) if (I(ARM[side][0]) != null) {
      const stack = [I(ARM[side][0])];
      while (stack.length) { const k = stack.pop(); arm.add(k); for (const c of children[k]) stack.push(c); }
    }
    let minZ = Infinity;
    // skeleton points only: not the arms, not the model root (tag_origin stays at 0) and no tags
    world.forEach((w, k) => { if (!arm.has(k) && bones[k].parent >= 0 && !bones[k].name.startsWith('tag_')) minZ = Math.min(minZ, w.p.z); });
    const sh = new THREE.Vector3(-world[root].p.x, -world[root].p.y, PRONE_BONE_Z - minZ);
    for (const w of world) w.p.add(sh);
  }
  // arms: the hands to the rifle
  const chest = I('j_spine4') != null ? world[I('j_spine4')].p : pelvis0.clone().add(new THREE.Vector3(0, 0, 15));
  for (const side of ['le', 'ri']) {
    if (!has(ARM[side])) continue;
    const sign = side === 'le' ? 1 : -1;
    let target, pole;
    if (def.handsPelvis) {
      const h = def.handsPelvis[side];
      target = new THREE.Vector3(world[root].p.x + h[0], world[root].p.y + h[1], h[2]);
      pole = new THREE.Vector3(...def.elbowPole).add(new THREE.Vector3(0, 0.6 * sign, 0));
    } else {
      target = chest.clone().add(new THREE.Vector3(...def.hands[side]));
      pole = new THREE.Vector3(-0.3, 0.9 * sign, -0.9);
    }
    ik(world, children, ARM[side].map(I), target, pole);
  }
  // ground: the feet back at z ~ 0 (stand, crouch)
  const shift = new THREE.Vector3();
  if (stance !== 'prone') {
    const feet = ['le', 'ri'].filter(s => has(LEG[s])).map(s => I(LEG[s][2]));
    // + lift: the posed feet (crouch: toes bent) reach a little below the ankle height of the bind pose
    if (feet.length) shift.set(0, 0, Math.min(...feet.map(i => bind[i].p.z)) - Math.min(...feet.map(i => world[i].p.z)) + (def.lift || 0));
  }
  for (const w of world) w.p.add(shift);
  return world;
}


/** local transforms (relative to the parent) from world transforms */
function toLocal(bones, world) {
  return bones.map((b, i) => {
    if (b.parent < 0) return { p: world[i].p.clone(), q: world[i].q.clone() };
    const pq = world[b.parent].q.clone().invert();
    return { p: world[i].p.clone().sub(world[b.parent].p).applyQuaternion(pq), q: pq.multiply(world[i].q) };
  });
}

/** fetch with two retries on a network error (a dropped connection under many parallel loads) */
async function fetchRetry(url) {
  for (let i = 0; ; i++) {
    try { await loadDataManifest(); return await fetch(dataUrl(url)); } catch (err) { if (i >= 2) throw err; await new Promise(r => setTimeout(r, 300 * (i + 1))); }
  }
}

/* ---------- library: one load per model name ---------- */
export class CharacterLibrary {
  constructor(texture, base = BASE) {
    this.texture = texture;            // (file) -> THREE.Texture, shared with the map
    this.base = base;
    this.models = new Map();           // name -> Promise<model>
    this.index = null;
  }
  async available() {
    if (!this.index) {
      try { const r = await fetchRetry(this.base + 'index.json'); this.index = r.ok ? await r.json() : {}; }
      catch (err) { this.index = {}; }
    }
    return this.index;
  }
  load(name) {
    if (!this.models.has(name)) {
      if (!this.resolved) this.resolved = new Map();
      this.models.set(name, this._load(name).then(m => { this.resolved.set(name, m); return m; }));
    }
    return this.models.get(name);
  }
  /** a model that has finished loading, else null (lets a character be built in the same frame) */
  loaded(name) { return this.resolved && this.resolved.get(name) || null; }
  /** weapons.json: base weapon -> world models {model, silencer, gl} (Phase 2, may be missing) */
  async weaponTable() {
    if (!this.weaponsReady) this.weaponsReady = fetchRetry(this.base + 'weapons.json').then(r => r.ok ? r.json() : null)
      .then(j => j && j.weapons || null).catch(() => null);
    return this.weaponsReady;
  }
  async _load(name) {
    const idx = await this.available();
    if (!idx[name]) throw new Error('character model ' + name + ' not exported');
    const meta = await (await fetchRetry(this.base + idx[name].file)).json();
    const bin = await (await fetchRetry(this.base + meta.file)).arrayBuffer();
    const S = meta.sections;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, S.position.offset, S.position.length / 4), 3));
    geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(bin, S.normal.offset, S.normal.length), 4), 3, 0, true));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, S.uv.offset, S.uv.length / 4), 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array(bin, S.skinIndex.offset, S.skinIndex.length), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Uint8Array(bin, S.skinWeight.offset, S.skinWeight.length), 4, true));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(bin, S.index.offset, S.index.length / 2), 1));
    // the vertex colours (the model shaders multiply the colour map by them)
    const colors = !!(S.color && S.color.length);
    if (colors) geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(bin, S.color.offset, S.color.length), 4, true));
    const mats = meta.surfaces.map((s, k) => {
      geo.addGroup(s.indexStart, s.indexCount, k);
      const m = s.material >= 0 ? meta.materials[s.material] : null;
      const opts = { color: 0xffffff, vertexColors: colors };
      const tex = m && this.texture(m.texture);
      if (tex) opts.map = tex; else opts.color = new THREE.Color(m && m.color || '#7a7a70');
      if (m && m.alphaTest && m.textureAlpha) opts.alphaTest = m.alphaTest === 'gt0' ? 0.05 : 0.5;
      if (m && m.blend) Object.assign(opts, blendOptions(m.blend));      // the game's blend factors (blend.js)
      if (m && m.doubleSided) opts.side = THREE.DoubleSide;
      // a shadow caster's material: only in the shadow maps (shadows.js), not drawn
      if (m && m.shadowOnly) opts.visible = false;
      // no lit / emissive technique: the game never draws it - nor does it cast (shadows.js)
      if (m && m.noDraw) { opts.visible = false; opts.userData = { noDraw: true }; }
      return new THREE.MeshLambertMaterial(opts);
    });
    // normal / specular maps per surface, used with the game's lighting (gridLit)
    const shadings = meta.surfaces.map(s => materialShading(s.material >= 0 ? meta.materials[s.material] : null, f => this.texture(f)));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 60;                  // posed limbs reach beyond the bind pose
    // the bind pose (model space) and the stance poses of this skeleton
    const bind = bindWorld(meta.bones);
    const inverses = bind.map(w => new THREE.Matrix4().compose(w.p, w.q, new THREE.Vector3(1, 1, 1)).invert());
    const poses = {};
    if (meta.kind === 'body') for (const st of Object.keys(POSES)) poses[st] = toLocal(meta.bones, stancePose(meta.bones, st));
    return { name, meta, geo, mats, shadings, bones: meta.bones, bind, inverses, poses, triangles: meta.triangleCount };
  }
}

/* ---------- one player's character ---------- */
export class Character {
  /** body, head: loaded library models (head may be null) */
  constructor(body, head) {
    this.body = body; this.head = head;
    this.group = new THREE.Group();
    this.group.name = 'character';
    // body skeleton
    const local = toLocal(body.bones, body.bind);
    this.bones = body.bones.map((b, i) => { const bone = new THREE.Bone(); bone.name = b.name; bone.position.copy(local[i].p); bone.quaternion.copy(local[i].q); return bone; });
    body.bones.forEach((b, i) => { if (b.parent >= 0) this.bones[b.parent].add(this.bones[i]); });
    this.byName = new Map(this.bones.map(b => [b.name, b]));
    this.restLocal = new Map(body.bones.map((b, i) => [b.name, local[i].p.clone()]));
    this.restQuat = local.map(l => l.q.clone());
    this.bodyMesh = new THREE.SkinnedMesh(body.geo, body.mats);
    for (let i = 0; i < this.bones.length; i++) if (body.bones[i].parent < 0) this.bodyMesh.add(this.bones[i]);
    // an explicit bind matrix: without it three.js recomputes the inverses from the current bones
    this.bodyMesh.bind(new THREE.Skeleton(this.bones, body.inverses), IDENTITY);
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.layers.enable(SHADOW_LAYER);                 // casts the sun's shadow (shadows.js)
    this.group.add(this.bodyMesh);
    this.triangles = body.triangles;
    // head: the body's bones by name + its own (face, fingers); its own bind space
    if (head) {
      const hl = toLocal(head.bones, head.bind);
      const hb = head.bones.map((b, i) => {
        const shared = this.byName.get(b.name);
        if (shared) return shared;
        const bone = new THREE.Bone(); bone.name = b.name; bone.position.copy(hl[i].p); bone.quaternion.copy(hl[i].q);
        return bone;
      });
      head.bones.forEach((b, i) => { if (!this.byName.has(b.name) && b.parent >= 0) hb[b.parent].add(hb[i]); });
      this.headMesh = new THREE.SkinnedMesh(head.geo, head.mats);
      this.headMesh.bind(new THREE.Skeleton(hb, head.inverses), IDENTITY);
      this.headMesh.frustumCulled = false;
      this.headMesh.layers.enable(SHADOW_LAYER);
      this.group.add(this.headMesh);
      this.triangles += head.triangles;
    }
    this.stance = null;
    this.pitchBones = PITCH_BONES.map(([n, share]) => [this.byName.get(n), share]).filter(x => x[0]);
    this.tmpQ = new THREE.Quaternion();
  }

  /** stance pose + view pitch (degrees, > 0 looks down). The group carries position and yaw. */
  pose(stance, pitch) {
    const P = this.body.poses[stance] || this.body.poses.stand;
    if (this.stance !== stance) {
      this.stance = stance;
      this.bones.forEach((b, i) => { b.position.copy(P[i].p); b.quaternion.copy(P[i].q); });
      this.pitchBase = this.pitchBones.map(([b]) => b.quaternion.clone());
      this.pitchWorld = this.pitchBones.map(([b]) => { b.updateWorldMatrix(true, false); return new THREE.Quaternion().setFromRotationMatrix(b.matrixWorld).premultiply(this.group.getWorldQuaternion(new THREE.Quaternion()).invert()); });
    }
    // bend about the model's lateral axis (Y): in the bone's local frame q_local * (W^-1 * R * W)
    const p = Math.max(-80, Math.min(80, pitch || 0)) * (stance === 'prone' ? 0.4 : 1);
    this.pitchBones.forEach(([b, share], k) => {
      const W = this.pitchWorld[k];
      this.tmpQ.setFromAxisAngle(AX.y, p * share * D2R);
      const delta = W.clone().invert().multiply(this.tmpQ).multiply(W);
      b.quaternion.copy(this.pitchBase[k]).multiply(delta);
    });
  }

  /** the game's model lighting (lighting.js): own copies of the materials, lit by the light grid
   *  values in this.lg (set per frame by the caller); the weapon follows */
  enableGridLighting() {
    if (this.lg) return this.lg;
    this.lg = objectLighting();
    const patch = (mats, model) => (Array.isArray(mats) ? mats : [mats]).map((m, k) => gridLit(m.clone(), this.lg, model && model.shadings && model.shadings[k]));
    this.bodyMesh.material = patch(this.bodyMesh.material, this.body);
    if (this.headMesh) this.headMesh.material = patch(this.headMesh.material, this.head);
    if (this.weapons) for (const w of this.weapons.values()) w.material = patch(w.material, w.userData.model);
    return this.lg;
  }

  /** the held weapon: a loaded library model of kind "weapon" (its root at tag_weapon_right) or null */
  setWeapon(model) {
    const name = model ? model.name : null;
    if (this.weaponName === name) return;
    if (this.weapon) { this.weapon.visible = false; this.triangles -= this.weapon.userData.triangles; }
    this.weaponName = name;
    this.weapon = null;
    const tag = model && this.byName.get('tag_weapon_right');
    if (!tag) return;
    if (!this.weapons) this.weapons = new Map();
    let m = this.weapons.get(name);
    if (!m) {
      m = new THREE.Mesh(model.geo, this.lg ? model.mats.map((x, k) => gridLit(x.clone(), this.lg, model.shadings && model.shadings[k])) : model.mats);
      m.name = name;
      m.userData.model = model;
      m.frustumCulled = false;
      m.layers.enable(SHADOW_LAYER);
      m.userData.triangles = model.triangles;
      tag.add(m);
      this.weapons.set(name, m);
    }
    m.visible = true;
    this.weapon = m;
    this.triangles += model.triangles;
  }

  /** names of all bones this character can animate (body + head) */
  boneNames() {
    if (!this._names) {
      this._names = new Set(this.byName.keys());
      if (this.headMesh) for (const b of this.headMesh.skeleton.bones) this._names.add(b.name);
    }
    return this._names;
  }

  /** Phase 2: the game's animations. layers: [{clip: THREE.AnimationClip, time (s), weight}];
   *  the view pitch (degrees, > 0 looks down) bends spine, neck and head on top. */
  animate(layers, pitch, stance) {
    if (!this.mixer) {
      // the mixer keeps the pose at binding time as the 'original' state: start from the bind pose
      this.bones.forEach((b, i) => { b.position.copy(this.restLocal.get(b.name)); b.quaternion.copy(this.restQuat[i]); });
      this.mixer = new THREE.AnimationMixer(this.group); this.actions = new Map();
    }
    for (const a of this.actions.values()) a.weight = 0;
    for (const l of layers) {
      let a = this.actions.get(l.clip);
      // a new action starts with weight 1 (three.js default): start it from 0, the layers add up below
      if (!a) { a = this.mixer.clipAction(l.clip); a.play(); a.weight = 0; this.actions.set(l.clip, a); }
      a.enabled = true;
      a.weight += l.weight;
      a.time = l.time;
    }
    for (const a of this.actions.values()) { a.setEffectiveWeight(a.weight); a.enabled = a.weight > 0; }
    // three.js writes a bone only when the mixed value differs from its own previous write
    // (PropertyMixer.apply). The pitch bend below and the static poses change the bones outside the
    // mixer, so the bones are first set back to what the mixer last wrote - otherwise a constant
    // value (static track, paused playback, a clip held at its end) keeps last frame's bent bone and
    // the bend compounds every frame until the skeleton degenerates.
    const S = this.mixed;
    if (S) this.bones.forEach((b, i) => { b.position.fromArray(S, 7 * i); b.quaternion.fromArray(S, 7 * i + 3); });
    this.mixer.update(0);
    const M = this.mixed || (this.mixed = new Float32Array(7 * this.bones.length));
    this.bones.forEach((b, i) => { b.position.toArray(M, 7 * i); b.quaternion.toArray(M, 7 * i + 3); });
    this.stance = null;                                // a static pose has to be set again
    this.bendPitch(pitch, stance);
  }

  /** the game's angle controllers (controllers.js) on top of the animation: the root (tag_origin)
   *  gets its yaw / pitch / roll and offset, the controller bones (back_low, back_mid, neck, head,
   *  pelvis) turn about the root's axes at their own position (DObjSetControlTagAngles), parents
   *  first, as the engine's skeleton does */
  applyControllers(c) {
    if (!this.ctrl) {
      const bones = CONTROLLER_BONES.map((n, k) => ({ bone: this.byName.get(n), k })).filter(x => x.bone)
        .sort((x, y) => this.bones.indexOf(x.bone) - this.bones.indexOf(y.bone));
      this.ctrl = { root: this.byName.get('tag_origin'), bones, q: new THREE.Quaternion(), W: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'ZYX') };
    }
    const { root, bones, q, W, e } = this.ctrl;
    const angles = (a, k) => q.setFromEuler(e.set(a[k + 2] * D2R, a[k] * D2R, a[k + 1] * D2R, 'ZYX'));   // yaw · pitch · roll
    if (root) {
      root.quaternion.premultiply(angles(c.tag, 0));
      root.position.x += c.offset[0]; root.position.y += c.offset[1];
    }
    for (const { bone, k } of bones) {
      const a = c.angles;
      if (!a[3 * k] && !a[3 * k + 1] && !a[3 * k + 2]) continue;
      // the parent's orientation in the root's frame
      W.identity();
      for (let o = bone.parent; o && o !== root && o !== this.bodyMesh; o = o.parent) W.premultiply(o.quaternion);
      angles(a, 3 * k);
      const Wi = W.clone().invert();
      bone.quaternion.premultiply(Wi.multiply(q).multiply(W)).normalize();
    }
  }

  /** bend the pitch bones about the model's lateral axis (Y), in their current pose */
  bendPitch(pitch, stance) {
    const p = Math.max(-80, Math.min(80, pitch || 0)) * (stance === 'prone' ? 0.4 : 1);
    if (!p) return;
    const W = new THREE.Quaternion(), R = new THREE.Quaternion(), d = new THREE.Quaternion();
    for (const [b, share] of this.pitchBones) {
      // model-space orientation of the bone: the product of the local rotations up to the mesh
      W.copy(b.quaternion);
      for (let o = b.parent; o && o !== this.bodyMesh; o = o.parent) W.premultiply(o.quaternion);
      W.normalize();                                   // invert() is the conjugate: exact for unit quaternions only
      R.setFromAxisAngle(AX.y, p * share * D2R);
      d.copy(W).invert().multiply(R).multiply(W);
      b.quaternion.multiply(d).normalize();
    }
  }

  dispose() { this.bodyMesh.skeleton.dispose(); if (this.headMesh) this.headMesh.skeleton.dispose(); }
}

/* ---------- the game's player animations (maps3d/_characters/anims.*) ---------- */
export class AnimationLibrary {
  constructor(base = BASE) { this.base = base; this.ready = null; this.cache = new Map(); this.bins = new Map(); this.loading = new Map(); }
  /** anims.json + the core clips (anims.bin) -> Promise<boolean> (false when nothing is exported) */
  load() {
    if (!this.ready) this.ready = (async () => {
      try {
        const r = await fetchRetry(this.base + 'anims.json');
        if (!r.ok) return false;
        this.meta = await r.json();
        this.aliases = this.meta.aliases || {};
        this.tree = this.meta.tree || [];
        await this.fetchFile('anims.bin');
        return true;
      } catch (err) { console.warn('player animations not loaded', err); return false; }
    })();
    return this.ready;
  }
  fetchFile(file) {
    if (!this.loading.has(file)) {
      this.loading.set(file, fetchRetry(this.base + file).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(buf => { this.bins.set(file, buf); if (this.onLoaded) this.onLoaded(file); return buf; })
        .catch(err => { console.warn('animation', file, err); this.bins.set(file, null); return null; }));
    }
    return this.loading.get(file);
  }
  /** load the files of the given clips (the clips a demo uses) -> Promise */
  preload(names) {
    const files = new Set();
    for (const n of names) { const c = this.info(n); if (c) files.add(c.file); }
    return Promise.all([...files].map(f => this.fetchFile(f)));
  }
  /** a viewer name ("stand_idle") or a game name ("pb_stand_alert") -> the game name */
  name(key) { return this.aliases && this.aliases[key] || key; }
  /** the clip name of an anim tree index (entity legsAnim / torsoAnim), or null (none / not exported) */
  treeName(index) {
    const n = this.tree && this.tree[index & 0x1ff];
    return n && this.meta.clips[n] ? n : null;
  }
  /** exported (it may still have to be loaded) */
  exists(key) { return !!(this.meta && this.meta.clips[this.name(key)]); }
  /** exported and its data loaded - otherwise the load is started and false returned */
  has(key) {
    const c = this.meta && this.meta.clips[this.name(key)];
    if (!c) return false;
    const buf = this.bins.get(c.file);
    if (buf === undefined) { this.fetchFile(c.file); return false; }
    return !!buf;
  }
  info(key) { return this.meta && this.meta.clips[this.name(key)]; }
  /** viewer names starting with a prefix (e.g. "death_stand_") */
  keys(prefix) { return this.aliases ? Object.keys(this.aliases).filter(k => k.startsWith(prefix)) : []; }
  /** the bones a clip animates (a torso clip covers the upper body only) */
  bones(key) {
    const c = this.info(key);
    if (!c) return null;
    if (!c.boneSet) c.boneSet = new Set(c.tracks.map(t => t[0]));
    return c.boneSet;
  }

  /** the upper body: every bone a torso clip (pt_*) of the game animates (spine and above) */
  upperBones() {
    if (!this.upper) {
      this.upper = new Set();
      for (const [n, c] of Object.entries(this.meta.clips)) if (n.startsWith('pt_')) for (const t of c.tracks) this.upper.add(t[0]);
    }
    return this.upper;
  }

  /** THREE.AnimationClip of `key` for a character: rotations as they are, translations as offsets
   *  on the character's rest positions; only tracks of bones the character has (upper: only the
   *  upper body - a full-body clip the game plays as the torso animation). Null while the clip's
   *  file is not loaded. */
  clip(key, character, upper = false) {
    const name = this.name(key);
    const ck = name + '|' + character.body.name + '|' + (character.head ? character.head.name : '') + (upper ? '|upper' : '');
    if (this.cache.has(ck)) return this.cache.get(ck);
    if (!this.has(name)) return null;
    const c = this.meta.clips[name], bin = this.bins.get(c.file);
    const names = character.boneNames(), tracks = [], only = upper ? this.upperBones() : null;
    for (const [bone, type, n, fOff, vOff] of c.tracks) {
      if (!names.has(bone) || (only && !only.has(bone))) continue;
      const frames = new Uint16Array(bin, fOff, n);
      const times = new Float32Array(n);
      for (let i = 0; i < n; i++) times[i] = frames[i] / c.framerate;
      if (type === 'q') {
        const raw = new Int16Array(bin, vOff, 4 * n), v = new Float32Array(4 * n);
        for (let i = 0; i < 4 * n; i++) v[i] = raw[i] / 32767;
        tracks.push(new THREE.QuaternionKeyframeTrack(bone + '.quaternion', times, v));
      } else {
        const r0 = character.restLocal.get(bone);
        if (!r0) continue;                                        // head-only bone: rotation only
        const raw = new Float32Array(bin, vOff, 3 * n), v = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) { v[3 * i] = r0.x + raw[3 * i]; v[3 * i + 1] = r0.y + raw[3 * i + 1]; v[3 * i + 2] = r0.z + raw[3 * i + 2]; }
        tracks.push(new THREE.VectorKeyframeTrack(bone + '.position', times, v));
      }
    }
    const clip = new THREE.AnimationClip(name, c.duration, tracks);
    this.cache.set(ck, clip);
    return clip;
  }
}

/** the stance pose of a skeleton (model space world transforms {p, q}) - also the hit boxes (hitboxes.js) */
export { stancePose };

/** a model without geometry from a character's JSON (bones only): enough for a Character whose
 *  skeleton is posed and animated like a drawn one (hitboxes.js: the players' hit boxes) */
export function rigModel(meta) {
  const bind = bindWorld(meta.bones);
  const inverses = bind.map(w => new THREE.Matrix4().compose(w.p, w.q, new THREE.Vector3(1, 1, 1)).invert());
  const poses = {};
  if (meta.kind === 'body') for (const st of Object.keys(POSES)) poses[st] = toLocal(meta.bones, stancePose(meta.bones, st));
  return { name: meta.name, meta, geo: new THREE.BufferGeometry(), mats: [], shadings: [], bones: meta.bones, bind, inverses, poses, triangles: 0 };
}
