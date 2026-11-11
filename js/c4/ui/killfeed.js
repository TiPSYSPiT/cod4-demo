/* The game's kill feed, for the 3D view and both video exports: the obituaries and the server's messages in the game message
 * window, as the client draws them - cl_console.cpp (the window's lines and their times), CG_Obituary and CL_DeathMessagePrint
 * (the line), RB_DrawHudIcon (its icon), CG_DrawScoreboard_GetTeamColorIndex and CL_LookupColor (the colours); the game's
 * font through hudtext.js, the icons of C4.weapons.killIcons. A pure function of the replay time and the player seen, so pause,
 * seeking and the playback speed need no state: the window's lines are worked out once, in the order they came.
 * An ES module (`import '../c4/ui/killfeed.js'`), so a view module never depends on the page's script list. It needs the
 * classic scripts C4.weapons and C4.events, which the page loads before any module. */
import { loadHudText } from '../../view3d/hudtext.js';
import { loadImage } from '../../app/retry.js';

const C4 = window.C4;
// ui_mp/hud.menu "gamemessages", "boldgamemessages" (rect, textscale); con_gameMsgWindow0 / 1 MsgTime, LineCount, ScrollTime,
// FadeInTime, FadeOutTime. Con_InitMessageBuffer: lines + 3, padding 3
const WINDOWS = [{ x: 6, y: -65, textScale: 0.28125, time: 5000, lines: 4, scroll: 250, fadeIn: 250, fadeOut: 500 },
  { x: 0, y: -60, textScale: 0.417, time: 8000, lines: 5, scroll: 250, fadeIn: 250, fadeOut: 10 }];
const PADDING = 3;
const ALLIES = [0.6, 0.64, 0.69], AXIS = [0.65, 0.57, 0.41];       // the defaults of g_TeamColor_Allies / Axis
const WHITE = [1, 1, 1];
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const upper = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };
const dvarColor = (v, def) => { const a = String(v || '').trim().split(/\s+/).map(Number); return a.length >= 3 && a.every(Number.isFinite) ? a.slice(0, 3) : def; };

/** One of the client's message windows over a demo. messages: [{t, ...}] in time order; clears: the times the window empties
 *  (a map_restart: Con_ClearNotify - the start of every round) */
class MessageWindow {
  constructor(W, messages, clears) {
    this.W = W;
    this.lines = [];
    const count = W.lines + PADDING;
    let active = [], ci = 0;
    const clear = t => { for (const l of active) l.end = Math.min(l.end, t); active = []; };
    for (const m of messages) {
      while (ci < clears.length && clears[ci] <= m.t) clear(clears[ci++]);
      while (active.length && m.t >= active[0].end) active.shift();            // Con_CullFinishedLines
      if (active.length === count) { const first = active.shift(); first.end = Math.min(first.end, m.t); }
      const line = { t: m.t, end: m.t + W.time, m };
      active.push(line);
      this.lines.push(line);
      // Con_UpdateMessageWindowLine: past the visible lines the oldest fades out at once
      const pad = active.length - (count - PADDING);
      if (pad > 0 && active[pad - 1].end - W.fadeOut > m.t) active[pad - 1].end = m.t + W.fadeOut;
    }
    while (ci < clears.length) clear(clears[ci++]);
    this.times = this.lines.map(l => l.t);
  }
  /** the lines alive at t, oldest first */
  at(t) {
    const out = [];
    for (let i = upper(this.times, t) - 1; i >= 0 && t - this.times[i] < this.W.time; i--) if (this.lines[i].end > t) out.unshift(this.lines[i]);
    return out;
  }
  /** Con_GetMessageAlpha */
  alpha(l, t) {
    const W = this.W, left = l.end - t, age = t - l.t;
    return clamp01((left < W.fadeOut ? left / W.fadeOut : 1) * (age < W.fadeIn ? age / W.fadeIn : 1));
  }
  /** Con_DrawMessageWindowNewToOld (up): [{m, y, alpha}] newest first - y: the line's baseline over the window's, in virtual
   *  units of charHeight lines, a new line pushing the others up as it scrolls in */
  rows(t, charHeight) {
    const lines = this.at(t);
    let y = 0;
    for (const l of lines) { const age = t - l.t; if (age < this.W.scroll) y += Math.round(charHeight * clamp01(1 - age / this.W.scroll)); }
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) { y -= charHeight; out.push({ m: lines[i].m, y, alpha: this.alpha(lines[i], t) }); }
    return out;
  }
}

/** the windows of a demo: its kills and the recorder's messages, emptied at the rounds' start */
function messagesOf(d) {
  const msgs = (d.psHud && d.psHud.messages) || [];
  const byTime = (a, b) => a.t - b.t;
  return [d.kills.map(k => ({ t: k.t, kill: k })).concat(msgs.filter(m => !m[1]).map(m => ({ t: m[0], text: m[2] }))).sort(byTime),
    msgs.filter(m => m[1]).map(m => ({ t: m[0], text: m[2] })).sort(byTime)];
}

