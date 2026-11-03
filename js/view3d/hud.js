/* The game's HUD in first person (Promod's ui_mp/hud.menu over the stock client code), drawn on a 2D canvas over
 * the 3D view - and into every frame of the video export (drawTo). The images are the game's (maps3d/_hud,
 * tools/export/hud_export.py; the minimap is the compass map of assets/maps); the layout is the menu's 640 x 480
 * screen, one scale (height / 480), anchored left / right:
 *   minimap      CG_PLAYER_COMPASS_MAP: the map turned with the view (the view up), compassMaxRange 2500 units
 *                to the edge, in minimap_background; the teammates (their arrows), the enemies while they fire
 *                (compassping_enemyfiring, ~1 s) and the player (compassping_player) - Promod's top left square
 *   ammo         CG_PLAYER_AMMO_VALUE: the clip (red below a third) and the reserve, the weapon's name and icon;
 *                the frag and special grenades with their counts (the player state's ammo / clip slots:
 *                BG_SetupAmmoIndexes / ClipIndexes - the n-th ammo / clip name in the weapon list's order)
 *   health       CG_PLAYER_LOW_HEALTH_OVERLAY: overlay_low_health over the screen, stronger and pulsing as the
 *                health falls
 *   damage       CG_DrawDamageDirectionIndicators: damage_feedback towards the attacker for 2 s
 *                (cg_hudDamageIconWidth 128, Height 64, Offset 128, Time 2000 - the values Promod enforces)
 *   names        CG_DrawCrosshairNames: the teammate under the crosshair (stats[3]) below it
 *   hints        CG_CURSORHINT: the use icon while the server shows a hint (planting / defusing the bomb ...)
 *   scoreboard   Tab (held): the teams with each player's kills and deaths so far
 * Promod hides the stance indicator (its rect lies off the screen) - so does this HUD. Only the recorder has a
 * player state: the ammo, health, damage, names and hints are his; for another player the minimap. The server's
 * own HUD elements (hudelems) are not drawn. */
import { isPromod } from './viewmodel.js';

const BASE = 'maps3d/';
const D2R = Math.PI / 180;
const MAX_RANGE = 2500;                  // compassMaxRange (the client's default)
const MINIMAP = { x: 6, y: 6, size: 120, inset: 9 };
const DAMAGE = { w: 128, h: 64, offset: 128, time: 2000 };
const FIRE_PING_MS = 1000;
const HUD_ALPHA = 0.65;
const LOW = '#e32e03';
const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const GRENADES = { frag_grenade_mp: 'hud_us_grenade', flash_grenade_mp: 'hud_us_flashgrenade', smoke_grenade_mp: 'hud_us_smokegrenade',
  concussion_grenade_mp: 'hud_us_stungrenade' };
// (images the archives do not hold: the weapon's own picture)
const FALLBACK_ICON = { frag_grenade_mp: 'weapon_fraggrenade', flash_grenade_mp: 'weapon_flashbang', smoke_grenade_mp: 'weapon_smokegrenade',
  concussion_grenade_mp: 'weapon_concgrenade' };

const lower = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };

export class GameHud {
  constructor(M, table) {
    this.M = M;
    this.table = table;                  // viewmodels.json (the weapon files' numbers) or null
    this.promod = isPromod(M);           // (a Promod server: its weapon files' names and numbers)
    this.enabled = true;
    this.scoreboard = false;
    this.images = new Map();
    this.imgList = null;
    fetch(BASE + '_hud/hud.json').then(r => (r.ok ? r.json() : null)).then(h => {
      this.imgList = (h && h.images) || {};
      for (const [k, v] of Object.entries(this.imgList)) this.image(k, BASE + v.file);
    }).catch(() => { this.imgList = {}; });
    const entry = M.mapEntry;
    if (entry && entry.image) this.image('map', 'assets/maps/' + entry.image);
    this.prepare();
  }

  image(key, src) {
    if (this.images.has(key)) return this.images.get(key);
    const img = new Image();
    img.onload = () => { img.ready = true; if (this.onChange) this.onChange(); };
    img.src = src;
    this.images.set(key, img);
    return img;
  }
  img(key) { const i = this.images.get(key); return i && i.ready ? i : null; }

