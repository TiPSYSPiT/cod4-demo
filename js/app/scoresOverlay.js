/* The scoreboard while Tab is held (main.js): one canvas over the views - 2D, 3D in every camera mode, fullscreen -,
 * gone when Tab is released, the window loses the focus or the page is hidden. Per team the players with their
 * kills and deaths up to the playback time (C4.build.kdRule: the Promod scoreboard's counting), the watched player
 * lit - the one in first person, else the selected one, else the one the demo follows. Redrawn every animation frame
 * while shown (the time moves while playing). Not part of the video exports. */
const C4 = window.C4;
const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

/** the scoreboard of match M at t into g (w x h device pixels, s: the scale of a 640 x 480 screen); cl: the watched
 *  player (lit) */
export function drawScoreboard(g, M, w, h, s, t, cl) {
  const d = M.d, kd = new Map();
  for (const k of d.kills) {
    if (k.t > t) break;
    const r = C4.build.kdRule(k);
    if (r.credit) { const a = kd.get(k.attacker) || [0, 0]; a[0]++; kd.set(k.attacker, a); }
    if (r.death) { const v = kd.get(k.victim) || [0, 0]; v[1]++; kd.set(k.victim, v); }
  }
  const W = 360 * s, x0 = (w - W) / 2;
  let y = 70 * s;
  g.save();
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
    drawScoreboard(g, this.R.match, w, h, h / 480, t, this.watched(t));
    this.raf = requestAnimationFrame(() => this.frame());
  }

  destroy() { this.show(false); this.canvas.remove(); }
}
