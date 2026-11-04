/* The map's intermission camera and hurt triggers in 3D (maps3d/<map>/entities.json, export_maps.py): the camera
 * (mp_global_intermission) as a small body with its view frustum along its angles, each trigger_hurt as its box
 * (edges, faintly filled) - analysis layers of the Layers panel (off by default), shown in 2D the same way. */
import * as THREE from 'three';

const D2R = Math.PI / 180;

export class MapMarks {
  constructor(scene, entities) {
    this.cams = new THREE.Group();
    this.hurt = new THREE.Group();
    this.cams.name = 'intermission cameras'; this.hurt.name = 'hurt triggers';
    this.cams.visible = this.hurt.visible = false;
    scene.add(this.cams, this.hurt);
    const E = entities || {};
    // the hurt triggers: their boxes
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.9 });
    const faceMat = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const box = new THREE.BoxGeometry(1, 1, 1), edges = new THREE.EdgesGeometry(box);
    for (const h of E.hurt || []) {
      const size = [0, 1, 2].map(i => Math.max(1, h.maxs[i] - h.mins[i])), c = [0, 1, 2].map(i => (h.mins[i] + h.maxs[i]) / 2);
      const face = new THREE.Mesh(box, faceMat), line = new THREE.LineSegments(edges, edgeMat);
      for (const o of [face, line]) { o.position.set(c[0], c[1], c[2]); o.scale.set(size[0], size[1], size[2]); o.renderOrder = 5; this.hurt.add(o); }
    }
    // the intermission camera: a box with the view frustum (65 degrees, 120 units)
    const camMat = new THREE.LineBasicMaterial({ color: 0xe6e6e6 });
    const L = 120, w = Math.tan(32.5 * D2R) * L, h = w * 0.75;
    const pts = [[0, 0, 0], [L, w, h], [0, 0, 0], [L, -w, h], [0, 0, 0], [L, w, -h], [0, 0, 0], [L, -w, -h],
      [L, w, h], [L, -w, h], [L, -w, h], [L, -w, -h], [L, -w, -h], [L, w, -h], [L, w, -h], [L, w, h]];
    const frustum = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    const body = new THREE.BoxGeometry(18, 12, 12);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0xe6e6e6 });
    for (const s of E.spawns || []) {
      if (s.classname !== 'mp_global_intermission' || !s.origin) continue;
      const g = new THREE.Group(), a = s.angles || [0, 0, 0];
      g.add(new THREE.LineSegments(frustum, camMat));
      const b = new THREE.Mesh(body, bodyMat); b.position.x = -9; g.add(b);
      g.position.set(s.origin[0], s.origin[1], s.origin[2]);
      g.quaternion.setFromEuler(new THREE.Euler((a[2] || 0) * D2R, (a[0] || 0) * D2R, (a[1] || 0) * D2R, 'ZYX'));
      this.cams.add(g);
    }
    this.mats = [edgeMat, faceMat, camMat, bodyMat];
    this.geos = [box, edges, frustum, body];
  }

  set(cams, hurt) { this.cams.visible = !!cams; this.hurt.visible = !!hurt; }

  dispose() {
    this.cams.removeFromParent(); this.hurt.removeFromParent();
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}
