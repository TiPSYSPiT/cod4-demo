/* 3D view: the exported map (or the minimap as ground plane), players, effects and four camera
 * modes, drawn from the shared Replay state - so time, selection and filters carry over from 2D. */
import * as THREE from 'three';
import '../c4/ui/killfeed.js';                     // C4.killfeed (a classic script, loaded here: see the file)
import { loadWorld, groundPlane, resolveMap, loadTexture } from './mapLoader.js';
import { Actors, EYE, stanceOf, forward } from './actors.js';
import { Effects } from './effects.js';
import { Cameras, MODES } from './cameras.js';
import { AuditView } from './audit.js';
import { CharacterLibrary, AnimationLibrary } from './characters.js';
import { SUN, PROBES, installGameFog } from './lighting.js';
import { SunShadows, castShadows, STATIC_LAYER, DYNAMIC_LAYER } from './shadows.js';
import { GRAPHICS, graphics, urlGraphics, setGraphics } from './graphics.js';
import { DEFAULTS, DISPLAY_KEYS, displaySwitch, clearOptions } from '../app/defaults.js';
import { R_ZNEAR } from './pov.js';
import { XRay, XRAY_MODES } from './xray.js';
import { Sky } from './sky.js';
import { FxSystem, shotTracer } from './fx.js';
import { ScriptModels } from './scriptModels.js';
import { SoundSystem } from './sound.js';
import { ViewModel, isPromod } from './viewmodel.js';
import { MapMarks } from './mapMarks.js';
import { WorldWeapons } from './worldWeapons.js';
import { Tracers } from './tracers.js';
import { GameHud } from './hud.js';
import { InfoHint, fadeHint, holdHint } from '../app/infoHint.js';

const C4 = window.C4;
const { el, icon, switchRow, selectRow } = C4.ui;
const CFG = C4.mapConfig;
const CAM_KEY = 'cod4demo3d.camera2';          // the camera mode, stored only by the viewer's own choice (default: first person)
/** shared colour maps of the exported data (maps3d/_textures), D3D texture coordinates - the players', weapons' and
 *  script models' textures: mipmapped (three's default) and filtered anisotropically (no shimmer at grazing angles) */
const texCache = new Map();
let ANISOTROPY = 1;
function mapTexture(file) {
  if (!file) return null;
  if (!texCache.has(file)) {
    const t = loadTexture('maps3d/' + file);
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = ANISOTROPY;
    texCache.set(file, t);
  }
  return texCache.get(file);
}
const MODE_HELP = { orbit: 'Left drag: rotate · right drag: pan · wheel: zoom · click a player: select',
  free: 'Drag: look · W A S D: move · R / F: up / down · Shift: fast · wheel: speed',
  follow: 'Follows the selected player · drag: turn around them · wheel: distance',
  fp: 'Eyes of the selected player (their real view angles)' };
const stored = key => { try { return localStorage.getItem(key); } catch (err) { return null; } };
const store = (key, v) => { try { localStorage.setItem(key, v); } catch (err) { /* not stored */ } };
// (the options' defaults and keys: app/defaults.js)
const K = DISPLAY_KEYS, DISPLAY = DEFAULTS.display;
const BOB_MAX = 8;                               // bg_bobMax
// the players' view lines, the team rings at the models' feet, the enemies' names
const ACTOR_SWITCHES = ['viewLines', 'rings', 'enemyNames'];

