/* The first-person view model: the gun the followed player holds, in the hands of their character
 * (maps3d/_characters/viewmodels.json, written by tools/export/viewmodels_export.py), animated with
 * the weapon's own view animations as the demo drives them (viewanim.js), the crosshair and the
 * sniper scope.
 *
 * As in the game it is one skeleton of two models: the hands (the character script's
 * setViewmodel - viewhands_*) and the gun (the weapon file's gunModel), the gun's root (j_gun) on
 * the hands' tag_weapon, the knife (knifeModel) on tag_knife_attach during a melee. The animations
 * (XAnimParts) are evaluated per bone and blended; a translation of an animation is added to the
 * skeleton's own local translation (XModel trans: zero on the hands, whose animations carry the
 * whole offset). The hands' root tag_view is the eye: the rig hangs at the first-person camera with
 * its view axes (model space X forward, Y left, Z up), moved by the bob, sway and kick offsets.
 *
 * Drawn after the scene in a pass of its own with the depth buffer cleared and a near plane of
 * 0.5 units: on top of the world, never in a wall - the game draws its view model the same way. Lit
 * like the players: the light grid and reflection probe at the eye (lighting.js). The crosshair and
 * the scope overlay follow in an orthographic pass (also in the video export). A weapon without a
 * view model falls back to its world model (weapons.json) ahead of the camera. */
import * as THREE from 'three';
import { toLocal } from './characters.js';
import { gridLit, objectLighting, setObjectLighting } from './lighting.js';
import { weaponModelName } from './actors.js';
import { ViewAnimator } from './viewanim.js';
import { loadTexture } from './mapLoader.js';

const IDENTITY = new THREE.Matrix4();
const D2R = Math.PI / 180;
// model space (X forward, Y left, Z up) -> camera space (-Z forward, -X left, Y up)
const MODEL_TO_CAMERA = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
  0, -1, 0, 0,
  0, 0, 1, 0,
  -1, 0, 0, 0,
  0, 0, 0, 1));
// the world model of a weapon without a view model: grip ahead of the eye, low right (model space)
const FALLBACK_OFFSET = new THREE.Vector3(14, -6, -8);
// the crosshair as CG_DrawCrosshair draws it (cg_draw_reticles.cpp; sizes in the game's 640 x 480 screen):
// cg_crosshairAlpha 1, cg_crosshairAlphaMin 0.5, the team colours g_TeamColor_MyTeam / EnemyTeam
const CROSSHAIR_ALPHA = 1, CROSSHAIR_ALPHA_MIN = 0.5;
const MY_TEAM = [0.4, 0.6, 0.85], ENEMY_TEAM = [0.75, 0.25, 0.25];

/** the reticle images (reticle_side_small, reticle_center_cross: in the fast files, drawn here): a soft
 *  white bar along the image's height / a small cross */
function reticleTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  if (kind === 'side') {
    g.globalAlpha = 0.4; g.fillRect(12, 1, 8, 30);
    g.globalAlpha = 1; g.fillRect(13.5, 2, 5, 28);
  } else {
    g.globalAlpha = 1; g.fillRect(15, 10, 2, 12); g.fillRect(10, 15, 12, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** the demo's server ran Promod (its own weapon files: viewmodels.json "promod") */
export function isPromod(M) {
  const m = M && M.d && M.d.meta;
  return !!(m && (/promod/i.test(m.mod || '') || /promod/i.test(m.fsGame || '') || m.promodVersion));
}

export class ViewModel {
  /** library: the CharacterLibrary (models, viewmodels.json, the animation files) */
  constructor(library) {
    this.library = library;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.scene.add(this.root);
    this.rigs = new Map();               // gun|hands|hide -> rig, null (failed) or undefined (loading)
    this.loads = new Map();              // gun|hands|hide -> Promise (settles when the rig is built or failed)
    this.fallbacks = new Map();          // world model name -> mesh
    this.clipBufs = new Map();           // clip name -> Promise<ArrayBuffer | null>
    this.decoded = new Map();            // clip name -> decoded clip | null (failed)
    this.missing = new Set();            // weapons drawn with their world model or not at all
    this.current = null;                 // the shown rig / fallback mesh
    this.enabled = true;                 // graphics: First-person weapon
    this.crosshair = true;               // graphics: Crosshair
    this.shown = false;
    this.grid = null; this.probes = null;
    this.lg = null; this.sample = {};
    this.onLoaded = null;
    this.state = null;                   // the last viewanim.js state (tests, stats)
    this.ready = library.viewModels().then(t => { this.table = t; this.changed(); return t; });
    library.weaponTable().then(t => { this.worldTable = t; });
    // the overlay pass: crosshair lines and the scope (pixels, origin at the centre)
    this.hud = new THREE.Scene();
    this.hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const quad = map => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map, color: 0xffffff, transparent: true, depthTest: false, depthWrite: false })); this.hud.add(m); return m; };
    const side = reticleTexture('side');
    this.lines = [quad(side), quad(side), quad(side), quad(side)];   // the four sides (top, right, bottom, left)
    this.center = quad(reticleTexture('center'));
    this.aimTarget = null;               // (cl, t, s, range) -> 'friend' | 'enemy' | null: the other players' crosshair colour
    this.scope = null;                   // {group, quads, bars, cross} built when an overlay is first needed
  }

  /** the match (a new demo): the animation driver; anims: the player animation library (ADS, sprint) */
  setMatch(M, anims) { this.anim = new ViewAnimator(M, anims); this.M = M; this.promod = isPromod(M); this.merged = new Map(); }

  /** the map's light grid and reflection probes (lighting.js): the view model is then lit like the players */
  setLighting(grid, probes) {
    this.grid = grid || null; this.probes = probes || null;
    this.lg = this.grid ? objectLighting() : null;
  }
  /** the scene lights for 'Simple' lighting (copies, kept in step at each render) */
  setSceneLights(hemi, sun) {
    this.hemi = hemi.clone(); this.sun = sun.clone();
    this.scene.add(this.hemi, this.sun);
    this.sceneLights = [hemi, sun];
  }

  changed() { if (this.onLoaded) this.onLoaded(); }

  /** the view model entry of a demo weapon name (m4_mp, gl_m16_mp, ...) or null */
  entry(name) {
    const W = this.table && this.table.weapons;
    if (!W || !name) return null;
    const n = String(name).toLowerCase();
    const key = W[n] ? n : W[n + '_mp'] ? n + '_mp' : W[n.replace(/_mp$/, '')] ? n.replace(/_mp$/, '') : null;
    if (!key) return null;
    // a Promod demo: the Promod weapon file's numbers over the stock ones (merged once per weapon)
    const pm = this.promod && this.table.promod && this.table.promod.weapons[key];
    if (!pm) return W[key];
    if (!this.merged.has(key)) {
      const params = Object.assign({}, W[key].params);
      for (const [k, v] of Object.entries(pm.params || {})) { if (v == null) delete params[k]; else params[k] = v; }
      this.merged.set(key, Object.assign({}, W[key], { params, fx: pm.fx, promod: true }));
    }
    return this.merged.get(key);
  }

  /** the hands of a body model (the character script), else the weapon file's own */
  hands(body, e) {
    const H = this.table && this.table.hands;
    return (H && body && H[String(body).toLowerCase()]) || e.hands;
  }

  /** the clip's meta (duration, loop) when its data is loaded - else the load starts and null */
  clipInfo(name) {
    const c = this.table && this.table.clips && this.table.clips[name];
    if (!c) return null;
    if (!this.decoded.has(name)) { this.loadClip(name); return null; }
    return this.decoded.get(name) ? c : null;
  }
  loadClip(name) {
    if (!this.clipBufs.has(name)) {
      const c = this.table.clips[name];
      this.clipBufs.set(name, this.library.binary(c.file).then(buf => { this.decoded.set(name, decodeClip(c, buf)); this.changed(); return buf; })
        .catch(err => { console.warn('view animation', name, err); this.decoded.set(name, null); return null; }));
    }
    return this.clipBufs.get(name);
  }

  /** the view model of client cl at t: sample s (null: dead / not visible -> hidden), body = the
   *  player's body model -> the state (viewanim.js) or null */
  update(cl, t, s, body) {
    this.state = null;
    let obj = null;
    if (s && this.table && this.anim && (this.enabled || this.crosshair)) {
      const st = this.anim.state(cl, t, s, n => this.entry(n), n => this.clipInfo(n));
      this.state = st;
      if (this.enabled && st.weapon) {
        const e = st.entry;
        if (e) {
          const group = this.rig(e, this.hands(body, e));
          if (group) { this.pose(group, st); obj = group; }
        } else {
          this.missing.add(String(st.weapon));
          obj = this.fallback(st.weapon);
          if (obj) { obj.position.copy(FALLBACK_OFFSET).add(new THREE.Vector3(...st.offset.pos)); }
        }
      }
    }
    // the scope overlay replaces the gun (the game hides the view model when scoped)
    if (obj && this.scoped()) obj = null;
    if (obj !== this.current) {
      if (this.current) this.current.visible = false;
      this.current = obj;
      if (obj) obj.visible = true;
    }
    this.shown = !!obj;
    return this.state;
  }

  /** the sniper's scope is up: the overlay shader and the sights fully raised */
  scoped() {
    const st = this.state, P = st && st.entry && st.entry.params;
    return !!(this.enabled && P && P.adsOverlayShader && this.table.overlays && this.table.overlays[P.adsOverlayShader] && st.ads >= 0.98);
  }

  /** CG_GetWeapReticleZoom: the scope overlay's fraction (0 .. 1) - a weapon with an overlay or overlay
   *  reticle, over the last adsZoomInFrac (aiming in) / adsZoomOutFrac (out) of the sights' fraction */
  reticleZoom() {
    const st = this.state, P = st && st.entry && st.entry.params;
    if (!P || !(st.ads > 0) || (!P.adsOverlayShader && (!P.adsOverlayReticle || P.adsOverlayReticle === 'none'))) return 0;
    const f = (st.adsIn ? P.adsZoomInFrac : P.adsZoomOutFrac) || 0.5;
    const z = (st.ads - (1 - f)) / f;
    return z <= 0.01 ? 0 : Math.min(1, z);
  }

  /** the vertical field of view for the first-person camera (deg) at the base fov: the weapon's ADS
   *  zoom (adsZoomFov, a horizontal fov on the game's 4:3 screen, scaled like the base) over the last
   *  part of the sights' transition (adsZoomInFrac) */
  fov(base) {
    const st = this.state, P = st && st.entry && st.entry.params;
    if (!this.enabled || !P || !P.adsZoomFov || !(st.ads > 0)) return base;
    const h43 = v => 2 * Math.atan(Math.tan(v * D2R / 2) / 0.75) / D2R, v43 = h => 2 * Math.atan(Math.tan(h * D2R / 2) * 0.75) / D2R;
    const scale = h43(base) / 80;                             // the base as cg_fov 80 x fov scale
    const zoomed = v43(Math.min(170, P.adsZoomFov * scale));
    const f = P.adsZoomInFrac || 0.5, z = Math.min(1, Math.max(0, (st.ads - (1 - f)) / f));
    return base + (zoomed - base) * z;
  }

  /** the rig of gun + hands (+ knife) of a view model entry (built when its models are loaded) */
  rig(e, hands) {
    const hide = e.hide || [];
    const key = e.gun + '|' + (hands || '') + '|' + hide.join(',');
    if (this.rigs.has(key)) return this.rigs.get(key) || null;
    this.rigs.set(key, undefined);
    const lib = this.library;
    this.loads.set(key, Promise.all([lib.load(e.gun), hands ? lib.load(hands).catch(() => null) : null, e.knife ? lib.load(e.knife).catch(() => null) : null]).then(([g, h, k]) => {
      this.rigs.set(key, this.build(g, h, k, hide));
      this.changed();
    }).catch(err => { console.warn('view model', e.gun, err); this.rigs.set(key, null); this.missing.add(e.gun); this.changed(); }));
    return null;
  }

  /** start loading the rigs and animations of [{weapon, body}] (a player's weapons over the demo), so
   *  that a weapon switch shows the new gun at once -> Promise settled when they are there (the video
   *  export waits) */
  async preload(pairs) {
    await this.ready;
    if (!this.table) return;
    const waits = [];
    for (const { weapon, body } of pairs) {
      const e = this.entry(weapon);
      if (!e) { this.missing.add(String(weapon)); continue; }
      const hands = this.hands(body, e);
      this.rig(e, hands);
      waits.push(this.loads.get(e.gun + '|' + (hands || '') + '|' + (e.hide || []).join(',')));
      for (const name of new Set(Object.values(e.anims || {}))) if (this.table.clips[name]) waits.push(this.loadClip(name));
    }
    await Promise.allSettled(waits.filter(Boolean));
  }

  /** materials: the game's model lighting with the light grid, else the plain (scene-lit) ones */
  materials(model) {
    if (!this.lg) return model.mats;
    return model.mats.map((m, k) => gridLit(m.clone(), this.lg, model.shadings && model.shadings[k]));
  }

  /** a skinned mesh of a model on its own bones (bind pose) -> {mesh, bones, roots} */
  skinned(model) {
    const local = toLocal(model.bones, model.bind);
    const bones = model.bones.map((b, i) => { const bone = new THREE.Bone(); bone.name = b.name; bone.position.copy(local[i].p); bone.quaternion.copy(local[i].q); return bone; });
    model.bones.forEach((b, i) => { if (b.parent >= 0) bones[b.parent].add(bones[i]); });
    const mesh = new THREE.SkinnedMesh(model.geo, this.materials(model));
    mesh.bind(new THREE.Skeleton(bones, model.inverses), IDENTITY);
    mesh.frustumCulled = false;
    return { mesh, bones, roots: bones.filter((b, i) => model.bones[i].parent < 0) };
  }

  build(gun, hands, knife, hide) {
    const group = new THREE.Group();
    group.name = 'viewmodel ' + gun.name;
    group.visible = false;
    // every bone of the rig: the bone, its rest (bind) local pose and the skeleton's own translation
    const rig = { group, bones: [], rest: [], trans: [], index: new Map(), maps: new Map(), knife: null };
    const add = (model, part) => {
      const local = toLocal(model.bones, model.bind);
      model.bones.forEach((b, i) => {
        if (rig.index.has(b.name)) return;
        rig.index.set(b.name, rig.bones.length);
        rig.bones.push(part.bones[i]);
        rig.rest.push({ p: local[i].p.clone(), q: local[i].q.clone() });
        rig.trans.push(b.trans ? new THREE.Vector3(...b.trans) : new THREE.Vector3());
      });
    };
    let H = null;
    if (hands) {
      H = this.skinned(hands);
      add(hands, H);
      for (const r of H.roots) group.add(r);
      group.add(H.mesh);
    }
    const G = this.skinned(gun);
    add(gun, G);
    const byName = n => rig.index.has(n) ? rig.bones[rig.index.get(n)] : null;
    // the gun's root on the hands' tag_weapon (the hands' root without one; the eye without hands)
    const tag = byName('tag_weapon') || (H && H.roots[0]) || group;
    for (const r of G.roots) { tag.add(r); r.position.set(0, 0, 0); r.quaternion.identity(); rig.rest[rig.index.get(r.name)] = { p: new THREE.Vector3(), q: new THREE.Quaternion() }; }
    group.add(G.mesh);
    // the knife on the hands' tag_knife_attach, shown during a melee
    if (knife && byName('tag_knife_attach')) {
      const K = this.skinned(knife);
      for (const r of K.roots) byName('tag_knife_attach').add(r);
      K.mesh.visible = false;
      group.add(K.mesh);
      rig.knife = K.mesh;
    }
    // the attachments the weapon does not have: their bones collapsed (the game skips their surfaces)
    rig.hidden = hide.map(byName).filter(Boolean);
    for (const b of rig.hidden) b.scale.set(0, 0, 0);
    group.userData.triangles = gun.triangles + (hands ? hands.triangles : 0) + (knife ? knife.triangles : 0);
    group.userData.rig = rig;
    rig.q = new Float32Array(4 * rig.bones.length); rig.p = new Float32Array(3 * rig.bones.length);
    rig.wq = new Float32Array(rig.bones.length); rig.wp = new Float32Array(rig.bones.length);
    this.root.add(group);
    return group;
  }

  /** pose a rig: the layers' animations blended per bone (bones no layer moves keep their rest pose),
   *  the knife, the bob / sway / kick offsets */
  pose(group, st) {
    const rig = group.userData.rig, n = rig.bones.length, Q = rig.q, Pp = rig.p, wq = rig.wq, wp = rig.wp;
    Q.fill(0); Pp.fill(0); wq.fill(0); wp.fill(0);
    // the blended layers first; an override layer (the ADS one) then replaces the bones it moves
    for (const L of st.layers) {
      if (L.override) continue;
      const c = this.decoded.get(L.clip);
      if (!c) continue;
      let map = rig.maps.get(L.clip);
      if (!map) { map = c.tracks.map(tr => rig.index.has(tr.bone) ? rig.index.get(tr.bone) : -1); rig.maps.set(L.clip, map); }
      const f = L.time * c.framerate;
      for (let k = 0; k < c.tracks.length; k++) {
        const b = map[k];
        if (b < 0) continue;
        const tr = c.tracks[k], w = L.weight;
        // the key interval of frame f
        const F = tr.frames, m = F.length;
        let i = 0;
        if (m > 1) { if (f >= F[m - 1]) i = m - 1; else { while (i + 1 < m && F[i + 1] <= f) i++; } }
        const j = Math.min(i + 1, m - 1), u = j > i && F[j] > F[i] ? Math.min(1, Math.max(0, (f - F[i]) / (F[j] - F[i]))) : 0;
        const V = tr.values;
        if (tr.q) {
          let x = V[4 * i], y = V[4 * i + 1], z = V[4 * i + 2], ww = V[4 * i + 3];
          if (u > 0) {
            let x1 = V[4 * j], y1 = V[4 * j + 1], z1 = V[4 * j + 2], w1 = V[4 * j + 3];
            if (x * x1 + y * y1 + z * z1 + ww * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
            x += (x1 - x) * u; y += (y1 - y) * u; z += (z1 - z) * u; ww += (w1 - ww) * u;
          }
          // the same hemisphere as what is accumulated
          if (Q[4 * b] * x + Q[4 * b + 1] * y + Q[4 * b + 2] * z + Q[4 * b + 3] * ww < 0) { x = -x; y = -y; z = -z; ww = -ww; }
          Q[4 * b] += x * w; Q[4 * b + 1] += y * w; Q[4 * b + 2] += z * w; Q[4 * b + 3] += ww * w; wq[b] += w;
        } else {
          const T = rig.trans[b];
          let x = V[3 * i], y = V[3 * i + 1], z = V[3 * i + 2];
          if (u > 0) { x += (V[3 * j] - x) * u; y += (V[3 * j + 1] - y) * u; z += (V[3 * j + 2] - z) * u; }
          Pp[3 * b] += (x + T.x) * w; Pp[3 * b + 1] += (y + T.y) * w; Pp[3 * b + 2] += (z + T.z) * w; wp[b] += w;
        }
      }
    }
    for (const L of st.layers) {
      if (!L.override) continue;
      const c = this.decoded.get(L.clip);
      if (!c) continue;
      let map = rig.maps.get(L.clip);
      if (!map) { map = c.tracks.map(tr => rig.index.has(tr.bone) ? rig.index.get(tr.bone) : -1); rig.maps.set(L.clip, map); }
      const f = L.time * c.framerate;
      for (let k = 0; k < c.tracks.length; k++) {
        const b = map[k];
        if (b < 0) continue;
        const tr = c.tracks[k], val = sample(tr, f);
        if (tr.q) { Q.set(val, 4 * b); wq[b] = 1; }
        else { const T = rig.trans[b]; Pp[3 * b] = val[0] + T.x; Pp[3 * b + 1] = val[1] + T.y; Pp[3 * b + 2] = val[2] + T.z; wp[b] = 1; }
      }
    }
    for (let b = 0; b < n; b++) {
      const bone = rig.bones[b], r = rig.rest[b];
      if (wq[b] > 0) {
        let x = Q[4 * b], y = Q[4 * b + 1], z = Q[4 * b + 2], w = Q[4 * b + 3];
        const rest = 1 - Math.min(1, wq[b]);
        if (rest > 0) {
          const s = x * r.q.x + y * r.q.y + z * r.q.z + w * r.q.w < 0 ? -rest : rest;
          x += r.q.x * s; y += r.q.y * s; z += r.q.z * s; w += r.q.w * s;
        }
        bone.quaternion.set(x, y, z, w).normalize();
      } else bone.quaternion.copy(r.q);
      if (wp[b] > 0) {
        const rest = 1 - Math.min(1, wp[b]);
        bone.position.set(Pp[3 * b] + r.p.x * rest, Pp[3 * b + 1] + r.p.y * rest, Pp[3 * b + 2] + r.p.z * rest);
      } else bone.position.copy(r.p);
    }
    for (const b of rig.hidden) b.scale.set(0, 0, 0);
    if (rig.knife) rig.knife.visible = !!st.knife;
    // the offsets of bob, sway, kick (model space; pitch > 0 down = about +Y, yaw > 0 left = about +Z)
    const o = st.offset;
    group.position.set(o.pos[0], o.pos[1], o.pos[2]);
    group.quaternion.setFromEuler(new THREE.Euler(o.rot[2] * D2R, o.rot[0] * D2R, o.rot[1] * D2R, 'ZYX'));
  }

  /** the world model of a weapon without a view model, ahead of the eye */
  fallback(weapon) {
    const name = this.worldTable ? weaponModelName(this.worldTable, weapon) : null;
    if (!name) return null;
    if (this.fallbacks.has(name)) return this.fallbacks.get(name) || null;
    this.fallbacks.set(name, undefined);
    this.library.load(name).then(m => {
      const mesh = new THREE.Mesh(m.geo, this.materials(m));
      mesh.name = 'viewmodel fallback ' + name;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.position.copy(FALLBACK_OFFSET);
      this.root.add(mesh);
      this.fallbacks.set(name, mesh);
      this.changed();
    }).catch(() => this.fallbacks.set(name, null));
    return null;
  }

  /** the frame {origin, axis} in world coordinates of a tag of the gun shown now (tag_flash, tag_brass:
   *  the view flash and casings, fx.js) with the rig hung at `camera` as render() hangs it, or null */
  tagFrame(camera, name) {
    const rig = this.shown && this.current && this.current.userData.rig;
    const i = rig ? rig.index.get(name) : null;
    if (i == null) return null;
    this.root.position.copy(camera.position);
    this.root.quaternion.copy(camera.quaternion).multiply(MODEL_TO_CAMERA);
    this.root.updateMatrixWorld(true);
    const e = rig.bones[i].matrixWorld.elements, n = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
    return { origin: [e[12], e[13], e[14]], axis: [n([e[0], e[1], e[2]]), n([e[4], e[5], e[6]]), n([e[8], e[9], e[10]])] };
  }

  /** draw over the finished frame of `camera` (the first-person camera at the eye): the gun, then the
   *  crosshair or the scope */
  render(renderer, camera) {
    if (this.shown && this.current) {
      const C = this.camera;
      C.position.copy(camera.position);
      C.quaternion.copy(camera.quaternion);
      C.fov = camera.fov; C.aspect = camera.aspect;
      C.updateProjectionMatrix();
      this.root.position.copy(camera.position);
      this.root.quaternion.copy(camera.quaternion).multiply(MODEL_TO_CAMERA);
      // lighting: the light grid and probe at the eye
      if (this.lg) {
        const p = camera.position, s = this.sample;
        if (this.probes) s.probe = this.probes.nearest(p.x, p.y, p.z);
        if (this.grid.sample(p.x, p.y, p.z, s)) setObjectLighting(this.lg, s);
      }
      if (this.sceneLights) {
        const [h, sun] = this.sceneLights;
        this.hemi.color.copy(h.color); this.hemi.groundColor.copy(h.groundColor); this.hemi.intensity = h.intensity;
        this.sun.color.copy(sun.color); this.sun.position.copy(sun.position); this.sun.intensity = sun.intensity;
      }
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.scene, C);
      renderer.autoClear = auto;
    }
    this.renderHud(renderer, camera);
  }

  /** the crosshair (CG_DrawCrosshair) and the scope overlay */
  renderHud(renderer, camera) {
    const st = this.state, P = st && st.entry && st.entry.params;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const W = size.x, H = size.y, px = H / 480;               // the game's 640 x 480 screen units (centred)
    let any = false;
    // the crosshair: the colour (CG_CalcCrosshairColor: a teammate / enemy under it, only for a weapon with
    // crosshairColorChange - the recorder's weapFlags 8 / 0x10, the others by their view), its alpha (1 -
    // the scope's zoom), hidden at full ADS and in the raise / drop / reload / melee states
    const zoom = this.reticleZoom();
    let show = !!(st && P && this.crosshair && st.ads < 1 && !st.reticleOff);
    let color = [1, 1, 1];
    if (show && P.crosshairColorChange) {
      const f = st.weapFlags;
      const who = f != null ? (f & 8 ? 'friend' : f & 0x10 ? 'enemy' : null) : this.aimTarget && this.aimTarget(st, P.enemyCrosshairRange || 0);
      if (who === 'friend') color = MY_TEAM; else if (who === 'enemy') color = ENEMY_TEAM;
    }
    const alpha = (1 - zoom) * CROSSHAIR_ALPHA;
    if (alpha < 0.01) show = false;
    // the ADS transition (CG_TransitionToAds): smaller and moved by the aim pitch over the last
    // adsCrosshairInFrac (in) / OutFrac (out) of the sights' fraction
    let transScale = 1, transShift = 0;
    const tanY = Math.tan(camera.fov * D2R / 2);
    if (show && st.ads > 0) {
      const fr = (st.adsIn ? P.adsCrosshairInFrac : P.adsCrosshairOutFrac) || 1, f = st.ads - (1 - fr);
      if (f > 0) { const fa = f / fr; transScale = 1 - fa * 0.5; transShift = fa * 240 / tanY * Math.tan((P.adsAimPitch || 0) * D2R); }
    }
    for (const l of this.lines) l.visible = false;
    this.center.visible = false;
    if (show) {
      const cy = -transShift * px;
      // the sides (CG_DrawReticleSides): the image four times, turned 0 / 90 / 180 / 270, at the spread's
      // distance tan(spread x transScale) x 240 / tan(fov / 2) (at least reticleMinOfs); faded by the
      // aim spread scale (CG_CalcReticleColor), not below cg_crosshairAlphaMin
      if (P.reticleSide) {
        const a = Math.max(CROSSHAIR_ALPHA_MIN, alpha * (1 - (st.spreadScale || 0)));
        const d = (P.reticleSideSize || 8) * transScale;
        let sp = Math.tan(st.spread * transScale * D2R) * 240 / tanY;
        if (sp < (P.reticleMinOfs || 0)) sp = P.reticleMinOfs || 0;
        sp -= (P.hipReticleSidePos || 0) * d;
        const off = d / 8;                                   // CG_CalcReticleImageOffset
        // the top-left corners of the four images (virtual units, y down) -> centres in pixels (y up)
        const corners = [[-d / 2, -d - sp - off], [sp, -d / 2], [-d / 2 - off, sp], [-d - sp - off, -d / 2 - off]];
        corners.forEach(([x, y], k) => {
          const l = this.lines[k];
          l.visible = true;
          l.position.set((x + d / 2) * px, cy - (y + d / 2) * px, 0);
          l.scale.set(d * px, d * px, 1);
          l.rotation.z = -k * Math.PI / 2;
          l.material.color.setRGB(...color); l.material.opacity = Math.min(1, a);
        });
      }
      // the centre image (grenades: reticle_center_cross at reticleCenterSize)
      if (P.reticleCenter) {
        const d = (P.reticleCenterSize || 4) * transScale;
        this.center.visible = true;
        this.center.position.set(0, cy, 0);
        this.center.scale.set(d * px, d * px, 1);
        this.center.material.color.setRGB(...color); this.center.material.opacity = alpha;
      }
      any = true;
    }
    // the scope: the overlay (the whole scope with its reticle) in a square of the screen's height, black around
    // (the overlay fades in with the reticle zoom: CG_DrawWeapReticle draws it at alpha = zoom)
    const scoped = zoom > 0 && this.enabled && P && P.adsOverlayShader && this.table.overlays && this.table.overlays[P.adsOverlayShader];
    if (scoped) { this.buildScope(this.table.overlays[P.adsOverlayShader]); any = true; }
    if (this.scope) { this.scope.group.visible = !!scoped; this.scope.quad.material.opacity = zoom; this.scope.bars.forEach(b => { b.material.transparent = true; b.material.opacity = zoom; }); }
    if (scoped) {
      this.scope.quad.scale.set(H, H, 1);
      const side = Math.max(0, (W - H) / 2) + 2;
      this.scope.bars[0].scale.set(side, H + 4, 1); this.scope.bars[0].position.set(-W / 2 + side / 2 - 1, 0, 0);
      this.scope.bars[1].scale.set(side, H + 4, 1); this.scope.bars[1].position.set(W / 2 - side / 2 + 1, 0, 0);
    }
    if (!any) return;
    const C = this.hudCam;
    C.left = -W / 2; C.right = W / 2; C.top = H / 2; C.bottom = -H / 2; C.updateProjectionMatrix();
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.hud, C);
    renderer.autoClear = auto;
  }

  buildScope(ov) {
    if (this.scope) return;
    const tex = loadTexture('maps3d/' + ov.texture, new THREE.TextureLoader().setCrossOrigin('anonymous'));
    tex.colorSpace = THREE.NoColorSpace;
    const poll = setInterval(() => { if (tex.image) { clearInterval(poll); tex.needsUpdate = true; this.changed(); } }, 100);
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    group.add(quad);
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false });
    const bars = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), black); group.add(m); return m; });
    group.visible = false;
    this.hud.add(group);
    this.scope = { group, quad, bars };
  }

  /** triangles of the shown view model (stats) */
  triangles() { return this.shown && this.current ? (this.current.userData.triangles || 0) : 0; }

  dispose() {
    this.root.traverse(o => { if (o.isSkinnedMesh) o.skeleton.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
    this.hud.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    this.scene.clear(); this.hud.clear();
  }
}

/** a track's value at frame f (linear between keys; rotations normalised) -> a new array */
function sample(tr, f) {
  const F = tr.frames, m = F.length, V = tr.values, k = tr.q ? 4 : 3;
  let i = 0;
  if (m > 1) { if (f >= F[m - 1]) i = m - 1; else { while (i + 1 < m && F[i + 1] <= f) i++; } }
  const j = Math.min(i + 1, m - 1), u = j > i && F[j] > F[i] ? Math.min(1, Math.max(0, (f - F[i]) / (F[j] - F[i]))) : 0;
  const out = new Float32Array(k);
  let sign = 1;
  if (tr.q && u > 0) { let d = 0; for (let c = 0; c < 4; c++) d += V[4 * i + c] * V[4 * j + c]; if (d < 0) sign = -1; }
  for (let c = 0; c < k; c++) out[c] = V[k * i + c] + (sign * V[k * j + c] - V[k * i + c]) * u;
  if (tr.q) { const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1; for (let c = 0; c < 4; c++) out[c] /= l; }
  return out;
}

/** an animation's tracks as numbers: [{bone, q (rotation) | t, frames, values}] - rotations as
 *  normalised quaternions, translations as stored (viewmodel adds the skeleton's own) */
function decodeClip(c, buf) {
  const tracks = [];
  for (const [bone, type, n, fOff, vOff] of c.tracks) {
    if (!n) continue;
    const frames = new Uint16Array(buf, fOff, n);
    if (type === 'q') {
      const raw = new Int16Array(buf, vOff, 4 * n), v = new Float32Array(4 * n);
      for (let i = 0; i < n; i++) {
        const x = raw[4 * i] / 32767, y = raw[4 * i + 1] / 32767, z = raw[4 * i + 2] / 32767, w = raw[4 * i + 3] / 32767, l = Math.hypot(x, y, z, w) || 1;
        v[4 * i] = x / l; v[4 * i + 1] = y / l; v[4 * i + 2] = z / l; v[4 * i + 3] = w / l;
      }
      tracks.push({ bone, q: true, frames, values: v });
    } else tracks.push({ bone, q: false, frames, values: new Float32Array(buf, vOff, 3 * n) });
  }
  return { framerate: c.framerate, duration: c.duration, tracks };
}
