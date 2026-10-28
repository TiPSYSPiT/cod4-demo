/* The game's shadow maps (docs/findings.md, "The game's shaders"):
 *
 * Sun (lm_sm_sun_*.hlsl / lp_sm_sun_*.hlsl): two partitions around the view - a near map and a far map
 * with 4 x the extent (rg.sunShadowPartitionRatio), the near one fading into the far one at its edge,
 * the far one into the baked visibility. World: the sun stays off where the baked visibility (primary
 * lightmap) is 0, else the shadow map decides; models: the shadow map instead of the light grid's
 * visibility. Each partition is split in two maps with the same projection: the static casters (world,
 * props - layer STATIC_LAYER) rendered only when the partition has to move, the moving ones (players,
 * their weapons, corpses - layer DYNAMIC_LAYER) every frame; the lookup takes the nearer depth.
 *
 * Lamps (lm_sm_spot_*.hlsl / lp_sm_spot_*.hlsl, r_primarylights.cpp / r_spotshadow.cpp): up to
 * sm_maxLights = 4 spot lights with canUseShadowMap get a 512 x 512 perspective map from the light,
 * chosen per frame by the game's score (R_ShadowedSpotLightScore: radius x intensity / distance from
 * a point 64 units ahead of the eye to a point 1/8 of the radius down the cone) and faded in / out over
 * sm_spotShadowFadeTime = 1 s; visibility = lrp(fade, shadow map, baked / grid visibility).
 *
 * Every caster gets a depth material that keeps its alpha test (foliage); blended surfaces cast
 * nothing; skinned and instanced meshes are handled by three.js. */
import * as THREE from 'three';
import { SHADOW, SPOT } from './lighting.js';

export const STATIC_LAYER = 5;
export const DYNAMIC_LAYER = 6;
export const SHADOW_LAYER = DYNAMIC_LAYER;              // for moving casters (characters.js)

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

function depthTarget(w, h) {
  const t = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
  t.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
  return t;
}

/** depth materials per source material, shared by all shadow maps */
class DepthMaterials {
  constructor() { this.map = new WeakMap(); }
  get(m) {
    let d = this.map.get(m);
    if (!d && (m.transparent || m.blending !== THREE.NormalBlending || m.depthWrite === false || m.userData.noDraw)) {
      // blended surfaces (glass, light beams, decals) cast no shadow, as in the game's baked light; nor do
      // materials the game never draws (noDraw: no lit, emissive or shadow map technique)
      d = this.noCast || (this.noCast = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
      this.map.set(m, d);
    }
    if (!d) {
      d = new THREE.MeshDepthMaterial({ side: m.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide });
      if (m.alphaTest && m.map) { d.map = m.map; d.alphaTest = m.alphaTest; }
      d.polygonOffset = true; d.polygonOffsetFactor = 2; d.polygonOffsetUnits = 4;
      this.map.set(m, d);
    }
    return d;
  }
  /** render the casters on `layer` with `camera` into `target` (whole target, or a viewport) */
  render(renderer, scene, camera, layer, target, viewport = null, clear = true) {
    const swapped = [];
    scene.traverse(o => {
      if (!o.isMesh || !o.layers.isEnabled(layer)) return;
      swapped.push([o, o.material]);
      o.material = Array.isArray(o.material) ? o.material.map(m => this.get(m)) : this.get(o.material);
    });
    const prevTarget = renderer.getRenderTarget(), prevBg = scene.background, prevFog = scene.fog;
    scene.background = null; scene.fog = null;
    camera.layers.set(layer);
    renderer.setRenderTarget(target);
    if (viewport) {
      target.viewport.set(...viewport); target.scissor.set(...viewport); target.scissorTest = true;
    } else {
      target.viewport.set(0, 0, target.width, target.height); target.scissorTest = false;
    }
    renderer.setRenderTarget(target);                 // (applies the viewport / scissor)
    if (clear) renderer.clear(true, true, false);
    renderer.render(scene, camera);
    target.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    scene.background = prevBg; scene.fog = prevFog;
    for (const [o, m] of swapped) o.material = m;
    return swapped.length;
  }
}

/** one sun shadow partition: a square map of `extent` units around a centre */
class SunPartition {
  constructor(size, extent, depth) {
    this.size = size; this.extent = extent; this.depth = depth;
    this.staticTarget = depthTarget(size, size);
    this.dynamicTarget = depthTarget(size, size);
    this.camera = new THREE.OrthographicCamera(-extent / 2, extent / 2, extent / 2, -extent / 2, 1, depth);
    this.camera.up.set(0, 0, 1);
    this.matrix = new THREE.Matrix4();
    this.center = null;
    this.sunDir = new THREE.Vector3();
    this.staticDirty = true;
  }
  /** moved only when the centre leaves the middle half of the map; snapped to the texel grid */
  place(center, sunDir) {
    const E = this.extent;
    if (!this.sunDir.equals(sunDir)) { this.sunDir.copy(sunDir); this.center = null; }
    if (this.center && this.center.distanceTo(center) < E / 4) return;
    const cam = this.camera, dir = sunDir.clone().normalize();
    cam.position.copy(center).addScaledVector(dir, this.depth / 2);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
    const texel = E / this.size;
    const local = center.clone().applyMatrix4(cam.matrixWorldInverse);
    const dx = local.x - Math.round(local.x / texel) * texel, dy = local.y - Math.round(local.y / texel) * texel;
    cam.left = -E / 2 + dx; cam.right = E / 2 + dx; cam.top = E / 2 + dy; cam.bottom = -E / 2 + dy;
    cam.updateProjectionMatrix();
    this.center = center.clone();
    this.staticDirty = true;
    this.matrix.copy(BIAS).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  }
  dispose() { this.staticTarget.dispose(); this.dynamicTarget.dispose(); }
}

export class SunShadows {
  /** size: map edge in texels per partition, extent: world units of the near partition (the far one
   *  covers 4 x), depth: range along the sun */
  constructor(renderer, { size = 2048, extent = 2400, depth = 14000 } = {}) {
    this.renderer = renderer;
    this.depthMats = new DepthMaterials();
    this.near = new SunPartition(size, extent, depth);
    this.far = new SunPartition(size, extent * 4, depth);
    this.spots = new SpotShadows(renderer, this.depthMats);
    this.ms = 0; this.staticRenders = 0;
    SHADOW.map.value = this.near.staticTarget.depthTexture;
    SHADOW.dynMap.value = this.near.dynamicTarget.depthTexture;
    SHADOW.farMap.value = this.far.staticTarget.depthTexture;
    SHADOW.farDynMap.value = this.far.dynamicTarget.depthTexture;
    SHADOW.params.value.set(0, 1 / size, 0.0006, 0);
    SHADOW.farParams.value.set(1 / size, 0.0012, 0, 0);
  }

