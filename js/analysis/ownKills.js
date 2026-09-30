/* Own-kill metrics - DemoData.ownKills, shown in the POV tab and in the JSON export. DOM-free.
 *
 * Only the POV and the team mates: "the POV team" is the team key (A / B) of the POV - the side swap at
 * halftime does not change it (teams.js membership); a player who changes teams counts only for the
 * kills while in the POV's team. A POV without a team (spectator / shoutcaster) gets both teams, the
 * UI lets the user pick one.
 *
 * Kills: live match time, the scoreboard's rule (no team kills, suicides, world or entity kills).
 * Every kill gets one verdict (RULES below):
 *   excluded   not an aim kill (grenade, launcher, knife, explosive, car) / no shot seen in the
 *              300 ms before / killer or victim not covered by samples from -550 ms to the kill
 *              (a gap > 150 ms: excluded instead of estimated) - counted per reason
 *   evaluated  complete data: crosshair error at the shot and at -0.5 s
 *   own kill   evaluated and crosshair within 10° of the victim at the shot
 * Metrics over the own kills: % crosshair ≤3° at -0.5 s, median crosshair error at -0.5 s, % target
 * silent (≈), % silent & unseen (≈, optional), median distance; ALL = the players shown (the team),
 * ratio player / ALL. "Data coverage" = evaluated / all kills of the player.
 *
 * Accuracy (measured on 60 demos, docs/ANALYSIS.md 3.10):
 *   angles  16 bit (0.0055°) on the wire, stored at 0.1° - negligible against 3°. POV and every
 *           followed player: player state angles / position; others: entity angles. Values between
 *           two samples are interpolated (position linear, angles over the shortest way); kill times
 *           lie on the 50 ms snapshot grid, so -0.5 s normally hits a sample exactly.
 *   eye     feet + exact view height of the player state (followed player), else by stance
 *           (stand / crouch / prone 60 / 40 / 11); lean ignored.
 *   target  the victim's upper body: the nearest point of the line chest -> head (by stance).
 *   error   3D angle between the view vector (pitch + yaw) and the line eye -> target point.
 *   shot    the latest shot in the 300 ms before the kill over all sources: fire event, bullet
 *           impact of the killer, clip decrement (followed player); only when none: the firing flag
 *           of a sample. The source is stored per kill. All shot times lie on the snapshot grid (50 ms).
 *   silent  no transmitted sound event of the victim in the 2 s before - ≈ ("not transmitted", not
 *           "not heard"); only victims covered for the whole 2 s.
 *   unseen  (optional) no living team mate of the killer saw the victim in the 2 s before: the victim
 *           was in no view cone (±40° / ±35°) with a free sight line. analyze() decides with the cone
 *           alone (no walls) and returns the candidate sight lines (team mate's eye -> victim's feet /
 *           chest / head at every sample inside the cone) as `sightJob`; applySight() then tests them
 *           against the map geometry (C4.sight, geometry/<map>/sight.js) on the main thread. ≈ either
 *           way: static models (trees, cars, crates) and smoke are not in the geometry, glass and
 *           brush entities (doors) do not block.
 * All times: ms since the first snapshot. */
