/* Audit mode of the 3D view (?audit=1): the assets coloured by the status tools/audit/asset_audit.py
 * wrote into maps3d/<map>/audit.json - props per model, world surfaces per material, script models per
 * model, effect sprites per material - over their own colour map; a click names the asset, its status and issues
 * (docs/asset-audit.md). */
import * as THREE from 'three';
import { dataUrl } from './data.js';

export const AUDIT_COLORS = {
  fallback: '#e23b3b', 'no-material': '#d83cd8', 'missing-texture': '#f29a2e',
  'shadow-only': '#8a5cf0', 'non-render': '#3fc6e0', unsupported: '#e6d84a', ok: '#4caf50'
};

export class AuditView {
  /** -> AuditView or null when the map has no audit.json */
  static async load(dir) {
    try {
      const r = await fetch(dataUrl(dir + 'audit.json'), { cache: 'no-cache' });
      return r.ok ? new AuditView(await r.json()) : null;
    } catch (err) { return null; }
  }

  constructor(audit) {
    this.audit = audit;
    this.mats = new Map();                  // source material -> tinted material
  }

  /** {kind, name, status, issues} of an asset */
  entry(kind, name) {
    const table = { prop: this.audit.models, world: this.audit.world, script: this.audit.script, fx: this.audit.fxMaterials }[kind] || {};
    const e = table[name];
    return { kind, name, status: e ? e.status : 'unknown', issues: e ? e.issues : [] };
  }

  tinted(src, status, name, fx = false) {
    const key = src.uuid + ':' + status;
    let m = this.mats.get(key);
    if (!m) {
      // (an effect's sprites: its colour map, half transparent - their own alpha is in the vertex colours)
      const map = src.map || (src.uniforms && src.uniforms.uMap && src.uniforms.uMap.value) || null;
      m = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(AUDIT_COLORS[status] || '#9a9a9a'),
        side: src.side, alphaTest: fx ? 0.02 : src.alphaTest || 0, transparent: fx || !!src.transparent, opacity: fx ? 0.55 : 1,
        depthWrite: fx ? false : src.depthWrite, visible: src.visible });
      m.userData.audit = name;
      this.mats.set(key, m);
    }
    return m;
  }

  /** swap the materials of the assets under root (idempotent: also for script models drawn later) */
  apply(root) {
    root.traverse(o => {
      if (!o.isMesh || o.userData.audited) return;
      let kind = null, name = null;
      if (o.isInstancedMesh && o.userData.model) { kind = 'prop'; name = o.userData.model; }
      else if (o.name === 'world') kind = 'world';
      else if (o.name.startsWith('script model ')) { kind = 'script'; name = o.name.slice(13); }
      else if (o.name.startsWith('fx ') && !o.name.startsWith('fx model ')) { kind = 'fx'; name = o.name.slice(3); }
      if (!kind) return;
      o.userData.audited = kind;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const out = list.map(m => {
        const n = kind === 'world' ? m.name : name;
        const t = this.tinted(m, this.entry(kind, n).status, n, kind === 'fx');
        t.userData.audit = n;
        return t;
      });
      o.userData.auditName = name;
      o.material = Array.isArray(o.material) ? out : out[0];
    });
  }

  /** the asset a ray hits first (world, props, script models under the roots) -> entry or null */
  pick(ray, roots) {
    const hits = ray.intersectObjects(Array.isArray(roots) ? roots : [roots], true).filter(h => h.object.userData.audited && h.object.visible);
    for (const h of hits) {
      const o = h.object, kind = o.userData.audited;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const mat = h.face && h.face.materialIndex != null ? mats[h.face.materialIndex] : mats[0];
      if (mat && !mat.visible) continue;
      const name = kind === 'world' ? mat && mat.userData.audit : o.userData.auditName;
      if (name) return this.entry(kind, name);
    }
    return null;
  }

  /** the legend (status: colour) for the hint line */
  legend() {
    const c = {};
    for (const t of ['models', 'world', 'script', 'fxMaterials']) for (const e of Object.values(this.audit[t] || {})) c[e.status] = (c[e.status] || 0) + 1;
    return Object.keys(AUDIT_COLORS).filter(k => c[k]).map(k => k + ' ' + c[k]).join(' · ');
  }
}
