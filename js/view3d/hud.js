/* The game's HUD in first person (Promod's ui_mp/hud.menu over the stock client code), drawn on a 2D canvas over
 * the 3D view - and into every frame of the video export (drawTo). The images are the game's (maps3d/_hud,
 * tools/export/hud_export.py; the minimap is the compass map of assets/maps); the layout is the menu's 640 x 480
 * screen, one scale (height / 480), anchored left / right:
 *   minimap      CG_PLAYER_COMPASS_MAP: the map turned with the view (the view up), compassMaxRange 2500 units
 *                to the edge, in minimap_background; the teammates (their arrows), the enemies while they fire
 *                (compassping_enemyfiring, ~1 s), the objectives of the player state (bomb sites, the bomb and its
 *                carrier: CG_CompassDrawPlayerObjectives, at the edge when out of range) and the player
 *                (compassping_player) - Promod's top left square
 *   ammo         CG_PLAYER_AMMO_VALUE: the clip and the reserve of the player state's weapon (the low colour at the weapon
 *                file's threshold), the weapon's name; the frag and special grenades with their counts - the player state's
 *                ammo / clip slots as the engine numbers them, checked against the demo (ammo.js AmmoBook)
 *   hit marker   the scripts' damage_feedback HUD element (_damagefeedback.gsc; collect.js hitMarks) on every hit
 *   messages     the bold game messages over the centre (the lower left window of the obituaries is the kill feed: killfeed.js,
 *                in every camera); "You killed" / "Killed by" for the player seen (CG_PriorityCenterPrint, 180 under the centre)
 *   names        CG_DrawCrosshairNames: the teammate under the crosshair (stats[3]) below it
 *   hints        CG_CURSORHINT: the use icon while the server shows a hint (planting / defusing the bomb ...)
 *   server HUD   the scripts' HUD elements of the player state (CG_Draw2dHudElems; collect.js doHudState): texts, values,
 *                timers, images, in the game's fonts and strings (hudtext.js) - the round's messages, Promod's timers ...
 *                The waypoints (13: the bomb, its carrier for his team) stay on the screen; the hit marker has its own place above
 * Promod hides the stance indicator (its rect lies off the screen) - so does this HUD. Only the recorder has a
 * player state: the ammo, hit marker, names, hints and the server's elements are his; for another player the minimap. */
import { isPromod } from './viewmodel.js';
import { configStrings, loadHudText } from './hudtext.js';
import { fetchJSON } from './data.js';
import { loadImage } from '../app/retry.js';
import { DVARS, PING_HOLD_MS, COMPASS_MENU } from './hudConfig.js';
import { AmmoBook } from './ammo.js';

const BASE = 'maps3d/';
const D2R = Math.PI / 180;
const HUD_ALPHA = 0.65;
const LOW = [0.89, 0.18, 0.01];             // the low ammo colour of the client code
const WHITE = [1, 1, 1];
const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const GRENADES = { frag_grenade_mp: 'hud_us_grenade', flash_grenade_mp: 'hud_us_flashgrenade', smoke_grenade_mp: 'hud_us_smokegrenade',
  concussion_grenade_mp: 'hud_us_stungrenade' };
// (images the archives do not hold: the weapon's own picture)
const FALLBACK_ICON = { frag_grenade_mp: 'weapon_fraggrenade', flash_grenade_mp: 'weapon_flashbang', smoke_grenade_mp: 'weapon_smokegrenade',
  concussion_grenade_mp: 'weapon_concgrenade' };

const hexColor = c => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || ''); return m ? m.slice(1).map(v => parseInt(v, 16) / 255) : WHITE; };
const u2f = (() => { const b = new DataView(new ArrayBuffer(4)); return u => { b.setUint32(0, u >>> 0); return b.getFloat32(0); }; })();
const rgba = c => [(c & 255) / 255, ((c >>> 8) & 255) / 255, ((c >>> 16) & 255) / 255, ((c >>> 24) & 255) / 255];
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
/** HudElemTimerString / HudElemTenthsTimerString */
const timer = (ms, tenths) => {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
  const base = h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  return tenths ? base + '.' + d : base;
};
// (GetHudElemInfo: the element's font -> its base scale and the font's kind in UI_GetFontHandle)
const ELEM_FONTS = [[0.25, 0], [0.5, 4], [1 / 3, 5], [0.25, 6], [0.25, 2], [0.25, 3]];
const NO_ENTITY = 1023;
const HINT_WEAPON = 5, HINT_FADE_MS = 100;       // FIRST_WEAPON_HINT: weapon number + 4
const HINT_ICONS = { 2: 'hint_usable', 3: 'hint_health' };
const KEY_USE = 'F', KEY_JUMP = 'SPACE';         // the default binds of +activate, +gostand
// cg_centertime 5 s, its last 0.1 s fading (CG_FadeColor); textscale of "CenterObituary": TEXTSIZE_DEFAULT (0.4583 in the stock hud.menu)
const CENTER_MS = 5000, CENTER_SCALE = 0.4583;
const TEXT_TYPES = new Set([1, 2, 3, 4, 5, 7, 8, 9, 10]);

const lower = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };

export class GameHud {
  constructor(M, table) {
    this.M = M;
    this.table = table;                  // viewmodels.json (the weapon files' numbers) or null
    this.promod = isPromod(M);           // (a Promod server: its weapon files' names and numbers)
    this.enabled = true;
    this.images = new Map();
    this.imgList = null;
    fetchJSON(BASE + '_hud/hud.json').catch(() => null).then(h => {
      this.imgList = (h && h.images) || {};
      for (const [k, v] of Object.entries(this.imgList)) this.image(k, BASE + v.file);
    }).catch(() => { this.imgList = {}; });
    const entry = M.mapEntry;
    if (entry && entry.image) this.image('map', 'assets/maps/' + entry.image);
    this.txt = null;                     // the game's fonts, strings, the elements' images (hudtext.js)
    this.elems = new Map();              // element number -> its fields
    this.csAt = configStrings(M.d);
    this.bold = new C4.killfeed.Feed(M.d).bold;
    this.killT = M.d.kills.map(k => k.t);
    this.icons = null;
    C4.killfeed.images().then(m => { this.icons = m; if (this.onChange) this.onChange(); });
    loadHudText().then(x => { this.txt = x; if (this.onChange) this.onChange(); });
    this.prepare();
  }

