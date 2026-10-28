/* X-Ray (Display popover, key X): the living players behind walls, props and effects, in their team
 * colour - the selected player in the accent colour. Ported from cod2-demo (the same technique).
 * After the frame, two passes over the players only (one draw per mesh each):
 * 1. their visible surface - where they pass the depth test as drawn (LessEqual, pulled slightly forward)
 *    - marks the stencil; colour and depth unchanged. One occlusion query per player (WebGL2) says whether
 *    any of him is in sight: `hidden` for the name badge of mode "Players + names" (a frame late).
 * 2. their hidden parts - where they fail the depth test (GreaterDepth) and the stencil is not marked -
 *    as a translucent silhouette in the team colour with a brighter rim (a matcap), each pixel once; not the
 *    lowest FEET_BAND units of the player: boots reaching into the ground (slopes, terrain) fail the depth
 *    test as well, and a player in plain sight would get a tinted patch at his feet.
 * Visible players stay untouched, also where they cover themselves (an arm in front of the body).
 * Needs a stencil buffer (view3d.js creates the renderer with stencil: true). */
import * as THREE from 'three';

export const XRAY_MODES = [['off', 'Off'], ['players', 'Players'], ['names', 'Players + names']];
const FEET_BAND = 4;                 // units above the player's origin (his feet) without a silhouette

/** the rim: a matcap from 0.55 in the middle to 1 at the edge (times the team colour) */
function rimTexture() {
  const n = 64, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grad.addColorStop(0, 'rgb(140,140,140)');
  grad.addColorStop(0.7, 'rgb(170,170,170)');
  grad.addColorStop(1, 'rgb(255,255,255)');
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class XRay {
  constructor(renderer) {
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : null;
    this.queries = new Map();          // client -> {q, pending, hidden}
    this.mask = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4
    });
    this.rim = rimTexture();
    this.mats = new Map();
    this.feet = { uFeetZ: { value: 0 }, uBand: { value: FEET_BAND } };     // (shared by every silhouette material)
  }

  /** the silhouette material of a colour (only where the stencil is 0; it then counts up: once per pixel) */
  material(color) {
    const key = color.getHex();
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshMatcapMaterial({
        color, matcap: this.rim, transparent: true, opacity: 0.5, depthWrite: false, depthFunc: THREE.GreaterDepth, fog: false,
        stencilWrite: true, stencilRef: 0, stencilFunc: THREE.EqualStencilFunc, stencilZPass: THREE.IncrementStencilOp
      });
      // the feet band: the fragment's world height against the player's origin (uFeetZ, set per player)
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, this.feet);
        sh.vertexShader = 'varying float vXrZ;\n' + sh.vertexShader.replace('#include <project_vertex>',
          '#include <project_vertex>\n  vXrZ = ( modelMatrix * vec4( transformed, 1.0 ) ).z;');
        sh.fragmentShader = 'uniform float uFeetZ;\nuniform float uBand;\nvarying float vXrZ;\n' + sh.fragmentShader.replace('void main() {',
          'void main() {\n  if ( vXrZ < uFeetZ + uBand ) discard;');
      };
      m.customProgramCacheKey = () => 'xray-silhouette';
      this.mats.set(key, m);
    }
    return m;
  }

  /** the finished occlusion queries -> true when a player's hidden state changed (the view then draws again;
   *  called by its loop also while nothing else moves) */
  poll() {
    const gl = this.gl;
    let changed = false;
    if (!gl) return false;
    for (const Q of this.queries.values()) {
      if (!Q.pending || !gl.getQueryParameter(Q.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const hidden = !gl.getQueryParameter(Q.q, gl.QUERY_RESULT);
      Q.pending = false;
      if (hidden !== Q.hidden) { Q.hidden = hidden; changed = true; }
    }
    return changed;
  }

  /** client -> hidden (the last finished query) */
  hidden() {
    const out = new Map();
    for (const [cl, Q] of this.queries) out.set(cl, Q.hidden);
    return out;
  }

  /** targets: [{cl, root (the player's drawn object), color, z (his origin: the feet)}]; the hidden state: hidden() */
  render(camera, targets) {
    const r = this.renderer, gl = this.gl;
    this.poll();
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.clearStencil();
    const swapped = [];
    const use = (root, m) => root.traverse(o => { if (o.isMesh && o.visible) { swapped.push([o, o.material]); o.material = m; } });
    const restore = () => { for (const [o, m] of swapped) o.material = m; swapped.length = 0; };
    // 1. the visible surfaces -> stencil, and whether anything of the player is in sight
    for (const p of targets) {
      let Q = this.queries.get(p.cl);
      if (gl && !Q) this.queries.set(p.cl, Q = { q: gl.createQuery(), pending: false, hidden: false });
      use(p.root, this.mask);
      const ask = Q && !Q.pending;
      if (ask) gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, Q.q);
      r.render(p.root, camera);
      if (ask) { gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE); Q.pending = true; }
      restore();
    }
    // 2. the hidden parts
    for (const p of targets) {
      this.feet.uFeetZ.value = p.z;
      use(p.root, this.material(p.color));
      r.render(p.root, camera);
      restore();
    }
    r.autoClear = autoClear;
  }

  dispose() {
    if (this.gl) for (const Q of this.queries.values()) this.gl.deleteQuery(Q.q);
    this.queries.clear();
    this.mask.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.rim.dispose();
  }
}

/** labels that overlap: each box {x, y (the bottom centre), w, h, rank (lower: placed first)} gets a new y -
 *  moved up until it is free of the boxes placed before it (at most `tries` steps). Used by the view's
 *  labels (actors.js) and the video export (exportVideo3d.js), so both look the same. */
export function declutter(boxes, gap = 2, tries = 6) {
  const placed = [];
  for (const b of [...boxes].sort((a, c) => a.rank - c.rank)) {
    for (let k = 0; k < tries; k++) {
      const hit = placed.find(o => Math.abs(o.x - b.x) * 2 < o.w + b.w + gap && b.y > o.y - o.h - gap && b.y - b.h - gap < o.y);
      if (!hit) break;
      b.y = hit.y - hit.h - gap;                // just above the label it touches
    }
    placed.push(b);
  }
  return boxes;
}
