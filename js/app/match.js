/* Match model: DemoData prepared for playback. Shared by the 2D and the 3D view, so both
 * answer "where is player X at time t" with exactly the same rules (interpolation, gaps,
 * deaths, round boundaries). Extracted from cod4-demo's map tab (prepare / sampleAt / trailOf). */
const C4 = window.C4;
const CFG = C4.mapConfig;
const PF = C4.collect.PF;

export const upperBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };
export const lowerBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };

/** shortest signed angle difference b - a in degrees */
const dAngle = (a, b) => ((b - a + 540) % 360) - 180;

export class Match {
  constructor(data, app) {
    const d = data, m = d.meta;
    this.d = d;
    this.app = app;
    this.players = new Map(d.players.map(p => [p.client, p]));
    // world rectangle: compass rectangle from the demo (CS 823) > maps.js > extent of positions
    this.mapEntry = C4.maps ? C4.maps.entry(m.map) : null;
    const toRect = c => ({ minX: Math.min(c[0], c[2]), maxX: Math.max(c[0], c[2]), minY: Math.min(c[1], c[3]), maxY: Math.max(c[1], c[3]) });
    let rect = null, rectSource = null, calibrated = false;
    if (m.minimap && m.minimap.corners) { rect = toRect(m.minimap.corners); rectSource = 'compass rectangle from the demo (config string 823)'; calibrated = true; }
    else if (this.mapEntry && this.mapEntry.bounds) { rect = toRect(this.mapEntry.bounds); rectSource = 'calibration from assets/maps/maps.js'; calibrated = true; }
    let bbox = null, zMin = Infinity, zMax = -Infinity;
    for (const p of Object.values(d.positions)) {
      for (let i = 0; i < p.t.length; i++) {
        if (!bbox) bbox = { minX: p.x[i], maxX: p.x[i], minY: p.y[i], maxY: p.y[i] };
        else {
          if (p.x[i] < bbox.minX) bbox.minX = p.x[i]; if (p.x[i] > bbox.maxX) bbox.maxX = p.x[i];
          if (p.y[i] < bbox.minY) bbox.minY = p.y[i]; if (p.y[i] > bbox.maxY) bbox.maxY = p.y[i];
        }
        if (p.z[i] < zMin) zMin = p.z[i]; if (p.z[i] > zMax) zMax = p.z[i];
      }
    }
    if (!rect) {
      const b = bbox || { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 };
      const pad = 300;
      rect = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
      rectSource = 'no calibration: grid fitted to the bounding box of all positions';
    }
    Object.assign(this, { rect, rectSource, calibrated, bbox, zRange: Number.isFinite(zMin) ? [zMin, zMax] : [0, 0] });

    this.colors = new Map();
    for (const p of d.players) this.colors.set(p.client, app.teamColor(p.team));
    this.deaths = new Map();
    for (const k of d.kills) {
      if (!this.deaths.has(k.victim)) this.deaths.set(k.victim, []);
      this.deaths.get(k.victim).push(k);
    }
    // live start per round (end of the strat time); the countdown [segStart, live) is skipped
    this.live = d.rounds.map(r => r.start != null ? r.start : r.segStart);
    this.countdowns = d.rounds.map((r, i) => [r.segStart, this.live[i]]).filter(c => c[1] > c[0]);
    // segment boundaries (restarts): nothing drawn may cross one
    this.bounds = [...new Set(d.rounds.flatMap(r => [r.segStart, r.segEnd]))].sort((a, b) => a - b);
    this.grenades = d.grenades.map(g => prepareGrenade(g));
    this.bombTimes = (d.bombTrack || []).map(e => e.t);
  }

  player(cl) { return this.players.get(cl) || null; }
  name(cl) { const p = this.player(cl); return p ? p.cleanName : (cl === 1022 ? 'World' : 'Client ' + cl); }
  color(cl) { return this.colors.get(cl) || '#a3a3ab'; }

  /** start of the segment (round) containing t */
  epochStart(t) {
    const i = upperBound(this.bounds, t) - 1;
    return i >= 0 ? this.bounds[i] : -Infinity;
  }

  /** position of client cl at time t, interpolated between two samples when they are close
   *  enough (same life, same round, gap <= GAP_MS, no jump); null when dead / not in this life.
   *  -> {x, y, z, yaw, pitch, age (ms since the sample, 0 = interpolated), crouch, prone, firing, weapon, ps} */
  sampleAt(cl, t) {
    const P = this.d.positions[cl];
    if (!P || !P.t.length) return null;
    const i = upperBound(P.t, t) - 1;
    if (i < 0) return null;
    const t0 = P.t[i];
    if (P.flags[i] & PF.DEAD) return null;
    const dl = this.deaths.get(cl);
    if (dl) for (const k of dl) if (k.t > t0 && k.t <= t) return null;
    if (t0 < this.epochStart(t)) return null;
    let x = P.x[i], y = P.y[i], z = P.z[i], yaw = P.yaw[i], pitch = P.pitch[i], age = t - t0;
    if (i + 1 < P.t.length && this.epochStart(P.t[i + 1]) <= t0) {
      const t1 = P.t[i + 1];
      const dx = P.x[i + 1] - x, dy = P.y[i + 1] - y;
      if (t1 - t0 <= CFG.GAP_MS && Math.hypot(dx, dy) <= CFG.JUMP_UNITS && !(P.flags[i + 1] & PF.DEAD)) {
        const f = (t - t0) / (t1 - t0);
        x += dx * f; y += dy * f; z += (P.z[i + 1] - z) * f;
        yaw += dAngle(yaw, P.yaw[i + 1]) * f;
        pitch += dAngle(pitch, P.pitch[i + 1]) * f;
        age = 0;
      }
    }
    const fl = P.flags[i];
    return { x, y, z, yaw, pitch, age, crouch: !!(fl & PF.CROUCH), prone: !!(fl & PF.PRONE), firing: !!(fl & PF.FIRING),
      weapon: P.weapon[i], ps: !!(fl & PF.FROM_PS) };
  }