  image(key, src) {
    if (this.images.has(key)) return this.images.get(key);
    // (a placeholder until the image is in - tried again on a failed load: retry.js)
    const slot = { ready: false };
    this.images.set(key, slot);
    loadImage(src).then(img => { img.ready = true; this.images.set(key, img); if (this.onChange) this.onChange(); }).catch(() => { slot.failed = true; });
    return slot;
  }
  img(key) { const i = this.images.get(key); return i && i.ready ? i : null; }

  /** the hit marker's states, the enemies' shots */
  prepare() {
    const d = this.M.d;
    // the scripts' hit marker element per client and slot (collect.js hitMarks): its states in time order
    this.marks = new Map();
    for (const m of d.hitMarks || []) {
      let bySlot = this.marks.get(m.client);
      if (!bySlot) this.marks.set(m.client, bySlot = new Map());
      let a = bySlot.get(m.slot);
      if (!a) bySlot.set(m.slot, a = { t: [], m: [] });
      a.t.push(m.t); a.m.push(m);
    }
    // the shots seen per client (the enemies' fire pings)
    this.shots = new Map(Object.entries(d.shotsSeen || {}).map(([cl, a]) => [+cl, a]));
  }

  /** the numbers of weapon n (a Promod server's: Promod's file over the stock one) or null */
  params(n) {
    const T = this.table, w = T && T.weapons[n];
    if (!w) return null;
    const pm = this.promod && T.promod && T.promod.weapons[n];
    if (!pm) return w.params;
    const P = Object.assign({}, w.params);
    for (const [k, v] of Object.entries(pm.params || {})) { if (v == null) delete P[k]; else P[k] = v; }
    return P;
  }

  /** the recorder's ammo (ammo.js), built once the weapon table is there */
  ammo() {
    if (!this.table) return null;
    if (!this.book || this.book.table !== this.table) this.book = new AmmoBook(this.M.d, this.table, this.promod);
    return this.book;
  }

  /** the recorder's HUD row at t (psHud) or -1 */
  hudRow(cl, t) {
    const H = this.M.d.psHud;
    if (!H || !H.t.length) return -1;
    const i = lower(H.t, t);
    return i >= 0 && H.client[i] === cl && t - H.t[i] < 1000 ? i : -1;
  }

  /** draw the HUD of client cl at t into the 2D context g (w x h device pixels: the safe area); view: {yaw, pitch}
   *  (null: the player is dead - nothing); full: the whole view {x, y, w, h} in the same coordinates (default the
   *  safe area) - the hit marker is centred on it */
  draw(g, w, h, t, cl, view, weaponName, full = null) {
    if (!this.enabled || cl == null) return;
    if (this.debug) this.drawn = [];
    const M = this.M, s = h / 480, R = x => w - (640 - x) * s;
    const row = this.hudRow(cl, t), H = M.d.psHud;
    g.save();
    // (dead: the scripts' elements stay - "You will spawn next round", the timers)
    const Fv = full || { x: 0, y: 0, w, h };
    this.drawMessages(g, w, h, s, Fv, t, cl);
    if (!view) { if (row >= 0) this.drawElems(g, w, h, s, Fv, t, row); g.restore(); return; }
    this.drawCompass(g, w, h, t, cl, view);
    if (row >= 0) {
      const F = full || { x: 0, y: 0, w, h };
      g.save(); g.translate(F.x, F.y);
      this.drawHitMarker(g, F.w, F.h, F.h / 480, t, cl);
      g.restore();
      this.drawAmmo(g, s, R, t, cl);
      this.drawNames(g, w, h, s, row);
      this.drawElems(g, w, h, s, full || { x: 0, y: 0, w, h }, t, row, view.flashed);
      this.drawHints(g, s, Fv, t, row);
    }
    g.restore();
  }