  /** the recorder's ammo / clip slots over time, the damage events */
  prepare() {
    const d = this.M.d;
    this.slots = [new Map(), new Map()];
    for (const [t, kind, slot, v] of d.psAmmo || []) {
      let s = this.slots[kind].get(slot);
      if (!s) this.slots[kind].set(slot, s = { t: [], v: [] });
      s.t.push(t); s.v.push(v);
    }
    // the damage hits: a new damageEvent counter -> {t, yaw (world, degrees)}
    const H = d.psHud;
    this.hits = [];
    if (H) for (let i = 1; i < H.t.length; i++) {
      if (H.damageEvent[i] !== H.damageEvent[i - 1] && H.client[i] === H.client[i - 1] && H.damageCount[i] > 0) this.hits.push({ t: H.t[i], yaw: (H.damageYaw[i] & 255) * 360 / 256, cl: H.client[i] });
    }
    this.hitTimes = this.hits.map(h => h.t);
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
    const key = list.join('|');
    if (this.slotKey !== key) {
      this.slotKey = key;
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

  /** draw the HUD of client cl at t into the 2D context g (w x h device pixels); view: {yaw, pitch} (null: the
   *  player is dead - only the scoreboard) */
  draw(g, w, h, t, cl, view, weaponName) {
    if (!this.enabled || cl == null) return;
    const M = this.M, s = h / 480, R = x => w - (640 - x) * s;
    g.save();
    if (!view) { if (this.scoreboard) this.drawScoreboard(g, w, h, s, t, cl); g.restore(); return; }
    const row = this.hudRow(cl, t), H = M.d.psHud;
    // the low health overlay (below the rest)
    if (row >= 0 && H.maxHealth[row] > 0) {
      const f = H.health[row] / H.maxHealth[row], img = this.img('overlay_low_health');
      if (img && f > 0 && f < 0.55) {
        const pulse = 0.85 + 0.15 * Math.sin(t / 1000 * Math.PI * 2 * (f < 0.3 ? 2 : 1));
        g.globalAlpha = Math.min(1, (0.55 - f) / 0.45) * pulse;
        g.drawImage(img, 0, 0, w, h);
      }
    }
    this.drawMinimap(g, s, t, cl, view);
    if (row >= 0) {
      this.drawDamage(g, w, h, s, t, cl, view);
      this.drawAmmo(g, s, R, t, cl, weaponName);
      this.drawNames(g, w, h, s, row);
      if (H.hint[row]) {
        const img = this.img('hint_usable');
        if (img) { g.globalAlpha = 1; g.drawImage(img, w / 2 - 20 * s, h / 2 + 40 * s, 40 * s, 40 * s); }
      }
    }
    if (this.scoreboard) this.drawScoreboard(g, w, h, s, t, cl);
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
    g.restore();
    // the player
    const pl = this.img('compassping_player'), sz = 16 * s;
    g.globalAlpha = 1;
    if (pl) g.drawImage(pl, cx - sz / 2, cy - sz / 2, sz, sz);
  }

  drawDamage(g, w, h, s, t, cl, view) {
    const img = this.img('damage_feedback');
    if (!img) return;
    for (let i = lower(this.hitTimes, t); i >= 0 && t - this.hitTimes[i] < DAMAGE.time; i--) {
      const hit = this.hits[i];
      if (hit.cl !== cl) continue;
      const a = 1 - (t - hit.t) / DAMAGE.time;
      // the attacker's direction relative to the view (the indicator turns around the crosshair)
      const rel = (view.yaw - hit.yaw) * D2R;
      g.save();
      g.translate(w / 2, h / 2); g.rotate(rel);
      g.globalAlpha = a;
      g.drawImage(img, -DAMAGE.w / 2 * s, -(DAMAGE.offset + DAMAGE.h / 2) * s, DAMAGE.w * s, DAMAGE.h * s);
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
    g.textBaseline = 'alphabetic';
    if (P && slots && (P.clipSize || 0) > 0 && P.inventoryType !== 'offhand') {
      const clip = this.slotAt(1, slots[1], t), ammo = this.slotAt(0, slots[0], t);
      const lowClip = clip <= Math.floor((P.clipSize || 0) / 3);
      g.globalAlpha = 1;
      g.textAlign = 'right';
      g.font = 'bold ' + Math.round(26 * s) + 'px ' + FONT;
      g.lineWidth = 3 * s; g.strokeStyle = 'rgba(0,0,0,0.6)';
      // the clip, then "| reserve" after it (CG_DrawPlayerAmmoValue)
      g.font = Math.round(16 * s) + 'px ' + FONT;
      const res = '| ' + ammo, rw = g.measureText(res).width, xr = R(632) - rw - 4 * s, yb = 462 * s;
      g.textAlign = 'left';
      g.strokeText(res, R(632) - rw, yb); g.fillStyle = ammo <= Math.floor((P.maxAmmo || 0) / 5) ? LOW : 'rgba(255,255,255,0.85)';
      g.fillText(res, R(632) - rw, yb);
      g.textAlign = 'right';
      g.font = 'bold ' + Math.round(26 * s) + 'px ' + FONT;
      g.strokeText(String(clip), xr, yb); g.fillStyle = lowClip ? LOW : '#fff'; g.fillText(String(clip), xr, yb);
    }
    // the weapon's name
    g.textAlign = 'right';
    g.font = Math.round(11 * s) + 'px ' + FONT;
    g.globalAlpha = HUD_ALPHA;
    g.fillStyle = '#fff';
    g.fillText(C4.weapons.label(weaponName), R(632), 436 * s);
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
      g.font = 'bold ' + Math.round(12 * s) + 'px ' + FONT;
      g.fillStyle = n ? '#fff' : LOW; g.textAlign = 'left';
      g.fillText(String(n), x + sz + 2 * s, 404 * s);
    }
  }

  drawNames(g, w, h, s, row) {
    const H = this.M.d.psHud, id = H.ident[row];
    if (!(id >= 0 && id < 64) || id === H.client[row]) return;
    const p = this.M.player(id);
    if (!p) return;
    g.globalAlpha = 0.9; g.textAlign = 'center'; g.textBaseline = 'top';
    g.font = Math.round(11 * s) + 'px ' + FONT;
    g.lineWidth = 3 * s; g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.strokeText(p.cleanName, w / 2, h / 2 + 22 * s);
    g.fillStyle = this.M.color(id); g.fillText(p.cleanName, w / 2, h / 2 + 22 * s);
  }

  /** the scoreboard (Tab): the teams, their players' kills / deaths up to t (the scoreboard's rule) */
  drawScoreboard(g, w, h, s, t, cl) {
    const M = this.M, d = M.d, kd = new Map();
    for (const k of d.kills) {
      if (k.t > t) break;
      const r = C4.build.kdRule(k);
      if (r.credit) { const a = kd.get(k.attacker) || [0, 0]; a[0]++; kd.set(k.attacker, a); }
      if (r.death) { const v = kd.get(k.victim) || [0, 0]; v[1]++; kd.set(k.victim, v); }
    }
    const W = 360 * s, x0 = (w - W) / 2;
    let y = 70 * s;
    g.globalAlpha = 0.8; g.fillStyle = '#0b0d10';
    const teams = d.teams.map(tm => ({ tm, ps: d.players.filter(p => p.team === tm.key) })).filter(x => x.ps.length);
    const rows = teams.reduce((a, x) => a + x.ps.length + 2, 0);
    g.fillRect(x0, y - 8 * s, W, (rows * 14 + 16) * s);
    g.globalAlpha = 1; g.textBaseline = 'top';
    for (const { tm, ps } of teams) {
      g.font = 'bold ' + Math.round(11 * s) + 'px ' + FONT; g.textAlign = 'left'; g.fillStyle = M.app ? M.app.teamColor(tm.key) : '#fff';
      g.fillText(tm.name, x0 + 10 * s, y);
      g.textAlign = 'right'; g.fillStyle = '#9aa0a6';
      g.fillText('K', x0 + W - 50 * s, y); g.fillText('D', x0 + W - 12 * s, y);
      y += 16 * s;
      g.font = Math.round(11 * s) + 'px ' + FONT;
      for (const p of ps.slice().sort((a, b) => ((kd.get(b.client) || [0])[0] - (kd.get(a.client) || [0])[0]))) {
        const v = kd.get(p.client) || [0, 0];
        g.textAlign = 'left'; g.fillStyle = p.client === cl ? '#ffd76a' : '#e8eaed';
        g.fillText(p.cleanName, x0 + 10 * s, y);
        g.textAlign = 'right';
        g.fillText(String(v[0]), x0 + W - 50 * s, y); g.fillText(String(v[1]), x0 + W - 12 * s, y);
        y += 14 * s;
      }
      y += 12 * s;
    }
  }
}
