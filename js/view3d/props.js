/* Props (static models) of an exported map: real model geometry (props.json format 2, written by
 * tools/export/props_export.py) drawn as one InstancedMesh per model - the geometry of a model is
 * shared by all its placements - with one material per surface. Models without geometry, and
 * the "Boxes" mode, use see-through boxes of the model bounds. Modes: off | boxes | high | low. */
import * as THREE from 'three';
import { gridLit, setInstanceLighting, materialShading, lightingAtlas } from './lighting.js';
import { blendOptions } from './blend.js';
import { fetchData, fetchBinary, checkedView } from './data.js';

const PROP_GAIN = 1.25;
const FOLIAGE = /foliage|grass|bush|shrub|tree|plant|leaf|leaves|vine|weed|flower|ivy|hedge|reed|fern/i;
const SECTION_TYPES = { position: Float32Array, normal: Int8Array, uv: Float32Array, index: Uint16Array, probe: Uint8Array, color: Uint8Array };

/** placement matrix of instance i: world = origin + scale * (x*forward + y*left + z*up) */
function placement(buf, o, out) {
  const s = buf[o + 13];
  return out.set(buf[o + 4] * s, buf[o + 7] * s, buf[o + 10] * s, buf[o + 1],
                 buf[o + 5] * s, buf[o + 8] * s, buf[o + 11] * s, buf[o + 2],
                 buf[o + 6] * s, buf[o + 9] * s, buf[o + 12] * s, buf[o + 3],
                 0, 0, 0, 1);
}

function propMaterial(m, texture, gameLit, vertexColors = false) {
  if (!m) return new THREE.MeshLambertMaterial({ color: 0x8c8780 });
  // the vertex colours: the model shaders (lp_*) multiply the colour map by them - foliage tint and shading
  const opts = { side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide, vertexColors };
  const tex = texture(m.texture);
  // props have no lightmap: with the light grid lit like in the game, else by the scene lights, a
  // little brighter to sit with the lightmapped world
  const gain = gameLit ? 1 : PROP_GAIN;
  if (tex) { opts.map = tex; opts.color = new THREE.Color(gain, gain, gain); } else opts.color = new THREE.Color(m.color || '#8c8780').multiplyScalar(gain);
  if (m.alphaTest && m.textureAlpha) opts.alphaTest = m.alphaTest === 'gt0' ? 0.05 : 0.5;
  // the game's blend factors (blend.js), the framebuffer's alpha kept
  Object.assign(opts, blendOptions(m.blend));
  const mat = new THREE.MeshLambertMaterial(opts);
  mat.name = m.name || '';
  // a shadow caster's material (e.g. mc/mtl_tree_shadow_caster): the game draws it only into the shadow
  // maps - hidden here, the shadow pass (shadows.js) swaps in a depth material that still casts
  if (m.shadowOnly) mat.visible = false;
  // no lit / emissive technique: the game never draws it - nor does it cast (shadows.js)
  if (m.noDraw) { mat.visible = false; mat.userData.noDraw = true; }
  return mat;
}

/** the props' collision placed in the world (props_coll.bin, props.json "collision": every model's
 *  collision triangles in model space, tools/export/props_export.py), for the bullet and debris traces
 *  of the effects (trace.js) - what the game's traces hit (foliage has none, a palm tree only its
 *  trunk). pj: props.json, inst: its instance floats, coll: the props_coll.bin buffer
 *  -> {positions: Float32Array (9 per triangle), surface: Uint8Array} or null (also used by tools/validate) */