  /** the compass (Promod's / the stock "Compass_old" menu; cg_compass.cpp, cg_compassfriendlies_mp.cpp) in the HUD area w x h:
   *  the items' virtual rects (hudConfig.js COMPASS_MENU) aligned left / top, their width / height times compassSize
   *  (CG_CompassCalcDimensions), virtual -> device by ScrPlace's scaleVirtualToReal. The map turned with the view
   *  (compassRotation), compassMaxRange world units across its height; the friendlies (compassping_friendly_mp, their firing
   *  ping over it), the enemies' firing pings at the place they fired from, the objectives, the player in the centre. The menu
   *  hides it while flashbanged or scoped */
  drawCompass(g, w, h, t, cl, view) {
    const M = this.M, D = DVARS, me = M.sampleAt(cl, t);
    if (!me || view.flashed || view.scoped) return;
    const sx = Math.min(h * 4 / 3, w) / 640, sy = h / 480;
    const R = COMPASS_MENU[this.promod ? 'promod' : 'stock'];
    // (device rect of an item: CG_CompassCalcDimensions, then ScrPlace_ApplyRect for HORIZONTAL_ALIGN_LEFT / VERTICAL_ALIGN_TOP)
    const rect = r => ({ x: r[0] * sx, y: r[1] * sy, w: r[2] * D.compassSize * sx, h: r[3] * D.compassSize * sy, vh: r[3] * D.compassSize });
    const back = rect(R.back), border = rect(R.tickerBorder), tape = rect(R.ticker), mr = rect(R.map);
    const bg = this.img('minimap_background');
    if (bg) g.drawImage(bg, back.x, back.y, back.w, back.h);
    const tb = this.img('minimap_tickertape_background');
    if (tb) g.drawImage(tb, border.x, border.y, border.w, border.h);
    this.drawTickertape(g, tape, view.yaw);
    // CG_WorldPosToCompass: pixPerInch = the map rect's height / compassMaxRange, the view's yaw vector up
    const cx = mr.x + mr.w / 2, cy = mr.y + mr.h / 2, ppi = mr.vh / D.compassMaxRange, kx = ppi * sx, ky = ppi * sy;
    const fs = Math.sin(view.yaw * D2R), fc = Math.cos(view.yaw * D2R);
    const half = [mr.w / 2, mr.h / 2];
    /** world (x, y) -> [device x, y, clipped] (clipped to the map rect's edge: CG_WorldPosToCompass outClipped) */
    const toCompass = (x, y) => {
      const dx = x - me.x, dy = y - me.y;
      let ox = kx * (fs * dx - fc * dy), oy = ky * (-fs * dy - fc * dx), clipped = false;
      if (ox > half[0] || ox < -half[0]) { const k = half[0] / Math.abs(ox); ox *= k; oy *= k; clipped = true; }
      if (oy > half[1] || oy < -half[1]) { const k = half[1] / Math.abs(oy); ox *= k; oy *= k; clipped = true; }
      return [cx + ox, cy + oy, clipped];
    };
    const map = this.img('map'), wr = M.rect;
    if (map && wr) {
      // CG_CompassDrawPlayerMap: the compass map image under the rect, turned with the view (the image's own alpha)
      const ax = (wr.maxX - wr.minX) / map.naturalWidth, ay = (wr.maxY - wr.minY) / map.naturalHeight;
      const ox = wr.minX - me.x, oy = wr.maxY - me.y;
      g.save();
      g.beginPath(); g.rect(mr.x, mr.y, mr.w, mr.h); g.clip();
      g.transform(kx * fs * ax, -ky * fc * ax, kx * fc * ay, ky * fs * ay, cx + kx * (fs * ox - fc * oy), cy - ky * (fc * ox + fs * oy));
      g.drawImage(map, 0, 0);
      g.restore();
    }
    // CG_CompassDrawPlayerPointers_MP: the objectives (icons clipped to the edge)
    this.drawObjectives(g, t, cl, sx, sy, toCompass);
    // CG_CompassDrawFriendlies: the teammates seen in the last 1500 ms, turned by the view's yaw minus theirs; a firing ping over
    // the arrow, fading out over compassSoundPingFadeTime (the arrow is left out while the ping is at full alpha)
    const fw = D.compassFriendlyWidth * D.compassSize * sx, fh = D.compassFriendlyHeight * D.compassSize * sy;
    const team = (M.player(cl) || {}).team, fade = D.compassSoundPingFadeTime * 1000;
    const arrow = this.img('compassping_green_hollow_mp') || this.img('compassping_green_mp'), firing = this.img('compassping_green_mp');
    const enemyPing = this.img('compassping_enemyfiring');
    for (const p of M.d.players) {
      if (p.client === cl || (p.team !== 'A' && p.team !== 'B')) continue;
      if (p.team === team) {
        const o = M.sampleAt(p.client, t);
        if (!o || o.age > 1500) continue;
        const [px, py, clipped] = toCompass(o.x, o.y);
        if (clipped && !D.compassClampIcons) continue;
        const shot = this.lastPing(p.client, t, fade);
        const ping = shot ? Math.min(1, 1 - (t - shot.t - PING_HOLD_MS) / fade) : 0;
        g.save(); g.translate(px, py); g.rotate((view.yaw - o.yaw) * D2R);
        if (arrow && !(shot && ping >= 1)) g.drawImage(arrow, -fw / 2, -fh / 2, fw, fh);
        if (firing && shot) { g.globalAlpha = Math.max(0, ping); g.drawImage(firing, -fw / 2, -fh / 2, fw, fh); }
        g.restore();
      } else {
        // CG_CompassDrawEnemies (g_compassShowEnemies 0): only a firing ping, at the place of the shot, friendly-sized
        const shot = this.lastPing(p.client, t, fade);
        if (!shot || !enemyPing) continue;
        const [px, py, clipped] = toCompass(shot.x, shot.y);
        if (clipped && !D.compassClampIcons) continue;
        g.globalAlpha = Math.max(0, Math.min(1, 1 - (t - shot.t - PING_HOLD_MS) / fade));
        g.drawImage(enemyPing, px - fw / 2, py - fh / 2, fw, fh);
        g.globalAlpha = 1;
      }
    }
    // CG_CompassDrawPlayer: the player in the centre (compassRotation: not turned)
    const pl = this.img('compassping_player'), pw = D.compassPlayerWidth * D.compassSize * sx, ph = D.compassPlayerHeight * D.compassSize * sy;
    if (pl) g.drawImage(pl, cx - pw / 2, cy - ph / 2, pw, ph);
  }

  /** CG_CompassDrawTickertape (CG_PLAYER_COMPASS_TICKERTAPE_NO_OBJ): the tape image of minimap_tickertape_mp over the rect, its
   *  texture from tapeCenter -/+ compassTickertapeStretch / 2 (tapeCenter = -(view yaw - north yaw) / 360; the image repeats) */
  drawTickertape(g, r, yaw) {
    const img = this.img('minimap_tickertape_256x16');
    if (!img) return;
    const D = DVARS, north = (this.M.d.meta && this.M.d.meta.northYaw) || 0;
    const center = -(yaw - north) / 360, left = center - D.compassTickertapeStretch / 2;
    const iw = img.naturalWidth, ih = img.naturalHeight, span = D.compassTickertapeStretch * iw;     // image pixels shown
    let u = (((left % 1) + 1) % 1) * iw, x = r.x, rest = span;
    // (the shown span in pieces at the image's wrap)
    while (rest > 0.01) {
      const n = Math.min(rest, iw - u), dw = n / span * r.w;
      g.drawImage(img, u, 0, n, ih, x, r.y, dw, r.h);
      x += dw; rest -= n; u = 0;
    }
  }

