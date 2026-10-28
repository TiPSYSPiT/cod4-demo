/* 3D effects from the shared match state: movement trails, kill lines + death markers,
 * grenade arcs and clouds, the bomb and the bomb-site labels. Same rules (and constants)
 * as the 2D view - only the current round is drawn. */
import * as THREE from 'three';
import '../c4/ui/killfeed.js';                     // C4.killfeed (a classic script, loaded here: see the file)

const C4 = window.C4;
const CFG = C4.mapConfig;
const MAX_LINE_VERTS = 20000;

/** a dynamic LineSegments with per-vertex RGBA colours, refilled every frame */
class LineBatch {
  constructor(scene, opts = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_LINE_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_LINE_VERTS * 4), 4).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: opts.depthTest !== false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder || 2;
    scene.add(this.mesh);
    this.n = 0;
    this.c = new THREE.Color();
  }
  begin() { this.n = 0; }
  seg(a, b, color, alphaA, alphaB = alphaA) {
    if (this.n + 2 > MAX_LINE_VERTS) return;
    const P = this.mesh.geometry.attributes.position.array, C = this.mesh.geometry.attributes.color.array, c = this.c.set(color);
    for (const [p, al] of [[a, alphaA], [b, alphaB]]) {
      P[this.n * 3] = p[0]; P[this.n * 3 + 1] = p[1]; P[this.n * 3 + 2] = p[2];
      C[this.n * 4] = c.r; C[this.n * 4 + 1] = c.g; C[this.n * 4 + 2] = c.b; C[this.n * 4 + 3] = al;
      this.n++;
    }
  }
  end() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.n);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

/** a pool of meshes created on demand, hidden when unused in a frame */
class Pool {
  constructor(scene, make) { this.scene = scene; this.make = make; this.items = []; this.used = 0; }
  begin() { this.used = 0; }
  next() {
    if (this.used === this.items.length) { const m = this.make(); this.scene.add(m); this.items.push(m); }
    const m = this.items[this.used++];
    m.visible = true;
    return m;
  }
  end() { for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false; }
}