export function propCollision(pj, inst, coll) {
  const C = pj.collision;
  if (!C || !coll || !C.triangles) return null;
  const T = new Float32Array(coll, 0, C.triangles * 9), surf = new Uint8Array(coll, C.triangles * 36, C.triangles);
  const S = pj.stride;
  let n = 0;
  for (let i = 0; i < pj.instanceCount; i++) { const r = C.models[inst[i * S]]; if (r) n += r[1]; }
  const pos = new Float32Array(n * 9), sf = new Uint8Array(n);
  let w = 0;
  for (let i = 0; i < pj.instanceCount; i++) {
    const o = i * S, r = C.models[inst[o]];
    if (!r) continue;
    const s = inst[o + 13];
    for (let k = r[0]; k < r[0] + r[1]; k++) {
      for (let v = 0; v < 3; v++) {
        const x = T[9 * k + 3 * v], y = T[9 * k + 3 * v + 1], z = T[9 * k + 3 * v + 2], q = 9 * w + 3 * v;
        // world = origin + scale * (x * forward + y * left + z * up)
        pos[q] = inst[o + 1] + s * (x * inst[o + 4] + y * inst[o + 7] + z * inst[o + 10]);
        pos[q + 1] = inst[o + 2] + s * (x * inst[o + 5] + y * inst[o + 8] + z * inst[o + 11]);
        pos[q + 2] = inst[o + 3] + s * (x * inst[o + 6] + y * inst[o + 9] + z * inst[o + 12]);
      }
      sf[w++] = surf[k];
    }
  }
  return { positions: pos, surface: sf };
}

export class Props {
  /** -> Props or null when the map has no props.json */
  static async load(dir, texture, lightGrid) {
    const r = await fetchData(dir + 'props.json').catch(err => (/HTTP 404/.test(err.message) ? null : Promise.reject(err)));
    if (!r) return null;                                    // (a map without props)
    const pj = await r.json();
    if (!pj.instanceCount) return null;
    // props.bin's length: the end of its last section (checked on arrival, data.js)
    const expected = pj.sections ? Math.max(...Object.values(pj.sections).map(x => x.offset + x.length)) : 0;
    const [bin, coll] = await Promise.all([fetchBinary(dir + pj.file, { expected }),
      pj.collision ? fetchBinary(dir + pj.collision.file).catch(err => { console.warn('prop collision:', err.message); return null; }) : null]);
    const props = new Props(pj, bin, texture, lightGrid);
    props.collisionData = coll;
    return props;
  }