  /** before each frame: the sun's partitions around `center` for the sun direction `sunDir` (towards
   *  the sun), the lamps' maps for the camera; dt in seconds (the lamps' fade) */
  update(scene, center, sunDir, camera = null, lights = null, dt = 0) {
    const t0 = performance.now();
    for (const p of [this.near, this.far]) {
      p.place(center, sunDir);
      if (p.staticDirty) {
        this.depthMats.render(this.renderer, scene, p.camera, STATIC_LAYER, p.staticTarget);
        p.staticDirty = false;
        this.staticRenders++;
      }
      this.dynamicCasters = this.depthMats.render(this.renderer, scene, p.camera, DYNAMIC_LAYER, p.dynamicTarget);
    }
    SHADOW.matrix.value.copy(this.near.matrix);
    SHADOW.farMatrix.value.copy(this.far.matrix);
    SHADOW.params.value.x = 1;
    SHADOW.params.value.w = 1;
    if (camera && lights) this.spots.update(scene, camera, lights, dt);
    this.ms = performance.now() - t0;
  }

  /** the static casters changed (props mode): render them again with the next frame */
  invalidate() { this.near.staticDirty = true; this.far.staticDirty = true; this.spots.invalidate(); }

  dispose() { this.near.dispose(); this.far.dispose(); this.spots.dispose(); SHADOW.params.value.x = 0; SPOT.lights.value.set(-1, -1, -1, -1); }
}

/** the lamps' spot shadow maps: SLOTS tiles of TILE x TILE in one atlas (static + dynamic) */
const SLOTS = 4, TILE = 512, EYE_PROJECT = 64, SPOT_PROJECT = 0.125, FADE_TIME = 1;
const INTENSITY = [0.2989, 0.587, 0.114];

class SpotShadows {
  constructor(renderer, depthMats) {
    this.renderer = renderer; this.depthMats = depthMats;
    this.staticTarget = depthTarget(TILE * SLOTS, TILE);
    this.dynamicTarget = depthTarget(TILE * SLOTS, TILE);
    this.slots = Array.from({ length: SLOTS }, () => ({ light: -1, fade: 0, out: false, camera: new THREE.PerspectiveCamera(90, 1, 1, 100),
                                                         staticFor: -2, dynamicUsed: false }));
    this.history = [];                                    // {light, fade, out}
    SPOT.map.value = this.staticTarget.depthTexture;
    SPOT.dynMap.value = this.dynamicTarget.depthTexture;
    SPOT.lights.value.set(-1, -1, -1, -1);
    this.cleared = false;
  }

  /** R_ShadowedSpotLightScore */
  score(L, eye, fwd) {
    const ref = [eye.x + EYE_PROJECT * fwd.x, eye.y + EYE_PROJECT * fwd.y, eye.z + EYE_PROJECT * fwd.z];
    const s = -L.radius * SPOT_PROJECT;
    const d = [L.origin[0] - ref[0] + s * L.dir[0], L.origin[1] - ref[1] + s * L.dir[1], L.origin[2] - ref[2] + s * L.dir[2]];
    const intensity = L.color[0] * INTENSITY[0] + L.color[1] * INTENSITY[1] + L.color[2] * INTENSITY[2];
    return L.radius * intensity / (Math.hypot(...d) + 1);
  }

