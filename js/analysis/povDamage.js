/* POV damage statistics - DemoData.povDamage, the one data source of the "POV Damage" tab, its
 * health chart and the JSON export. DOM-free (runs in the worker).
 *
 * A client demo contains only the recording player's (POV) view. What is exact and what is derived
 * (measured on all 56 sample demos, docs/ANALYSIS.md "POV damage"):
 *   exact    health (player state stats[0]); every damage raises damageEvent by 1 and damageCount =
 *            the health lost; bullet hits on the POV (EV_BULLET_HIT_CLIENT_*) with attacker and
 *            weapon; kills and deaths (obituary); the hit-marker sound "mp_hit_alert" the server
 *            plays for the POV whenever he damages a player (number of hits dealt, no value); the
 *            POV's own bullet impacts EV_BULLET_HIT (shooter = otherEntityNum, un1 bit 0 = head)
 *   derived  (≈) damage without hit event and without attacker direction (damageYaw 255) = own
 *            grenade (a frag of the POV detonated) or fall; an explosion with direction = thrower
 *            unknown; the weapon of a dealt hit = the weapon the POV held; headshot hits taken
 *            from the sound "bullet_impact_headshot_2"; the victim of an own bullet impact = the
 *            nearest player (hits per opponent)
 *   n/a      damage dealt as a value
 * Only phase "live" counts (like the scoreboard). The lethal hit shows as the health left (e.g.
 * 40 -> 0), not as its raw damage. All times: ms since the first snapshot. */