export class Effects {
  constructor(scene, labelLayer, match) {
    this.M = match;
    this.scene = scene;
    this.trails = new LineBatch(scene);
    this.lines = new LineBatch(scene, { renderOrder: 3 });
    const sphere = new THREE.SphereGeometry(1, 20, 14);
    this.grenades = new Pool(scene, () => new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })));
    this.clouds = new Pool(scene, () => { const m = new THREE.Mesh(sphere, new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false })); m.renderOrder = 4; return m; });
    this.bomb = new THREE.Mesh(new THREE.BoxGeometry(14, 9, 5), new THREE.MeshBasicMaterial({ color: CFG.BOMB.color }));
    this.bomb.visible = false;
    this.bombRing = new THREE.Mesh(new THREE.RingGeometry(16, 20, 40), new THREE.MeshBasicMaterial({ color: CFG.BOMB.color, transparent: true, side: THREE.DoubleSide, depthTest: false }));
    this.bombRing.renderOrder = 6;
    this.bombRing.visible = false;
    this.blast = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, depthWrite: false }));
    this.blast.visible = false;
    scene.add(this.bomb, this.bombRing, this.blast);
    this.layer = labelLayer;
    this.siteLabels = [];
    this.markers = true;              // kill lines, death crosses and the bomb (the video export can hide them)
    this.killIcons = false;           // the weapon icon over each death marker (3D toolbar: Kill icons)
    this.killMarks = new Map();       // kill -> {el, pos, alpha}: the shown icon labels
  }

  /** bomb-site letters from the map entities */
  setSites(sites) {
    for (const s of this.siteLabels) s.el.remove();
    this.siteLabels = sites.map(s => {
      const el = document.createElement('div');
      el.className = 'p3-label site';
      el.textContent = s.label;
      this.layer.append(el);
      return { el, pos: new THREE.Vector3(s.origin[0], s.origin[1], s.origin[2] + 70) };
    });
  }

  update(t, R) {
    const M = this.M, o = R.opts, shown = R.shownPlayers(), ep = M.epochStart(t);
    // trails
    this.trails.begin();
    if (o.trails) {
      for (const cl of shown) {
        const col = M.color(cl);
        for (const seg of M.trailOf(cl, t)) {
          for (let i = 1; i < seg.length; i++) {
            const a = seg[i - 1], b = seg[i];
            this.trails.seg([a[0], a[1], a[2] + 4], [b[0], b[1], b[2] + 4], col, Math.max(0.05, 1 - a[3]) * 0.9, Math.max(0.05, 1 - b[3]) * 0.9);
          }
        }
      }
    }
    this.trails.end();
    // kill lines (eye of the killer -> chest of the victim), death crosses and their weapon icons
    this.lines.begin();
    const marks = new Set();
    for (const k of this.markers ? R.recentKills(t, CFG.DEATH_MARKER_MS) : []) {
      if (!shown.has(k.victim) && !shown.has(k.attacker)) continue;
      const fade = 1 - (t - k.t) / CFG.DEATH_MARKER_MS;
      const vp = M.deathPos(k);
      if (!vp) continue;
      const vz = vp[2] != null ? vp[2] : M.zRange[0];
      if (this.killIcons && shown.has(k.victim)) {
        let m = this.killMarks.get(k);
        if (!m) {
          m = { el: C4.killfeed.markNode(k), pos: new THREE.Vector3() };
          this.layer.append(m.el);
          this.killMarks.set(k, m);
        }
        m.pos.set(vp[0], vp[1], vz + 24);
        m.alpha = Math.min(1, fade * 3);
        marks.add(k);
      }
      if (o.killLines && !k.suicide && !k.world && k.attacker < 64) {
        const ap = M.attackerPos(k);
        if (ap) this.lines.seg([ap[0], ap[1], (ap[2] != null ? ap[2] : vz) + 56], [vp[0], vp[1], vz + 40], M.color(k.attacker), 0.95 * fade, 0.6 * fade);
      }
      if (shown.has(k.victim)) {
        const c = M.color(k.victim), s = 14, z = vz + 2;
        this.lines.seg([vp[0] - s, vp[1] - s, z], [vp[0] + s, vp[1] + s, z], c, fade);
        this.lines.seg([vp[0] - s, vp[1] + s, z], [vp[0] + s, vp[1] - s, z], c, fade);
      }
    }
    // grenade arcs
    this.grenades.begin();
    this.clouds.begin();
    for (const gr of M.grenades) {
      if (!o.grenadeKinds.has(gr.g.kind) || t < gr.start || t > gr.end || gr.start < ep) continue;
      const det = gr.g.detonation;
      if (!det || t < det.t) {
        let last = null;
        for (const p of gr.pts) {
          if (p[0] > t) break;
          if (last) this.lines.seg([last[1], last[2], last[3]], [p[1], p[2], p[3]], gr.cfg.color, 0.85);
          last = p;
        }
        if (last) {
          const m = this.grenades.next();
          m.position.set(last[1], last[2], last[3]);
          m.scale.setScalar(4);
          m.material.color.set(gr.cfg.color); m.material.opacity = 1;
        }
      } else {
        if (this.realFx) continue;                // the game's own explosion / smoke effects (fx.js) are drawn
        const age = t - det.t, fadeStart = gr.cfg.duration - gr.cfg.fade;
        const alpha = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / gr.cfg.fade);
        const m = this.clouds.next();
        m.position.set(det.x, det.y, det.z);
        if (gr.g.kind === 'smoke') {
          // a smoke cloud grows in the first 2 s
          const grow = Math.min(1, age / 2000);
          m.scale.set(gr.cfg.radius * (0.4 + 0.6 * grow), gr.cfg.radius * (0.4 + 0.6 * grow), gr.cfg.radius * 0.55 * (0.4 + 0.6 * grow));
          m.position.z = det.z + gr.cfg.radius * 0.25;
          m.material.color.set(0xc4c9cf); m.material.opacity = 0.82 * alpha;
        } else {
          const f = Math.min(1, age / 250);
          m.scale.setScalar(gr.cfg.radius * (0.3 + 0.7 * f));
          m.material.color.set(gr.cfg.color); m.material.opacity = 0.45 * alpha * (1 - 0.6 * f);
        }
      }
    }
    for (const [k, m] of this.killMarks) if (!marks.has(k)) { m.el.remove(); this.killMarks.delete(k); }
    this.grenades.end();
    this.clouds.end();
    this.lines.end();
    this.updateBomb(t);
  }

  updateBomb(t) {
    const M = this.M, e = M.bombAt(t), B = CFG.BOMB;
    this.bomb.visible = this.bombRing.visible = this.blast.visible = false;
    if (!e || !this.markers) return;
    let x, y, z;
    if (e.state === 'carried') {
      const s = M.sampleAt(e.carrier, t);
      if (!s || s.age > CFG.STALE_MS) return;
      x = s.x; y = s.y; z = s.z + (s.prone ? 30 : s.crouch ? 64 : 86);
    } else {
      if (e.x == null) return;
      x = e.x; y = e.y; z = (e.z != null ? e.z : M.zRange[0]) + 3;
    }
    if (e.state === 'exploded') {
      const age = t - e.t;
      if (age > B.explodedMs) return;
      this.blast.visible = true;
      this.blast.position.set(x, y, z);
      this.blast.scale.setScalar(40 + 360 * age / B.explodedMs);
      this.blast.material.opacity = 0.6 * (1 - age / B.explodedMs);
      return;
    }
    this.bomb.visible = true;
    this.bomb.position.set(x, y, z);
    this.bomb.material.color.set(e.state === 'defused' ? B.defusedColor : B.color);
    this.bomb.material.transparent = e.state === 'unknown';
    this.bomb.material.opacity = e.state === 'unknown' ? 0.45 : 1;
    if (e.state === 'planted') {
      const p = ((t - e.t) % B.pulseMs) / B.pulseMs;
      this.bombRing.visible = true;
      this.bombRing.position.set(x, y, z - 1);
      this.bombRing.scale.setScalar(1 + 2.5 * p);
      this.bombRing.material.opacity = 0.9 * (1 - p);
    }
  }

  projectLabels(camera, w, h) {
    const v = new THREE.Vector3();
    for (const m of this.killMarks.values()) {
      v.copy(m.pos).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      m.el.style.display = on ? '' : 'none';
      if (on) { m.el.style.left = ((v.x + 1) / 2 * w).toFixed(1) + 'px'; m.el.style.top = ((1 - v.y) / 2 * h).toFixed(1) + 'px'; m.el.style.opacity = m.alpha.toFixed(2); }
    }
    for (const s of this.siteLabels) {
      v.copy(s.pos).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      s.el.style.display = on ? '' : 'none';
      if (on) { s.el.style.left = ((v.x + 1) / 2 * w).toFixed(1) + 'px'; s.el.style.top = ((1 - v.y) / 2 * h).toFixed(1) + 'px'; }
    }
  }

  dispose() { for (const s of this.siteLabels) s.el.remove(); for (const m of this.killMarks.values()) m.el.remove(); }
}