  /** the last firing ping of client cl before t within ms: an unsilenced shot of a weapon that is no grenade (CG_FireWeapon:
   *  CG_CompassAddWeaponPingInfo) -> {t, x, y} (where he fired) or null */
  lastPing(cl, t, ms) {
    const a = this.shots.get(cl);
    if (!a) return null;
    for (let i = lower(a, t); i >= 0 && t - a[i] <= ms + PING_HOLD_MS; i--) {
      const o = this.M.sampleAt(cl, a[i]);
      if (!o) continue;
      const name = o.weapon ? this.M.weaponName(o.weapon, a[i]) : null, n = String(name || '').toLowerCase();
      if (n.includes('silencer') || /grenade|^c4|claymore/.test(n)) continue;
      return { t: a[i], x: o.x, y: o.y };
    }
    return null;
  }

  /** the hit marker (the scripts' HUD element, _damagefeedback.gsc: damage_feedback 24 x 48 at -12 / -12 from the
   *  screen's centre, alpha 1 faded out over 1 s on every hit - CG_Draw2dHudElems): its state at t from the server's
   *  fade (colours RGBA, alpha in the high byte), size change and placement (alignScreen: horizontal << 3 | vertical,
   *  1 left / top, 2 centre / middle, 3 right / bottom; alignOrg: horizontal << 2 | vertical, 0 left / top, 1 centre,
   *  2 right / bottom), in the whole view as the game places it */
  drawHitMarker(g, w, h, s, t, cl) {
    const bySlot = this.marks && this.marks.get(cl), img = this.img('damage_feedback');
    if (!bySlot || !img) return;
    for (const a of bySlot.values()) {
      const i = lower(a.t, t);
      if (i < 0 || a.m[i].gone) continue;
      const m = a.m[i];
      let alpha = (m.color >>> 24) / 255;
      if (m.fadeTime > 0 && t - m.fadeStart < m.fadeTime) {
        const f = Math.max(0, Math.min(1, (t - m.fadeStart) / m.fadeTime));
        alpha = (m.fromColor >>> 24) / 255 + (alpha - (m.fromColor >>> 24) / 255) * f;
      }
      if (alpha <= 0.004) continue;
      let ew = m.w, eh = m.h;
      if (m.scaleTime > 0 && t - m.scaleStart < m.scaleTime) {
        const f = Math.max(0, Math.min(1, (t - m.scaleStart) / m.scaleTime));
        ew = m.fromW + (ew - m.fromW) * f; eh = m.fromH + (eh - m.fromH) * f;
      }
      const hs = (m.alignScreen >> 3) & 7, vs = m.alignScreen & 7, ho = (m.alignOrg >> 2) & 3, vo = m.alignOrg & 3;
      let x = (hs === 2 ? w / 2 : hs === 3 ? w : 0) + m.x * s, y = (vs === 2 ? h / 2 : vs === 3 ? h : 0) + m.y * s;
      x -= ho === 1 ? ew * s / 2 : ho === 2 ? ew * s : 0;
      y -= vo === 1 ? eh * s / 2 : vo === 2 ? eh * s : 0;
      const c = m.fromColor && m.fadeTime > 0 && t - m.fadeStart < m.fadeTime ? m.fromColor : m.color;
      g.save();
      g.globalAlpha = Math.min(1, alpha);
      if ((c & 0xffffff) !== 0xffffff) {
        // (a tinted marker - Promod's colours: the image multiplied by the colour, drawn through an offscreen copy)
        const k = this.tinted || (this.tinted = document.createElement('canvas'));
        k.width = img.width; k.height = img.height;
        const kg = k.getContext('2d');
        kg.globalCompositeOperation = 'source-over'; kg.drawImage(img, 0, 0);
        kg.globalCompositeOperation = 'multiply'; kg.fillStyle = 'rgb(' + (c & 255) + ',' + ((c >> 8) & 255) + ',' + ((c >> 16) & 255) + ')'; kg.fillRect(0, 0, k.width, k.height);
        kg.globalCompositeOperation = 'destination-in'; kg.drawImage(img, 0, 0);
        g.drawImage(k, x, y, ew * s, eh * s);
      } else g.drawImage(img, x, y, ew * s, eh * s);
      g.restore();
    }
  }

  /** CG_DrawPlayerAmmoValue and the offhand counts (ammo.js): the player state's weapon at t - the clip, "| reserve" after
   *  it (the low colour at the weapon file's thresholds), the weapon's name; the frag and special grenades. Nothing without
   *  the player state of cl, no numbers for a weapon whose slots are unknown */
  drawAmmo(g, s, R, t, cl) {
    const book = this.ammo(), a = book && book.at(cl, t);
    if (!a) return;
    // (a check's record of the drawn numbers - hud.debug, off by default)
    if (this.debug) (this.drawn || (this.drawn = [])).push({ ammo: { t, cl, weapon: a.weapon, clip: a.clip, reserve: a.reserve, lowClip: a.lowClip,
      lowAmmo: a.lowAmmo, offhand: a.offhand.map(o => o.cls + ':' + o.n).join(' ') } });
    if (a.weapon && a.reserve != null && !(a.P && a.P.offhandClass)) {
      const yb = 462 * s;
      const rw = a.P && a.P.suppressAmmoReserveDisplay ? 0 : this.say(g, '| ' + a.reserve, R(632), yb, 0.36, s, a.lowAmmo ? LOW : WHITE, 0.85, 2);
      if (a.clip != null) this.say(g, String(a.clip), R(632) - rw - 4 * s, yb, 0.5, s, a.lowClip ? LOW : WHITE, 1, 2);
    }
    // the weapon's name
    if (a.weapon) this.say(g, C4.weapons.label(a.weapon), R(632), 436 * s, 0.25, s, WHITE, HUD_ALPHA, 2);
    // the grenades: the frag class always, the others while the player has one (CG_DrawOffHandAmmo: 0 in the low colour)
    let x = R(632);
    for (const o of a.offhand) {
      if (!o.n && o.cls !== 'Frag Grenade') continue;
      const gn = o.weapon in GRENADES ? o.weapon : Object.keys(GRENADES).find(k => k.startsWith(o.weapon.split('_')[0])) || 'frag_grenade_mp';
      const img = this.img(GRENADES[gn]) || this.img(FALLBACK_ICON[gn]), sz = 22 * s;
      x -= sz + 20 * s;
      g.globalAlpha = o.n ? 1 : 0.35;
      if (img) g.drawImage(img, x, 386 * s, sz, sz);
      this.say(g, String(o.n), x + sz + 2 * s, 404 * s, 0.25, s, o.n ? WHITE : LOW, o.n ? 1 : 0.35, 0);
    }
    g.globalAlpha = 1;
  }