C4.define('povDamage', function (C4) {
  'use strict';
  const W = C4.weapons;

  const HIT_WINDOW = 100;        // bullet hit event <-> health drop (measured: same snapshot)
  const IMPACT_WINDOW = 150;     // own bullet impact <-> hit marker
  const DEATH_WINDOW = 150;      // obituary <-> last health drop
  const BLAST_WINDOW = [200, 100];   // frag detonation before / after a health drop or hit alert
  const NO_DIRECTION = 255;      // damageYaw without attacker direction (self / world)
  const OWN_NADE_DIST = 120;     // first sighting of the POV's own grenade: this close to the POV
  const SOURCES = ['enemy', 'team', 'self', 'other'];

  const zeroBy = () => ({ enemy: 0, team: 0, self: 0, other: 0 });
  const emptyBucket = () => ({ damageDealt: null, damageTaken: 0, damageTakenBy: zeroBy(), damageTakenApprox: 0,
    hitsTaken: 0, hitsTakenBy: zeroBy(), hitsDealt: 0, headshotHitsDealt: 0, kills: 0, headshotKills: 0, deaths: 0, died: false, deathCause: null });

  /** index of the first element with key >= v in a sorted array */
  function lowerBound(arr, v, key) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) < v) lo = m + 1; else hi = m; }
    return lo;
  }
  const within = (arr, t, before, after) => {
    const i = lowerBound(arr, t - before, x => x.t);
    return i < arr.length && arr[i].t <= t + after ? arr[i] : null;
  };

  function analyze(ctx) {
    const { pov, states, kills, rounds, phaseAt, roundAt, sideAt, playerName } = ctx;
    const out = { povClient: pov, povName: ctx.povName, available: false,
      sources: { hitAlerts: 0, headshotSounds: 0 },
      overview: null, rounds: [], otherLive: null, opponents: [], weapons: { taken: [], dealt: [] },
      timeline: { health: { t: [], hp: [] }, events: [] } };
    if (pov == null) return out;
    const counted = t => phaseAt(t) === 'live';
    const relation = (cl, t) => {
      if (cl == null || cl === pov) return 'self';
      if (cl >= 64) return 'other';
      const a = sideAt(cl, t), b = sideAt(pov, t);
      if ((a === 1 || a === 2) && (b === 1 || b === 2)) return a === b ? 'team' : 'enemy';
      return 'other';
    };

    // ---- the POV's own frag grenades (≈): first seen right at the POV, right after the launch
    const track = ctx.povTrack;
    const povPosAt = t => {
      if (!track || !track.t.length) return null;
      let i = lowerBound(track.t, t + 1, x => x) - 1;
      if (i < 0 || t - track.t[i] > 300) return null;
      return [track.x[i], track.y[i], track.z[i]];
    };
    const blasts = [];                  // frag detonations {t, own}
    for (const g of ctx.grenades) {
      if (g.kind !== 'frag' || !g.detonation) continue;
      let own = false;
      if (g.segments.length && g.launch != null && g.first - g.launch <= 300) {
        const p = povPosAt(g.first), s = g.segments[0];
        own = !!p && Math.hypot(s[2] - p[0], s[3] - p[1], s[4] - p[2]) <= OWN_NADE_DIST;
      }
      blasts.push({ t: g.detonation.t, own, weapon: g.weapon });
    }
    blasts.sort((a, b) => a.t - b.t);

    // ---- health of the POV (only while the player state follows the POV himself)
    const H = out.timeline.health;
    let lastHp;
    for (const s of states) {
      const hp = s.client === pov ? Math.max(0, s.health) : null;
      if (hp === lastHp) continue;
      H.t.push(s.t); H.hp.push(hp); lastHp = hp;
    }
    if (!H.t.length || H.hp.every(v => v == null)) return out;
    out.available = true;

    // ---- bucket per match round (+ live time outside a match round, normally empty)
    const buckets = rounds.map(r => (r.kind === 'round' ? emptyBucket() : null));
    const other = emptyBucket();
    const bucketAt = t => { const ri = roundAt(rounds, t); return { ri, b: ri >= 0 && buckets[ri] ? buckets[ri] : other }; };
    const opp = new Map();
    const oppRow = (cl, t) => {
      if (!opp.has(cl)) opp.set(cl, { client: cl, name: playerName(cl), relation: relation(cl, t), damageTaken: 0, hitsTaken: 0,
        killedPov: 0, kills: 0, hitsDealt: 0, headshotHitsDealt: 0, hitsDealtApprox: true });
      return opp.get(cl);
    };
    const wTaken = new Map(), wDealt = new Map();
    /** row of a per-weapon table; weapon = internal weapon name or MOD_* (icon via C4.weapons.weaponIcon) */
    const wRow = (map, key, weapon, label, approx, source) => {
      if (!map.has(key)) map.set(key, { weapon: weapon || null, label, source: source || null, damage: 0, hits: 0, kills: 0, headshotKills: 0, approx: !!approx });
      const r = map.get(key);
      if (approx) r.approx = true;
      return r;
    };
    const weaponRow = (map, weapon, approx) => wRow(map, weapon || '(unknown)', weapon, weapon ? W.label(weapon) : 'Unknown weapon', approx);
    const ev = out.timeline.events;

    // ---- deaths / kills of the POV
    const povDeaths = kills.filter(k => k.victim === pov);
    const deathAt = t => { const i = lowerBound(povDeaths, t - DEATH_WINDOW, k => k.t); return i < povDeaths.length && povDeaths[i].t <= t + DEATH_WINDOW ? povDeaths[i] : null; };
    const hitsOnPov = ctx.hitsTaken.filter(h => h.victim === pov);
    const usedHits = new Set();

    // ---- damage taken: every health drop while the POV is followed
    let prev = null;
    const drops = [];
    for (const s of states) {
      if (s.client !== pov) { prev = null; continue; }
      if (prev && s.health < prev.health) drops.push({ s, prev });
      prev = s;
    }
    for (const { s, prev: p } of drops) {
      const t = s.t, amount = Math.max(0, p.health) - Math.max(0, s.health);
      const step = (s.damageEvent - p.damageEvent) & 0xff;
      const hits = step >= 1 && step <= 16 ? step : 1;
      let attacker = null, weapon = null, source, how, approx = false, weaponApprox = false, headshot = false;
      const lethal = s.health <= 0;
      // exact: the obituary of the POV's death, or a bullet hit event on the POV
      let hit = null;
      for (let i = lowerBound(hitsOnPov, t - HIT_WINDOW, x => x.t); i < hitsOnPov.length && hitsOnPov[i].t <= t + HIT_WINDOW; i++) {
        if (!usedHits.has(i)) { hit = hitsOnPov[i]; usedHits.add(i); break; }
      }
      const death = lethal ? deathAt(t) : null;
      if (death) {
        attacker = death.attacker;
        headshot = !!death.headshot;
        // the obituary of a headshot names no weapon: the bullet hit event does (else the killer's held weapon, ≈)
        if (hit && death.headshot) weapon = hit.weapon;
        else if (death.weaponName && death.weaponName !== 'none') { weapon = death.weaponName; weaponApprox = !!death.weaponHeuristic; }
        else weapon = death.mod || null;
        how = death.falling ? 'fall' : death.suicide ? 'suicide' : death.world ? 'world' : death.entityAttacker ? 'entity' : 'kill';
        source = death.suicide || death.falling ? 'self' : death.world || death.entityAttacker ? 'other' : death.teamkill ? 'team' : relation(attacker, t);
      } else if (hit) {
        attacker = hit.attacker; weapon = hit.weapon; how = 'bullet';
        source = relation(attacker, t);
      } else {
        const blast = within(blasts, t, BLAST_WINDOW[0], BLAST_WINDOW[1]);
        approx = true;
        if (s.damageYaw === NO_DIRECTION && step >= 1) {
          // no attacker direction: the POV hurt himself
          source = 'self';
          if (blast) { how = 'own grenade'; weapon = blast.weapon; attacker = pov; }
          else how = 'fall';
        } else if (blast) {
          source = blast.own ? 'self' : 'other'; how = blast.own ? 'own grenade' : 'explosion'; weapon = blast.weapon;
          if (blast.own) attacker = pov;
        } else { source = 'other'; how = 'unknown'; approx = false; }
      }
      const isCounted = counted(t);
      const { ri, b } = bucketAt(t);
      ev.push({ t, type: 'taken', amount, hits, source, how, attacker, weapon, approx, weaponApprox, lethal, round: ri, counted: isCounted,
        headshot, headshotApprox: false, healthBefore: Math.max(0, p.health), healthAfter: Math.max(0, s.health) });
      if (!isCounted) continue;
      b.damageTaken += amount; b.damageTakenBy[source] += amount; b.hitsTaken += hits; b.hitsTakenBy[source] += hits;
      if (approx) b.damageTakenApprox += amount;
      if (attacker != null && attacker !== pov && attacker < 64 && (source === 'enemy' || source === 'team')) {
        const o = oppRow(attacker, t); o.damageTaken += amount; o.hitsTaken += hits;
      }
      // per weapon: the attacker's weapon; self / other damage one row per kind
      let wr;
      if (source === 'enemy' || source === 'team') wr = wRow(wTaken, source + ':' + (weapon || '?'), weapon, weapon ? W.label(weapon) : 'Unknown weapon', approx || weaponApprox, source);
      else {
        const kind = {
          fall: ['MOD_FALLING', 'Fall'], suicide: [weapon || 'MOD_SUICIDE', 'Suicide' + (weapon && !/^MOD_/.test(weapon) ? ' (' + W.label(weapon) + ')' : '')],
          'own grenade': [weapon, 'Own grenade'], world: [null, 'World / trigger'], entity: [weapon, 'World entity (' + (weapon ? W.label(weapon) : '?') + ')'],
          explosion: [weapon, 'Explosion (thrower unknown)'], unknown: [null, 'Unknown source']
        }[how] || [null, how];
        wr = wRow(wTaken, source + ':' + how + ':' + (kind[0] || ''), kind[0], kind[1], approx, source);
      }
      wr.damage += amount; wr.hits += hits;
      if (lethal) wr.kills++;
    }

    // ---- headshot sounds: headshot hits taken (the sound at a health drop, ≈); the POV's own
    //      headshots come from the head flag of his bullet impacts
    const takenEv = ev.filter(e => e.type === 'taken');
    const alerts = ctx.sounds.filter(x => x.name === 'mp_hit_alert');
    const hsSounds = ctx.sounds.filter(x => x.name === 'bullet_impact_headshot_2');
    out.sources.hitAlerts = alerts.length;
    out.sources.headshotSounds = hsSounds.length;
    out.sources.ownImpacts = (ctx.povImpacts || []).length;
    for (const h of hsSounds) {
      const drop = within(takenEv, h.t, HIT_WINDOW, HIT_WINDOW);
      if (drop && !drop.headshot) { drop.headshot = true; drop.headshotApprox = true; }
    }

    // ---- hits dealt: one hit-marker sound per damage the POV did (no value, no victim)
    const heldWeaponAt = t => {
      const i = lowerBound(states, t + 1, x => x.t) - 1;
      for (let j = i; j >= 0 && j > i - 50; j--) {
        if (states[j].client !== pov) continue;
        // weapon 0 = nothing in hand (e.g. while throwing a grenade): unknown, not "None"
        const n = ctx.weaponName(states[j].weapon, states[j].t);
        return n && n !== 'none' ? n : null;
      }
      return null;
    };
    const impacts = ctx.povImpacts || [];
    for (const a of alerts) {
      const blast = within(blasts, a.t, BLAST_WINDOW[0], BLAST_WINDOW[1]);
      // the own bullet impact of this hit marker (same snapshot): weapon, head flag, victim (≈)
      const imp = impacts.length ? within(impacts, a.t, IMPACT_WINDOW, IMPACT_WINDOW) : null;
      const weapon = imp ? imp.weapon : blast && blast.own ? blast.weapon : heldWeaponAt(a.t);
      const isCounted = counted(a.t);
      const { ri, b } = bucketAt(a.t);
      ev.push({ t: a.t, type: 'dealt', weapon, weaponApprox: !imp, headshot: imp ? imp.headshot : null,
        victim: imp ? imp.victim : null, victimApprox: true, round: ri, counted: isCounted });
      if (!isCounted) continue;
      b.hitsDealt++;
      weaponRow(wDealt, weapon, !imp).hits++;
    }
    // ---- the POV's own bullet impacts: headshots (flag, exact) and hits per opponent (victim ≈)
    let impactsCounted = 0, impactsNoVictim = 0;
    for (const h of impacts) {
      if (!counted(h.t)) continue;
      impactsCounted++;
      const { b } = bucketAt(h.t);
      if (h.headshot) b.headshotHitsDealt++;
      if (h.victim == null || h.victim >= 64) { impactsNoVictim++; continue; }
      const o = oppRow(h.victim, h.t);
      o.hitsDealt++;
      if (h.headshot) o.headshotHitsDealt++;
    }

    // ---- kills and deaths (exact, obituary)
    for (const k of kills) {
      if (k.attacker !== pov && k.victim !== pov) continue;
      const isCounted = k.phase === 'live';
      const { ri, b } = bucketAt(k.t);
      if (k.victim === pov) {
        ev.push({ t: k.t, type: 'death', attacker: k.attacker, weapon: k.weaponName, weaponLabel: k.weaponLabel, mod: k.mod,
          headshot: k.headshot, suicide: k.suicide, world: k.world, teamkill: k.teamkill, kill: k.index, round: ri, counted: isCounted });
        if (!isCounted) continue;
        b.died = true; b.deaths++;
        b.deathCause = k.suicide ? 'suicide' : k.falling ? 'fall' : k.world ? 'world' : k.teamkill ? 'team kill' : 'killed';
        if (k.attacker !== pov && k.attacker < 64) oppRow(k.attacker, k.t).killedPov++;
      } else {
        ev.push({ t: k.t, type: 'kill', victim: k.victim, weapon: k.weaponName, weaponLabel: k.weaponLabel, headshot: k.headshot,
          teamkill: k.teamkill, kill: k.index, round: ri, counted: isCounted });
        if (!isCounted) continue;
        if (k.victim < 64) oppRow(k.victim, k.t).kills++;
        // the scoreboard's counting rule: no kill for a team kill / suicide / world or entity kill
        const credit = !k.suicide && !k.world && !k.entityAttacker && !k.teamkill;
        if (!credit) continue;
        b.kills++;
        if (k.headshot) b.headshotKills++;
        const wr = weaponRow(wDealt, k.weaponName && k.weaponName !== 'none' ? k.weaponName : k.mod, !!k.weaponHeuristic);
        wr.kills++;
        if (k.headshot) wr.headshotKills++;
      }
    }
    ev.sort((a, b) => a.t - b.t);

    // ---- per round / totals: the totals are the sum of the rounds (+ other live time)
    const sumInto = (acc, b) => {
      for (const k of ['damageTaken', 'damageTakenApprox', 'hitsTaken', 'hitsDealt', 'headshotHitsDealt', 'kills', 'headshotKills', 'deaths']) acc[k] += b[k];
      for (const s of SOURCES) { acc.damageTakenBy[s] += b.damageTakenBy[s]; acc.hitsTakenBy[s] += b.hitsTakenBy[s]; }
    };
    const total = emptyBucket();
    rounds.forEach((r, i) => {
      const b = buckets[i];
      if (!b) return;
      out.rounds.push(Object.assign({ round: i, label: r.label, half: r.half }, b));
      sumInto(total, b);
    });
    const otherUsed = other.damageTaken || other.hitsTaken || other.hitsDealt || other.headshotHitsDealt || other.kills || other.deaths;
    if (otherUsed) { out.otherLive = Object.assign({}, other); sumInto(total, other); }
    const headshotHitsTaken = takenEv.filter(e => e.counted && e.headshot).length;
    out.overview = {
      damageTaken: total.damageTaken, damageTakenBy: total.damageTakenBy, damageTakenApprox: total.damageTakenApprox,
      hitsTaken: total.hitsTaken, hitsTakenBy: total.hitsTakenBy,
      damageDealt: null,
      hitsDealt: total.hitsDealt, headshotHitsDealt: total.headshotHitsDealt, headshotHitsTaken,
      // own bullet impacts of the POV (another source than the hit markers: bullets only, and only
      // the impacts sent to him); without a player near the impact no victim
      impacts: impactsCounted, impactsNoVictim,
      kills: total.kills, headshotKills: total.headshotKills, deaths: total.deaths,
      // kills of the POV but not one hit-marker sound in the whole demo: the server does not send it
      hitsDealtAvailable: alerts.length > 0 || !kills.some(k => k.attacker === pov && k.victim !== pov && !k.world)
    };
    if (!out.overview.hitsDealtAvailable) {
      out.overview.hitsDealt = null;
      for (const r of out.rounds) r.hitsDealt = null;
    }
    out.opponents = [...opp.values()].filter(o => o.relation === 'enemy' || o.relation === 'team')
      .sort((a, b) => (a.relation === b.relation ? 0 : a.relation === 'enemy' ? -1 : 1) || b.damageTaken - a.damageTaken || b.kills - a.kills);
    out.weapons.taken = [...wTaken.values()].sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || b.damage - a.damage);
    out.weapons.dealt = [...wDealt.values()].sort((a, b) => b.hits - a.hits || b.kills - a.kills);
    return out;
  }

  C4.povDamage = { analyze, SOURCES };
});