export class View3D {
  constructor(replay, container) {
    this.key = '3d';
    this.R = replay;
    this.M = replay.match;
    this.visible = false;
    this.t = replay.pb.t;
    this.stage = el('div', { class: 'view-stage view3d' });
    this.stage.hidden = true;
    container.append(this.stage);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: true });   // (stencil: X-Ray)
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    ANISOTROPY = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;    // gamma-space colours, as the game
    this.stage.append(this.renderer.domElement);
    this.labels = el('div', { class: 'label-layer' });
    this.stage.append(this.labels);
    // the map's details (the rail's info popover; loading and warnings shown on the view: infoHint.js);
    // `hint` is its box (the export and the test tools check its "warn" class); the camera hint fades
    this.info = new InfoHint(this.stage, 'Map and data details');
    this.hint = this.info.box;
    this.info.set('Loading the 3D map …', { open: true });
    this.camHint = el('div', { class: 'cam-hint', hidden: true });
    this.stage.append(this.camHint);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b0c);
    this.camera = new THREE.PerspectiveCamera(60, 1, R_ZNEAR, 80000);
    const hemi = new THREE.HemisphereLight(0xdde6f0, 0x3a3328, 1.6);
    hemi.position.set(0, 0, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-0.4, -0.5, 1);
    scene.add(hemi, this.sun);
    // (the lights on the shadow passes' layers too: three.js gathers the lights a camera sees - without them each pass's
    // light setup differs from the frame's, and every lit material re-derived its program twice a frame)
    for (const l of [hemi, this.sun]) { l.layers.enable(STATIC_LAYER); l.layers.enable(DYNAMIC_LAYER); }
    this.characters = new CharacterLibrary(mapTexture);
    this.animations = new AnimationLibrary();
    this.actors = new Actors(scene, this.labels, this.M, this.characters, failed => this.showPlayerNotice(failed), this.animations);
    this.actors.onLoaded = () => { this.R.invalidate(); this.needsRender = true; };
    // the first-person weapon (viewmodel.js; graphics: First-person weapon)
    this.viewmodel = new ViewModel(this.characters);
    this.viewmodel.setSceneLights(hemi, this.sun);
    this.viewmodel.enabled = graphics().viewmodel !== 'off';
    this.viewmodel.crosshair = graphics().crosshair !== 'off';
    this.viewmodel.setMatch(this.M, this.animations);
    this.viewmodel.onLoaded = () => { this.needsRender = true; };
    this.playerNotice = el('div', { class: 'player-notice', hidden: true });
    this.stage.append(this.playerNotice);
    this.effects = new Effects(scene, this.labels, this.M);
    // the game's kill feed, lower left on the HUD canvas in every camera (js/c4/ui/killfeed.js; drawHud)
    this.feed = new C4.killfeed.Feed(this.M.d);
    this.feedAssets = null;
    C4.killfeed.ready().then(a => { this.feedAssets = a; this.needsRender = true; });
    this.needsRender = true;
    this.cams = new Cameras(this.camera, this.renderer.domElement, () => { this.needsRender = true; });
    this.xray = new XRay(this.renderer);
    this.buildToolbar();
    this.setXray(stored(K.xray) || DISPLAY.xray);
    this.setKillfeed(displaySwitch('killfeed'));
    this.setItems(displaySwitch('items'));
    this.setCasings(displaySwitch('casings'));
    for (const k of ACTOR_SWITCHES) this.setActorSwitch(k, displaySwitch(k));
    // the bullet tracers (tracers.js)
    this.tracers = new Tracers(this.scene, this.M);
    this.setTracers(displaySwitch('tracers'));
    // the game's HUD in first person (hud.js): a 2D canvas over the view (Tab's scoreboard: js/app/scoresOverlay.js)
    this.hud = new GameHud(this.M, null);
    this.hud.onChange = () => { this.needsRender = true; };
    this.hud.camera = this.camera;       // (the waypoints' place on the screen)
    this.characters.viewModels().then(t => { this.hud.table = t; this.needsRender = true; }).catch(() => null);
    this.hudCanvas = el('canvas', { class: 'hud-canvas', 'aria-hidden': 'true' });
    this.stage.append(this.hudCanvas);
    this.setHud(displaySwitch('hud'));
    // the start: first person without a selected player - the demo's own view (the recorder's eyes, or the player he
    // followed then); the viewer's own choice wins
    let mode = 'fp';
    try { const v = localStorage.getItem(CAM_KEY); if (MODES.some(m => m[0] === v)) mode = v; } catch (err) { /* default */ }
    this.setMode(mode);
    // the players: the character models by default (their cost is in the noise of the map's: docs/validation.md),
    // the capsules when chosen
    this.setPlayersMode(stored(K.players) || DISPLAY.players);

    // click a player to select them (not after a drag)
    let down = null;
    this.renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      // audit mode: name the asset under the cursor
      if (this.audit && this.world) {
        const a = this.audit.pick(ray, [this.world.group, this.scriptModels ? this.scriptModels.group : null, this.fx ? this.fx.group : null].filter(Boolean));
        this.auditInfo.textContent = a ? a.kind + ' ' + a.name + ': ' + a.status + (a.issues.length ? ' - ' + a.issues.join('; ') : '')
          : this.audit.legend();
      }
      const cl = this.actors.pick(ray);
      if (cl != null) this.R.setFocus(cl);
    });
    this.offFocus = replay.on(what => { if (what === 'focus') this.syncPlayerSelect(); });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.loop = this.loop.bind(this);
    this.last = null;
    this.load();
  }

  /* ---------- map ---------- */
  async load() {
    const M = this.M, map = M.d.meta.map;
    let name = null;
    try { name = await resolveMap(map); } catch (err) { name = null; }
    if (name) {
      try {
        // the graphics settings (graphics.js; ?lighting / ?fx / ?reflections / ?shadows override them)
        const gfx = graphics();
        // lighting 'scene': players and props lit by the scene lights instead of the game's light grid
        const gameLighting = gfx.lighting !== 'scene';
        const w = await loadWorld(name, { gameLighting, onProgress: f => { this.info.set('Loading the 3D map ' + name + ' … ' + Math.round(f * 100) + ' %', { open: true }); } });
        this.world = w;
        this.scene.add(w.group);
        this.scene.background = new THREE.Color(0x8ea2b4);
        // the map's sky (sky.js; the flat colour until it is loaded / without one)
        if (w.info.sky) Sky.load('maps3d/' + name + '/', w.info.sky).then(sky => {
          if (!sky || this.world !== w) return;
          this.sky = sky; this.scene.add(sky.mesh); this.needsRender = true;
        }).catch(err => console.warn('sky not loaded:', err));
        const b = w.info.bounds;
        const span = b ? Math.max(b.maxs[0] - b.mins[0], b.maxs[1] - b.mins[1]) : 8000;
        // the fog: with the game's lighting the fog the server sent (config string 9; most servers send
        // none), else a light distance haze
        const gfog = this.M.d.meta.fog;
        if (gameLighting) {
          installGameFog();
          this.scene.fog = gfog ? new THREE.Fog(new THREE.Color(...gfog.color), gfog.start, -gfog.density) : null;
        } else this.scene.fog = new THREE.Fog(0x8ea2b4, span * 0.9, span * 3);
        if (w.info.sun && w.info.sun.angles) {
          const [p, y] = w.info.sun.angles.map(a => a * Math.PI / 180);
          this.sun.position.set(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
          if (w.info.sun.sunColor) this.sun.color.setRGB(...w.info.sun.sunColor);
          // the game's sun (sunPosition / sunDiffuse of its shaders): direction towards the sun, colour
          // x (sunLight - ambientScale) x (1 - diffuseFraction); older exports: colour x sunLight
          SUN.dir.value.copy(this.sun.position).normalize();
          if (w.info.sun.dir) SUN.dir.value.set(...w.info.sun.dir).normalize();
          const k = w.info.sun.sunLight != null ? w.info.sun.sunLight : 1;
          if (w.info.sun.diffuse) SUN.color.value.setRGB(...w.info.sun.diffuse);
          else SUN.color.value.setRGB(...(w.info.sun.sunColor || [1, 1, 1]).map(c => c * k));
        }
        this.effects.setSites(w.sites || []);
        if (this.mapMarks) this.mapMarks.dispose();
        this.mapMarks = new MapMarks(this.scene, w.entities);
        // the script models: destructible cars and the gametypes' objects, with their state from the demo
        this.scriptModels = new ScriptModels(this.M, w.scriptModels, this.characters, w.lightGrid, () => { this.needsRender = true; }, w.props);
        this.scriptModels.setCollision(w.scriptCollision);
        this.scene.add(this.scriptModels.group);
        // the dropped weapons and the grenades in flight (worldWeapons.js)
        this.worldWeapons = new WorldWeapons(this.M, this.characters, w.lightGrid, () => this.actors.weaponTable, () => { this.needsRender = true; });
        this.worldWeapons.enabled = this.itemsOn !== false;
        this.scene.add(this.worldWeapons.group);
        // ?audit=1: the assets coloured by the audit's status (audit.js, tools/audit/asset_audit.py)
        if (new URLSearchParams(location.search).get('audit')) {
          AuditView.load('maps3d/' + name + '/').then(a => {
            if (!a || this.world !== w) return;
            this.audit = a;
            this.auditInfo = el('div', { class: 'audit-info' }, 'Audit: ' + a.legend() + ' - click an asset');
            this.stage.append(this.auditInfo);
            const apply = () => { a.apply(this.world.group); if (this.scriptModels) a.apply(this.scriptModels.group); if (this.fx) a.apply(this.fx.group); this.needsRender = true; };
            apply();
            this.auditTimer = setInterval(apply, 1000);         // script models appear later
          });
        }
        this.propsRow.hidden = !w.props;
        if (w.props) { this.propsSel.value = this.loadPropsMode(w.props); }
        this.mapName = name;
        this.actors.setLightGrid(w.lightGrid);
        // the effects (fx.js): the map's ambient effects (smoke, fire, dust from the createfx placements)
        // and the demo's own (explosions, smoke grenades, blood, muzzle flashes, scripted effects);
        // effects 'off': none, 'ambient' / 'demo': only those
        const fxOpt = gfx.fx;
        // the sounds (sound.js; ?sound=off: none): the world impacts come from the effects' traces
        if (new URLSearchParams(location.search).get('sound') !== 'off') {
          SoundSystem.load(name).then(snd => {
            if (!snd || this.world !== w) return;
            this.sound = snd;
            snd.setDemo(this.M, this.fx);
            // (the first-person reload sounds need the weapon files and the view animations' notes)
            this.viewmodel.ready.then(t => { if (t && t.clips && this.sound === snd) snd.addViewNotes(n => this.viewmodel.entry(n), t.clips); }).catch(() => null);
            snd.setVolume(this.soundVolume);
            this.soundRows.hidden = false;
            this.soundBtn.checked = this.soundWanted;
            const active = !navigator.userActivation || navigator.userActivation.hasBeenActive;
            if (this.soundWanted && active) this.setSound(true);
            else if (this.soundWanted) this.soundNote.textContent = 'starts with the first click';
            this.syncSoundHint();
          }).catch(err => console.warn('sounds not loaded:', err));
        }
        if (fxOpt !== 'off') {
          // (a Promod demo: the effects of Promod's weapon files - viewmodels.json, before the demo's effects are set up)
          Promise.all([FxSystem.load('maps3d/' + name + '/', w.lightGrid, w.info.lights, w.info.sun && w.info.sun.index != null ? w.info.sun.index : 1),
            isPromod(this.M) ? this.characters.viewModels() : null]).then(([fx, vmt]) => {
            if (!fx || this.world !== w) return;
            if (vmt && vmt.promod) fx.setWeaponOverrides(vmt.promod.weapons);
            fx.setModels(this.characters, () => { this.needsRender = true; });   // a debris model loaded
            fx.setDemo(this.M);
            fx.scripts = this.scriptModels;            // the cars stop bullets and debris (scriptModels.js trace)
            // the players' hit boxes in their animated pose (hitboxes.js): the animations in any player mode
            const A = this.actors;
            if (A.anims) {
              fx.animLoad = A.loadAnimations().catch(() => false);
              fx.hitBoxes.setAnimation({ animator: A.animator, anims: A.anims, controllers: A.controllers, ready: () => A.animReady });
            }
            fx.setWorld(w);
            this.fxOpts = { ambient: fxOpt !== 'demo', demo: fxOpt !== 'ambient' };
            this.fx = fx; this.scene.add(fx.group); this.needsRender = true;
            fx.casings = this.casingsOn !== false;
            if (this.sound) this.sound.setDemo(this.M, fx);
            this.effects.realFx = this.fxOpts.demo;     // no marker clouds where the real smoke is drawn
            this.actors.realFlash = this.fxOpts.demo;   // no marker sphere where the muzzle flash is drawn
          }).catch(err => console.warn('effects not loaded:', err));
        }
        // the reflection probes of the specular maps (graphics: reflections)
        PROBES.on.value = 0;
        if (w.probes) w.probes.activate(gfx.reflections !== 'off');
        this.actors.setProbes(w.probes);
        if (gameLighting) this.viewmodel.setLighting(w.lightGrid, w.probes);
        // the game's sun shadow map (shadows.js): world, props and players cast (graphics: sun shadows)
        if (w.lightGrid && gfx.shadows !== 'off') {
          this.shadows = this.shadows || new SunShadows(this.renderer);
          castShadows(w.mesh);
          if (w.props) { castShadows(w.props.high); castShadows(w.props.low); }
        }
        this.updateHint();
      } catch (err) {
        console.error(err);
        this.fallback('The 3D map data for ' + name + ' could not be loaded (' + err.message + ').');
      }
    } else {
      this.fallback('No 3D map data for ' + (map || 'this map') + ' - run tools/export/export_maps.py (see README).');
    }
    // start the camera over the area the players used
    const b = M.bbox;
    if (b) this.cams.frame({ mins: [b.minX, b.minY, M.zRange[0]], maxs: [b.maxX, b.maxY, M.zRange[1]] });
    // deep link ?cam=x,y,z,yaw,pitch: a free camera there (yaw / pitch in degrees)
    const cam = (new URLSearchParams(location.search).get('cam') || '').split(',').map(Number);
    if (cam.length === 5 && cam.every(Number.isFinite)) {
      this.cams.place(...cam);
      if (this.modeSel) this.modeSel.value = 'free';
      this.camHint.textContent = MODE_HELP.free;
      fadeHint(this.camHint);
    }
    this.needsRender = true;
    this.R.invalidate();
  }

  fallback(text) {
    const g = groundPlane(this.M);
    this.scene.add(g.group);
    this.scene.background = new THREE.Color(0x0b0b0c);
    this.propsRow.hidden = true;
    this.info.set(text + ' Showing the minimap as the ground.', { warn: true });
  }

  /* ---------- options: the Camera, Display and Graphics popovers of the rail (main.js: panels) ---------- */
  buildToolbar() {
    const SHORT = { orbit: 'Orbit', free: 'Free', follow: 'Follow', fp: '1st P.' };
    this.modeSel = C4.ui.segmented(MODES.map(([k, label]) => [k, SHORT[k] || label, label]), v => this.setMode(v, true));
    const playerSel = el('select', { onchange: e => { const v = e.target.value; if (v === '') { if (this.R.focus != null) this.R.setFocus(this.R.focus); } else if (Number(v) !== this.R.focus) this.R.setFocus(Number(v)); } });
    this.playerSel = playerSel;
    this.fillPlayerSelect();
    this.propsSel = el('select', { onchange: e => this.setPropsMode(e.target.value, true) },
      el('option', { value: 'high' }, 'Models'), el('option', { value: 'low' }, 'Models (low detail)'),
      el('option', { value: 'boxes' }, 'Boxes'), el('option', { value: 'off' }, 'Off'));
    this.propsRow = selectRow('Props', this.propsSel, "Static models (props): the real models (the game's detail level by distance, or the lowest everywhere), see-through boxes of their bounds (foliage in green), or none");
    this.propsRow.hidden = true;
    this.playersSel = el('select', { onchange: e => this.setPlayersMode(e.target.value, true) },
      el('option', { value: 'simple' }, 'Simple'), el('option', { value: 'models' }, 'Models'));
    // sound: on at 30 % unless the user chose otherwise (remembered); the browsers start audio only
    // after a click or key in the page - until then it waits (armed below), without an error
    this.soundWanted = displaySwitch('sound'); this.soundVolume = DISPLAY.volume;
    const savedVolume = stored(K.volume), volume = Number(savedVolume);
    if (savedVolume != null && savedVolume !== '' && volume >= 0 && volume <= 1) this.soundVolume = volume;
    this.soundBtn = el('input', { type: 'checkbox', onchange: e => this.setSound(e.target.checked, true) });
    this.soundNote = el('span');
    this.soundVol = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(this.soundVolume), title: 'Volume', 'aria-label': 'Volume',
      oninput: e => { this.soundVolume = Number(e.target.value); if (this.sound) this.sound.setVolume(this.soundVolume); store(K.volume, String(this.soundVolume)); } });
    this.soundRows = el('div', { class: 'grp', hidden: true }, el('h4', null, 'Sound'),
      switchRow('Game sounds', this.soundBtn, { title: 'The game\'s sounds with the replay: shots, impacts, footsteps, explosions, the announcer (heard at the camera)', small: this.soundNote }),
      el('label', { class: 'sw' }, el('span', { class: 'sw-l' }, 'Volume'), this.soundVol));
    this.xraySel = el('select', { onchange: e => this.setXray(e.target.value, true) }, ...XRAY_MODES.map(([v, label]) => el('option', { value: v }, label)));
    this.killfeedBox = el('input', { type: 'checkbox', onchange: e => this.setKillfeed(e.target.checked, true) });
    this.tracersBox = el('input', { type: 'checkbox', onchange: e => this.setTracers(e.target.checked, true) });
    this.itemsBox = el('input', { type: 'checkbox', onchange: e => this.setItems(e.target.checked, true) });
    this.casingsBox = el('input', { type: 'checkbox', onchange: e => this.setCasings(e.target.checked, true) });
    this.switchBoxes = {};
    for (const k of ACTOR_SWITCHES) this.switchBoxes[k] = el('input', { type: 'checkbox', onchange: e => this.setActorSwitch(k, e.target.checked, true) });
    this.hudBox = el('input', { type: 'checkbox', onchange: e => this.setHud(e.target.checked, true) });
    // sound wanted (the default) starts with the first click / key / touch in the page - opening a demo,
    // play, the timeline (a dropped file is no user gesture for the browsers: then the next click)
    const arm = () => { if (this.soundWanted && this.sound && this.visible && (!this.sound.enabled || !this.sound.ctx || this.sound.ctx.state !== 'running')) this.setSound(true); this.syncSoundHint(); };
    // (a demo opened by a link: no click yet, the browser holds the sound back)
    this.soundHint = el('button', { class: 'sound-hint', hidden: true, title: 'The browser starts sound only after a click' }, 'Click to enable sound');
    this.stage.append(this.soundHint);
    const ARM_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'];
    for (const ev of ARM_EVENTS) window.addEventListener(ev, arm, { capture: true });
    this.offArm = () => { for (const ev of ARM_EVENTS) window.removeEventListener(ev, arm, { capture: true }); };
    // graphics (graphics.js): applied when the map loads - a change rebuilds the 3D view
    const gNow = graphics(), gRows = [];
    this.gSelects = {};
    for (const g of GRAPHICS) {
      const fixed = urlGraphics(g.key);
      const sel = el('select', { disabled: fixed ? 'disabled' : null, onchange: e => {
        setGraphics(g.key, e.target.value);
        if (g.live) this.applyGraphics(g.key, e.target.value); else if (this.R.app.reload3d) this.R.app.reload3d('graphics');
      } },
        g.values.map(([v, label]) => el('option', { value: v, selected: v === gNow[g.key] ? 'selected' : null }, label)));
      this.gSelects[g.key] = sel;
      gRows.push(selectRow(g.label, sel, g.title + (fixed ? ' - set by the page address (?' + g.key + '=)' : '')));
    }
    const resetBtn = () => el('button', { class: 'tb wide', title: 'All Display, Sound and Graphics options back to their defaults (forgets your choices; the camera stays)', onclick: () => this.resetDefaults() }, icon('reset', 's'), 'Reset to defaults');
    this.panels = [
      { key: 'camera', title: 'Camera', hint: 'C cycles', icon: 'camera', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' }, this.modeSel,
          selectRow('Player', playerSel, 'Selected player (follow / first person); also click a player in the view or the team panel'),
          el('button', { class: 'tb wide', title: 'Back to the overview', onclick: () => this.resetView() }, icon('reset', 's'), 'Reset view'))) },
      { key: 'display', title: 'Display', hint: '3D only', icon: 'sliders', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' },
          selectRow('Players', this.playersSel, 'Player display: capsules, or the real character models (body and head from the demo, animated with the game\'s animations)'),
          selectRow('X-Ray', this.xraySel, 'Living players behind walls and props as a translucent silhouette in the team colour, the selected player in orange (key X cycles). "Players + names" also shows every name - a player out of sight gets his name on a badge with the team shape (▲ / ◆) - and keeps overlapping names apart'),
          this.propsRow,
          switchRow('View lines', this.switchBoxes.viewLines, { title: 'A line from each player\'s eyes along the view (the real pitch), in the team colour' }),
          switchRow('Player rings', this.switchBoxes.rings, { title: 'A ring in the team colour at the feet of each player model (Players: Models)' }),
          switchRow('Enemy names', this.switchBoxes.enemyNames, { title: 'The enemies\' names over their heads (enemies of the player in first person, else of the selected player, else of the player the demo follows). Off: as in the game, only teammates are named; the selected / hovered player and X-Ray\'s "Players + names" keep theirs' }),
          switchRow('Kill feed', this.killfeedBox, { title: "The game's kill feed, lower left in every camera: the obituaries and the server's messages, " + C4.killfeed.WINDOWS[0].time / 1000 + ' s each, friend and enemy from the view of the player seen' }),
          switchRow('Game HUD', this.hudBox, { title: "First person: the game's HUD (Promod's layout) - the minimap, ammo and grenades, the hit marker, the teammate under the crosshair" }),
          switchRow('Grenades and dropped weapons', this.itemsBox, { title: "The grenades in flight (their own model, spinning as the demo has it) and the weapons on the ground, where the demo's entities have them" }),
          switchRow('Shell casings', this.casingsBox, { title: "The cases each shot ejects, the game's shell eject effect at the gun's ejection port" }),
          switchRow('Bullet tracers', this.tracersBox, { title: "The game's bullet tracers: a short glowing streak flying from the muzzle, gone at the impact - for 20 % of the hits the server reports (cg_tracerChance) and half the shots of the player seen in first person (cg_firstPersonTracerChance)" })),
        this.soundRows, el('div', { class: 'grp' }, resetBtn())) },
      { key: 'graphics', title: 'Graphics', hint: 'reloads the 3D map', icon: 'sun', node: el('div', { class: 'pop-body' },
        el('div', { class: 'grp' }, ...gRows),
        el('p', { class: 'pop-note' }, 'Lower settings help on slow graphics cards. A change reloads the 3D map (the first-person weapon switches at once); time, selection and the other options stay.'),
        el('div', { class: 'grp' }, resetBtn())) }
    ];
  }
  fillPlayerSelect() {
    const d = this.M.d, sel = this.playerSel;
    sel.textContent = '';
    sel.append(el('option', { value: '' }, '— POV / followed —'));
    for (const t of d.teams) {
      const ps = d.players.filter(p => p.team === t.key && d.positions[p.client]);
      if (!ps.length) continue;
      const g = el('optgroup', { label: this.R.app.teamName(t.key) });
      for (const p of ps) g.append(el('option', { value: String(p.client) }, p.cleanName));
      sel.append(g);
    }
    this.syncPlayerSelect();
  }
  syncPlayerSelect() { this.playerSel.value = this.R.focus != null ? String(this.R.focus) : ''; this.needsRender = true; }

  /** the camera mode; user: the viewer's own choice (the buttons, C, Reset view - remembered) */
  setMode(mode, user = false) {
    this.cams.setMode(mode);
    this.modeSel.value = mode;
    this.R.invalidate();
    if (user) { try { localStorage.setItem(CAM_KEY, mode); } catch (err) { /* not stored */ } }
    this.camHint.textContent = MODE_HELP[mode];
    this.camHint.hidden = false;
    fadeHint(this.camHint);
    this.needsRender = true;
  }
  /** a graphics setting that applies without rebuilding the view (graphics.js "live") */
  applyGraphics(key, value) {
    if (key === 'viewmodel') this.viewmodel.enabled = value !== 'off';
    if (key === 'crosshair') this.viewmodel.crosshair = value !== 'off';
    this.needsRender = true;
  }
  /** every Display, Sound and Graphics option back to app/defaults.js: the saved choices forgotten, the live ones applied at
   *  once, the 3D map reloaded if a graphics option that needs it changed (a URL parameter still wins on its page) */
  resetDefaults() {
    const before = graphics();
    clearOptions();
    const now = graphics(), reload = GRAPHICS.some(g => !g.live && before[g.key] !== now[g.key]);
    this.setXray(DISPLAY.xray);
    this.setKillfeed(DISPLAY.killfeed);
    this.setItems(DISPLAY.items);
    this.setCasings(DISPLAY.casings);
    for (const k of ACTOR_SWITCHES) this.setActorSwitch(k, DISPLAY[k]);
    this.setHud(DISPLAY.hud);
    this.setTracers(DISPLAY.tracers);
    this.soundWanted = DISPLAY.sound;
    this.setSound(DISPLAY.sound);
    this.soundVolume = DISPLAY.volume; this.soundVol.value = String(DISPLAY.volume);
    if (this.sound) this.sound.setVolume(DISPLAY.volume);
    this.setPlayersMode(DISPLAY.players);
    this.setPropsMode(DISPLAY.props);
    for (const g of GRAPHICS) {
      this.gSelects[g.key].value = now[g.key];
      if (g.live) this.applyGraphics(g.key, now[g.key]);
    }
    if (reload && this.R.app.reload3d) this.R.app.reload3d('graphics');
  }
  /** X-Ray: 'off' | 'players' | 'names' (xray.js); user: chosen in the popover or with X - remembered */
  setXray(mode, user = false) {
    mode = XRAY_MODES.some(m => m[0] === mode) ? mode : 'off';
    this.xrayMode = mode;
    if (this.xraySel) this.xraySel.value = mode;
    if (user) store(K.xray, mode);
    this.R.invalidate();
    this.needsRender = true;
  }
  /** the kill feed over the view on / off (user: from the toolbar - remembered) */
  setKillfeed(on, user = false) {
    this.killfeedOn = on;
    this.killfeedBox.checked = on;
    if (user) store(K.killfeed, on ? 'on' : 'off');
    this.needsRender = true;
  }
  /** the grenades in flight and the dropped weapons on / off */
  setItems(on, user = false) {
    this.itemsOn = on;
    if (this.worldWeapons) this.worldWeapons.enabled = on;
    if (this.itemsBox) this.itemsBox.checked = on;
    if (user) store(K.items, on ? 'on' : 'off');
    this.needsRender = true;
  }
  /** the shell casings on / off */
  setCasings(on, user = false) {
    this.casingsOn = on;
    if (this.fx) this.fx.casings = on;
    if (this.casingsBox) this.casingsBox.checked = on;
    if (user) store(K.casings, on ? 'on' : 'off');
    this.needsRender = true;
  }
  /** a player overlay switch (ACTOR_SWITCHES: view lines, player rings, enemy names) on / off */
  setActorSwitch(key, on, user = false) {
    this.actors[key] = on;
    if (this.switchBoxes && this.switchBoxes[key]) this.switchBoxes[key].checked = on;
    if (user) store(K[key], on ? 'on' : 'off');
    this.R.invalidate();
    this.needsRender = true;
  }
  /** the game's HUD in first person on / off */
  setHud(on, user = false) {
    this.hud.enabled = on;
    if (this.hudBox) this.hudBox.checked = on;
    if (user) store(K.hud, on ? 'on' : 'off');
    this.needsRender = true;
  }
  /** the bullet tracers on / off */
  setTracers(on, user = false) {
    this.tracers.enabled = on;
    if (this.tracersBox) this.tracersBox.checked = on;
    if (user) store(K.tracers, on ? 'on' : 'off');
    this.needsRender = true;
  }
  /** the hint while the sound is wanted and the page has had no click yet */
  syncSoundHint() {
    const U = navigator.userActivation;
    this.soundHint.hidden = !(this.sound && this.soundWanted && this.visible && U && !U.hasBeenActive);
  }
  /** sound on / off (user: from the button - remembered) */
  setSound(on, user = false) {
    if (user) { this.soundWanted = on; store(K.sound, on ? 'on' : 'off'); }
    if (!this.sound) return;
    this.sound.enable(on && this.visible);
    this.soundBtn.checked = on;
    this.soundNote.textContent = '';
  }
  loadPropsMode(props) {
    const v = stored(K.props);
    return props.setMode(['high', 'low', 'boxes', 'off'].includes(v) ? v : DISPLAY.props);
  }
  setPropsMode(mode, user = false) {
    const p = this.world && this.world.props;
    if (!p) return;
    this.propsSel.value = p.setMode(mode);
    if (this.shadows) this.shadows.invalidate();              // the props cast from the static map
    if (user) store(K.props, mode);
    this.updateHint();
    this.needsRender = true;
  }
  /** map, triangle counts and load times (world / props) */
  updateHint() {
    const w = this.world;
    if (!w) return;
    const p = w.props, k = n => (n / 1000).toFixed(0) + 'k';
    const propsText = !p ? 'no props' : p.mode === 'off' ? 'props off'
      : p.mode === 'boxes' ? p.instanceCount + ' props as boxes'
      : p.instanceCount + ' props (' + p.modelCount + ' models' + (p.fallbackModels.length ? ', ' + p.fallbackModels.length + ' as boxes' : '') + ', ' + k(p.triangles) + ' triangles' + (p.mode === 'low' ? ', low detail' : '') + ')';
    this.info.set('Map: ' + this.mapName + ' (' + k(w.info.triangleCount) + ' triangles, ' + propsText + '; loaded in ' +
      ((w.worldMs + (w.propsMs || 0)) / 1000).toFixed(1) + ' s). Extracted from the game files.' +
      (this.mapName !== this.M.d.meta.map ? ' Using ' + this.mapName + ' for ' + this.M.d.meta.map + '.' : ''));
  }
  setPlayersMode(mode, user = false) {
    mode = mode === 'models' ? 'models' : 'simple';
    this.playersSel.value = mode;
    this.actors.setMode(mode);
    if (user) store(K.players, mode);
    if (mode === 'simple') this.playerNotice.hidden = true; else if (this.actors.failed.size) this.showPlayerNotice([...this.actors.failed.keys()]);
    this.R.invalidate();
    this.needsRender = true;
  }
  showPlayerNotice(failed) {
    if (this.actors.mode !== 'models' || !failed.length) return;
    this.playerNotice.textContent = 'Player models not available: ' + failed.join(', ') + ' - those players are shown as capsules.';
    this.playerNotice.hidden = false;
  }
  resetView() {
    const M = this.M, b = M.bbox;
    if (this.cams.mode !== 'orbit') this.setMode('orbit', true);
    if (b) this.cams.frame({ mins: [b.minX, b.minY, M.zRange[0]], maxs: [b.maxX, b.maxY, M.zRange[1]] });
  }
  capturesKeys(e) {
    if (!this.visible) return false;
    if (e.code === 'KeyC') { const i = MODES.findIndex(m => m[0] === this.cams.mode); this.setMode(MODES[(i + 1) % MODES.length][0], true); return true; }
    if (e.code === 'KeyX' && !e.shiftKey) { const i = XRAY_MODES.findIndex(m => m[0] === this.xrayMode); this.setXray(XRAY_MODES[(i + 1) % XRAY_MODES.length][0], true); return true; }
    return this.cams.captureKey(e);
  }

  /* ---------- show / hide / size ---------- */
  show() {
    this.visible = true; this.stage.hidden = false; this.resize(); this.needsRender = true; this.last = null; requestAnimationFrame(this.loop);
    if (this.sound && this.soundWanted && this.sound.ctx) this.sound.enable(true);
  }
  hide() { this.visible = false; this.stage.hidden = true; if (this.sound && this.sound.enabled) this.sound.enable(false); }
  resize() {
    if (this.exporting) return;                    // the video export renders at its own size
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.w = r.width; this.h = r.height;
    this.renderer.setSize(r.width, r.height, false);
    const dpr = this.renderer.getPixelRatio();
    this.hudCanvas.width = Math.round(r.width * dpr); this.hudCanvas.height = Math.round(r.height * dpr);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /* ---------- per playback frame ---------- */
  draw(t) {
    this.t = t;
    const R = this.R;
    if (this.mapMarks) this.mapMarks.set(R.opts.mapCams, R.opts.hurt);
    // (the reference of Enemy names: the player in first person / followed - the selected one, else the demo's own view)
    this.actors.update(t, { shown: R.shownPlayers(), focus: R.focus, hover: R.hover, labels: R.opts.labels || this.xrayMode === 'names', lastKnown: R.opts.lastKnown,
      xrayNames: this.xrayMode === 'names', ref: R.focus != null ? R.focus : this.M.followedAt(t),
      kills: R.recentKills(t, CFG.DEATH_MARKER_MS) });
    this.effects.update(t, R);
    if (this.scriptModels) this.scriptModels.update(t);
    if (this.worldWeapons) this.worldWeapons.update(t);
    this.needsRender = true;
  }

  /** the centre of the sun shadow map: the orbit target, else a point ahead of the camera */
  shadowCenter() {
    if (this.cams.mode === 'orbit' && this.cams.orbit && this.cams.orbit.target) return this.cams.orbit.target.clone();
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    return this.camera.position.clone().addScaledVector(f, 700);
  }

  /** the weapons the given clients hold between a and b (ms; default the whole demo), each with the
   *  client's body model at its first use -> [{weapon, body}] (ViewModel.preload) */
  viewModelPairs(clients, a = -Infinity, b = Infinity) {
    const M = this.M, out = [], seen = new Set();
    for (const cl of clients) {
      const P = M.d.positions[cl];
      if (!P) continue;
      for (let i = 0; i < P.t.length; i++) {
        const t = P.t[i];
        if (t < a || t > b) continue;
        const name = M.weaponName(P.weapon[i], t);
        if (!name) continue;
        const models = this.actors.modelsAt(cl, t), body = models && models.body;
        const key = name + '|' + body;
        if (!seen.has(key)) { seen.add(key); out.push({ weapon: name, body }); }
      }
      // the recorder's offhand weapons (the grenade he holds and throws: viewanim.js)
      const W = M.d.psWeapon;
      for (let i = 0; W && i < W.t.length; i++) {
        if (W.client[i] !== cl || !W.offhand[i] || W.state[i] < 15 || W.state[i] > 20 || W.t[i] < a || W.t[i] > b) continue;
        const name = M.weaponName(W.offhand[i], W.t[i]), models = this.actors.modelsAt(cl, W.t[i]), body = models && models.body;
        const key = name + '|' + body;
        if (name && !seen.has(key)) { seen.add(key); out.push({ weapon: name, body }); }
      }
    }
    return out;
  }

  /** the player under client cl's crosshair within range (the crosshair's colour of a player without his
   *  player state: CG_CalcCrosshairColor's teammate / enemy test, here a trace along his view against the
   *  world and the players) -> 'friend' | 'enemy' | null */
  aimedPlayer(cl, t, target, range) {
    if (!range || !this.fx || !this.fx.tracer) return null;
    const tr = shotTracer(this.fx.tracer, this.M, t, cl);
    const e = target.eye, f = forward(target.yaw, target.pitch);
    const h = tr.trace([e.x, e.y, e.z], [e.x + f.x * range, e.y + f.y * range, e.z + f.z * range]);
    if (!h || h.player == null) return null;
    const team = c => { const p = this.M.d.players.find(x => x.client === c); return p ? p.team : null; };
    return team(h.player) === team(cl) ? 'friend' : 'enemy';
  }

  /** the player the follow / first-person camera uses: the selection, else the POV's followed player */
  cameraTarget() {
    const M = this.M, t = this.t;
    const cl = this.R.focus != null ? this.R.focus : M.followedAt(t);
    const s = cl != null ? M.sampleAt(cl, t) : null;
    if (!s || s.age > C4.mapConfig.STALE_MS) return { cl, target: null };
    const pos = new THREE.Vector3(s.x, s.y, s.z);
    // the eye: the recorder's view height, else the stance's moving as the game moves it; in first person
    // the landing dip (viewanim.js)
    const A = this.viewmodel.anim;
    const eyeH = A ? A.eyeHeight(cl, t, s) + (this.cams.mode === 'fp' ? A.landDip(cl, t) : 0) : EYE[stanceOf(s)];
    const eye = new THREE.Vector3(s.x, s.y, s.z + eyeH);
    // the lean moves the first-person eye, at least 8 units over the feet (CG_CalcViewValues)
    const lean = A && this.cams.mode === 'fp' ? A.leanEye(cl, t, s.yaw) : null;
    if (lean) { eye.x += lean[0]; eye.y += lean[1]; eye.z = Math.max(eye.z + lean[2], s.z + 8); }
    if (A && this.cams.mode === 'fp') eye.z = Math.max(eye.z + A.stepOffset(cl, t), s.z + 8);
    // the view's motion in first person: the bob (stock servers: Promod sets bg_bobMax 0) and the flinch when hit
    let pitch = s.pitch, roll = 0;
    if (A && this.cams.mode === 'fp') {
      const b = A.viewBob(cl, t, s, isPromod(this.M) ? 0 : BOB_MAX), y = s.yaw * Math.PI / 180;
      if (b) { eye.x += Math.sin(y) * b.right; eye.y -= Math.cos(y) * b.right; eye.z += b.up; }
      const k = A.damageKick(cl, t, n => this.viewmodel.entry(n));
      if (k) { pitch += k[0]; roll = k[1]; }
    }
    return { cl, target: { pos, eye, yaw: s.yaw, pitch, roll, weapon: s.weapon } };
  }

  loop(now) {
    if (!this.visible) return;
    requestAnimationFrame(this.loop);
    if (this.exporting) { this.last = null; return; }   // the export renders its frames (and plays the WebM's sound) itself
    const dt = this.last == null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.xrayMode === 'names' && this.xray.poll()) this.needsRender = true;     // (a name badge changed)
    if (this.renderFrame(dt, this.lastShadowT == null ? 0 : (now - this.lastShadowT) / 1000)) this.lastShadowT = now;
    // the sounds at the camera; the first-person camera's player hears his own (the "_plr" aliases)
    if (this.sound && this.sound.enabled) {
      const fp = this.cams.mode === 'fp' ? this.cameraTarget().cl : null;
      this.sound.update(this.t || 0, this.camera, this.R.pb, fp);
    }
  }

  /** move the camera by dt (s), then render if anything changed (force: always) - the shadow maps'
   *  fades advance by shadowDt (s). -> the client hidden for the first-person view, or false when
   *  nothing was rendered */
  renderFrame(dt, shadowDt, force = false) {
    const mode = this.cams.mode;
    let hideClient = null, hudClient = null;       // (the HUD also while the player seen in first person is dead)
    if (mode === 'follow' || mode === 'fp') {
      const { cl, target } = this.cameraTarget();
      if (mode === 'fp') hudClient = cl;
      if (this.cams.tick(dt, target)) this.needsRender = true;
      const name = cl != null ? this.M.name(cl) : null;
      const msg = !target ? (name ? name + ' is not visible at this time (dead or not sent by the server)' : 'Select a player to follow') : null;
      // a message (nobody to follow / not visible) stays; the plain help fades like the others
      const text = msg || (mode === 'fp' ? 'First person: ' + name : 'Following ' + name + ' · drag to turn around them');
      if (this.camHint.textContent !== text) {
        this.camHint.textContent = text;
        if (msg) holdHint(this.camHint); else fadeHint(this.camHint);
      }
      if (mode === 'fp' && target) { hideClient = cl; this.actors.hide(cl); }
      // the first-person weapon: the weapon held now, in the hands of the player's character (the
      // player's weapons over the demo are loaded when the camera starts following them)
      if (mode === 'fp' && cl != null && this.vmPreloaded !== cl) { this.vmPreloaded = cl; this.viewmodel.preload(this.viewModelPairs([cl])); }
      // its animations, aiming, crosshair (viewanim.js) - and the sights' zoom of the camera
      const models = mode === 'fp' && target ? this.actors.modelsAt(cl, this.t || 0) : null;
      this.viewmodel.aimTarget = target ? (st, range) => this.aimedPlayer(cl, this.t || 0, target, range) : null;
      this.viewmodel.update(cl, this.t || 0, mode === 'fp' && target ? this.M.sampleAt(cl, this.t || 0) : null, models && models.body);
      if (mode === 'fp') {
        const fov = this.viewmodel.fov();
        if (Math.abs(this.camera.fov - fov) > 1e-3) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); this.needsRender = true; }
      }
      // the view's own motion: the scope's sway (viewanim.js viewSway, with the held breath) and the camera
      // shakes of earthquakes (shakeAngles) - pitch / yaw / roll on top of the player's view angles
      if (mode === 'fp' && target) {
        const st = this.viewmodel.state, sw = st && st.viewSway, sh = this.shakeAngles(this.t || 0, target.eye);
        if (sw || sh) {
          const p = (sw ? sw[0] : 0) + (sh ? sh[0] : 0), y = (sw ? sw[1] : 0) + (sh ? sh[1] : 0);
          this.camera.lookAt(target.eye.clone().add(forward(target.yaw + y, target.pitch + p)));
          if (sh) this.camera.rotateZ(-sh[2] * Math.PI / 180);
          this.needsRender = true;
        }
      }
    } else {
      this.viewmodel.update(-1, 0, null);
      if (this.cams.tick(dt, null)) this.needsRender = true;
    }
    if (!this.needsRender && !force) return false;
    this.needsRender = false;
    // the game's LODs by the eye's distance: the props' (props.js updateLods) and the player models' (characters.js)
    if (this.world && this.world.props) this.world.props.updateLods(this.camera);
    this.actors.updateLods(this.camera);
    if (this.shadows) {
      this.camera.updateMatrixWorld();
      this.shadows.update(this.scene, this.shadowCenter(), SUN.dir.value, this.camera, this.world && this.world.info.lights, shadowDt);
    }
    if (this.fx) {
      // the player seen in first person: the view flash and casings at the view model's tags (fx.js)
      this.fx.viewClient = hideClient;
      this.fx.viewMuzzle = hideClient != null && this.viewmodel.enabled ? tag => this.viewmodel.tagFrame(this.camera, tag) : null;
      this.fx.update((this.t || 0) + (this.M.d.meta.firstServerTime || 0), this.camera, (cl, tag) => this.actors.muzzle(cl, tag), this.fxOpts);
    }
    if (this.tracers) {
      const mz = cl => { const f = this.actors.muzzle(cl); return f ? f.origin : null; };
      this.tracers.update(this.t || 0, this.camera, mz, hideClient, (from) => (this.fx && hideClient != null ? this.fx.ownShots(hideClient, from, this.t || 0) : []));
    }
    this.renderer.render(this.scene, this.camera);
    // X-Ray: the players' hidden parts over the finished frame (also in the video export)
    if (this.xrayMode !== 'off') this.xray.render(this.camera, this.actors.xrayTargets(hideClient, this.R.focus));
    this.actors.setXrayHidden(this.xrayMode === 'names' ? this.xray.hidden() : null);
    // the first-person weapon over everything (its own pass, depth cleared: never in a wall), then the
    // crosshair or the scope
    this.viewmodel.render(this.renderer, this.camera);
    // the game's HUD (first person)
    this.drawHud(this.hudCanvas.getContext('2d'), this.hudCanvas.width, this.hudCanvas.height, hudClient);
    if (!this.exporting) {
      this.actors.projectLabels(this.camera, this.w, this.h, hideClient);
      this.effects.projectLabels(this.camera, this.w, this.h);
    }
    return { hideClient, hudClient };
  }

  /** the HUD of the player seen in first person (cl; null: none) into g, w x h device pixels (clear: the HUD's
   *  own canvas; the video export draws it over its frame) */
  drawHud(g, w, h, cl, clear = true) {
    if (clear) g.clearRect(0, 0, w, h);
    const hud = cl != null && this.hud.enabled, feed = clear && this.killfeedOn && this.feedAssets;      // (the export draws its feed itself)
    if (!hud && !feed) return;
    // the live view: inside the viewer's controls (their safe area); the export's frame: all of it
    const ins = clear ? this.uiInsets(w / Math.max(1, this.hudCanvas.clientWidth || w)) : { l: 0, t: 0, r: 0, b: 0 };
    g.save();
    g.translate(ins.l, ins.t);
    if (feed) this.feed.draw(g, this.t || 0, { w: w - ins.l - ins.r, h: h - ins.t - ins.b, pov: this.povAt(this.t || 0), assets: this.feedAssets });
    if (!hud) { g.restore(); return; }
    const s = this.M.sampleAt(cl, this.t || 0);
    const st = this.viewmodel.state;
    // (the whole view in the safe area's coordinates: the hit marker centred on the screen as the game draws it)
    this.hud.draw(g, w - ins.l - ins.r, h - ins.t - ins.b, this.t || 0, cl, s ? { yaw: s.yaw, pitch: s.pitch, flashed: !!(st && st.flashed) } : null, st && st.weapon ? String(st.weapon).toLowerCase() : null,
      { x: -ins.l, y: -ins.t, w, h });
    g.restore();
  }

  /** the player whose view the HUD's relations go by: the selected one, else the demo's own */
  povAt(t) { return this.R.focus != null ? this.R.focus : this.M.followedAt(t); }

  /** the viewer's controls over the 3D canvas (rail, score, drawer, the playback bar) as the HUD's safe area: per
   *  control the canvas edge it hugs, inset past it (device pixels) */
  uiInsets(dpr) {
    const c = this.renderer.domElement.getBoundingClientRect(), ins = { l: 0, t: 0, r: 0, b: 0 }, gap = 8;
    // (in fullscreen the player bar floats over the view only while the mouse moves: the HUD stays put)
    const fs = !!document.fullscreenElement;
    for (const sel of ['#rail', '#overview', '#drawer', '#drawer-open', '#controls']) {
      if (fs && sel === '#controls') continue;
      for (const e of document.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        if (!r.width || !r.height || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        if (r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue;
        const cand = { l: r.right - c.left, r: c.right - r.left, t: r.bottom - c.top, b: c.bottom - r.top };
        const edge = Object.keys(cand).reduce((a, b) => (cand[a] <= cand[b] ? a : b));
        ins[edge] = Math.max(ins[edge], cand[edge] + gap);
      }
    }
    for (const k in ins) ins[k] = Math.round(ins[k] * dpr);
    return ins;
  }

  /** CG_ShakeCamera: the strongest earthquake (EV_EARTHQUAKE: scale, radius, duration) at the eye now ->
   *  [pitch, yaw, roll] degrees or null; its size falls off over the radius and the duration, the angles are
   *  sines of the server time / 600 at a phase drawn once per shake */
  shakeAngles(t, eye) {
    const Q = this.M.d.fx3d && this.M.d.fx3d.quakes;
    if (!Q || !Q.length) return null;
    let size = 0, rumble = 0, start = 0;
    for (const q of Q) {
      const dt = t - q[0];
      if (dt < 0 || dt >= q[6] || !(q[4] > 0) || !(q[5] > 0)) continue;
      const x = (1 - dt / q[6]) * q[4];
      const val = 1 - Math.hypot(eye.x - q[1], eye.y - q[2], eye.z - q[3]) / q[5];
      const sz = val < 0 ? val / x : val * x;
      if (sz > size) { size = sz; rumble = x; start = q[0]; }
    }
    if (size <= 0) return null;
    const s = Math.min(1, size), sx = (t + (this.M.d.meta.firstServerTime || 0)) / 600;
    const ph = ((start * 9301 + 49297) % 233280) / 233280 * 2 * Math.PI - Math.PI;
    return [Math.sin(ph + sx * 25.13274) * rumble * 18 * s, Math.sin(ph + sx * 47.12389) * rumble * 16 * s, Math.sin(ph + sx * 37.69911) * rumble * 10 * s];
  }

  /* ---------- video export (exportVideo3d.js, loaded on first use) ---------- */
  exportVideo() {
    import('./exportVideo3d.js').then(m => m.openExport(this)).catch(err => { console.error(err); alert('The video export could not be loaded: ' + err.message); });
  }

  destroy() {
    this.visible = false;
    this.offFocus();
    if (this.mapMarks) this.mapMarks.dispose();
    this.actors.dispose();
    this.effects.dispose();
    if (this.tracers) this.tracers.dispose();
    this.cams.dispose();
    if (this.shadows) { this.shadows.dispose(); this.shadows = null; }
    this.xray.dispose();
    this.viewmodel.dispose();
    if (this.sky) { this.sky.dispose(); this.sky = null; }
    if (this.fx) { this.fx.dispose(); this.fx = null; }
    if (this.scriptModels) { this.scriptModels.dispose(); this.scriptModels = null; }
    if (this.worldWeapons) { this.worldWeapons.dispose(); this.worldWeapons = null; }
    if (this.auditTimer) { clearInterval(this.auditTimer); this.auditTimer = null; }
    if (this.sound) { this.sound.dispose(); this.sound = null; }
    if (this.offArm) this.offArm();
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.resizeObserver.disconnect();
    // the shared texture cache keeps its images for the next demo, but each texture's GPU copy of this renderer is
    // released: three.js keeps it per texture source, and through it this renderer's context - and this view with its
    // demo - would stay alive after the demo is closed
    for (const t of texCache.values()) t.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();          // free the GPU memory when the next demo is opened
    this.stage.remove();
  }
}