  /** a prop model as a standalone model (for script entities that show it: scriptModels.js) in the
   *  shape of characters.js's library models {geo, mats, shadings, triangles}, or null */
  modelFor(name) {
    this.single = this.single || new Map();
    if (this.single.has(name)) return this.single.get(name);
    let out = null;
    const model = this.arrays && this.pj.models.find(m => m.name === name && m.lods && m.lods.length);
    if (model) {
      const { P, N, U, I, C } = this.arrays, lod = model.lods[0], v0 = lod.vertexStart, n = lod.vertexCount;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P.subarray(v0 * 3, (v0 + n) * 3), 3));
      geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(N.subarray(v0 * 4, (v0 + n) * 4), 4), 3, 0, true));
      geo.setAttribute('uv', new THREE.BufferAttribute(U.subarray(v0 * 2, (v0 + n) * 2), 2));
      if (C) geo.setAttribute('color', new THREE.BufferAttribute(C.subarray(v0 * 4, (v0 + n) * 4), 4, true));
      geo.setIndex(new THREE.BufferAttribute(I.subarray(lod.indexStart, lod.indexStart + lod.indexCount), 1));
      const mats = [], shadings = [];
      lod.surfaces.forEach((s, k) => {
        geo.addGroup(s.indexStart, s.indexCount, k);
        const m = s.material >= 0 ? this.entries[s.material] : null;
        mats.push(propMaterial(m, this.texture, true, !!C));
        shadings.push(m ? materialShading(m, this.texture) : null);
      });
      out = { name, geo, mats, shadings, triangles: lod.indexCount / 3 };
    }
    this.single.set(name, out);
    return out;
  }

  /** the placed collision triangles (propCollision), built on first use */
  collision() {
    if (this._collision === undefined) this._collision = propCollision(this.pj, this.inst, this.collisionData);
    return this._collision;
  }

  /** lightGrid: the map's LightGrid (lighting.js) - props are then lit like in the game (per placement
   *  at the centre of its bounds), else by the scene lights */
  constructor(pj, bin, texture, lightGrid) {
    const t0 = performance.now();
    this.pj = pj;
    this.group = new THREE.Group();
    this.group.name = 'props';
    const sec = pj.sections || { instances: { offset: 0, length: bin.byteLength } };
    const S = pj.stride;
    const inst = checkedView(Float32Array, bin, sec.instances.offset, sec.instances.length / 4, pj.file + ' instances');
    this.inst = inst;
    this.instanceCount = pj.instanceCount;
    // instances per model
    const byModel = pj.models.map(() => []);
    for (let i = 0; i < pj.instanceCount; i++) byModel[inst[i * S]].push(i);
    const M = new THREE.Matrix4();
    this.counts = { high: { tris: 0, draws: 0 }, low: { tris: 0, draws: 0 }, boxes: { tris: 0, draws: 0 } };

    // real models
    this.high = new THREE.Group(); this.low = new THREE.Group();
    const entries = pj.materials || [];
    const probeOf = sec.probe ? checkedView(Uint8Array, bin, sec.probe.offset, sec.probe.length, pj.file + ' probe') : null;
    // the game's lighting per placement: the light grid at the centre of its bounds
    const lighting = lightGrid ? new Map() : null;
    const placeLight = i => {
      if (lighting.has(i)) return lighting.get(i);
      const m = pj.models[inst[i * S]], o = i * S, s = inst[o + 13];
      let x = inst[o + 1], y = inst[o + 2], z = inst[o + 3];
      if (m.mins) {
        const c = [0, 1, 2].map(k => (m.mins[k] + m.maxs[k]) / 2 * s);
        x += c[0] * inst[o + 4] + c[1] * inst[o + 7] + c[2] * inst[o + 10];
        y += c[0] * inst[o + 5] + c[1] * inst[o + 8] + c[2] * inst[o + 11];
        z += c[0] * inst[o + 6] + c[1] * inst[o + 9] + c[2] * inst[o + 12];
      }
      const out = {};
      if (!lightGrid.sample(x, y, z, out)) { out.cube = new Float32Array(18).fill(0.5); out.sun = 1; this.unlit = (this.unlit || 0) + 1; }
      lighting.set(i, out);
      return out;
    };
    // with the game's lighting: the light grid's block of every placement in one 3D texture (lighting.js
    // lightingAtlas), the normal / specular / detail maps, the reflection probe of each placement
    const samples = lightGrid ? Array.from({ length: pj.instanceCount }, (_, i) => placeLight(i)) : null;
    const atlas = samples ? lightingAtlas(samples) : null;
    const colors = !!(pj.sections && pj.sections.color && pj.sections.color.length);
    const mats = entries.map(m => lightGrid ? gridLit(propMaterial(m, texture, true, colors), null, materialShading(m, texture), atlas) : propMaterial(m, texture, false, colors));
    const noMat = lightGrid ? gridLit(propMaterial(null, null, true), null, null, atlas) : propMaterial(null, null, false);
    const surfaceMat = k => k < 0 ? noMat : mats[k];
    const fallback = [];
    this.texture = texture; this.entries = entries;
    if (pj.sections) {
      const view = name => { const T = SECTION_TYPES[name]; return checkedView(T, bin, sec[name].offset, sec[name].length / T.BYTES_PER_ELEMENT, pj.file + ' ' + name); };
      const P = view('position'), N = view('normal'), U = view('uv'), I = view('index'), C = colors ? view('color') : null;
      this.arrays = { P, N, U, I, C };
      pj.models.forEach((model, mi) => {
        const list = byModel[mi];
        if (!list.length) return;
        if (!model.lods || !model.lods.length) { fallback.push(mi); return; }
        const lodSets = [[model.lods[0], this.high, 'high'], [model.lods[model.lods.length - 1], this.low, 'low']];
        for (const [lod, target, key] of lodSets) {
          const geo = new THREE.BufferGeometry();
          const v0 = lod.vertexStart, n = lod.vertexCount;
          geo.setAttribute('position', new THREE.BufferAttribute(P.subarray(v0 * 3, (v0 + n) * 3), 3));
          geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(N.subarray(v0 * 4, (v0 + n) * 4), 4), 3, 0, true));
          geo.setAttribute('uv', new THREE.BufferAttribute(U.subarray(v0 * 2, (v0 + n) * 2), 2));
          if (C) geo.setAttribute('color', new THREE.BufferAttribute(C.subarray(v0 * 4, (v0 + n) * 4), 4, true));
          geo.setIndex(new THREE.BufferAttribute(I.subarray(lod.indexStart, lod.indexStart + lod.indexCount), 1));
          if (atlas) setInstanceLighting(geo, atlas, list, samples, probeOf && list.map(i => probeOf[i]));
          const surfMats = [];
          lod.surfaces.forEach((s, k) => { geo.addGroup(s.indexStart, s.indexCount, k); surfMats.push(surfaceMat(s.material)); });
          const mesh = new THREE.InstancedMesh(geo, surfMats, list.length);
          mesh.name = model.name;
          list.forEach((i, k) => mesh.setMatrixAt(k, placement(inst, i * S, M)));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();                       // over all placements, for culling
          mesh.userData.model = model.name;
          target.add(mesh);
          this.counts[key].tris += list.length * lod.indexCount / 3;
          this.counts[key].draws += lod.surfaces.length;
        }
      });
    } else {
      pj.models.forEach((m, mi) => fallback.push(mi));        // format 1: placements only
    }
    this.modelCount = pj.models.length - fallback.length;
    this.fallbackModels = fallback.map(mi => pj.models[mi].name);

    // boxes: every placement ("boxes" mode) and the models without geometry (in the model modes)
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const B = new THREE.Matrix4(), C = new THREE.Matrix4();
    const boxes = (models, color, opacity) => {
      const list = [];
      for (const mi of models) for (const i of byModel[mi]) if (pj.models[mi].mins) list.push(i);
      const mesh = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color, transparent: true, opacity, depthWrite: false }), list.length);
      list.forEach((i, k) => {
        const m = pj.models[inst[i * S]];
        B.makeScale(Math.max(1, m.maxs[0] - m.mins[0]), Math.max(1, m.maxs[1] - m.mins[1]), Math.max(1, m.maxs[2] - m.mins[2]));
        C.makeTranslation((m.mins[0] + m.maxs[0]) / 2, (m.mins[1] + m.maxs[1]) / 2, (m.mins[2] + m.maxs[2]) / 2);
        mesh.setMatrixAt(k, placement(inst, i * S, M).multiply(C).multiply(B));
      });
      mesh.renderOrder = 1;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      return mesh;
    };
    const all = pj.models.map((m, mi) => mi);
    this.boxes = new THREE.Group();
    this.boxes.add(boxes(all.filter(mi => !FOLIAGE.test(pj.models[mi].name)), 0xd8d0c2, 0.45),
                   boxes(all.filter(mi => FOLIAGE.test(pj.models[mi].name)), 0x7fa86a, 0.18));
    this.counts.boxes.tris = this.instanceCount * 12;
    this.fallbackBoxes = boxes(fallback, 0xd8d0c2, 0.45);
    this.group.add(this.high, this.low, this.boxes, this.fallbackBoxes);
    this.buildMs = performance.now() - t0;
    this.setMode(this.modelCount ? 'high' : 'boxes');
  }

  /** off | boxes | high | low */
  setMode(mode) {
    if (!this.modelCount && (mode === 'high' || mode === 'low')) mode = 'boxes';
    this.mode = mode;
    this.high.visible = mode === 'high';
    this.low.visible = mode === 'low';
    this.boxes.visible = mode === 'boxes';
    this.fallbackBoxes.visible = mode === 'high' || mode === 'low';
    return mode;
  }

  /** triangles drawn for all placements in the current mode */
  get triangles() { return this.mode === 'off' ? 0 : this.counts[this.mode].tris; }
}
