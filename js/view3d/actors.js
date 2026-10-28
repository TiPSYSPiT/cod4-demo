/* Players in 3D: a capsule in the team colour (standing 72, crouched 50 units high, prone lying
 * along the view direction), an aim line from the eye with the real pitch, a ring for the
 * selected player and HTML name labels projected on top. Driven by Match.sampleAt - the same
 * positions the 2D view draws.
 * Mode "models": the player's real character (body + head from the demo's client state, see
 * characters.js) with a team-coloured ring at the feet, animated with the game's animations
 * (animator.js: idle / walk / run / sprint / crouch / crawl, deaths, bomb plants); without the
 * exported animations the static stance poses of Phase 1. The capsule stays as the pick target and
 * is drawn instead while a model loads, is missing or the player is stale. */
import * as THREE from 'three';
import { Character } from './characters.js';
import { Animator } from './animator.js';
import { Controllers } from './controllers.js';
import { setObjectLighting } from './lighting.js';
import { declutter } from './xray.js';

const C4 = window.C4;
const CFG = C4.mapConfig;
const RADIUS = 14;
const PRONE_R = 11;
export const EYE = { stand: 60, crouch: 40, prone: 11 };
const HEIGHT = { stand: 72, crouch: 50 };
const AIM_LEN = 90;

const D2R = Math.PI / 180;
const FOCUS_COLOR = new THREE.Color(0xff8a1f);   // the selected player's X-Ray silhouette (the accent)
/** CoD view angles -> unit forward vector (pitch > 0 looks down) */
export function forward(yaw, pitch, out = new THREE.Vector3()) {
  const cp = Math.cos(pitch * D2R);
  return out.set(cp * Math.cos(yaw * D2R), cp * Math.sin(yaw * D2R), -Math.sin(pitch * D2R));
}
export function stanceOf(s) { return s.prone ? 'prone' : s.crouch ? 'crouch' : 'stand'; }

/** world model of an internal weapon name with the table of weapons.json (ak47_silencer_mp ->
 *  weapon_ak47_silencer, gl_m16_mp -> the M16 with launcher); null for none / not drawn */
export function weaponModelName(table, name) {
  if (!table || !name) return null;
  const n = String(name).toLowerCase().replace(/_mp$/, '');
  let base, variant = 'model';
  if (n.startsWith('gl_')) { base = C4.weapons.baseWeapon(n.slice(3)); variant = 'gl'; }
  else {
    base = C4.weapons.baseWeapon(n);
    if (/_silencer/.test(n)) variant = 'silencer'; else if (/_gl(_|$)/.test(n)) variant = 'gl';
  }
  const w = table[base] || table[base.replace(/gold$/, '')];
  return w ? w[variant] || w.model : null;
}

export class Actors {
  constructor(scene, labelLayer, match, library, onNotice, anims) {
    this.scene = scene;
    this.library = library;
    this.anims = anims || null;                  // AnimationLibrary (Phase 2), loaded on first use
    this.animReady = false;
    this.animator = anims ? new Animator(match, anims) : null;
    this.controllers = anims ? new Controllers(match, anims) : null;   // the game's legs / torso yaw, pitch, lean
    this.corpses = new Map();                    // corpse id -> holder of its character (animator.corpsesAt)
    this.corpsePool = new Map();                 // body|head -> free corpse characters
    this.weaponModels = new Map();               // world model name -> loaded model | null (missing)
    this.weaponTable = null;
    this.onNotice = onNotice || (() => {});
    this.mode = 'simple';
    this.failed = new Map();           // model name -> reason
    this.requested = new Set();
    this.M = match;
    this.layer = labelLayer;
    this.root = new THREE.Group();
    this.root.name = 'players';
    scene.add(this.root);
    this.items = new Map();
    // one capsule per stance (CapsuleGeometry runs along Y, centred on the origin)
    this.geo = {
      stand: new THREE.CapsuleGeometry(RADIUS, HEIGHT.stand - 2 * RADIUS, 4, 12),
      crouch: new THREE.CapsuleGeometry(RADIUS, HEIGHT.crouch - 2 * RADIUS, 4, 12),
      prone: new THREE.CapsuleGeometry(PRONE_R, 66 - 2 * PRONE_R, 4, 12)
    };
    this.ringGeo = new THREE.RingGeometry(RADIUS + 6, RADIUS + 10, 32);
    this.teamRingGeo = new THREE.RingGeometry(13, 17, 28);
  }

