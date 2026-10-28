/* Loads the exported map (maps3d/<map>/, written by tools/export/export_maps.py) into three.js
 * objects: the textured, lightmapped world, the props (props.js) and the objectives.
 * Without exported data the minimap image becomes a ground plane (or a grid). CoD world
 * coordinates stay as they are (+Z up); the camera's up vector is Z. */
import * as THREE from 'three';
import { blendOptions, isMultiply } from './blend.js';
import { fetchJSON, fetchBinary, checkedView, dataUrl } from './data.js';
import { Props } from './props.js';
import { LightGrid, ProbeSet, materialShading, gameWorld, setLights } from './lighting.js';

const C4 = window.C4;
const BASE = 'maps3d/';
const LIGHTMAP_SCALE = 2.0;          // the composite lightmap (scene lighting, blended decals): x 2
let manifest = null;

/** maps3d/index.json (cached); null when there is none */
async function loadManifest() {
  if (manifest !== null) return manifest;
  try { manifest = await fetchJSON(BASE + 'index.json', { cache: 'no-cache' }); } catch (err) { console.warn('maps3d/index.json:', err.message); manifest = { maps: {} }; }
  return manifest;
}

/** raw map name of the demo -> the exported map to use (exact name, else the registry alias) */
export async function resolveMap(raw) {
  const m = await loadManifest();
  const name = String(raw || '').toLowerCase();
  if (m.maps[name]) return name;
  const key = C4.maps && C4.maps.resolve(name);
  return key && m.maps[key] ? key : null;
}

const ARRAYS = { float32: Float32Array, int8: Int8Array, uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array };
/** a layout entry {type, offset, length (bytes)} of world.bin as a typed array (checked: data.js) */
function view(buf, a, what = 'world.bin') { const T = ARRAYS[a.type]; return checkedView(T, buf, a.offset, a.length / T.BYTES_PER_ELEMENT, what); }

/** the textures that failed to load (maps3d files): drawn neutral grey, listed here and warned about */
export const failedTextures = new Set();
let grey = null;
/** load a maps3d texture; on an error the texture gets a neutral grey 1 x 1 image instead of none - three
 *  draws a texture without an image black - and a console warning */
export function loadTexture(url, loader = new THREE.TextureLoader()) {
  const t = loader.load(dataUrl(url), undefined, undefined, () => {
    failedTextures.add(url);
    console.warn('texture not loaded - drawn neutral grey:', url);
    if (!grey) { grey = document.createElement('canvas'); grey.width = grey.height = 1; const g = grey.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 1, 1); }
    t.image = grey; t.needsUpdate = true;
  });
  return t;
}

/** material of one draw group (see world.json groups) */
function makeMaterial(g, tex, lightmaps) {
  const opts = { side: g.doubleSided ? THREE.DoubleSide : THREE.FrontSide };
  if (tex) opts.map = tex;
  else opts.color = new THREE.Color(g.color || (g.water ? '#3c5560' : '#8a8a84'));
  const lm = g.lightmap >= 0 ? lightmaps[g.lightmap] : null;
  const multiply = isMultiply(g.blend);
  if (lm && !multiply) { opts.lightMap = lm; opts.lightMapIntensity = LIGHTMAP_SCALE * Math.PI; }
  if (g.alphaTest && g.textureAlpha && !g.vertexAlpha) opts.alphaTest = g.alphaTest === 'gt0' ? 0.05 : 0.5;
  if (g.water) { opts.transparent = true; opts.opacity = 0.75; opts.depthWrite = false; }
  // the game's blend factors (blend.js): multiply decals (also the 2x ones, destcolor/srccolor), additive
  // light shafts (invdestcolor/one), premultiplied decals; the framebuffer's alpha stays 1
  Object.assign(opts, blendOptions(g.blend));
  if (g.decal || g.blend) { opts.polygonOffset = true; opts.polygonOffsetFactor = -1; opts.polygonOffsetUnits = -4; }
  const mat = new THREE.MeshBasicMaterial(opts);
  mat.name = g.material;
  // a shadow caster's material: only in the shadow maps (shadows.js draws it with a depth material)
  if (g.shadowOnly) mat.visible = false;
  // a material the game's colour pass never draws (no lit / emissive technique, e.g. wc/caulk_shadow): not
  // drawn, and no shadow either (shadows.js)
  if (g.noDraw) { mat.visible = false; mat.userData.noDraw = true; }
  return mat;
}