C4.define('ownKills', function (C4) {
  'use strict';
  const W = C4.weapons;

  /** ALL thresholds of the own-kill metrics (one place) */
  const RULES = {
    shotWindowMs: 300,          // a shot of the killer at most this long before the kill
    ownKillMaxDeg: 10,          // crosshair error at the shot for an own kill
    earlyMs: 500,               // "before the kill": this long before it
    earlyMaxDeg: 3,             // "on target" at -0.5 s
    silentWindowMs: 2000,       // victim silent / unseen: in this window before the kill
    maxGapMs: 150,              // largest allowed gap between two samples in a window
    coverMs: 550,               // killer and victim must be covered from this long before the kill
    reliableMinKills: 15,       // fewer evaluated kills: values shown grey (little meaning)
    highlight: [0.7, 1.3],      // ratio player / ALL marked outside this range
    coneHalfDeg: 40, coneVertHalfDeg: 35,   // optional "unseen": view cone of a team mate
    sightSkip: 1 | 2,           // "unseen" with geometry: glass (1) and brush entities (2, doors) do not block
    sightCutUnits: 4,           // sight line shortened at both ends (eye / target touching a wall)
    eye: { stand: 60, crouch: 40, prone: 11 },           // view height by stance (no player state)
    target: { stand: [44, 58], crouch: [30, 40], prone: [8, 12] }   // chest -> head height above the feet
  };
  const REASONS = {
    notAimKill: 'not an aim kill (grenade, launcher, knife, explosive, car)',
    noShot: 'no shot seen in the ' + RULES.shotWindowMs + ' ms before the kill',
    killerNoData: 'killer not covered by samples (gap > ' + RULES.maxGapMs + ' ms)',
    victimNoData: 'victim not covered by samples (gap > ' + RULES.maxGapMs + ' ms)'
  };
  const PF_CROUCH = 2, PF_PRONE = 4, PF_FIRING = 8, PF_DEAD = 16;
  const stanceOf = f => (f & PF_PRONE ? 'prone' : f & PF_CROUCH ? 'crouch' : 'stand');
  function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  const lerpAngle = (a, b, f) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

  /** is a kill an aim kill (bullet weapon / headshot)? */
  function isAimKill(k) {
    if (k.headshot) return true;
    if (k.mod && k.mod !== 'MOD_HEAD_SHOT') return false;            // knife, falling, crush ...
    const n = String(k.weaponName || '').toLowerCase();
    if (!n || n === 'none') return false;
    if (W.grenadeKind(n) || W.isCarWeapon(n) || W.isBombWeapon(n)) return false;
    return !/^(gl_|rpg|at4|c4|claymore|airstrike|artillery|helicopter|cobra|hind|explodable)|_gl_/.test(n);
  }

  /** a track covers [a, b]: a sample at or before a, no gap > maxGap, the last one at most maxGap before b */
  function covers(P, a, b) {
    if (!P || !P.t.length) return false;
    let i = lowerBound(P.t, a + 1) - 1;
    if (i < 0) return false;
    const j = lowerBound(P.t, b + 1);
    if (j - i < 1) return false;
    for (let k = i + 1; k < j; k++) if (P.t[k] - P.t[k - 1] > RULES.maxGapMs) return false;
    return b - P.t[j - 1] <= RULES.maxGapMs;
  }
  /** state of a track at time t, interpolated between the samples around it (null: gap / outside) */
  function stateAt(P, t, eyeTrack) {
    if (!P || !P.t.length) return null;
    const j = lowerBound(P.t, t);
    let a, b, f;
    if (j < P.t.length && P.t[j] === t) { a = b = j; f = 0; }
    else if (j === 0) return null;
    else if (j < P.t.length && P.t[j] - P.t[j - 1] <= RULES.maxGapMs) { a = j - 1; b = j; f = (t - P.t[a]) / (P.t[b] - P.t[a]); }
    else if (t - P.t[j - 1] <= RULES.maxGapMs) { a = b = j - 1; f = 0; }     // no later sample nearby (the victim died): hold the last one
    else return null;
    const near = f < 0.5 ? a : b;
    const st = {
      x: P.x[a] + (P.x[b] - P.x[a]) * f, y: P.y[a] + (P.y[b] - P.y[a]) * f, z: P.z[a] + (P.z[b] - P.z[a]) * f,
      yaw: lerpAngle(P.yaw[a], P.yaw[b], f), pitch: P.pitch[a] + (P.pitch[b] - P.pitch[a]) * f,
      stance: stanceOf(P.flags[near]), dead: !!((P.flags[a] | P.flags[b]) & PF_DEAD), eye: null
    };
    // exact view height of the player state (only while this player was followed)
    if (eyeTrack) {
      const e = lowerBound(eyeTrack.t, t);
      for (const q of [e, e - 1]) if (q >= 0 && q < eyeTrack.t.length && Math.abs(eyeTrack.t[q] - t) <= 50) { st.eye = eyeTrack.vh[q]; break; }
    }
    return st;
  }
  /** 3D angle (degrees) between the view of K and the victim's upper body (nearest point chest -> head) */
  function crosshairError(K, V) {
    const p = K.pitch * Math.PI / 180, y = K.yaw * Math.PI / 180;
    const dx = Math.cos(p) * Math.cos(y), dy = Math.cos(p) * Math.sin(y), dz = -Math.sin(p);
    const ex = K.x, ey = K.y, ez = K.z + (K.eye != null ? K.eye : RULES.eye[K.stance]);
    const [h0, h1] = RULES.target[V.stance];
    let best = 180;
    for (let s = 0; s <= 8; s++) {
      const tx = V.x - ex, ty = V.y - ey, tz = V.z + h0 + (h1 - h0) * s / 8 - ez;
      const n = Math.hypot(tx, ty, tz) || 1e-9;
      const a = Math.acos(Math.max(-1, Math.min(1, (dx * tx + dy * ty + dz * tz) / n))) * 180 / Math.PI;
      if (a < best) best = a;
    }
    return best;
  }
  /** is the point inside the view cone of state T (no walls)? */
  function inCone(T, x, y, z) {
    const ez = T.z + (T.eye != null ? T.eye : RULES.eye[T.stance]);
    const dx = x - T.x, dy = y - T.y, dz = z - ez;
    const dYaw = Math.abs(((Math.atan2(dy, dx) * 180 / Math.PI - T.yaw) % 360 + 540) % 360 - 180);
    if (dYaw > RULES.coneHalfDeg) return false;
    return Math.abs(-Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI - T.pitch) <= RULES.coneVertHalfDeg;
  }

  function summarize(list) {
    const own = list.filter(k => k.own);
    const e05 = own.map(k => k.errEarly);
    const silentKnown = own.filter(k => k.silent != null);
    const suKnown = own.filter(k => k.silentUnseen != null);
    const dist = own.filter(k => k.distance != null).map(k => k.distance);
    const excluded = { notAimKill: 0, noShot: 0, killerNoData: 0, victimNoData: 0 };
    for (const k of list) if (k.excluded) excluded[k.excluded]++;
    const evaluated = list.filter(k => k.evaluated).length;
    return {
      kills: list.length, evaluated, excluded, offTarget: list.filter(k => k.evaluated && !k.own).length,
      ownKills: own.length,
      pctEarlyOnTarget: e05.length ? 100 * e05.filter(v => v <= RULES.earlyMaxDeg).length / e05.length : null,
      medianErrEarly: r1(median(e05)),
      silentKnown: silentKnown.length,
      pctSilent: silentKnown.length ? 100 * silentKnown.filter(k => k.silent).length / silentKnown.length : null,
      silentUnseenKnown: suKnown.length,
      pctSilentUnseen: suKnown.length ? 100 * suKnown.filter(k => k.silentUnseen).length / suKnown.length : null,
      medianDistance: dist.length ? Math.round(median(dist)) : null,
      reliable: evaluated >= RULES.reliableMinKills
    };
  }

  function analyze(ctx) {
    const { kills, positions, sounds, players, pov } = ctx;
    const sideAt = ctx.sideAt || (() => null), rounds = ctx.rounds || [];
    const teamAt = ctx.teamAt || (() => null);          // strict: team key while in a team, else null
    const psEye = ctx.psEye || new Map();
    const shotSources = [['fire event', ctx.shots], ['bullet impact', ctx.impactShots], ['clip decrement', ctx.ammoShots]];
    const deaths = new Map();
    for (const k of kills) { if (!deaths.has(k.victim)) deaths.set(k.victim, []); deaths.get(k.victim).push(k.t); }

    /** last shot of cl in [a, b]: {t, source} or null */
    function lastShot(cl, a, b) {
      let best = null;
      for (const [src, map] of shotSources) {
        const S = map && map.get(cl);
        if (!S) continue;
        let i = lowerBound(S, b + 1) - 1;
        if (i >= 0 && S[i] >= a && (!best || S[i] > best.t)) best = { t: S[i], source: src };
      }
      if (!best) {
        // fallback: the firing flag of a sample (entity eFlags / player state)
        const P = positions[cl];
        if (P) for (let i = lowerBound(P.t, b + 1) - 1; i >= 0 && P.t[i] >= a; i--) if (P.flags[i] & PF_FIRING) { best = { t: P.t[i], source: 'firing flag' }; break; }
      }
      return best;
    }
    /** optional "unseen": the living team mates of the killer in the 2 s before. Returns the verdict of
     *  the view cone alone ({unseen: true / false / null}) and the candidate sight lines (every sample
     *  with the victim inside a cone): 12 floats each - eye, victim's feet, chest, head */
    function unseenBy(k) {
      const t = k.t, a = t - RULES.silentWindowMs, side = sideAt(k.attacker, t);
      if (side !== 1 && side !== 2) return { unseen: null, unknown: true, segs: [] };
      const roundStart = k.round >= 0 && rounds[k.round] ? rounds[k.round].segStart : a;
      const V = positions[k.victim];
      let unknown = false;
      const segs = [];
      for (const p of players) {
        const cl = p.client;
        if (cl === k.attacker || cl === k.victim || sideAt(cl, t) !== side) continue;
        const died = (deaths.get(cl) || []).find(x => x >= roundStart && x <= t);
        if (died != null && died <= a) continue;
        const T = positions[cl], end = died != null ? died : t;
        if (!covers(T, a, end)) { unknown = true; continue; }
        for (let i = lowerBound(T.t, a); i < T.t.length && T.t[i] <= end; i++) {
          if (T.flags[i] & PF_DEAD) continue;
          const ts = stateAt(T, T.t[i], psEye.get(cl)), vs = stateAt(V, T.t[i], null);
          if (!ts || !vs) continue;
          const [h0, h1] = RULES.target[vs.stance];
          if (!inCone(ts, vs.x, vs.y, vs.z + (h0 + h1) / 2)) continue;
          const ez = ts.z + (ts.eye != null ? ts.eye : RULES.eye[ts.stance]);
          segs.push(ts.x, ts.y, ez, vs.x, vs.y, vs.z + 8, vs.x, vs.y, vs.z + h0, vs.x, vs.y, vs.z + h1);
        }
      }
      // cone alone: seen as soon as the victim was in a cone (a known "seen" wins over an unknown team mate)
      return { unseen: segs.length ? false : unknown ? null : true, unknown, segs };
    }

    const counted = kills.filter(k => k.phase === 'live' && !k.suicide && !k.world && !k.entityAttacker && !k.teamkill && k.attacker < 64);
    const perKill = [], job = [];
    for (const k of counted) {
      const t = k.t;
      const rec = { kill: k.index, t, killer: k.attacker, victim: k.victim, team: teamAt(k.attacker, t), excluded: null, evaluated: false, own: false,
        shotT: null, shotSource: null, errShot: null, errEarly: null, silent: null, unseen: null, silentUnseen: null,
        distance: k.distance != null ? k.distance : null };
      perKill.push(rec);
      if (!isAimKill(k)) { rec.excluded = 'notAimKill'; continue; }
      const shot = lastShot(k.attacker, t - RULES.shotWindowMs, t);
      if (!shot) { rec.excluded = 'noShot'; continue; }
      rec.shotT = shot.t; rec.shotSource = shot.source;
      const K = positions[k.attacker], V = positions[k.victim];
      if (!covers(K, t - RULES.coverMs, t)) { rec.excluded = 'killerNoData'; continue; }
      if (!covers(V, t - RULES.coverMs, t)) { rec.excluded = 'victimNoData'; continue; }
      const eyeK = psEye.get(k.attacker);
      const ks = stateAt(K, shot.t, eyeK), vs = stateAt(V, shot.t, null);
      const ke = stateAt(K, t - RULES.earlyMs, eyeK), ve = stateAt(V, t - RULES.earlyMs, null);
      if (!ks || ks.dead || !ke) { rec.excluded = 'killerNoData'; continue; }
      if (!vs || !ve) { rec.excluded = 'victimNoData'; continue; }
      rec.evaluated = true;
      rec.errShot = r1(crosshairError(ks, vs));
      rec.errEarly = r1(crosshairError(ke, ve));
      rec.own = rec.errShot <= RULES.ownKillMaxDeg;
      if (!rec.own) continue;
      // silent (≈): victim covered for the whole 2 s and not one sound event
      if (covers(V, t - RULES.silentWindowMs, t)) {
        const snd = sounds.get(k.victim) || [];
        const j = lowerBound(snd, t - RULES.silentWindowMs);
        rec.silent = !(j < snd.length && snd[j] <= t);
      }
      if (rec.silent === false) rec.silentUnseen = false;
      else if (rec.silent === true) {
        const u = unseenBy(k);
        rec.unseen = u.unseen; rec.silentUnseen = u.unseen;
        if (u.segs.length) job.push({ kill: k.index, unknown: u.unknown, segs: new Float32Array(u.segs) });
      }
    }

    // which team(s): the POV's team; none (spectator / shoutcaster): both, the UI picks one
    const povPlayer = players.find(p => p.client === pov);
    const povTeam = povPlayer && (povPlayer.team === 'A' || povPlayer.team === 'B') ? povPlayer.team : null;
    const teams = {};
    for (const key of povTeam ? [povTeam] : ['A', 'B']) teams[key] = teamResult(key, perKill.filter(r => r.team === key), players, pov);
    return { rules: RULES, reasons: REASONS, povTeam, teams,
      // how "unseen" was decided; applySight() replaces it when the map geometry is available
      sight: { method: 'cone', map: null, reason: 'map geometry not applied' },
      sightJob: { kills: job } };
  }

  /** summary of one team: ALL, one row per killer (POV first), shot sources, the kill list */
  function teamResult(key, list, players, pov) {
    const ratio = (v, a) => (v == null || a == null || a === 0 ? null : Math.round(v / a * 100) / 100);
    const all = summarize(list);
    const byKiller = new Map();
    for (const r of list) { if (!byKiller.has(r.killer)) byKiller.set(r.killer, []); byKiller.get(r.killer).push(r); }
    const rows = [];
    for (const [cl, l] of byKiller) {
      const s = summarize(l);
      const p = players.find(x => x.client === cl);
      rows.push(Object.assign({ client: cl, name: p ? p.cleanName : 'Client ' + cl, isPov: cl === pov }, s, {
        ratio: { pctEarlyOnTarget: ratio(s.pctEarlyOnTarget, all.pctEarlyOnTarget), medianErrEarly: ratio(s.medianErrEarly, all.medianErrEarly),
          pctSilent: ratio(s.pctSilent, all.pctSilent), pctSilentUnseen: ratio(s.pctSilentUnseen, all.pctSilentUnseen),
          medianDistance: ratio(s.medianDistance, all.medianDistance) }
      }));
    }
    // the POV first, then by own kills
    rows.sort((a, b) => (b.isPov - a.isPov) || b.ownKills - a.ownKills || b.kills - a.kills);
    const sources = {};
    for (const r of list) if (r.shotSource && r.evaluated) sources[r.shotSource] = (sources[r.shotSource] || 0) + 1;
    return { team: key, all, players: rows, shotSources: sources, kills: list };
  }

  /**
   * "Unseen" with walls: test the candidate sight lines of analyze() against the map geometry and
   * rebuild the summaries. ok = DemoData.ownKills (changed in place), job = its sightJob, bvh =
   * C4.sight.read(...) or null (then only ok.sight says why), players = DemoData.players.
   * A kill is "seen" as soon as one line (eye -> feet / chest / head) of one candidate is free.
   */
  function applySight(ok, job, bvh, players, map, reason) {
    if (!bvh || !job) {
      ok.sight = { method: 'cone', map: map || null, reason: reason || 'no map geometry' };
      return ok;
    }
    const t0 = Date.now(), cut = RULES.sightCutUnits, skip = RULES.sightSkip;
    const byKill = new Map(job.kills.map(j => [j.kill, j]));
    const a = [0, 0, 0], b = [0, 0, 0];
    let lines = 0, tested = 0, changed = 0;
    /** is one of the three lines of candidate c free? */
    const free = (s, c) => {
      const ex = s[c], ey = s[c + 1], ez = s[c + 2];
      for (let p = 3; p < 12; p += 3) {
        const dx = s[c + p] - ex, dy = s[c + p + 1] - ey, dz = s[c + p + 2] - ez, len = Math.hypot(dx, dy, dz);
        if (len <= 2 * cut) return true;                               // touching: nothing can be in between
        const f = cut / len;
        a[0] = ex + dx * f; a[1] = ey + dy * f; a[2] = ez + dz * f;
        b[0] = ex + dx * (1 - f); b[1] = ey + dy * (1 - f); b[2] = ez + dz * (1 - f);
        lines++;
        if (!C4.sight.blocked(bvh, a, b, skip)) return true;
      }
      return false;
    };
    for (const T of Object.values(ok.teams)) {
      for (const r of T.kills) {
        if (r.silent !== true) continue;
        const j = byKill.get(r.kill);
        let unseen;
        if (!j) unseen = r.unseen;                                     // no cone contact: unseen / unknown as before
        else {
          tested++;
          let seen = false;
          for (let c = 0; c < j.segs.length && !seen; c += 12) seen = free(j.segs, c);
          unseen = seen ? false : j.unknown ? null : true;
        }
        if (unseen !== r.unseen) changed++;
        r.unseen = unseen; r.silentUnseen = unseen;
      }
    }
    const pov = (players.find(p => p.isPov) || {}).client;
    for (const [key, T] of Object.entries(ok.teams)) ok.teams[key] = teamResult(key, T.kills, players, pov);
    ok.sight = { method: 'geometry', map, killsTested: tested, sightLines: lines, changedFromCone: changed, ms: Date.now() - t0,
      geometry: { triangles: bvh.triangles, nodes: bvh.nodes, bytes: bvh.bytes } };
    return ok;
  }

  C4.ownKills = { analyze, applySight, RULES, REASONS, isAimKill };
});