  /** the map's light grid (lighting.js): characters are then lit like in the game */
  setLightGrid(grid) { this.lightGrid = grid || null; }
  /** the map's reflection probes (lighting.js ProbeSet): characters reflect the probe the game picks
   *  (the nearest probe of their DPVS cell) */
  setProbes(probes) { this.probes = probes || null; }

  /** light a character like the game: the light grid at its lighting origin - the origin raised by
   *  32 standing, 20 crouched, 12 prone (cg_players_mp.cpp) */
  lightCharacter(ch, x, y, z, stance) {
    if (!this.lightGrid) return;
    const L = ch.enableGridLighting();
    const s = ch._lgSample || (ch._lgSample = {});
    const lz = z + (stance === 'prone' ? 12 : stance === 'crouch' ? 20 : 32);
    if (this.probes) {
      // the probe of the lighting origin, looked up again after 16 units of movement
      const p = ch._lgProbeAt;
      if (!p || Math.abs(p[0] - x) + Math.abs(p[1] - y) + Math.abs(p[2] - lz) > 16) {
        ch._lgProbeAt = [x, y, lz];
        ch._lgProbe = this.probes.nearest(x, y, lz);
      }
      s.probe = ch._lgProbe;
    }
    if (this.lightGrid.sample(x, y, lz, s)) setObjectLighting(L, s);
  }

  /** 'simple' | 'models' */
  setMode(mode) {
    this.mode = mode === 'models' ? 'models' : 'simple';
    for (const it of this.items.values()) if (it.char) it.char.group.visible = false;
    for (const h of this.corpses.values()) if (h.char) h.char.group.visible = false;
    if (this.mode === 'models' && !this.weaponLoading) {
      this.weaponLoading = this.library.weaponTable().then(t => { this.weaponTable = t; if (this.onLoaded) this.onLoaded(); });
    }
    if (this.mode === 'models') this.loadAnimations();
  }

  /** the player animations of the demo (Models; the traced shots' hit boxes in any mode) -> Promise<bool> */
  loadAnimations() {
    if (!this.anims) return Promise.resolve(false);
    if (!this.animLoading) {
      this.anims.onLoaded = () => { if (this.onLoaded) this.onLoaded(); };   // a clip file loaded on demand
      // all clips the demo uses are loaded before the animations start: a clip loaded on demand in
      // the middle of playback would leave its player on the movement-based fallback for the frames
      // in between and the pose would jump back and forth
      this.animLoading = this.anims.load().then(ok => ok ? this.anims.preload(this.animator.usedClips()).then(() => true) : false).then(ok => {
        this.animReady = ok;
        if (!ok) console.warn('player animations not available - static stance poses are used');
        if (this.onLoaded) this.onLoaded();
        return ok;
      });
    }
    return this.animLoading;
  }

  /** body + head model names of client cl at time t (the demo's client state; while a player has
   *  no model - dead, spectating - the nearest known one) */
  modelsAt(cl, t) {
    const list = (this.M.d.playerModels || {})[cl];
    if (!list || !list.length) return null;
    // the body slot can briefly hold something else (view hands, a head, the bomb case): only
    // entries with a body_* model count
    const pick = e => {
      const names = [e.body, ...e.attach].filter(Boolean);
      const body = names.find(n => n.startsWith('body_'));
      return body ? { body, head: names.find(n => n.startsWith('head_')) || null } : null;
    };
    let best = null;
    for (const e of list) { if (e.t > t) break; best = pick(e) || best; }
    if (!best) for (const e of list) { best = pick(e); if (best) break; }
    return best;
  }