/** the alpha-tested world shaders' cut (lm_*_t0*) for a material without the game's world shading:
 *  colour map alpha x vertex alpha >= 0.5, opaque there (lighting.js gameWorld does the same) */
function vertexAlphaCut(mat) {
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 color;
varying float vVa;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vVa = color.a;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vVa;`)
      .replace('#include <opaque_fragment>', `if (diffuseColor.a * vVa < 0.5) discard;
diffuseColor.a = 1.0;
#include <opaque_fragment>`);
  };
  mat.needsUpdate = true;
  return mat;
}

/** the world mesh + props + objectives of an exported map -> {group, info, bounds} */
export async function loadWorld(mapName, { onProgress, props = true, gameLighting = true } = {}) {
  const t0 = performance.now();
  const dir = BASE + mapName + '/';
  const info = await fetchJSON(dir + 'world.json');
  // the length world.bin must have: the end of its last array (the layout); checked on arrival (data.js)
  const expected = Math.max(...Object.values(info.layout).map(a => a.offset + a.length));
  const buf = await fetchBinary(dir + info.file, { expected, onProgress });
  const L = info.layout;
  const geo = new THREE.BufferGeometry();
  // the world is drawn unlit (albedo x baked lightmap, as the game does); normals (int8 x4) and the
  // reflection probe per vertex are only needed for the reflections of materials with a specular map
  geo.setAttribute('position', new THREE.BufferAttribute(view(buf, L.position), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(view(buf, L.uv), 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(view(buf, L.uv2), 2, true));
  // the game's world shading (lighting.js gameWorld): normals, vertex colours, the reflection probe
  // and the primary light of each vertex
  const gameWorldOn = gameLighting && L.probe && L.light && info.gameLightmaps && info.gameLightmaps.length;
  // the vertex colours: the world shading multiplies by them, the alpha-tested decals fade by their alpha
  geo.setAttribute('color', new THREE.BufferAttribute(view(buf, L.color), 4, true));
  if (gameWorldOn) {
    geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(view(buf, L.normal), 4), 3, 0, true));
    geo.setAttribute('probe', new THREE.BufferAttribute(view(buf, L.probe), 1));
    geo.setAttribute('light', new THREE.BufferAttribute(view(buf, L.light), 1));
  }
  geo.setIndex(new THREE.BufferAttribute(view(buf, L.index), 1));
  geo.computeBoundingSphere();

  const loader = new THREE.TextureLoader();
  const texCache = new Map();
  const texture = (file, repeat) => {
    if (!file) return null;
    if (texCache.has(file)) return texCache.get(file);
    const t = loadTexture(BASE + file, loader);
    t.flipY = false;                                        // D3D texture coordinates: v = 0 at the top
    t.colorSpace = THREE.NoColorSpace;                      // gamma-space math, like the game
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
    texCache.set(file, t);
    return t;
  };
  const lightmaps = (info.lightmaps || []).map(f => {
    const t = f ? texture(mapName + '/' + f, false) : null;
    if (t) t.channel = 1;                                   // sample with the lightmap coordinates (uv1)
    return t;
  });
  // the game's lightmaps (secondary: both layers with the light direction in alpha, primary: the sun's
  // visibility), read by the game's formula
  const gameLms = (gameWorldOn ? info.gameLightmaps : []).map(e => e && {
    secondary: texture(mapName + '/' + e.secondary, false), primary: e.primary ? texture(mapName + '/' + e.primary, false) : null });
  // the map's primary lights (the sun, lamps) for the world and model shaders
  if (gameLighting) setLights(info.lights, info.sun && info.sun.index != null ? info.sun.index : 1);
  const materials = [];
  let skipped = 0;
  for (const g of info.groups) {
    // nothing to draw: untextured decals / blended surfaces (portal glows, signs whose image is unknown)
    if (!g.texture && !g.water && (g.decal || g.blend)) { skipped++; continue; }
    geo.addGroup(g.start, g.count, materials.length);
    // the game's lightmap shading also for alpha-blended surfaces (decals, signs, posters): the older
    // lightmap<N>.webp does not match the lightmap coordinates any more (black patches); multiply and
    // additive blends stay unlit
    const game = gameWorldOn && g.lightmap >= 0 && (!g.blend || g.blend === 'one/invsrcalpha') && !g.water && gameLms[g.lightmap];
    const m = makeMaterial(g, texture(g.texture, true), game ? [] : lightmaps);
    if (game) gameWorld(m, gameLms[g.lightmap], materialShading(g, f => texture(f, true)), !!g.vertexAlpha);
    else if (g.vertexAlpha) vertexAlphaCut(m);
    // draw order: opaque, alpha tested, decals, blended
    m.userData.order = g.blend || g.water ? 3 : g.decal ? 2 : g.alphaTest ? 1 : 0;
    materials.push(m);
  }
  const mesh = new THREE.Mesh(geo, materials);
  mesh.name = 'world';
  mesh.matrixAutoUpdate = false;
  // groups sorted so transparent ones draw last (three sorts objects, not groups)
  geo.groups.sort((a, b) => materials[a.materialIndex].userData.order - materials[b.materialIndex].userData.order);
  const group = new THREE.Group();
  group.add(mesh);
  const out = { group, info, mesh, skippedGroups: skipped, props: null, sites: [] };
  out.worldMs = performance.now() - t0;
  // the light grid: the game's lighting of players and props (lighting.js)
  out.lightGrid = null;
  out.probes = null;
  if (gameLighting) {
    try { out.lightGrid = await LightGrid.load(dir, info.lightGrid, info.sight, info.lights); } catch (err) { console.warn('light grid not loaded:', err); }
    // the reflection probes (specular maps of the world, props and players)
    try { out.probes = await ProbeSet.load(dir, info.probes); } catch (err) { console.warn('reflection probes not loaded:', err); }
  }
  if (props) {
    const tp = performance.now();
    try { out.props = await Props.load(dir, f => texture(f, true), out.lightGrid); if (out.props) group.add(out.props.group); }
    catch (err) { console.warn('props not loaded:', err); }
    out.propsMs = performance.now() - tp;
  }
  try { out.sites = await loadSites(dir); } catch (err) { out.sites = []; }
  // the map's script models (destructible cars, ...: scriptModels.js)
  try {
    const ents = await fetchJSON(dir + 'entities.json');
    out.scriptModels = ents.scriptModels || [];
    // their collision (script_coll.bin: model space, float32 x 9 per triangle, then a uint8 surface type each)
    if (ents.collision && ents.collision.triangles) {
      const buf = await fetchBinary(dir + ents.collision.file).catch(err => { console.warn('script model collision:', err.message); return null; });
      const n = ents.collision.triangles;
      if (buf) out.scriptCollision = { models: ents.collision.models, P: checkedView(Float32Array, buf, 0, 9 * n, ents.collision.file),
        S: checkedView(Uint8Array, buf, 36 * n, n, ents.collision.file) };
    }
  } catch (err) { out.scriptModels = []; }
  return out;
}