  update(scene, camera, lights, dt) {
    if (!this.cleared) {                                  // depth 1 everywhere before the first use
      const r = this.renderer, prev = r.getRenderTarget();
      for (const t of [this.staticTarget, this.dynamicTarget]) { r.setRenderTarget(t); r.clear(true, true, false); }
      r.setRenderTarget(prev);
      this.cleared = true;
    }
    // candidates: the shadow-casting spot lights the view sees (their sphere in the view frustum), by score
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const sphere = new THREE.Sphere();
    const cand = [];
    lights.forEach((L, k) => {
      if (!L || L.type !== 2 || !L.shadow || !(L.cosOuter > 0 && L.cosOuter < 1)) return;
      sphere.center.set(...L.origin); sphere.radius = L.radius;
      if (!frustum.intersectsSphere(sphere)) return;
      cand.push([this.score(L, camera.position, fwd), k]);
    });
    cand.sort((a, b) => b[0] - a[0]);
    const chosen = cand.slice(0, SLOTS).map(c => c[1]);
    // the shadow history (R_AddShadowedLightToShadowHistory): chosen lights fade in, others fade out
    const step = FADE_TIME > 0 ? Math.min(1, dt / FADE_TIME) : 1;
    for (const h of this.history) {
      if (chosen.includes(h.light)) { h.out = false; h.fade = Math.min(1, h.fade + step); }
      else { h.out = true; h.fade -= step; }
    }
    this.history = this.history.filter(h => h.fade > 0 || !h.out);
    for (const k of chosen) {
      if (!this.history.some(h => h.light === k) && this.history.length < SLOTS) this.history.push({ light: k, fade: step, out: false });
    }
    // slots: keep each light in its slot
    for (const s of this.slots) if (!this.history.some(h => h.light === s.light)) s.light = -1;
    for (const h of this.history) {
      if (this.slots.some(s => s.light === h.light)) continue;
      const free = this.slots.find(s => s.light < 0);
      if (free) { free.light = h.light; free.staticFor = -2; free.dynamicUsed = true; }
    }
    // render
    const dynPos = [];
    scene.traverse(o => { if (o.isSkinnedMesh && o.visible && o.layers.isEnabled(DYNAMIC_LAYER)) dynPos.push(new THREE.Vector3().setFromMatrixPosition(o.matrixWorld)); });
    this.slots.forEach((s, i) => {
      const vp = [i * TILE, 0, TILE, TILE];
      if (s.light < 0) { SPOT.lights.value.setComponent(i, -1); return; }
      const L = lights[s.light], h = this.history.find(x => x.light === s.light);
      const cam = s.camera;
      if (s.staticFor !== s.light) {
        cam.fov = 2 * Math.acos(L.cosOuter) * 180 / Math.PI;
        cam.near = 1; cam.far = L.radius;
        cam.position.set(...L.origin);
        cam.up.set(0, 0, 1);
        if (Math.abs(L.dir[2]) > 0.99) cam.up.set(1, 0, 0);
        cam.lookAt(L.origin[0] - L.dir[0], L.origin[1] - L.dir[1], L.origin[2] - L.dir[2]);
        cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
        this.depthMats.render(this.renderer, scene, cam, STATIC_LAYER, this.staticTarget, vp);
        s.staticFor = s.light;
        // world -> the tile of this slot in the atlas
        SPOT.matrices.value[i].makeTranslation(i / SLOTS, 0, 0).multiply(new THREE.Matrix4().makeScale(1 / SLOTS, 1, 1))
          .multiply(BIAS).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      }
      // moving casters only when a player is within the light's reach
      const o = new THREE.Vector3(...L.origin);
      const near = dynPos.some(p => p.distanceTo(o) < L.radius + 80);
      if (near || s.dynamicUsed) {
        this.depthMats.render(this.renderer, scene, cam, DYNAMIC_LAYER, this.dynamicTarget, vp);
        s.dynamicUsed = near;
      }
      SPOT.lights.value.setComponent(i, s.light);
      SPOT.fades.value.setComponent(i, h ? Math.max(0, h.fade) : 0);
    });
    SPOT.texel.value.set(1 / (TILE * SLOTS), 1 / TILE);
  }

  invalidate() { for (const s of this.slots) s.staticFor = -2; }
  dispose() { this.staticTarget.dispose(); this.dynamicTarget.dispose(); }
}

/** mark an object tree as static shadow caster (layer STATIC_LAYER, still drawn on layer 0) */
export function castShadows(obj) {
  obj.traverse(o => { if (o.isMesh) o.layers.enable(STATIC_LAYER); });
}