  /** the character of a holder (a player item, or a corpse) for the given models; loads them on
   *  first use; null while loading / when missing */
  character(it, models) {
    const key = models.body + '|' + (models.head || '');
    if (it.charKey === key) return it.char;
    if (it.char) { it.char.group.visible = false; }
    const cached = (it.chars || (it.chars = new Map())).get(key);
    if (cached) { it.char = cached; it.charKey = key; return cached; }
    if (it.loading === key) return null;
    const lib = this.library;
    // models already in memory: build the character now - a promise callback would come a frame
    // later and the capsule would show for that frame (e.g. a respawn with another class)
    const b0 = lib.loaded(models.body), h0 = models.head ? lib.loaded(models.head) : null;
    if (b0 && (!models.head || h0)) {
      const ch = new Character(b0, h0);
      ch.group.visible = false;
      this.root.add(ch.group);
      it.chars.set(key, ch);
      it.char = ch; it.charKey = key; it.loading = null;
      return ch;
    }
    it.loading = key;
    Promise.all([lib.load(models.body), models.head ? lib.load(models.head).catch(err => { this.fail(models.head, err); return null; }) : null])
      .then(([body, head]) => {
        const ch = new Character(body, head);
        ch.group.visible = false;
        this.root.add(ch.group);
        it.chars.set(key, ch);
        if (it.loading === key) { it.char = ch; it.charKey = key; it.loading = null; }
        if (this.onLoaded) this.onLoaded();
      })
      .catch(err => { this.fail(models.body, err); it.loading = null; it.charKey = key; it.char = null; });
    return null;
  }

  /** the loaded weapon model held with weapon index `index` at t (null while loading / none) */
  weaponAt(index, t) {
    const model = weaponModelName(this.weaponTable, this.M.weaponName(index, t));
    if (!model) return null;
    if (!this.weaponModels.has(model)) {
      this.weaponModels.set(model, undefined);
      this.library.load(model).then(m => { this.weaponModels.set(model, m); if (this.onLoaded) this.onLoaded(); })
        .catch(err => { this.weaponModels.set(model, null); console.warn('weapon model', model, err); });
    }
    return this.weaponModels.get(model) || null;
  }

  fail(name, err) {
    if (this.failed.has(name)) return;
    this.failed.set(name, err && err.message ? err.message : String(err));
    console.warn('character model', name, err);
    this.onNotice([...this.failed.keys()]);
  }

