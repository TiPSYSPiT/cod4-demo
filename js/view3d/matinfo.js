/* Material debug mode of the 3D view (?matinfo=1, off by default): hovering (or clicking, which pins it) a surface names its
 * material and its textures - colour, normal, specular and detail map, how the alpha is drawn - for precise reports of texture
 * problems. World surfaces and decals, static models, script models, player and weapon models. The materials carry what they
 * were made from in userData.matinfo (mapLoader.js, props.js, characters.js). */
import * as THREE from 'three';

const file = f => (f ? String(f).replace(/^_textures\//, '').replace(/\.webp$/, '') : '-');

/** what a material is made of, for the debug line (stored on the material: userData.matinfo) */
export function matInfo(kind, m, extra = {}) {
  if (!m) return { kind, name: '(no material)' };
  return Object.assign({ kind, name: m.name || m.material || '?', color: m.texture || null, normal: m.normalMap || null,
    specular: m.specularMap || null, detail: m.detailMap || null, blend: m.blend || null, alphaTest: m.alphaTest || null,
    guess: m.textureGuess || null }, extra);
}

export class MatInfo {
  /** view: the View3D; roots(): the objects to pick from */
  constructor(view, dom, roots) {
    this.view = view;
    this.roots = roots;
    this.ray = new THREE.Raycaster();
    this.box = document.createElement('div');
    this.box.className = 'audit-info matinfo';
    this.box.textContent = 'Material info: hover a surface (click pins it)';
    view.stage.append(this.box);
    this.pinned = false;
    this.last = 0;
    this.onMove = e => {
      if (this.pinned) return;
      const now = performance.now();
      if (now - this.last < 120) return;           // (a ray through the whole world: not every event)
      this.last = now;
      this.show(e, dom);
    };
    this.onClick = e => { this.pinned = !this.pinned || !this.show(e, dom); if (this.pinned) this.show(e, dom); };
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('click', this.onClick);
    this.dispose = () => { dom.removeEventListener('pointermove', this.onMove); dom.removeEventListener('click', this.onClick); this.box.remove(); };
  }

  /** the surface under the pointer -> its line in the box; -> whether something was hit */
  show(e, dom) {
    const r = dom.getBoundingClientRect(), v = this.view;
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), v.camera);
    // (a decal lies on the surface under it: every material within a unit of the first one is named, the nearest first)
    const found = [];
    for (const h of this.ray.intersectObjects(this.roots().filter(Boolean), true)) {
      const o = h.object;
      if (!o.visible || !o.isMesh) continue;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const m = h.face && h.face.materialIndex != null ? mats[h.face.materialIndex] : mats[0];
      if (!m || !m.visible || !m.userData.matinfo) continue;
      if (found.length && h.distance - found[0].d > 1) break;
      if (!found.some(f => f.i === m.userData.matinfo)) found.push({ d: h.distance, i: m.userData.matinfo });
    }
    if (found.length) {
      found.sort((a, b) => (b.i.kind === 'decal') - (a.i.kind === 'decal'));
      this.box.textContent = '';
      found.forEach((f, k) => {
        const i = f.i, b = document.createElement('b');
        b.textContent = (k ? ' | ' : '') + i.kind + (i.model ? ' ' + i.model : '') + ': ' + i.name;
        const alpha = i.alpha ? 'alpha ' + i.alpha : i.alphaTest ? 'alpha test ' + i.alphaTest : '';
        this.box.append(b, ' - colour ' + file(i.color) + (i.guess ? ' (matched by name)' : '') + ' · normal ' + file(i.normal) + ' · specular ' + file(i.specular) +
          (i.detail ? ' · detail ' + file(i.detail) : '') + (i.blend ? ' · blend ' + i.blend : '') + (alpha ? ' · ' + alpha : ''));
      });
      if (this.pinned) this.box.append(' (pinned)');
      return true;
    }
    this.box.textContent = 'Material info: nothing under the pointer';
    return false;
  }
}
