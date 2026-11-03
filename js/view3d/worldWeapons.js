/* The weapons in the world besides the players' hands: the dropped weapons (CG_Item: DemoData.items, the ET_ITEM
 * entities - the weapon's world model where the server has it lying, index % 128 = the weapon) and the thrown
 * grenades in flight (CG_Missile: the weapon file's projectileModel at the missile's trajectory, turning by its
 * angular trajectory - G_FireGrenade's spin, slowed at each bounce). Models: maps3d/_characters (the world weapon
 * models of weapons.json, the projectile models of viewmodels.json), lit by the light grid like the players.
 * Positions: the trajectory of the state valid at t (BG_EvaluateTrajectory); a lying weapon the server moves by
 * physics comes as one state per snapshot - drawn between them. */
import * as THREE from 'three';
import { objectLighting, setObjectLighting, gridLit } from './lighting.js';
import { SHADOW_LAYER } from './shadows.js';
import { evaluateTrajectory } from './scriptModels.js';
import { weaponModelName } from './actors.js';

const EF_NODRAW = 0x20;
const GRAVITY = 800;                     // g_gravity (the grenades' TR_GRAVITY)
const HOLD_MS = 120;                     // a record stays drawn this long past its last snapshot

/** AnglesToAxis (pitch, yaw, roll degrees) at origin -> matrix */
function placement(a, o, out) {
  const r = Math.PI / 180, p = a[0] * r, y = a[1] * r, rl = a[2] * r;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(rl), cr = Math.cos(rl);
  const f = [cp * cy, cp * sy, -sp], l = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp], u = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  return out.set(f[0], l[0], u[0], o[0], f[1], l[1], u[1], o[1], f[2], l[2], u[2], o[2], 0, 0, 0, 1);
}

export class WorldWeapons {
  /** M: the match; library: CharacterLibrary; weaponTable(): weapons.json's table (actors.js) or null;
   *  projectiles: weapon name -> projectileModel (viewmodels.json) */
  constructor(M, library, lightGrid, weaponTable, onChange) {
    this.M = M;
    this.library = library;
    this.lightGrid = lightGrid;
    this.weaponTable = weaponTable;
    this.onChange = onChange;
    this.group = new THREE.Group();
    this.group.name = 'world weapons';
    this.items = M.d.items || [];
    this.grenades = (M.grenades || []).filter(gr => gr.g.segments && gr.g.segments.length);
    this.projectiles = null;
    library.viewModels().then(t => {
      this.projectiles = {};
      for (const [n, w] of Object.entries((t && t.weapons) || {})) if (w.params && w.params.projectileModel) this.projectiles[n] = w.params.projectileModel;
      if (this.onChange) this.onChange();
    }).catch(() => { this.projectiles = {}; });
    this.pool = new Map();                 // model name -> [entry ...]
    this.used = new Map();
    this.tmpM = new THREE.Matrix4();
    this.enabled = true;
  }

  /** the drawn weapons at t */
  update(t) {
    for (const list of this.pool.values()) for (const e of list) e.mesh.visible = false;
    this.used.clear();
    this.count = 0;
    if (!this.enabled) return;
    const pos = [0, 0, 0], ang = [0, 0, 0];
    // the dropped weapons
    const table = this.weaponTable();
    if (table) {
      for (const it of this.items) {
        if (t < it.t0 || t > it.t1 + HOLD_MS) continue;
        const S = it.states;
        let i = S.length - 1;
        while (i > 0 && S[i][0] > t) i--;
        const s = S[i];
        if (s[13] & EF_NODRAW) continue;
        const name = weaponModelName(table, it.weapon);
        if (!name) continue;
        evaluateTrajectory(s[2], s[3], 0, [s[4], s[5], s[6]], [s[7], s[8], s[9]], t, pos);
        ang[0] = s[10]; ang[1] = s[11]; ang[2] = s[12];
        // (a weapon the server moves state by state: between this snapshot's place and the next one's)
        const n = S[i + 1];
        if (n && (s[2] === 1 || s[2] === 8) && n[0] - s[0] <= 100 && t > s[0]) {
          const f = (t - s[0]) / (n[0] - s[0]);
          for (let k = 0; k < 3; k++) { pos[k] += (n[4 + k] - s[4 + k]) * f; let d = n[10 + k] - s[10 + k]; d -= Math.round(d / 360) * 360; ang[k] += d * f; }
        }
        this.place(name, pos, ang);
      }
    }
    // the grenades in flight
    if (this.projectiles) {
      for (const gr of this.grenades) {
        const g = gr.g, det = g.detonation;
        const start = g.launch != null ? g.launch : g.first;
        if (t < start || t > (det ? det.t : g.last + 50)) continue;
        const name = this.projectiles[g.weapon];
        if (!name) continue;
        let k = g.segments.length - 1;
        while (k > 0 && g.segments[k][0] > t) k--;
        const sg = g.segments[k];
        const dt = Math.max(0, (t - sg[0]) / 1000);
        if (sg[1] === 5) { pos[0] = sg[2] + sg[5] * dt; pos[1] = sg[3] + sg[6] * dt; pos[2] = sg[4] + sg[7] * dt - 0.5 * GRAVITY * dt * dt; }
        else { pos[0] = sg[2]; pos[1] = sg[3]; pos[2] = sg[4]; }
        if (sg.length > 8) {
          // the spin: apos TR_LINEAR (degrees per second), else its base
          const at = Math.max(0, (t - sg[9]) / 1000), lin = sg[8] === 2;
          for (let a = 0; a < 3; a++) ang[a] = sg[10 + a] + (lin ? sg[13 + a] * at : 0);
        } else ang[0] = ang[1] = ang[2] = 0;
        this.place(name, pos, ang);
      }
    }
  }

  place(name, pos, ang) {
    const model = this.library.loaded(name);
    if (!model) { this.load(name); return; }
    let list = this.pool.get(name);
    if (!list) this.pool.set(name, list = []);
    const n = this.used.get(name) || 0;
    this.used.set(name, n + 1);
    let e = list[n];
    if (!e) { e = this.mesh(model, name); list.push(e); }
    e.mesh.matrix.copy(placement(ang, pos, this.tmpM));
    e.mesh.matrixWorldNeedsUpdate = true;
    e.mesh.visible = true;
    this.count++;
    const at = e.at;
    if (this.lightGrid && (!at || Math.abs(at[0] - pos[0]) + Math.abs(at[1] - pos[1]) + Math.abs(at[2] - pos[2]) > 8)) {
      const s = {};
      if (this.lightGrid.sample(pos[0], pos[1], pos[2] + 8, s)) setObjectLighting(e.lg, s);
      e.at = pos.slice();
    }
  }

  load(name) {
    if (this.library.models.has(name)) return;
    this.library.available().then(idx => {
      if (idx && idx[name]) this.library.load(name).then(() => this.onChange && this.onChange()).catch(() => null);
    });
  }

  mesh(model, name) {
    const lg = objectLighting();
    const mesh = new THREE.Mesh(model.geo, model.mats.map((m, k) => gridLit(m.clone(), lg, model.shadings && model.shadings[k])));
    mesh.name = 'world weapon ' + name;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.layers.enable(SHADOW_LAYER);
    this.group.add(mesh);
    return { mesh, lg, at: null };
  }

  dispose() {
    for (const list of this.pool.values()) for (const { mesh } of list) for (const m of mesh.material) m.dispose();
    this.group.removeFromParent();
  }
}