  item(cl) {
    let it = this.items.get(cl);
    if (it) return it;
    const color = new THREE.Color(this.M.color(cl));
    const body = new THREE.Mesh(this.geo.stand, new THREE.MeshLambertMaterial({ color, transparent: true }));
    const group = new THREE.Group();
    group.add(body);
    const aimGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const aim = new THREE.Line(aimGeo, new THREE.LineBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.35), transparent: true }));
    aim.frustumCulled = false;
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffb35c, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ring.renderOrder = 5;
    const fire = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff0b4 }));
    const label = document.createElement('div');
    label.className = 'p3-label';
    label.style.setProperty('--tc', '#' + color.getHexString());     // the name in the team colour (styles.css)
    // the team's shape (▲ the blue team, ◆ the red one) on the X-Ray badge: readable without the colours
    const team = (this.M.d.players.find(p => p.client === cl) || {}).team, app = this.M.app;
    if ((team === 'A' || team === 'B') && app) label.dataset.mark = team === app.blueTeam ? '▲' : '◆';
    this.layer.append(label);
    const teamRing = new THREE.Mesh(this.teamRingGeo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
    teamRing.renderOrder = 4;
    it = { cl, group, body, aim, ring, fire, label, color, teamRing, visible: false, pos: new THREE.Vector3(), eye: new THREE.Vector3(), sample: null };
    this.root.add(group, aim, ring, fire, teamRing);
    this.items.set(cl, it);
    return it;
  }

  /** place every player at time t; opts: {shown:Set, focus, hover, labels, lastKnown} */
  update(t, opts) {
    const M = this.M, fwd = new THREE.Vector3();
    for (const it of this.items.values()) it.visible = false;
    for (const cl of opts.shown) {
      const s = M.sampleAt(cl, t);
      if (!s) continue;
      const stale = s.age > CFG.STALE_MS;
      if (stale && (!opts.lastKnown || s.age > CFG.LAST_KNOWN_MAX_MS)) continue;
      const it = this.item(cl);
      it.visible = true;
      it.sample = s;
      it.stale = stale;
      const st = stanceOf(s);
      it.pos.set(s.x, s.y, s.z);
      forward(s.yaw, s.pitch, fwd);
      // body
      const b = it.body;
      b.geometry = this.geo[st];
      if (st === 'prone') {
        // lying along the view direction (capsule axis Y turned onto the yaw), centre behind the origin
        b.rotation.set(0, 0, s.yaw * D2R - Math.PI / 2);
        b.position.set(s.x - Math.cos(s.yaw * D2R) * 14, s.y - Math.sin(s.yaw * D2R) * 14, s.z + PRONE_R);
      } else {
        b.rotation.set(Math.PI / 2, 0, 0);
        b.position.set(s.x, s.y, s.z + HEIGHT[st] / 2);
      }
      const focus = cl === opts.focus, hover = cl === opts.hover;
      b.material.opacity = stale ? 0.35 : 1;
      b.material.wireframe = stale;
      b.material.emissive.set(hover || focus ? 0x333333 : 0x000000);
      // aim line from the eye
      const eyeH = s.ps && s.eyeHeight ? s.eyeHeight : EYE[st];
      it.eye.set(s.x, s.y, s.z + eyeH);
      const a = it.aim.geometry.attributes.position.array;
      a[0] = it.eye.x; a[1] = it.eye.y; a[2] = it.eye.z;
      a[3] = it.eye.x + fwd.x * AIM_LEN; a[4] = it.eye.y + fwd.y * AIM_LEN; a[5] = it.eye.z + fwd.z * AIM_LEN;
      it.aim.geometry.attributes.position.needsUpdate = true;
      it.aim.visible = !stale;
      it.fire.visible = s.firing && !stale && !this.realFlash;
      it.fire.position.set(it.eye.x + fwd.x * 34, it.eye.y + fwd.y * 34, it.eye.z - 8 + fwd.z * 34);
      // real model (mode "models"): placed at the feet, turned by the yaw, posed by stance and pitch
      let ch = null;
      if (this.mode === 'models' && !stale) {
        const models = this.modelsAt(cl, t);
        ch = models ? this.character(it, models) : null;
      }
      if (it.char && it.char !== ch) it.char.group.visible = false;
      if (ch) {
        ch.group.visible = true;
        ch.group.position.set(s.x, s.y, s.z);
        ch.group.rotation.set(0, 0, s.yaw * D2R);
        const layers = this.animReady ? this.animator.alive(cl, t, s, st) : null;
        it.animSource = layers && layers.length ? this.animator.source : 'pose';
        // the game's animation state comes with the game's angle controllers; the movement-based
        // fallback and the static poses bend the spine by the view pitch instead
        const ctrl = it.animSource === 'game' ? this.controllers.at(cl, t) : null;
        if (layers && layers.length) this.play(ch, layers, ctrl ? 0 : s.pitch, st);
        else ch.pose(st, s.pitch);
        if (ctrl) ch.applyControllers(ctrl);
        this.lightCharacter(ch, s.x, s.y, s.z, st);
        ch.setWeapon(this.weaponAt(s.weapon, t));
      }
      it.modelShown = !!ch;
      b.visible = !ch;                                      // the capsule stays the pick target
      it.teamRing.visible = !!ch;
      it.teamRing.position.set(s.x, s.y, s.z + 1);
      it.ring.visible = focus || hover;
      it.ring.position.set(s.x, s.y, s.z + 1.5);
      it.ring.material.color.set(focus ? 0xffb35c : 0xffffff);
      // label text (position is set in projectLabels)
      const name = M.name(cl) + (stale ? ' (' + Math.round(s.age / 1000) + 's ago)' : '');
      it.labelText = opts.labels || focus || hover ? name + (focus && !stale ? '  ·  ' + M.weaponLabel(s.weapon, t) : '') : '';
      it.label.classList.toggle('stale', stale);
      it.label.classList.toggle('focus', focus);
    }
    for (const it of this.items.values()) {
      it.group.visible = it.visible;
      if (!it.visible) {
        it.aim.visible = false; it.ring.visible = false; it.fire.visible = false; it.teamRing.visible = false;
        if (it.char) it.char.group.visible = false;
      }
    }
    this.updateCorpses(t, opts);
  }

  /** play animation layers [{key, weight, time}] on a character */
  play(ch, layers, pitch, stance) {
    const list = layers.map(l => ({ clip: this.anims.clip(l.key, ch, !!l.torso), weight: l.weight, time: l.time })).filter(l => l.clip);
    if (list.length) ch.animate(list, pitch, stance); else ch.pose(stance, pitch);
  }

  /** mode "models" with animations: the dead. The corpse entities of the demo play the death
   *  animation the server chose until the round ends; a kill whose corpse the demo does not hold
   *  falls with a death clip picked from the movement while the death markers are shown (opts.kills).
   *  Corpse characters are reused through a pool per body + head. */
  updateCorpses(t, opts) {
    const want = this.mode === 'models' && this.animReady ? this.animator.corpsesAt(t, opts.kills).filter(d => opts.shown.has(d.cl)) : [];
    const ids = new Set(want.map(d => d.id));
    for (const [id, h] of this.corpses) {
      if (ids.has(id)) continue;
      if (h.char) { h.char.group.visible = false; const p = this.corpsePool.get(h.charKey) || []; p.push(h.char); this.corpsePool.set(h.charKey, p); }
      this.corpses.delete(id);
    }
    for (const d of want) {
      const models = this.modelsAt(d.cl, d.t0);
      if (!models) continue;
      let h = this.corpses.get(d.id);
      if (!h) {
        h = {};
        const key = models.body + '|' + (models.head || ''), p = this.corpsePool.get(key);
        if (p && p.length) { h.char = p.pop(); h.charKey = key; h.chars = new Map([[key, h.char]]); }
        this.corpses.set(d.id, h);
      }
      const ch = this.character(h, models);
      h.shown = !!ch;
      if (!ch) continue;
      ch.group.visible = true;
      ch.group.position.set(d.x, d.y, d.z);
      ch.group.rotation.set(0, 0, d.yaw * D2R);
      this.play(ch, [{ key: d.key, weight: 1, time: d.time }], 0, 'stand');
      ch.setWeapon(null);
      this.lightCharacter(ch, d.x, d.y, d.z, 'prone');
    }
  }

  /** HTML labels above the heads (after the camera moved) */
  /** X-Ray (xray.js): the living players as drawn now - not a last known position, not the first-person
   *  camera's own player; the selected one in the accent colour -> [{cl, root, color, z}] */
  xrayTargets(hideClient, focus) {
    const out = [];
    for (const it of this.items.values()) {
      if (!it.visible || it.stale || it.cl === hideClient) continue;
      const root = it.modelShown && it.char ? it.char.group : it.body;
      if (root.visible) out.push({ cl: it.cl, root, color: it.cl === focus ? FOCUS_COLOR : it.color, z: it.pos.z });
    }
    return out;
  }

  /** X-Ray "Players + names": hidden = Map client -> nothing of him in sight (the name gets a badge), and
   *  the labels are kept apart (declutter); null: neither */
  setXrayHidden(hidden) {
    this.declutter = !!hidden;
    for (const it of this.items.values()) it.xrayHidden = !!(hidden && hidden.get(it.cl));
  }

  /** the labels shown at this camera: [{it, x, y (the bottom centre in px), depth}] - the view's labels and
   *  the video export's (exportVideo3d.js) take the same list */
  labelSpots(camera, w, h, hideClient) {
    const v = new THREE.Vector3(), out = [];
    for (const it of this.items.values()) {
      if (!it.visible || !it.labelText || it.cl === hideClient) continue;
      const top = it.sample && it.sample.prone ? 30 : it.sample && it.sample.crouch ? 58 : 80;
      v.set(it.pos.x, it.pos.y, it.pos.z + top).project(camera);
      if (!(v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1)) continue;
      out.push({ it, x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, depth: v.z });
    }
    return out;
  }

  /** HTML labels above the heads (after the camera moved); X-Ray "Players + names": overlapping labels
   *  moved apart (the selected player's first, then the nearest) */
  projectLabels(camera, w, h, hideClient) {
    const spots = this.labelSpots(camera, w, h, hideClient), shown = new Set();
    for (const sp of spots) {
      const it = sp.it;
      shown.add(it);
      if (it.label.textContent !== it.labelText) { it.label.textContent = it.labelText; it.labelSize = null; }
      it.label.classList.toggle('xray-hidden', !!it.xrayHidden);
    }
    for (const it of this.items.values()) {
      if (shown.has(it)) continue;
      it.label.style.display = 'none';
      it.label.classList.remove('xray-hidden');      // (no badge left for when the player shows again)
    }
    if (this.declutter && spots.length > 1) {
      for (const sp of spots) {
        const it = sp.it;
        it.label.style.display = '';
        // (the size is read once per text and badge state: no layout read every frame)
        const key = it.labelText + (it.xrayHidden ? '#' : '');
        if (!it.labelSize || it.labelSize.key !== key) it.labelSize = { key, w: it.label.offsetWidth, h: it.label.offsetHeight };
        Object.assign(sp, { w: it.labelSize.w, h: it.labelSize.h, rank: (it.label.classList.contains('focus') ? -2 : 0) + sp.depth });
      }
      declutter(spots);
    }
    for (const sp of spots) {
      const st = sp.it.label.style;
      st.display = '';
      st.left = sp.x.toFixed(1) + 'px';
      st.top = sp.y.toFixed(1) + 'px';
    }
  }

  /** the player under a screen point (NDC) - for picking with the mouse */
  pick(raycaster) {
    const bodies = [...this.items.values()].filter(it => it.visible).map(it => it.body);
    const hit = raycaster.intersectObjects(bodies, false)[0];
    if (!hit) return null;
    for (const it of this.items.values()) if (it.body === hit.object) return it.cl;
    return null;
  }

  /** hide a player completely (first-person camera: the followed player's own model) */
  /** where client cl's muzzle flash is played now (CG_FireWeapon: bolted to tag_flash): the held
   *  weapon model's tag_flash ({origin, axis: [forward, left, up]}); players drawn as capsules: 34
   *  units ahead of the eye along the view; null if the player is not drawn */
  muzzle(cl, tagName = 'tag_flash') {
    const it = this.items.get(cl);
    if (!it || !it.visible || it.stale || !it.sample) return null;
    const ch = it.char, w = ch && it.modelShown && ch.weapon;
    const tag = w && w.userData.model && w.userData.model.bones && w.userData.model.bones.find(b => b.name === tagName);
    if (tag) {
      w.updateWorldMatrix(true, false);
      const q = new THREE.Quaternion(...tag.quat), M = new THREE.Matrix4().compose(new THREE.Vector3(...tag.pos), q, new THREE.Vector3(1, 1, 1));
      M.premultiply(w.matrixWorld);
      const e = M.elements, n = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
      return { origin: [e[12], e[13], e[14]], axis: [n([e[0], e[1], e[2]]), n([e[4], e[5], e[6]]), n([e[8], e[9], e[10]])] };
    }
    const s = it.sample, f = forward(s.yaw, s.pitch), y = s.yaw * D2R;
    const left = [-Math.sin(y), Math.cos(y), 0];
    const up = [f.y * left[2] - f.z * left[1], f.z * left[0] - f.x * left[2], f.x * left[1] - f.y * left[0]];
    // capsules (or a weapon without the tag): ahead of the eye; the casings (tag_brass) beside the gun
    const d = tagName === 'tag_brass' ? 16 : 34, side = tagName === 'tag_brass' ? -4 : 0;
    return { origin: [it.eye.x + f.x * d + left[0] * side, it.eye.y + f.y * d + left[1] * side, it.eye.z - 8 + f.z * d], axis: [[f.x, f.y, f.z], left, up] };
  }

  hide(cl) {
    const it = this.items.get(cl);
    if (!it) return;
    it.group.visible = false; it.aim.visible = it.ring.visible = it.fire.visible = it.teamRing.visible = false;
    if (it.char) it.char.group.visible = false;
  }

  /** players drawn as models / as capsules (for the toolbar notice and the stats) */
  counts() {
    let models = 0, capsules = 0, triangles = 0, corpses = 0, gameState = 0;
    for (const it of this.items.values()) {
      if (!it.visible) continue;
      if (it.modelShown) { models++; triangles += it.char.triangles; if (it.animSource === 'game') gameState++; } else capsules++;
    }
    for (const h of this.corpses.values()) if (h.shown && h.char) { corpses++; triangles += h.char.triangles; }
    return { models, capsules, triangles, corpses, animated: this.animReady, gameState };
  }

  dispose() {
    for (const it of this.items.values()) { it.label.remove(); if (it.chars) for (const c of it.chars.values()) c.dispose(); }
    for (const h of this.corpses.values()) if (h.chars) for (const c of h.chars.values()) c.dispose();
    for (const p of this.corpsePool.values()) for (const c of p) c.dispose();
    this.scene.remove(this.root);
  }
}