class Feed {
  constructor(d) {
    this.d = d;
    this.players = new Map(d.players.map(p => [p.client, p]));
    const clears = d.rounds.map(r => r.segStart).filter(Number.isFinite).sort((a, b) => a - b), [plain, bold] = messagesOf(d);
    this.window = new MessageWindow(WINDOWS[0], plain, clears);
    this.bold = new MessageWindow(WINDOWS[1], bold, clears);
  }
  /** the side a team plays at t: 'axis' / 'allies' (the round's attack / defence, the demo's attackers), null before it is known */
  sideAt(key, t) {
    const d = this.d, m = d.meta || {};
    let ri = C4.events.roundAt(d.rounds, t);
    if (ri < 0) for (let i = 0; i < d.rounds.length; i++) if (d.rounds[i].segStart <= t) ri = i;
    const role = ri >= 0 && d.rounds[ri].sides ? d.rounds[ri].sides[key] : null;
    if (!role || !m.attackSide) return null;
    return role === 'attack' ? m.attackSide : m.attackSide === 'axis' ? 'allies' : 'axis';
  }
  /** CL_LookupColor: [^8, ^9] for a viewer of team key: his side's colour and the other's (no team: as the allies) */
  teamColors(key, t) {
    const dv = (this.d.meta && this.d.meta.dvars) || {};
    const allies = dvarColor(dv.g_TeamColor_Allies, ALLIES), axis = dvarColor(dv.g_TeamColor_Axis, AXIS);
    return this.sideAt(key, t) === 'axis' ? [axis, allies] : [allies, axis];
  }
  /** CG_DrawScoreboard_GetTeamColorIndex: 7 without a team on either side, 8 the viewer's team, 9 the other */
  code(team, viewer) {
    const inTeam = x => x === 'A' || x === 'B';
    return !inTeam(team) || !inTeam(viewer) ? '7' : team === viewer ? '8' : '9';
  }
  /** CG_Obituary, CL_DeathMessagePrint: {attacker, icon, victim}: the texts with their colour codes, no attacker for a suicide or
   *  the world */
  line(k, viewer) {
    const name = cl => { const p = this.players.get(cl); return p ? p.name : ''; };
    const team = (cl, tm) => tm || (this.players.get(cl) || {}).team;
    const own = k.attacker === k.victim || k.attacker == null || k.attacker >= 64;
    return { attacker: own ? '' : '^' + this.code(team(k.attacker, k.attackerTeam), viewer) + name(k.attacker) + '^7 ',
      icon: C4.weapons.killIcons(k).game, victim: ' ^' + this.code(team(k.victim, k.victimTeam), viewer) + name(k.victim) };
  }
  /** the window into g at t: w x h device pixels (the safe area, its corner at the origin); pov: the client seen; assets: ready() */
  draw(g, t, { w, h, pov, assets }) {
    const T = assets && assets.txt;
    if (!T) return;
    const W = WINDOWS[0], s = h / 480, charHeight = Math.round(W.textScale * 48), scale = charHeight / 48, real = W.textScale * s;
    const rows = this.window.rows(t, charHeight);
    if (!rows.length) return;
    const viewer = (this.players.get(pov) || {}).team, codes = this.teamColors(viewer, t), font = T.fonts.pick(0, real);
    const text = (str, x, y, alpha) => T.draw(g, str, x, y, scale, s, WHITE, alpha, 3, 0, real, codes);
    for (const r of rows) {
      const y = h + (W.y + r.y) * s;
      let x = W.x * s;
      if (!r.m.kill) { text(T.localize(r.m.text), x, y, r.alpha); continue; }
      const L = this.line(r.m.kill, viewer);
      x += text(L.attacker, x, y, r.alpha);
      x += this.icon(g, assets.imgs, L.icon, x, y, font.height, scale * 48 / font.height * s, r.alpha);
      text(L.victim, x, y, r.alpha);
    }
  }
  /** RB_DrawHudIcon: the whole image, its size in the font's lines (the size rounded to 1/32 of a line), centred on the line, mirrored
   *  by flipKillIcon; no shadow -> the width */
  icon(g, imgs, ic, x, y, height, k, alpha) {
    const img = ic && imgs && imgs.get(ic.file);
    if (!img) return 0;
    const dim = v => Math.floor((height * Math.max(16, Math.min(127, Math.round(v * 32))) + 16) / 32) * k;
    const w = dim(ic.lines[0]), hh = dim(ic.lines[1]), top = y - (height * k + hh) / 2;
    g.save();
    g.globalAlpha = alpha;
    if (ic.flip) { g.translate(x + w, top); g.scale(-1, 1); g.drawImage(img, 0, 0, w, hh); } else g.drawImage(img, x, top, w, hh);
    g.restore();
    return w;
  }
}

let loading = null;
/** all icon images, loaded once -> Promise<Map file -> HTMLImageElement> (a file that fails to load is left out) */
function images() {
  if (!loading) {
    // (tried again on a failed load: retry.js)
    loading = Promise.all(Object.keys(C4.weapons.ICONS).map(file => loadImage(C4.weapons.ICON_DIR + file).then(img => [file, img])
      .catch(() => { console.warn('kill feed icon not loaded:', file); return null; }))).then(list => new Map(list.filter(Boolean)));
  }
  return loading;
}
/** the font and the icons -> Promise<{txt, imgs}> (txt null without maps3d/_hud: nothing is drawn) */
const ready = () => Promise.all([loadHudText(), images()]).then(([txt, imgs]) => ({ txt, imgs }));

C4.killfeed = { WINDOWS, MessageWindow, Feed, images, ready };