  /** trail of the last TRAIL_MS before t: segments of [x, y, z, age 0..1], broken at gaps / jumps / deaths */
  trailOf(cl, t, ms = CFG.TRAIL_MS) {
    const P = this.d.positions[cl];
    if (!P) return [];
    const from = Math.max(t - ms, this.epochStart(t));
    let i = lowerBound(P.t, from);
    const end = upperBound(P.t, t);
    const segs = [];
    let seg = [], prev = null;
    const brk = () => { if (seg.length > 1) segs.push(seg); seg = []; };
    for (; i < end; i++) {
      if (P.flags[i] & PF.DEAD) { brk(); prev = null; continue; }
      if (prev != null) {
        const gap = P.t[i] - P.t[prev];
        const jump = Math.hypot(P.x[i] - P.x[prev], P.y[i] - P.y[prev]);
        if (gap > CFG.GAP_MS || jump > CFG.JUMP_UNITS) brk();
      }
      seg.push([P.x[i], P.y[i], P.z[i], (t - P.t[i]) / ms]);
      prev = i;
    }
    const cur = this.sampleAt(cl, t);
    if (cur && cur.age === 0 && seg.length) seg.push([cur.x, cur.y, cur.z, 0]);
    brk();
    return segs;
  }

  /** the death position of kill k (victim position from the kill, else the last sample <= 2 s old) */
  deathPos(k) {
    if (k.victimPos) return k.victimPos;
    const P = this.d.positions[k.victim];
    const i = P ? upperBound(P.t, k.t) - 1 : -1;
    if (i >= 0 && k.t - P.t[i] <= 2000) return [P.x[i], P.y[i], P.z[i]];
    return null;
  }
  attackerPos(k) {
    if (k.attackerPos) return k.attackerPos;
    const s = this.sampleAt(k.attacker, k.t);
    return s && s.age <= CFG.STALE_MS ? [s.x, s.y, s.z] : null;
  }

  /** the player the POV follows (player state) at time t */
  followedAt(t) {
    const pov = this.d.meta.povClient;
    const P = this.d.positions[pov];
    if (P) { const i = upperBound(P.t, t) - 1; if (i >= 0 && t - P.t[i] < 200 && (P.flags[i] & PF.FROM_PS)) return pov; }
    for (const [cl, Q] of Object.entries(this.d.positions)) {
      const i = upperBound(Q.t, t) - 1;
      if (i >= 0 && t - Q.t[i] < 200 && (Q.flags[i] & PF.FROM_PS)) return Number(cl);
    }
    return pov;
  }

  /** the bomb entry valid at t (nothing from another round) */
  bombAt(t) {
    const T = this.d.bombTrack;
    if (!T || !T.length) return null;
    const i = upperBound(this.bombTimes, t) - 1;
    const e = i >= 0 ? T[i] : null;
    if (!e || e.state === 'none' || e.t < this.epochStart(t)) return null;
    return e;
  }

  /** the round at t; between two rounds the last one before t (null before the first) */
  roundAtOrBefore(t) {
    const d = this.d;
    let ri = C4.events.roundAt(d.rounds, t);
    if (ri < 0) for (let i = 0; i < d.rounds.length; i++) if (d.rounds[i].segStart <= t) ri = i;
    return ri >= 0 ? d.rounds[ri] : null;
  }

  /** weapon index held at time t -> internal name (ak47_acog_mp) or null */
  weaponName(index, t) {
    if (!index) return null;
    let list = null;
    for (const w of this.d.weaponLists || []) { if (w.t <= t) list = w.list; else break; }
    return list && index <= list.length ? list[index - 1] : null;
  }
  /** weapon index held at time t -> readable name */
  weaponLabel(index, t) {
    if (!index) return '-';
    const name = this.weaponName(index, t);
    return name ? C4.weapons.label(name) : '#' + index;
  }
}

/** grenade flight path from the trajectory segments: points [t, x, y, z] every 40 ms */
function prepareGrenade(g) {
  const pts = [];
  const end = g.detonation ? g.detonation.t : g.last + 50;
  const G = CFG.GRAVITY;
  for (let s = 0; s < g.segments.length; s++) {
    const [trTime, trType, bx, by, bz, vx, vy, vz] = g.segments[s];
    const from = Math.max(trTime, s === 0 ? (g.launch != null ? g.launch : g.first) : trTime);
    const to = s + 1 < g.segments.length ? g.segments[s + 1][0] : end;
    for (let t = from; t <= to; t += 40) {
      const dt = (t - trTime) / 1000;
      if (trType === 5) pts.push([t, bx + vx * dt, by + vy * dt, bz + vz * dt - 0.5 * G * dt * dt]);
      else { pts.push([t, bx, by, bz]); break; }
    }
  }
  if (g.detonation) pts.push([g.detonation.t, g.detonation.x, g.detonation.y, g.detonation.z]);
  const start = pts.length ? pts[0][0] : (g.detonation ? g.detonation.t : g.first);
  const c = CFG.GRENADE[g.kind] || CFG.GRENADE.other;
  return { g, pts, start, end: g.detonation ? g.detonation.t + c.duration : end + 500, cfg: c };
}