  /** a line of the HUD at a device position (y: the baseline; align 0 left, 1 centre, 2 right) in the game's font, else the
   *  browser's -> its width */
  say(g, str, x, y, scale, s, color, alpha, align) {
    const T = this.txt;
    if (T) {
      const w = T.width(str, scale, s);
      T.draw(g, str, x - (align === 2 ? w : align === 1 ? w / 2 : 0), y, scale, s, color, alpha);
      return w;
    }
    g.save();
    g.globalAlpha = alpha; g.textBaseline = 'alphabetic'; g.textAlign = align === 2 ? 'right' : align === 1 ? 'center' : 'left';
    g.font = Math.round(scale * 48 * s) + 'px ' + FONT;
    g.fillStyle = 'rgb(' + color.map(c => Math.round(c * 255)).join(',') + ')';
    g.fillText(str, x, y);
    const w = g.measureText(str).width;
    g.restore();
    return w;
  }

  /** the bold game messages and the first person's "You killed" line */
  drawMessages(g, w, h, s, F, t, cl) {
    const T = this.txt;
    if (!T) return;
    const B = this.bold.W, charHeight = Math.round(B.textScale * 48), scale = charHeight / 48, real = B.textScale * s;
    for (const r of this.bold.rows(t, charHeight)) {
      const text = T.localize(r.m.text);
      T.draw(g, text, F.x + F.w / 2 - T.width(text, scale, s, 0, real) / 2, F.y + F.h / 2 + (B.y + r.y) * s, scale, s, WHITE, r.alpha, 3, 0, real);
    }
    // CG_Obituary: the player's own kill or death, the last one (a teammate as such); not a suicide
    for (let i = lower(this.killT, t); i >= 0 && t - this.killT[i] < CENTER_MS; i--) {
      const k = this.M.d.kills[i];
      if (k.attacker === k.victim || k.victim >= 64 || k.attacker >= 64 || (k.attacker !== cl && k.victim !== cl)) continue;
      const mine = k.attacker === cl, other = this.M.player(mine ? k.victim : k.attacker), own = this.M.player(cl);
      const mate = other && own && other.team === own.team;
      const text = T.localize((mine ? 'CGAME_YOUKILLED' : 'CGAME_YOUWEREKILLED') + '\x15' + (mate ? T.localize('CGAME_TEAMMATE') + ' ' : '') + (other ? other.name : ''));
      const left = CENTER_MS - (t - k.t);
      T.draw(g, text, F.x + F.w / 2 - T.width(text, CENTER_SCALE, s) / 2, F.y + F.h / 2 + 180 * s, CENTER_SCALE, s, WHITE, Math.min(1, left / 100));
      break;
    }
  }

  /** CG_DrawCursorhint / CG_DrawMantleHint: the text, then the icon after it, centred at the menus' place (Cursorhints 60,
   *  MantleHint 105 under the centre; 40 x 40), fading out over 100 ms. The keys are the game's defaults (not in the demo) */
  drawHints(g, s, F, t, row) {
    const H = this.M.d.psHud, T = this.txt, cx = F.x + F.w / 2, cy = F.y + F.h / 2;
    let k = row;
    while (k > 0 && !H.hint[k] && H.client[k - 1] === H.client[row] && t - H.t[k] < HINT_FADE_MS + 60) k--;
    if (H.hint[k]) {
      const a = k === row ? 1 : Math.max(0, 1 - (t - H.t[k + 1]) / HINT_FADE_MS), hint = H.hint[k], hs = H.hintString[k];
      let text = '', icon = null, ratio = 1;
      const useString = hs >= 0 ? this.csAt(C4.constants.CS.HINT_STRINGS + hs, t) : '';
      if (hint >= HINT_WEAPON) {
        const name = this.M.weaponName(hint - HINT_WEAPON + 1, t), ic = name ? C4.weapons.weaponIcon(name) : null, P = name ? this.params(name) : null;
        icon = ic && this.icons ? { img: this.icons.get(ic.file), box: ic.box } : null;
        const off = P && P.inventoryType === 'offhand';
        if (T) text = T.localize((off ? 'PLATFORM_THROWBACKGRENADE' : 'PLATFORM_SWAPWEAPONS') + '\x15' + KEY_USE);
      } else {
        const key = HINT_ICONS[hint], img = key && this.img(key);
        icon = img ? { img, box: [0, 0, img.naturalWidth, img.naturalHeight] } : null;
        if (T && useString) text = T.localize(useString + '\x15' + KEY_USE);
        else if (T && hint === 3) text = T.localize('PLATFORM_PICKUPHEALTH\x15' + KEY_USE);
      }
      this.hintLine(g, s, text, icon, cx, cy + 60 * s, a);
    }
    if (H.mantle[row] & 8) {
      const img = this.img('hint_mantle');
      if (T) this.hintLine(g, s, T.localize('PLATFORM_MANTLE\x15' + KEY_JUMP), img ? { img, box: [0, 0, img.naturalWidth, img.naturalHeight] } : null, cx, cy + 105 * s, 1);
    }
  }
  hintLine(g, s, text, icon, x, y, alpha) {
    const T = this.txt, size = 40 * s, iw = icon && icon.img ? size * Math.min(2.5, icon.box[2] / icon.box[3]) : 0, scale = 0.3;
    const tw = T && text ? T.width(text, scale, s) : 0;
    let px = x - (tw + iw) / 2;
    if (tw) { T.draw(g, text, px, y + scale * 48 * s / 2, scale, s, WHITE, alpha); px += tw; }
    if (iw) {
      g.save(); g.globalAlpha = alpha;
      g.drawImage(icon.img, icon.box[0], icon.box[1], icon.box[2], icon.box[3], px, y - size / 2, iw, size);
      g.restore();
    }
  }

