/* The game's scoreboard while Tab is held (main.js): one canvas over the views - 2D, 3D in every camera mode, fullscreen -,
 * gone when Tab is released, the window loses the focus or the page is hidden. CG_DrawScoreboard_ScoresList's list in the
 * game's fonts: per team a banner (the team's icon, name, count, score) and a row per player in the team's colour - status
 * icon, name, score, kills, assists, deaths, ping - the watched player's text in cg_scoreboardMyColor. Those numbers are the
 * last ones the server sent ("b": the recorder must have looked at the scoreboard), as in the game; a player the server did
 * not list yet has the kills and deaths up to the playback time (C4.build.kdRule) and no score, assists or ping. Redrawn
 * every animation frame while shown. Not part of the video exports. */
import { configStrings, loadHudText } from '../view3d/hudtext.js';

const C4 = window.C4;
const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
// cg_scoreboardWidth / Height, ItemHeight, BannerHeight; the list's width and the font scale (0.35). The columns of
// columnInfoWithPing: the rank's and the talking icon's share go to the name (the demo has neither)
const SB = { w: 500, h: 435, item: 18, banner: 35, gap: 4, list: 482, font: 0.35 };
const COLS = [['status', 0.05, ''], ['name', 0.45, ''], ['score', 0.1, 'CGAME_SB_SCORE'], ['kills', 0.1, 'CGAME_SB_KILLS'], ['assists', 0.1, 'CGAME_SB_ASSISTS'],
  ['deaths', 0.1, 'CGAME_SB_DEATHS'], ['ping', 0.1, 'CGAME_SB_PING']];
const TITLES = { CGAME_SB_SCORE: 'Score', CGAME_SB_KILLS: 'Kills', CGAME_SB_ASSISTS: 'Assists', CGAME_SB_DEATHS: 'Deaths', CGAME_SB_PING: 'Ping' };
const WHITE = [1, 1, 1], MINE = [1, 0.8, 0.4], GREY = [0.25, 0.25, 0.25];      // cg_scoreboardMyColor, g_ScoresColor_Spectator
const STATUS_ICONS = 2258;                                                     // config strings of the status icons (+ 1 .. 8)
const dvarColor = (v, def) => { const a = String(v || '').trim().split(/\s+/).map(Number); return a.length >= 3 && a.every(Number.isFinite) ? a.slice(0, 3) : def; };
const lastAt = (list, t) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t <= t) lo = m + 1; else hi = m; } return lo ? list[lo - 1] : null; };

/** the rows of the list at t per team, the spectators the server listed last: [{tm, side, score, ps: [row]}] */
function listAt(M, t) {
  const d = M.d, board = lastAt(d.scoreboards || [], t), kd = new Map();
  for (const k of d.kills) {
    if (k.t > t) break;
    const r = C4.build.kdRule(k);
    if (r.credit) { const a = kd.get(k.attacker) || [0, 0]; a[0]++; kd.set(k.attacker, a); }
    if (r.death) { const v = kd.get(k.victim) || [0, 0]; v[1]++; kd.set(k.victim, v); }
  }
  const round = M.roundAtOrBefore(t), byClient = new Map((board ? board.entries : []).map((e, i) => [e.client, [e, i]]));
  const row = p => {
    const b = byClient.get(p.client), own = kd.get(p.client) || [0, 0];
    return b ? { p, score: b[0].score, kills: b[0].kills, assists: b[0].assists, deaths: b[0].deaths, ping: b[0].ping, status: b[0].statusIcon, at: b[1] }
      : { p, score: null, kills: own[0], assists: null, deaths: own[1], ping: null, status: 0, at: 99 - own[0] / 1000 };
  };
  const inTeam = new Set(), teams = [];
  for (const tm of d.teams) {
    const ps = d.players.filter(p => p.team === tm.key);
    if (!ps.length) continue;
    ps.forEach(p => inTeam.add(p.client));
    // (a round's sides are attack / defence; the demo's attackers are the axis or the allies)
    const role = round && round.sides ? round.sides[tm.key] : null, attack = d.meta && d.meta.attackSide;
    const side = !role || !attack ? null : role === 'attack' ? attack : attack === 'axis' ? 'allies' : 'axis';
    teams.push({ tm, side, score: board && side ? board[side] : null, rows: ps.map(row).sort((a, b) => a.at - b.at) });
  }
  const others = (board ? board.entries : []).map(e => M.player(e.client)).filter(p => p && !inTeam.has(p.client));
  if (others.length) teams.push({ tm: null, side: null, score: null, rows: others.map(row).sort((a, b) => a.at - b.at) });
  return teams;
}

/** the scoreboard of match M at t into g (w x h device pixels, s: the scale of a 640 x 480 screen); cl: the watched player;
 *  T: the game's text and images (hudtext.js) or null */