/* ---------- objectives: S&D bomb sites (labels A / B) ---------- */
async function loadSites(dir) {
  const ej = await fetchJSON(dir + 'entities.json');
  const sites = [];
  for (const e of ej.objectives || []) {
    if (e.origin && e.targetname === 'bombzone' && e.label) sites.push({ label: e.label.replace(/^_/, '').toUpperCase(), origin: e.origin });
  }
  return sites;
}

/** fallback without exported geometry: the compass image as a ground plane (or a grid) */
export function groundPlane(match) {
  const R = match.rect, z = match.zRange[0] - 2;
  const group = new THREE.Group();
  const w = R.maxX - R.minX, h = R.maxY - R.minY;
  const geo = new THREE.PlaneGeometry(w, h);
  const mat = new THREE.MeshBasicMaterial({ color: 0x1b222c });
  const plane = new THREE.Mesh(geo, mat);
  plane.position.set((R.minX + R.maxX) / 2, (R.minY + R.maxY) / 2, z);
  group.add(plane);
  const img = match.mapEntry && match.mapEntry.image;
  if (img && match.calibrated) {
    new THREE.TextureLoader().load(C4.maps.IMAGE_DIR + img, t => {
      t.colorSpace = THREE.NoColorSpace;
      mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true;
    });
  }
  const grid = new THREE.GridHelper(Math.max(w, h), Math.round(Math.max(w, h) / 256), 0x3a4656, 0x252d38);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(plane.position.x, plane.position.y, z + 0.5);
  grid.material.transparent = true; grid.material.opacity = 0.35;
  group.add(grid);
  return { group, plane };
}