  /** the fields of element number id */
  elem(id) {
    let e = this.elems.get(id);
    if (!e) {
      const E = this.M.d.psHud.elems, HE = C4.delta.HUD_INDEX, b = id * E.stride;
      e = {};
      for (const k of Object.keys(HE)) e[k] = E.data[b + HE[k]];
      for (const k of ['x', 'y', 'z', 'fontScale', 'value', 'fromX', 'fromY']) e[k] = u2f(e[k]);
      if (this.elems.size > 4000) this.elems.clear();
      this.elems.set(id, e);
    }
    return e;
  }

  /** CG_Draw2dHudElems: the elements of row's player state by their sort, the foreground ones last; flags 1 foreground,
   *  2 hidden while dead, 4 hidden under a menu (none here). Edges in the safe area (w x h), centres in the full view F */
  drawElems(g, w, h, s, F, t, row, flashed = false) {
    const H = this.M.d.psHud, E = H.elems;
    if (!this.txt || !E || !E.stride) return;
    const st = H.ref[row], list = [], dead = H.health[row] <= 0;
    for (let i = E.start[st]; i < E.start[st + 1]; i++) list.push([this.elem(E.ids[i]), i]);
    list.sort((a, b) => u2f(a[0].sort) - u2f(b[0].sort) || a[1] - b[1]);
    const S = { g, w, h, s, F, now: t + E.t0, t, cl: H.client[row], flashed };
    for (const fg of [0, 1]) for (const [e] of list) {
      if ((e.flags & 1) !== fg || (dead && (e.flags & 2))) continue;
      if (e.type === 13) this.drawWaypoint(e, S); else this.drawElem(e, S);
    }
  }

  /** ScrPlace_ApplyX / Y: a virtual place by the alignment -> device pixels */
  placeX(x, a, S) {
    switch (a) {
      case 1: return x * S.s;
      case 2: case 7: return S.F.x + S.F.w / 2 + x * S.s;
      case 3: return S.w + x * S.s;
      case 4: return S.F.x + x * S.F.w / 640;
      case 5: return x;
      default: return (S.w - 640 * S.s) / 2 + x * S.s;
    }
  }
  placeY(y, a, S) {
    switch (a) {
      case 2: case 7: return S.F.y + S.F.h / 2 + y * S.s;
      case 3: return S.h + y * S.s;
      case 4: return S.F.y + y * S.F.h / 480;
      case 5: return y;
      default: return y * S.s;
    }
  }

  /** BG_LerpHudColors */
  elemColor(e, now) {
    const color = rgba(e['color.rgba']);
    if (!(e.fadeTime > 0 && now - e.fadeStartTime < e.fadeTime)) return color;
    const f = clamp01((now - e.fadeStartTime) / e.fadeTime), from = rgba(e['fromColor.rgba']);
    return color.map((c, i) => from[i] + (c - from[i]) * f);
  }

