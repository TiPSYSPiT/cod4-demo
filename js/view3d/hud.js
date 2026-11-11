/* The game's HUD in first person (Promod's ui_mp/hud.menu over the stock client code), drawn on a 2D canvas over
 * the 3D view - and into every frame of the video export (drawTo). The images are the game's (maps3d/_hud,
 * tools/export/hud_export.py; the minimap is the compass map of assets/maps); the layout is the menu's 640 x 480
 * screen, one scale (height / 480), anchored left / right:
 *   minimap      CG_PLAYER_COMPASS_MAP: the map turned with the view (the view up), compassMaxRange 2500 units
 *                to the edge, in minimap_background; the teammates (their arrows), the enemies while they fire
 *                (compassping_enemyfiring, ~1 s), the objectives of the player state (bomb sites, the bomb and its
 *                carrier: CG_CompassDrawPlayerObjectives, at the edge when out of range) and the player
 *                (compassping_player) - Promod's top left square
 *   ammo         CG_PLAYER_AMMO_VALUE: the clip (red below a third) and the reserve, the weapon's name and icon;
 *                the frag and special grenades with their counts (the player state's ammo / clip slots:
 *                BG_SetupAmmoIndexes / ClipIndexes - the n-th ammo / clip name in the weapon list's order)
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

const BASE = 'maps3d/';
const D2R = Math.PI / 180;
const MAX_RANGE = 2500;                  // compassMaxRange (the client's default)
const MINIMAP = { x: 6, y: 6, size: 120, inset: 9 };
const FIRE_PING_MS = 1000;
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

  /** the recorder's ammo / clip slots over time, the hit marker's states */
  prepare() {
    const d = this.M.d;
    this.slots = [new Map(), new Map()];
    for (const [t, kind, slot, v] of d.psAmmo || []) {
      let s = this.slots[kind].get(slot);
      if (!s) this.slots[kind].set(slot, s = { t: [], v: [] });
      s.t.push(t); s.v.push(v);
    }
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

  /** the ammo / clip slot of a weapon (BG_SetupAmmoIndexes / ClipIndexes): the n-th different ammo / clip name
   *  (strcmp: case kept, trimmed; none -> the weapon's own name) in the weapon list's order, from weapon 1 on */
  slotOf(list, name) {
    if (!this.table || !list) return null;
    if (this.slotList !== list) {
      this.slotList = list;
      const ammo = [], clip = [], map = new Map();
      for (const raw of list) {
        const n = String(raw).toLowerCase(), P = this.params(n);
        const an = (P && P.ammoName) || n, cn = (P && P.clipName) || n;
        let a = ammo.indexOf(an); if (a < 0) { a = ammo.length; ammo.push(an); }
        let c = clip.indexOf(cn); if (c < 0) { c = clip.length; clip.push(cn); }
        map.set(n, [a, c]);
      }
      this.slotMap = map;
    }
    return this.slotMap.get(String(name).toLowerCase()) || null;
  }
  slotAt(kind, slot, t) {
    const s = this.slots[kind].get(slot);
    if (!s) return 0;
    const i = lower(s.t, t);
    return i >= 0 ? s.v[i] : 0;
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
    const M = this.M, s = h / 480, R = x => w - (640 - x) * s;
    const row = this.hudRow(cl, t), H = M.d.psHud;
    g.save();
    // (dead: the scripts' elements stay - "You will spawn next round", the timers)
    const Fv = full || { x: 0, y: 0, w, h };
    this.drawMessages(g, w, h, s, Fv, t, cl);
    if (!view) { if (row >= 0) this.drawElems(g, w, h, s, Fv, t, row); g.restore(); return; }
    this.drawMinimap(g, s, t, cl, view);
    if (row >= 0) {
      const F = full || { x: 0, y: 0, w, h };
      g.save(); g.translate(F.x, F.y);
      this.drawHitMarker(g, F.w, F.h, F.h / 480, t, cl);
      g.restore();
      this.drawAmmo(g, s, R, t, cl, weaponName);
      this.drawNames(g, w, h, s, row);
      this.drawElems(g, w, h, s, full || { x: 0, y: 0, w, h }, t, row, view.flashed);
      this.drawHints(g, s, Fv, t, row);
    }
    g.restore();
  }

  drawMinimap(g, s, t, cl, view) {
    const M = this.M, me = M.sampleAt(cl, t), map = this.img('map'), rect = M.rect;
    if (!me) return;
    const S = MINIMAP.size * s, x0 = MINIMAP.x * s, y0 = MINIMAP.y * s, cx = x0 + S / 2, cy = y0 + S / 2;
    const bg = this.img('minimap_background');
    const inner = S - 2 * MINIMAP.inset * s, k = inner / 2 / MAX_RANGE;
    g.globalAlpha = 0.6; g.fillStyle = '#000';
    g.fillRect(cx - inner / 2, cy - inner / 2, inner, inner);
    g.globalAlpha = 1;
    if (bg) g.drawImage(bg, x0 - 4 * s, y0 - 4 * s, S + 8 * s, S + 8 * s);
    const sy = Math.sin(view.yaw * D2R), cyw = Math.cos(view.yaw * D2R);
    // world (x, y) -> screen: the view's forward up, its right to the right
    const toScreen = (x, y) => { const dx = x - me.x, dy = y - me.y; return [cx + k * (dx * sy - dy * cyw), cy - k * (dx * cyw + dy * sy)]; };
    g.save();
    g.beginPath(); g.rect(cx - inner / 2, cy - inner / 2, inner, inner); g.clip();
    if (map && rect) {
      const ax = (rect.maxX - rect.minX) / map.naturalWidth, ay = (rect.maxY - rect.minY) / map.naturalHeight;
      const ox = rect.minX - me.x, oy = rect.maxY - me.y;
      g.save();
      g.transform(k * sy * ax, -k * cyw * ax, k * cyw * ay, k * sy * ay, cx + k * (sy * ox - cyw * oy), cy - k * (cyw * ox + sy * oy));
      g.globalAlpha = 0.9;
      g.drawImage(map, 0, 0);
      g.restore();
    }
    // teammates (arrows by their yaw) and enemies firing
    const team = (M.player(cl) || {}).team;
    const friend = this.img('compassping_green_mp'), enemy = this.img('compassping_enemyfiring');
    for (const p of M.d.players) {
      if (p.client === cl || (p.team !== 'A' && p.team !== 'B')) continue;
      const o = M.sampleAt(p.client, t);
      if (!o || o.age > 1000) continue;
      const [px, py] = toScreen(o.x, o.y);
      if (p.team === team) {
        const sz = 12 * s;
        g.save(); g.translate(px, py); g.rotate((view.yaw - o.yaw) * D2R); g.globalAlpha = 1;
        if (friend) g.drawImage(friend, -sz / 2, -sz / 2, sz, sz);
        else { g.fillStyle = '#7fe07f'; g.beginPath(); g.moveTo(0, -sz / 2); g.lineTo(sz / 3, sz / 2); g.lineTo(-sz / 3, sz / 2); g.closePath(); g.fill(); }
        g.restore();
      } else {
        const a = this.shots.get(p.client);
        const i = a ? lower(a, t) : -1;
        if (i < 0 || t - a[i] > FIRE_PING_MS) continue;
        const sz = 14 * s;
        g.globalAlpha = 1 - (t - a[i]) / FIRE_PING_MS;
        if (enemy) g.drawImage(enemy, px - sz / 2, py - sz / 2, sz, sz);
        else { g.fillStyle = '#e04040'; g.beginPath(); g.arc(px, py, sz / 3, 0, Math.PI * 2); g.fill(); }
      }
    }
    this.drawObjectives(g, t, cl, s, toScreen, cx, cy, inner / 2);
    g.restore();
    // the player
    const pl = this.img('compassping_player'), sz = 16 * s;
    g.globalAlpha = 1;
    if (pl) g.drawImage(pl, cx - sz / 2, cy - sz / 2, sz, sz);
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

  drawAmmo(g, s, R, t, cl, weaponName) {
    const M = this.M;
    let list = null;
    for (const wl of M.d.weaponLists || []) { if (wl.t <= t) list = wl.list; else break; }
    if (!weaponName || !list) return;
    const P = this.params(weaponName);
    const slots = this.slotOf(list, weaponName);
    if (P && slots && (P.clipSize || 0) > 0 && P.inventoryType !== 'offhand') {
      const clip = this.slotAt(1, slots[1], t), ammo = this.slotAt(0, slots[0], t);
      const lowClip = clip <= Math.floor((P.clipSize || 0) / 3), lowAmmo = ammo <= Math.floor((P.maxAmmo || 0) / 5);
      // the clip, then "| reserve" after it (CG_DrawPlayerAmmoValue)
      const res = '| ' + ammo, yb = 462 * s, rw = this.say(g, res, R(632), yb, 0.36, s, lowAmmo ? LOW : WHITE, 0.85, 2);
      this.say(g, String(clip), R(632) - rw - 4 * s, yb, 0.5, s, lowClip ? LOW : WHITE, 1, 2);
    }
    // the weapon's name
    this.say(g, C4.weapons.label(weaponName), R(632), 436 * s, 0.25, s, WHITE, HUD_ALPHA, 2);
    // the grenades
    let x = R(632);
    for (const [gn, icon] of Object.entries(GRENADES)) {
      if (!list.some(n => String(n).toLowerCase() === gn)) continue;
      const sl = this.slotOf(list, gn);
      const n = sl ? this.slotAt(0, sl[0], t) + this.slotAt(1, sl[1], t) : 0;
      if (!n && gn !== 'frag_grenade_mp') continue;
      const img = this.img(icon) || this.img(FALLBACK_ICON[gn]), sz = 22 * s;
      x -= sz + 20 * s;
      g.globalAlpha = n ? 1 : 0.35;
      if (img) g.drawImage(img, x, 386 * s, sz, sz);
      this.say(g, String(n), x + sz + 2 * s, 404 * s, 0.25, s, n ? WHITE : LOW, n ? 1 : 0.35, 0);
    }
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

  /** DrawOffscreenViewableWaypoint: a script's world icon that stays on the screen (the bomb, its carrier for his team ...):
   *  36 x 36 at the world position, smaller with the distance, held at the screen's edge with an arrow to where it is. The
   *  waypoints without an off-screen image are sprites in the world; the scripts' are never visible (objpoint_default,
   *  alpha 0), so they are not drawn */
  drawWaypoint(e, S) {
    const T = this.txt, cam = this.camera, { g, s, F, now, t, w, h } = S;
    const mat = e.offscreenMaterialIdx ? this.csAt(C4.constants.CS.SERVER_MATERIALS + e.offscreenMaterialIdx, t).toLowerCase() : '';
    if (!mat || !cam || S.flashed) return;
    const color = this.elemColor(e, now);
    if (color[3] <= 0.002) return;
    let { x, y, z } = e;
    if (e.targetEntNum !== NO_ENTITY) {
      const o = e.targetEntNum === S.cl ? null : this.M.sampleAt(e.targetEntNum, t);
      if (!o || o.age > 1000) return;
      x = o.x; y = o.y; z = o.z + (o.prone ? 30 : o.crouch ? 56 : 74);        // waypointPlayerOffsetProne / Crouch / Stand
    }
    // WorldPosToScreenPos (behind the view: far out in its direction), in the full view
    const m = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements;
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12], vy = m[1] * x + m[5] * y + m[9] * z + m[13], depth = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
    let sx, sy;
    if (depth > 0.01) { sx = F.x + F.w / 2 * (1 + P[0] * vx / depth); sy = F.y + F.h / 2 * (1 - P[5] * vy / depth); } else {
      const k = 4 * Math.max(F.w, F.h) / Math.max(Math.abs(vx), Math.abs(vy), 0.001);
      sx = F.x + F.w / 2 + vx * k; sy = F.y + F.h / 2 - vy * k;
    }
    sy -= 17 * s;                                                                // waypointTweakY
    // ClampScreenPosToEdges: waypointOffscreenPadLeft 103, Bottom 30, the arrow's room everywhere - in the safe area
    const pad = (6 + 30) * s, x0 = 103 * s + pad, x1 = w - pad, y0 = pad, y1 = h - 30 * s - pad;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dx = sx - cx, dy = sy - cy;
    const f = Math.min(1, (x1 - x0) / 2 / Math.max(Math.abs(dx), 0.001), (y1 - y0) / 2 / Math.max(Math.abs(dy), 0.001));
    const px = cx + dx * f, py = cy + dy * f, dist = Math.hypot(sx - px, sy - py), col = color.slice(0, 3);
    if (dist > 0) {
      const ux = (sx - px) / dist, uy = (sy - py) / dist, aw = 25 * s, ah = 12 * s;
      g.save();
      g.translate(px + ux * 30 * s, py + uy * 30 * s);
      g.rotate(Math.atan2(ux, -uy));
      T.pic(g, 'offscreenobjectivepointer', -aw / 2, -ah / 2, aw, ah, col, color[3] * Math.min(1, dist / (30 * s)));
      g.restore();
    }
    // GetScaleForDistance: waypointDistScaleRangeMin 1000, Max 3000, Smallest 0.8
    const d3 = Math.hypot(x - cam.position.x, y - cam.position.y, z - cam.position.z), r = clamp01((d3 - 1000) / 2000), size = 36 * s * (1 - 0.2 * r);
    T.pic(g, mat, px - size / 2, py - size / 2, size, size, col, color[3]);
  }

  /** the side number of client cl at t (team numbers: 1 axis, 2 allies) or 0 */
  teamNum(cl, t) {
    const M = this.M, p = M.player(cl), r = M.roundAtOrBefore(t), attack = M.d.meta && M.d.meta.attackSide;
    const role = p && r && r.sides ? r.sides[p.team] : null;
    if (!role || !attack) return 0;
    return (role === 'attack' ? attack : attack === 'axis' ? 'allies' : 'axis') === 'axis' ? 1 : 2;
  }

  /** CG_CompassDrawPlayerObjectives: the objectives of the player state at t for cl's team, an objective on a player at
   *  that player, one out of range at the map's edge. toScreen: world -> the minimap; half: the map's half size */
  drawObjectives(g, t, cl, s, toScreen, cx, cy, half) {
    const H = this.M.d.psHud, T = this.txt;
    if (!T || !H.objs || !H.objs.length) return;
    const i = lower(H.t, t), list = i >= 0 ? H.objs[H.objRef[i]] : null, mine = this.teamNum(cl, t), size = 16 * s;
    for (const [ox, oy, , icon, ent, team] of list || []) {
      if (team && team !== mine) continue;
      let x = ox, y = oy;
      if (ent < 64) { const o = this.M.sampleAt(ent, t); if (o) { x = o.x; y = o.y; } }
      const [px, py] = toScreen(x, y), dx = px - cx, dy = py - cy, room = half - size / 2;
      const f = Math.min(1, room / Math.max(Math.abs(dx), Math.abs(dy), 0.001));
      T.pic(g, this.csAt(C4.constants.CS.SERVER_MATERIALS + icon, t).toLowerCase(), cx + dx * f - size / 2, cy + dy * f - size / 2, size, size, WHITE, 1);
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
