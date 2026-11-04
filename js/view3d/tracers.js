/* Bullet tracers in 3D, as the CoD4 client spawns and draws them (CG_SpawnTracer, CG_AddMovingTracer, CG_DrawTracer).
 *
 * With the client-side bullets of MP (sv_clientSideBullets) a client draws the tracers of
 *   - the other players' bullets the server reports as hits (EV_BULLET_HIT: BulletTrajectoryEffects - from the
 *     shooter's tag_flash to the impact, with the chance cg_tracerChance 0.2; never the local player's own), and
 *   - its own shots (DrawBulletImpacts: cg_firstPersonTracerChance 0.5, from the view model's tag_flash to the first
 *     hit of the bullet's trace) - here the player seen in first person, whose shots the effects trace (fx.js).
 * A tracer is a local entity: a point leaving the muzzle at cg_tracerSpeed (7500 units/s), gone when it reaches the
 * end; CG_AddMovingTracer draws the beam from it cg_tracerLength (160) ahead, never past the end, cg_tracerWidth (4)
 * wide (cg_tracerScale 1: no widening with the distance), with the additive material gfx_tracer (its image
 * tracer#0: maps3d/_textures/tracer_0.webp). The chance is decided per bullet by a hash, so pausing, seeking, any
 * speed and the video export show the same. Off by default (Display, Bullet tracers). */
import * as THREE from 'three';
import { loadTexture } from './mapLoader.js';

const P = { chance: 0.2, fpChance: 0.5, width: 4, speed: 7500, length: 160 };
const MAX = 96;                        // tracers drawn at once
const RANGE = 8192;                    // a bullet's longest path: the longest life is RANGE / speed

const hash01 = (a, b) => {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
};

export class Tracers {
  constructor(scene, M) {
    // the server's bullet hits: [t, x, y, z, dir, surface, weapon, flags, shooter] (fx3d.impacts, sorted)
    this.hits = ((M.d.fx3d && M.d.fx3d.impacts) || []).filter(r => r[8] < 64);
    this.times = Float64Array.from(this.hits, r => r[0]);
    this.enabled = false;
    const pos = new Float32Array(MAX * 4 * 3), uv = new Float32Array(MAX * 4 * 2), idx = [];
    for (let i = 0; i < MAX; i++) {
      // (the corners: back - side, back + side, front - side, front + side; the glow's u along, v across)
      uv.set([0, 0, 0, 1, 1, 0, 1, 1], i * 8);
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    const tex = loadTexture('maps3d/_textures/tracer_0.webp');
    tex.colorSpace = THREE.NoColorSpace;
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false, toneMapped: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** the tracers at time t for the camera; muzzleOf(cl) -> [x, y, z] of a shooter's tag_flash now or null;
   *  fp: the client seen in first person; own(fromT) -> [{t, start, end}] of his shots since fromT (fx.js) */
  update(t, camera, muzzleOf, fp, own) {
    let n = 0;
    if (this.enabled) {
      const pos = this.geo.attributes.position.array, cam = camera.position, life = RANGE * 1000 / P.speed;
      const add = (sx, sy, sz, ex, ey, ez, t0) => {
        let dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1) return;
        dx /= dist; dy /= dist; dz /= dist;
        // the point flown so far (gone at the end) and the beam ahead of it
        const travel = P.speed * (t - t0) / 1000;
        if (travel >= dist || travel < 0) return;
        const ahead = travel + Math.min(dist - travel, P.length);
        const ax = sx + dx * travel, ay = sy + dy * travel, az = sz + dz * travel;
        const bx = sx + dx * ahead, by = sy + dy * ahead, bz = sz + dz * ahead;
        // the side vector: across the beam, facing the camera
        const mx = (ax + bx) / 2 - cam.x, my = (ay + by) / 2 - cam.y, mz = (az + bz) / 2 - cam.z;
        let px = dy * mz - dz * my, py = dz * mx - dx * mz, pz = dx * my - dy * mx;
        const pl = Math.hypot(px, py, pz) || 1, w = P.width / 2;
        px = px / pl * w; py = py / pl * w; pz = pz / pl * w;
        pos.set([ax - px, ay - py, az - pz, ax + px, ay + py, az + pz, bx - px, by - py, bz - pz, bx + px, by + py, bz + pz], n * 12);
        n++;
      };
      let lo = 0, hi = this.times.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.times[m] < t - life) lo = m + 1; else hi = m; }
      for (let i = lo; i < this.hits.length && this.hits[i][0] <= t && n < MAX; i++) {
        const r = this.hits[i], cl = r[8];
        if (cl === fp || hash01(r[0], cl * 7919 + i) >= P.chance) continue;
        const mz = muzzleOf ? muzzleOf(cl) : null;
        if (mz) add(mz[0], mz[1], mz[2], r[1], r[2], r[3], r[0]);
      }
      if (fp != null && own) {
        for (const s of own(t - life)) {
          if (n >= MAX) break;
          if (hash01(s.t, fp * 104729 + 1) >= P.fpChance) continue;
          add(s.start[0], s.start[1], s.start[2], s.end[0], s.end[1], s.end[2], s.t);
        }
      }
      if (n) this.geo.attributes.position.needsUpdate = true;
    }
    this.geo.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
    return n;
  }

  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); if (this.mesh.material.map) this.mesh.material.map.dispose(); this.mesh.material.dispose(); }
}