  /** DrawOffscreenViewableWaypoint (cg_hudelem.cpp 1322): a script's world icon that stays on the screen (the bomb for the
   *  attackers, "defend" over its carrier ...). Sizes in virtual units times ScrPlace's scaleVirtualToReal of the whole view
   *  (x: min(h * 4 / 3, w) / 640, y: h / 480); WorldPosToScreenPos in the whole view, waypointTweakY, ClampScreenPosToEdges
   *  inside the HUD area (the engine's realViewableMin / Max - here the part of the view the viewer's controls leave), the
   *  off-screen arrow, then GetScaleForDistance. The icon on whole device pixels (sharp at any size and pixel ratio). The
   *  waypoints without an off-screen image are sprites in the world; the scripts' are never visible (objpoint_default,
   *  alpha 0), so they are not drawn */
  drawWaypoint(e, S) {
    const T = this.txt, cam = this.camera, D = DVARS, { g, F, now, t, w, h } = S;
    const mat = e.offscreenMaterialIdx ? this.csAt(C4.constants.CS.SERVER_MATERIALS + e.offscreenMaterialIdx, t).toLowerCase() : '';
    if (!mat || !cam || S.flashed) return;
    const color = this.elemColor(e, now);
    if (color[3] <= 0.002) return;
    const sx = Math.min(F.h * 4 / 3, F.w) / 640, sy = F.h / 480, avg = (sx + sy) / 2;
    let iconW = D.waypointIconWidth * sx, iconH = D.waypointIconHeight * sy;
    const pointerW = D.waypointOffscreenPointerWidth * sx, pointerH = D.waypointOffscreenPointerHeight * sy;
    const pointerDist = D.waypointOffscreenPointerDistance * avg;
    const thresholdAlpha = Math.max(0.1, D.waypointOffscreenDistanceThresholdAlpha * avg);
    const padding = pointerH * 0.5 + pointerDist;
    const padL = D.waypointOffscreenPadLeft * sx + padding, padR = D.waypointOffscreenPadRight * sx + padding;
    const padT = D.waypointOffscreenPadTop * sy + padding, padB = D.waypointOffscreenPadBottom * sy + padding;
    let { x, y, z } = e;
    if (e.targetEntNum !== NO_ENTITY) {
      const o = e.targetEntNum === S.cl ? null : this.M.sampleAt(e.targetEntNum, t);
      if (!o || o.age > 1000) return;
      x = o.x; y = o.y;
      z = o.z + (o.prone ? D.waypointPlayerOffsetProne : o.crouch ? D.waypointPlayerOffsetCrouch : D.waypointPlayerOffsetStand);
    }
    // WorldPosToScreenPos (in the whole view; x / y from its top left): behind the eye the left / up projections, pushed out
    // past the view's size
    const m = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements, VW = F.w, VH = F.h;
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12], vy = m[1] * x + m[5] * y + m[9] * z + m[13], depth = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
    let px, py;
    if (depth >= 0 && depth > 1e-6) { px = VW / 2 * (1 + P[0] * vx / depth); py = VH / 2 * (1 - P[5] * vy / depth); } else {
      px = vx; py = -vy;
      if (Math.abs(px) >= 1e-6 || Math.abs(py) >= 1e-6) {
        if (Math.abs(px) < 1e-6) px = 0.001;
        if (Math.abs(py) < 1e-6) py = 0.001;
        while (Math.abs(px) < VW) { px *= VW; py *= VW; }
        while (Math.abs(py) < VH) { px *= VH; py *= VH; }
      } else py = VH * 2;
    }
    py += D.waypointTweakY * sy;
    // ClampScreenPosToEdges: about the view's centre, the borders from the HUD area (realViewableMin / Max) and the pads
    const halfW = VW / 2, halfH = VH / 2, vMinX = -F.x, vMinY = -F.y, vMaxX = -F.x + w, vMaxY = -F.y + h;
    const bl = vMinX + padL - halfW, br = halfW - (VW - vMaxX + padR), bt = vMinY + padT - halfH, bb = halfH - (VH - vMaxY + padB);
    let qx = px - halfW, qy = py - halfH, clamped = false;
    if (qx < bl) { const k = bl / qx; qx *= k; qy *= k; clamped = true; } else if (qx > br) { const k = br / qx; qx *= k; qy *= k; clamped = true; }
    if (qy < bt) { const k = bt / qy; qx *= k; qy *= k; clamped = true; } else if (qy > bb) { const k = bb / qy; qx *= k; qy *= k; clamped = true; }
    if (D.waypointOffscreenRoundedCorners) {
      const radius = avg * D.waypointOffscreenCornerRadius, left = qx < 0, top = qy < 0;
      const fx = left ? bl + radius : br - radius, fy = top ? bt + radius : bb - radius;
      let dx = qx - fx, dy = qy - fy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      if (((left && dx < 0) || (!left && dx > 0)) && ((top && dy < 0) || (!top && dy > 0)) && radius < Math.hypot(qx - fx, qy - fy)) {
        qx = radius * dx + fx; qy = radius * dy + fy; clamped = true;
      }
    }
    const sxp = qx + halfW, syp = qy + halfH, col = color.slice(0, 3);
    if (clamped) {
      const dist = Math.hypot(px - sxp, py - syp);
      if (dist > 0) {
        const ux = (px - sxp) / dist, uy = (py - syp) / dist;
        const shrink = D.waypointOffscreenScaleLength * avg;
        const k = shrink <= dist ? D.waypointOffscreenScaleSmallest : (dist / shrink) * D.waypointOffscreenScaleSmallest + (1 - dist / shrink);
        iconW *= k; iconH *= k;
        g.save();
        g.translate(F.x + sxp + pointerDist * ux, F.y + syp + pointerDist * uy);
        g.rotate(Math.atan2(ux, -uy));
        T.pic(g, 'offscreenobjectivepointer', -pointerW / 2, -pointerH / 2, pointerW, pointerH, col, color[3] * Math.min(1, dist / thresholdAlpha));
        g.restore();
      }
    }
    // GetScaleForDistance (from the eye), then the icon centred on its place - on whole device pixels
    const d3 = Math.hypot(x - cam.position.x, y - cam.position.y, z - cam.position.z);
    const r = d3 <= D.waypointDistScaleRangeMin ? 0 : d3 >= D.waypointDistScaleRangeMax ? 1
      : (d3 - D.waypointDistScaleRangeMin) / Math.max(1, D.waypointDistScaleRangeMax - D.waypointDistScaleRangeMin);
    const ds = r * D.waypointDistScaleSmallest + (1 - r);
    iconW *= ds; iconH *= ds;
    const iw = Math.max(1, Math.round(iconW)), ih = Math.max(1, Math.round(iconH));
    g.save();
    g.imageSmoothingQuality = 'high';
    T.pic(g, mat, Math.round(F.x + sxp - iw / 2), Math.round(F.y + syp - ih / 2), iw, ih, col, color[3]);
    g.restore();
    // (a check's record of the drawn waypoints - hud.debug, off by default)
    if (this.debug) (this.drawn || (this.drawn = [])).push({ mat, clamped, x: Math.round(F.x + sxp - iw / 2), y: Math.round(F.y + syp - ih / 2), w: iw, h: ih, alpha: color[3], dist: Math.round(d3) });
  }

  /** the side number of client cl at t (team numbers: 1 axis, 2 allies) or 0 */
  teamNum(cl, t) {
    const M = this.M, p = M.player(cl), r = M.roundAtOrBefore(t), attack = M.d.meta && M.d.meta.attackSide;
    const role = p && r && r.sides ? r.sides[p.team] : null;
    if (!role || !attack) return 0;
    return (role === 'attack' ? attack : attack === 'axis' ? 'allies' : 'axis') === 'axis' ? 1 : 2;
  }

  /** CG_CompassDrawPlayerPointers_MP: the objectives of the player state at t (OBJST_ACTIVE / CURRENT; for cl's team), an
   *  objective on a player at that player, compassObjectiveWidth / Height times compassSize, centred on its place clipped to the
   *  map's edge; beyond compassMaxRange its alpha goes down to compassObjectiveMinAlpha at compassObjectiveMaxRange. (The lines
   *  to an OBJST_CURRENT objective are not drawn: the MP scripts' objectives are "active" ones - _gameobjects.gsc) */
  drawObjectives(g, t, cl, sx, sy, toCompass) {
    const H = this.M.d.psHud, T = this.txt, D = DVARS, me = this.M.sampleAt(cl, t);
    if (!T || !me || !H.objs || !H.objs.length) return;
    const i = lower(H.t, t), list = i >= 0 ? H.objs[H.objRef[i]] : null, mine = this.teamNum(cl, t);
    const w = D.compassObjectiveWidth * D.compassSize * sx, h = D.compassObjectiveHeight * D.compassSize * sy;
    for (const [ox, oy, , icon, ent, team] of list || []) {
      if (team && team !== mine) continue;
      let x = ox, y = oy;
      if (ent < 64) { const o = this.M.sampleAt(ent, t); if (o) { x = o.x; y = o.y; } }
      const dist = Math.hypot(x - me.x, y - me.y);
      let alpha = 1;
      if (dist > D.compassMaxRange) {
        const span = D.compassObjectiveMaxRange - D.compassMaxRange;
        alpha = dist >= D.compassObjectiveMaxRange ? D.compassObjectiveMinAlpha : 1 - (1 - D.compassObjectiveMinAlpha) * (span ? (dist - D.compassMaxRange) / span : 0);
      }
      const [px, py] = toCompass(x, y);
      T.pic(g, this.csAt(C4.constants.CS.SERVER_MATERIALS + icon, t).toLowerCase(), px - w / 2, py - h / 2, w, h, WHITE, alpha);
    }
  }

  /** DrawSingleHudElem2d */
  drawElem(e, S) {
    const T = this.txt, { g, s, now, t } = S;
    const color = this.elemColor(e, now);
    if (color[3] <= 0.002) return;
    // GetHudElemInfo: the font, the label and the text
    const [base, kind] = ELEM_FONTS[e.font] || ELEM_FONTS[0], scale = base * e.fontScale, fh = scale * 48, real = scale * s * s;
    let label = e.label ? T.localize(this.csAt(C4.constants.CS.LOCALIZED + e.label, t)) : '', text = '';
    switch (e.type) {
      case 1: text = e.text ? T.localize(this.csAt(C4.constants.CS.LOCALIZED + e.text, t)) : ''; break;
      case 2: text = String(Number(e.value.toPrecision(6))); break;
      case 3: { const p = this.M.player(Math.round(e.value)); text = p ? p.name : ''; break; }
      case 4: text = this.M.d.meta.map || ''; break;
      case 5: text = this.M.d.meta.gametype || ''; break;
      case 7: text = timer(e.time - now + 999, false); break;
      case 8: text = timer(now - e.time, false); break;
      case 9: text = timer(e.time - now + 99, true); break;
      case 10: text = timer(now - e.time, true); break;
      default: break;
    }
    // ConsolidateHudElemText: the text at the label's &&1, else after it
    if (label && text) { text = label.includes('&&1') ? label.replace('&&1', text) : label + text; label = ''; }
    const isText = TEXT_TYPES.has(e.type);
    if (isText) text = label || text;
    if (isText && !text) return;
    // the letters of a pulse (setPulseFX): typed out, gone after the decay
    let alpha = color[3];
    if (isText && e.fxBirthTime) {
      const age = now - e.fxBirthTime;
      if (age < 0) return;
      if (e.fxLetterTime > 0) text = text.slice(0, Math.ceil(age / e.fxLetterTime));
      if (e.fxDecayStartTime > 0 && age > e.fxDecayStartTime) alpha *= e.fxDecayDuration > 0 ? 1 - clamp01((age - e.fxDecayStartTime) / e.fxDecayDuration) : 0;
      if (alpha <= 0 || !text) return;
    }
    // the size: the text's, or the element's with the scale change (HudElemWidth / Height: in virtual units)
    const scaled = (to, from) => {
      const v = to || fh;
      return e.scaleTime > 0 && now - e.scaleStartTime < e.scaleTime ? (from || fh) + (v - (from || fh)) * clamp01((now - e.scaleStartTime) / e.scaleTime) : v;
    };
    const ew = isText ? T.width(text, scale, 1, kind, real) : scaled(e.width, e.fromWidth), eh = isText ? fh : scaled(e.height, e.fromHeight);
    // the place (GetHudElemOrg: the screen's alignment, then the element's own); moving from its last one
    const org = (x, y, ao, as) => {
      const ax = (ao >> 2) & 3, ay = ao & 3;
      return [this.placeX(x, (as >> 3) & 7, S) - ew * s * (ax === 1 ? 0.5 : ax === 2 ? 1 : 0), this.placeY(y, as & 7, S) - eh * s * (ay === 1 ? 0.5 : ay === 2 ? 1 : 0)];
    };
    let [x, y] = org(e.x, e.y, e.alignOrg, e.alignScreen);
    const moving = e.moveTime > 0 && now - e.moveStartTime < e.moveTime;
    if (moving) {
      const f = clamp01((now - e.moveStartTime) / e.moveTime), p = org(e.fromX, e.fromY, e.fromAlignOrg, e.fromAlignScreen);
      x = p[0] + (x - p[0]) * f; y = p[1] + (y - p[1]) * f;
    } else { x = Math.round(x); y = Math.round(y); }
    const col = color.slice(0, 3);
    if (isText) { T.draw(g, text, x, y + fh * s, scale, s, col, alpha, 3, kind, real); return; }
    if (e.type !== 6 && e.type !== 11 && e.type !== 12) return;
    const mat = e.materialIndex > 0 ? this.csAt(C4.constants.CS.SERVER_MATERIALS + e.materialIndex, t).toLowerCase() : '';
    if (mat && mat !== 'damage_feedback') T.pic(g, mat, x, y, ew * s, eh * s, col, alpha);
  }

  drawNames(g, w, h, s, row) {
    const H = this.M.d.psHud, id = H.ident[row];
    if (!(id >= 0 && id < 64) || id === H.client[row]) return;
    const p = this.M.player(id);
    if (!p) return;
    this.say(g, p.cleanName, w / 2, h / 2 + 33 * s, 0.25, s, hexColor(this.M.color(id)), 0.9, 1);
  }
}