export function drawScoreboard(g, M, w, h, s, t, cl, T, csAt) {
  const d = M.d, teams = listAt(M, t), meta = d.meta || {}, dv = meta.dvars || {};
  const rows = teams.reduce((a, x) => a + x.rows.length, 0);
  // (more players than the height holds: everything a little smaller - the game scrolls)
  const need = 70 + teams.length * (SB.banner + SB.gap * 2) + rows * (SB.item + SB.gap);
  const f = Math.min(1, (SB.h - 8) / need), item = SB.item * f, banner = SB.banner * f, gap = SB.gap * f, scale = SB.font * Math.max(0.72, f);
  const left = (w - SB.w * s) / 2, top = (h - SB.h * s) / 2, x0 = left + 9 * s;
  const text = (str, x, y, c, align = 0, sc = scale, alpha = 1) => {
    if (T) { const tw = T.width(str, sc, s); T.draw(g, str, x - (align === 2 ? tw : align === 1 ? tw / 2 : 0), y, sc, s, c, alpha); return tw; }
    g.globalAlpha = alpha; g.textBaseline = 'alphabetic'; g.textAlign = align === 2 ? 'right' : align === 1 ? 'center' : 'left';
    g.font = Math.round(sc * 48 * s) + 'px ' + FONT; g.fillStyle = 'rgb(' + c.map(v => Math.round(v * 255)).join(',') + ')';
    g.fillText(str.replace(/\^[0-9]/g, ''), x, y);
    return g.measureText(str).width;
  };
  g.save();
  g.globalAlpha = 0.72; g.fillStyle = '#000'; g.fillRect(left, top, SB.w * s, SB.h * s);
  // the game type and map; the server's name at the bottom (CG_DrawBackdropServerInfo)
  text(String(meta.gametype || '').toUpperCase(), x0, top + 24 * s, WHITE);
  text(String(meta.mapDisplay || meta.map || ''), x0 + SB.list * s, top + 24 * s, WHITE, 2);
  text(String(dv.sv_hostname || ''), x0, top + (SB.h - 6) * s, WHITE, 0, 0.26);
  // the columns' titles, centred on the columns (CG_DrawScoreboard_ListColumnHeaders)
  let x = x0, y = top + 48 * s;
  for (const [, cw, title] of COLS) {
    if (title) text(T ? T.localize(title) : TITLES[title], x + cw * SB.list * s / 2, y, WHITE, 1, scale * 0.85);
    x += cw * SB.list * s;
  }
  y = top + 56 * s;
  for (const team of teams) {
    const Side = team.side === 'axis' ? 'Axis' : team.side === 'allies' ? 'Allies' : null;
    const color = team.tm ? dvarColor(Side && dv['g_ScoresColor_' + Side], [0.5, 0.5, 0.5]) : GREY;
    // the banner (CG_DrawScoreboard_ListBanner): the team's icon, name and "( n )"; the team's score under its column
    const icon = Side && dv['g_TeamIcon_' + Side], bx = x0, by = y + banner * s;
    let tx = bx;
    if (T && icon && T.pic(g, icon, bx, y, banner * s, banner * s, WHITE, 1)) tx += (banner + 8) * s;
    tx += text(team.tm ? team.tm.name : T ? T.localize('CGAME_SPECTATORS') : 'Spectators', tx, by, WHITE) + 8 * s;
    text('( ' + team.rows.length + ' )', tx, by, WHITE);
    if (team.score != null) text(String(team.score), x0 + (0.05 + 0.45 + 0.1) * SB.list * s - 4 * s, by, WHITE, 2);
    y += (banner + gap) * s;
    for (const r of team.rows) {
      g.globalAlpha = 0.5; g.fillStyle = 'rgb(' + color.map(v => Math.round(v * 255)).join(',') + ')';
      g.fillRect(x0, y, SB.list * s, item * s);
      const c = r.p.client === cl ? MINE : WHITE, base = y + (scale * 48 + item) * 0.5 * s, spectator = !team.tm;
      let cx = x0;
      for (const [k, cw] of COLS) {
        const W = cw * SB.list * s;
        if (k === 'status') {
          const name = r.status > 0 && r.status <= 8 && csAt ? csAt(STATUS_ICONS + r.status, t) : '';
          if (T && name) T.pic(g, name, cx + W - item * s, y, item * s, item * s, WHITE, 1);
        } else if (k === 'name') {
          // (DrawListString: a long name smaller)
          const name = T ? r.p.name || r.p.cleanName : r.p.cleanName;
          let sc = scale;
          while (T && sc > 0.1 && T.width(name, sc, s) > W) sc -= 0.025;
          text(name, cx + 2 * s, base, c, 0, sc);
        } else if (!(spectator && k !== 'ping')) {
          const v = r[k];
          text(v == null ? '-' : String(v), cx + W - 4 * s, base, c, 2);
        }
        cx += W;
      }
      y += (item + gap) * s;
    }
    y += gap * s;
  }
  g.restore();
}

export class ScoresOverlay {
  /** viewport: the views' container (#viewport - also the fullscreen element); replay: the Replay */
  constructor(viewport, replay) {
    this.R = replay;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scores-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    viewport.append(this.canvas);
    this.shown = false;
    this.raf = 0;
    this.txt = null;                     // the game's fonts and images (hudtext.js)
    this.csAt = configStrings(replay.match.d);
    loadHudText().then(x => { this.txt = x; });
  }

  /** the player the scoreboard lights: first person, else the selection, else the demo's own view */
  watched(t) {
    const R = this.R, v = R.view;
    if (v && v.key === '3d' && v.cams && v.cams.mode === 'fp' && v.cameraTarget) { const tg = v.cameraTarget(); if (tg && tg.cl != null) return tg.cl; }
    return R.focus != null ? R.focus : R.match.followedAt(t);
  }

  show(on) {
    if (on === this.shown) return;
    this.shown = on;
    this.canvas.hidden = !on;
    if (on) this.frame();
    else if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }

  frame() {
    this.raf = 0;
    if (!this.shown) return;
    const c = this.canvas, r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'), t = this.R.pb.t;
    g.clearRect(0, 0, w, h);
    drawScoreboard(g, this.R.match, w, h, h / 480, t, this.watched(t), this.txt, this.csAt);
    this.raf = requestAnimationFrame(() => this.frame());
  }

  destroy() { this.show(false); this.canvas.remove(); }
}
