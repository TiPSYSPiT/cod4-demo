/* Assemble DemoData - the only object the UI renders from.
 *
 *   C4.analyzeDemo(bytes, fileInfo, onProgress) -> DemoData
 *
 * All times in DemoData are milliseconds since the first snapshot. */
C4.define('build', function (C4) {
  'use strict';
  const { stripColors, parseInfostring } = C4.text;
  const K = C4.constants;
  const W = C4.weapons;
  const N = C4.names;

  const CS_RANGES = [[20, 147, 'dvar name'], [148, 275, 'dvar value'], [277, 308, 'use trigger'],
    [309, 820, 'localized string'], [830, 1341, 'model'], [1342, 1597, 'sound'], [1598, 1697, 'effect'],
    [1698, 1953, 'effect tag'], [1954, 1969, 'shellshock'], [1970, 2001, 'script menu'],
    [2002, 2257, 'material'], [2259, 2266, 'status icon'], [2267, 2281, 'head icon'], [2282, 2313, 'tag']];
  const CS_SINGLE = { 0: 'serverinfo', 1: 'systeminfo', 2: 'game version', 3: 'message', 4: 'scores 1',
    5: 'scores 2', 9: 'fog', 10: 'motd', 11: 'game end time', 12: 'map centre', 13: 'vote time',
    14: 'vote string', 15: 'vote yes', 16: 'vote no', 821: 'ambient', 822: 'north yaw', 823: 'minimap',
    824: 'vision set', 825: 'night vision set', 2258: 'weapon list', 2314: 'items' };
  function csCategory(i) {
    if (CS_SINGLE[i]) return CS_SINGLE[i];
    for (const [a, b, n] of CS_RANGES) if (i >= a && i <= b) return n;
    return i >= 2442 ? 'extended' : 'other';
  }

  const pad2 = n => String(n).padStart(2, '0');
  /** "Sun Aug 30 18:22:12 2026" (ctime, server local time) -> "20260830182212"; null if not in that form.
   * Parsed by hand: Date() would apply the browser's time zone. */
  function ctimeStamp(text) {
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text));
    const mon = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    return mon < 0 ? null : m[6] + pad2(mon + 1) + pad2(m[2]) + pad2(m[3]) + m[4] + m[5];
  }
  /** Date -> "YYYYMMDDHHMMSS" in local time */
  function localStamp(dt) {
    return dt.getFullYear() + pad2(dt.getMonth() + 1) + pad2(dt.getDate()) + pad2(dt.getHours()) + pad2(dt.getMinutes()) + pad2(dt.getSeconds());
  }

  function protocolLabel(p) {
    if (p === 1) return 'Stock CoD4';
    if (p <= 17) return 'CoD4X ' + p + ' (legacy position encoding)';
    return 'CoD4X ' + p;
  }

  function analyzeDemo(bytes, fileInfo, onProgress) {
    const { collector: col, visitor } = C4.collect.createCollector();
    let summary = null, fatal = null;
    try {
      summary = C4.demo.parseDemo(bytes, visitor, onProgress);
    } catch (err) {
      if (err instanceof C4.demo.DemoError) throw err;
      fatal = err;                                  // keep what was read so far
    }
    if (col.firstTime === null) {
      if (fatal) throw fatal;
      throw new C4.demo.DemoError('The demo contains no readable snapshot.');
    }
    return build(col, summary, fatal, fileInfo || {});
  }

  function build(col, summary, fatal, fileInfo) {
    const t0 = col.firstTime;
    const endTime = col.lastTime - t0;
    const rel = t => (t == null ? null : Math.max(0, Math.min(t - t0, endTime)));
    const warnings = [];
    if (fatal) warnings.push('Reading stopped because of an internal error: ' + (fatal.message || fatal) + '. Results are partial.');
    if (summary && summary.truncated) warnings.push('The demo is truncated (the last record is cut off). Everything up to that point is shown.');
    if (summary && !summary.cleanEnd && !summary.truncated) warnings.push('The demo has no end marker.');
    const proto = summary ? summary.protocol : col.protocol;
    if (![1, 17, 19, 21].includes(proto)) warnings.push('Protocol ' + proto + ' has not been tested (tested: stock CoD4, CoD4X 17, 19, 21). The field tables may differ - check the results.');
    if (summary && summary.stats.snapshotsDropped) warnings.push(summary.stats.snapshotsDropped + ' snapshot(s) could not be decoded (delta reference missing in the file) and were skipped.');

    const cs = col.cs;
    const csInit = col.csInitial || cs;
    const serverinfo = parseInfostring(cs.get(K.CS.SERVERINFO) || '');
    const systeminfo = parseInfostring(cs.get(K.CS.SYSTEMINFO) || '');
    const weapons = String(cs.get(K.CS.WEAPONFILES) || '').split(/\s+/).filter(Boolean);
    const weaponName = i => (i > 0 && i <= weapons.length ? weapons[i - 1] : (i === 0 ? 'none' : null));

    // dvars announced by the server (names 20..147, values +128)
    const dvars = {};
    for (let i = 0; i < 128; i++) {
      const name = cs.get(K.CS.CODINFO + i);
      if (name) dvars[name] = cs.get(K.CS.CODINFO_VALUE + i) || '';
    }
    let attackSide = 'allies', attackSideHeuristic = true;
    if (/attack/i.test(dvars.g_TeamName_Allies || '')) { attackSide = 'allies'; attackSideHeuristic = false; }
    else if (/attack/i.test(dvars.g_TeamName_Axis || '')) { attackSide = 'axis'; attackSideHeuristic = false; }

    // times
    const commands = col.commands.map(c => ({ t: rel(c.t || col.firstTime), seq: c.seq, text: c.text, d: c.d }));
    const csOldByCmd = new Map();
    {
      // old values of config string commands, in order
      const cur = new Map(csInit);
      for (const c of commands) {
        if (c.d.verb === 'd' && c.d.index != null) { csOldByCmd.set(c, cur.has(c.d.index) ? cur.get(c.d.index) : null); cur.set(c.d.index, c.d.value); }
      }
    }
    const csChanges = col.csChanges.map(ch => ({ t: rel(ch.t || col.firstTime), index: ch.index, old: ch.old, value: ch.value }));

    // ruleset / promod headers: the most frequent non-empty value over the demo
    const mostFrequent = idx => {
      const count = new Map();
      const add = v => { const s = stripColors(v || '').trim(); if (s) count.set(s, (count.get(s) || 0) + 1); };
      add(csInit.get(idx));
      for (const ch of csChanges) if (ch.index === idx) add(ch.value);
      let best = null, n = 0;
      for (const [s, k] of count) if (k > n) { best = s; n = k; }
      return best;
    };
    const rulesetHud = mostFrequent(381);
    const promodHeader = mostFrequent(380);
    const fsGame = serverinfo.fs_game || systeminfo.fs_game || '';

    // teams
    const teams = C4.teams.analyzeTeams(
      { teamTimeline: col.teamTimeline.map(e => ({ t: rel(e.t), client: e.client, team: e.team })) }, 0, endTime);

    const names = col.names;
    const povClient = col.gamestate ? col.gamestate.clientNum : null;
    const allClients = new Set([...names.keys(), ...teams.teamOf.keys()]);
    const playerName = cl => {
      if (cl === K.ENTITYNUM_WORLD) return 'World';
      if (cl == null) return 'n/a';
      if (cl >= 64) return 'Entity ' + cl;
      const n = names.get(cl);
      return n ? n.name : 'Client ' + cl;
    };

    // kills
    const kills = col.kills.map((k, index) => {
      const t = rel(k.t);
      const isMod = (k.parm & 0x80) !== 0;
      const mod = isMod ? K.MEANS_OF_DEATH[k.parm & 0x7f] || 'MOD_UNKNOWN' : null;
      const weapon = isMod ? null : k.parm;
      const world = k.attacker === K.ENTITYNUM_WORLD || k.attacker === K.ENTITYNUM_NONE;
      const entityAttacker = !world && k.attacker >= 64;
      const suicide = k.attacker === k.victim || mod === 'MOD_SUICIDE';
      // teams at the moment of the kill; a team kill = both on the same side (client states)
      const aTeam = entityAttacker || world ? null : teams.teamAt(k.attacker, t);
      const vTeam = teams.teamAt(k.victim, t);
      const aSide = teams.rawSideAt(k.attacker, t), vSide = teams.rawSideAt(k.victim, t);
      const teamkill = !suicide && !world && !entityAttacker && (aSide === 1 || aSide === 2) && aSide === vSide;
      let wName = weapon != null ? weaponName(weapon) : null;
      let weaponHeuristic = false;
      if (mod === 'MOD_HEAD_SHOT' && k.attackerWeapon != null) {
        wName = weaponName(k.attackerWeapon);
        weaponHeuristic = true;
      }
      let label;
      if (mod === 'MOD_HEAD_SHOT') label = wName ? W.label(wName) : 'Headshot';
      else if (mod) label = W.MOD_LABELS[mod] || mod;
      else label = wName ? W.label(wName) : 'Weapon #' + weapon;
      const dist = k.attackerPos && k.victimPos && !suicide && !world
        ? Math.round(Math.hypot(k.attackerPos[0] - k.victimPos[0], k.attackerPos[1] - k.victimPos[1], k.attackerPos[2] - k.victimPos[2]))
        : null;
      return {
        index, t, attacker: k.attacker, victim: k.victim, weapon, weaponName: wName, weaponLabel: label,
        weaponHeuristic, mod, headshot: mod === 'MOD_HEAD_SHOT', knife: mod === 'MOD_MELEE',
        falling: mod === 'MOD_FALLING', suicide, world, entityAttacker, teamkill,
        // frag grenade kill: only from the weapon in the obituary (never from the held weapon of a headshot)
        nade: weapon != null && W.isFragNade(weaponName(weapon)),
        bomb: /briefcase_bomb/.test(wName || ''), car: wName === 'destructible_car',
        attackerTeam: aTeam || null, victimTeam: vTeam || null,
        attackerPos: k.attackerPos, victimPos: k.victimPos, distance: dist, round: -1
      };
    });

    // rounds
    const R = C4.rounds.analyzeRounds({ commands, csChanges, teams, kills, attackSide, endTime,
      clients: Array.from(teams.byClient.keys()) });
    const rounds = R.rounds;
    for (let i = 0; i < rounds.length; i++) for (const ki of rounds[i].kills) kills[ki].round = i;
    if (R.initialScore.A + R.initialScore.B > 0) {
      warnings.push('The recording starts in the middle of the match at ' + R.initialScore.A + ':' + R.initialScore.B +
        ' - the first ' + (R.initialScore.A + R.initialScore.B) + ' rounds are not in the demo.');
    }
    // Half numbers of a recording that starts mid-match: halftimes before the recording are not in the
    // demo. Derived from the Promod ruleset ("MR12" = 12 rounds per half, "OT3" = 3 per overtime half)
    // and the score at the start (heuristic). The half the recording starts in is incomplete unless the
    // recording starts exactly at a half boundary.
    const halfInfo = { offset: 0, heuristic: false, firstPartial: false, unknown: false };
    const playedBefore = R.initialScore.A + R.initialScore.B;
    const firstMatchRound = rounds.find(r => r.kind === 'round');
    if (playedBefore > 0 && firstMatchRound) {
      const mr = Number((/\bMR(\d+)/i.exec(rulesetHud || '') || [])[1]) || 0;
      const ot = Number((/\bOT(\d+)/i.exec(rulesetHud || '') || [])[1]) || 0;
      let off = null, boundary = false;
      if (mr && playedBefore < 2 * mr) { off = Math.floor(playedBefore / mr); boundary = playedBefore % mr === 0; }
      else if (mr && ot) { off = 2 + Math.floor((playedBefore - 2 * mr) / ot); boundary = (playedBefore - 2 * mr) % ot === 0; }
      if (off == null) { halfInfo.unknown = true; halfInfo.firstPartial = true; }
      else {
        // a halftime already recorded before the first round is counted by the round analysis
        off -= R.halftimes.filter(h => h < firstMatchRound.segStart + 1).length;
        halfInfo.offset = Math.max(0, off);
        halfInfo.heuristic = true;
        halfInfo.firstPartial = !boundary;
      }
      for (const r of rounds) r.half += halfInfo.offset;
    }

    // players: the game's scoreboard (b) first.
    // Scoreboards reset to zero after the last round (map restart after the match) are ignored.
    const boards = col.scoreboards.map(sb => ({ t: rel(sb.t), entries: sb.entries }));
    const isZero = sb => sb.entries.length > 0 && sb.entries.every(e => !e.score && !e.kills && !e.deaths && !e.assists);
    let validUntil = Infinity;
    for (let i = 1; i < boards.length; i++) {
      if (isZero(boards[i]) && !isZero(boards[i - 1]) && R.lastRoundEnd != null && boards[i].t > R.lastRoundEnd) { validUntil = boards[i].t; break; }
    }
    const lastEntry = new Map();
    for (const sb of boards) {
      if (sb.t >= validUntil) break;
      for (const e of sb.entries) if (e.client != null) lastEntry.set(e.client, Object.assign({ t: sb.t }, e));
    }
    const own = new Map(), after = new Map();
    const bump = (map, cl, key) => { if (cl == null || cl >= 64) return; const o = map.get(cl) || { kills: 0, deaths: 0, headshots: 0, teamkills: 0, nadeKills: 0, nadeDeaths: 0 }; o[key]++; map.set(cl, o); };
    // team kills of the running match only: live phase of a match round (live start = CS 11 to the
    // round win). Warm-up, pauses (timeouts), strat mode and ready-up are segments without a round,
    // the knife round is not counted either (like kills / deaths); excluded ones go to diagnostics.
    const teamkillsExcluded = { outsideRounds: 0, knifeRound: 0, outsideLivePhase: 0 };
    for (const k of kills) {
      if (!k.teamkill) continue;
      const r = k.round >= 0 ? rounds[k.round] : null;
      if (!r) teamkillsExcluded.outsideRounds++;
      else if (r.kind !== 'round') teamkillsExcluded.knifeRound++;
      else if (k.t < r.start || (r.end != null && k.t > r.end)) teamkillsExcluded.outsideLivePhase++;
      else bump(own, k.attacker, 'teamkills');
    }
    for (const k of kills) {
      if (k.round < 0 || rounds[k.round].kind !== 'round') continue;
      // counting rules measured against the Promod scoreboard: team kills and suicides give
      // the shooter no kill; deaths by the world (falling) are not counted as deaths
      const credit = !k.suicide && !k.world && !k.entityAttacker && !k.teamkill;
      const death = !k.world;
      if (death) bump(own, k.victim, 'deaths');
      if (credit) bump(own, k.attacker, 'kills');
      if (credit && k.headshot) bump(own, k.attacker, 'headshots');
      // frag grenade kills / deaths, same kill events and rules as K/D: an own grenade or a team
      // mate's grenade gives the victim a nade death but nobody a nade kill
      if (credit && k.nade) bump(own, k.attacker, 'nadeKills');
      if (death && k.nade) bump(own, k.victim, 'nadeDeaths');
      // kills after a player's last scoreboard entry: the last scoreboard can be older than the last round
      const ev = lastEntry.get(k.victim);
      if (death && ev && k.t > ev.t) bump(after, k.victim, 'deaths');
      const ea = lastEntry.get(k.attacker);
      if (credit && ea && k.t > ea.t) bump(after, k.attacker, 'kills');
    }
    const resolver = C4.events.nameResolver(col.nameHistory, names);
    const status = R.status;
    const events = C4.events.buildEvents({ commands, rounds, kills, slotEvents: col.slotEvents.map(s => ({ t: rel(s.t) - (s.t === col.firstTime ? 1 : 0), client: s.client, kind: s.kind })), resolver, povClient, playerName, endTime, status, halftimes: R.halftimes, halftimeFromSound: R.halftimeFromSound });
    const leftAt = new Map(), joinedAt = new Map();
    for (const e of events) {
      if (e.type === 'left' && e.clients.length) leftAt.set(e.clients[0], e.t);
      if (e.type === 'joined' && e.clients.length && !joinedAt.has(e.clients[0])) joinedAt.set(e.clients[0], e.t);
      if (e.type === 'disconnected' && e.clients.length && e.t < endTime - 5000 && !leftAt.has(e.clients[0])) leftAt.set(e.clients[0], e.t);
    }
    // a player who came back after leaving did not leave early
    for (const s of col.slotEvents) if (s.kind === 'connected' && leftAt.has(s.client) && rel(s.t) > leftAt.get(s.client)) leftAt.delete(s.client);
    // bomb plants / defuses per player: server message MP_EXPLOSIVES_PLANTED_BY / _DEFUSED_BY<name>,
    // counted in match rounds only (not in warm-up or strat mode); unresolved names are listed in diagnostics.
    // The bomb can be planted and defused once per round: a repeated message (seen: the same plant
    // sent twice 50 ms apart) is counted once.
    const plants = new Map(), defuses = new Map(), bombUnresolved = [], bombSeen = new Set();
    for (const e of events) {
      if (e.type !== 'bomb_planted' && e.type !== 'bomb_defused') continue;
      const ri = C4.events.roundAt(rounds, e.t);
      if (ri < 0 || rounds[ri].kind !== 'round') continue;
      if (bombSeen.has(e.type + ri)) continue;
      bombSeen.add(e.type + ri);
      const cl = e.clients.length ? e.clients[0] : null;
      if (cl == null) { bombUnresolved.push({ t: e.t, text: e.text }); continue; }
      const m = e.type === 'bomb_planted' ? plants : defuses;
      m.set(cl, (m.get(cl) || 0) + 1);
    }

    const byTeam = { A: [], B: [] };
    const players = [];
    for (const cl of Array.from(allClients).filter(c => c < 64).sort((a, b) => a - b)) {
      const n = names.get(cl) || { name: 'Client ' + cl, clantag: '' };
      const team = teams.teamOf.get(cl) || 'spectator';
      const e = lastEntry.get(cl);
      const o = own.get(cl) || { kills: 0, deaths: 0 };
      const a = after.get(cl) || { kills: 0, deaths: 0 };
      const p = {
        client: cl, name: n.name, cleanName: stripColors(n.name).trim(), cod4xTag: n.clantag || '',
        team, isPov: cl === povClient,
        score: e ? e.score : null,
        kills: e ? e.kills + a.kills : o.kills, deaths: e ? e.deaths + a.deaths : o.deaths,
        assists: e ? e.assists : null, ping: e ? e.ping : null,
        statsSource: e ? (a.kills || a.deaths ? 'scoreboard+killfeed' : 'scoreboard') : 'killfeed',
        scoreboardTime: e ? e.t : null, killsAfterScoreboard: a.kills, deathsAfterScoreboard: a.deaths,
        ownKills: o.kills, ownDeaths: o.deaths,
        // headshot share of the kills in the kill feed of this demo (the scoreboard has no headshots)
        headshots: o.headshots || 0, headshotPct: o.kills ? (o.headshots || 0) / o.kills * 100 : null,
        plants: plants.get(cl) || 0, defuses: defuses.get(cl) || 0,
        teamkills: o.teamkills || 0,
        nadeKills: o.nadeKills || 0, nadeDeaths: o.nadeDeaths || 0,
        joinedAt: joinedAt.has(cl) ? joinedAt.get(cl) : null, leftAt: leftAt.has(cl) ? leftAt.get(cl) : null,
        clan: '', clanHeuristic: false
      };
      p.leftEarly = p.leftAt != null;
      players.push(p);
      if (team === 'A' || team === 'B') byTeam[team].push(p);
    }
    const tagInfo = C4.teams.clanTags(byTeam);
    for (const p of players) {
      const t = tagInfo.tags.get(p.client);
      if (t) { p.clan = t.tag; p.clanHeuristic = t.heuristic; }
      else if (p.team === 'spectator') {
        const m = p.cleanName.match(/^\s*[[({<]([^\])}>]{1,12})[\])}>]/);
        if (m) { p.clan = m[0].trim(); p.clanHeuristic = true; }
      }
    }
    // own count vs. game scoreboard (the brief asks for console.debug of the differences)
    const diagnostics = { scoreboardMismatches: [], scoreboardResetIgnored: validUntil !== Infinity, bombUnresolved, teamkillsExcluded };
    for (const p of players) {
      if (p.statsSource !== 'killfeed' && (p.kills !== p.ownKills || p.deaths !== p.ownDeaths)) {
        diagnostics.scoreboardMismatches.push({ client: p.client, name: p.cleanName, shown: [p.kills, p.deaths],
          killfeed: [p.ownKills, p.ownDeaths], addedAfterScoreboard: [p.killsAfterScoreboard, p.deathsAfterScoreboard] });
      }
    }
    const teamList = ['A', 'B'].map(key => ({
      key,
      name: tagInfo.teamNames[key] ? tagInfo.teamNames[key].name : 'Team ' + key,
      nameHeuristic: !!tagInfo.teamNames[key],
      clients: byTeam[key].map(p => p.client),
      wins: R.finalScore[key],
      halves: [],
      startSide: key === 'A' ? 'axis' : 'allies'
    }));
    for (const t of teamList) {
      const halves = [];
      for (const r of rounds) {
        if (r.kind !== 'round') continue;
        halves[r.half - 1] = (halves[r.half - 1] || 0) + (r.winnerTeam === t.key ? 1 : 0);
      }
      t.halves = Array.from(halves, v => v == null ? null : v);   // null = half not in the recording
    }

    // cross-check the final score with the team scores the server sent at the last round win
    if (R.serverScore) {
      diagnostics.serverScore = R.serverScore;
      if (R.serverScore.A !== R.finalScore.A || R.serverScore.B !== R.finalScore.B) {
        warnings.push('Final score from the round analysis (' + R.finalScore.A + ':' + R.finalScore.B +
          ') differs from the team scores sent by the server (' + R.serverScore.A + ':' + R.serverScore.B + ').');
      }
    }

    // chat and console
    const chat = C4.events.buildChat({ commands, resolver, rounds });
    const consoleLines = C4.events.buildConsole({ commands, resolver, rounds, gamestate: col.gamestate,
      issues: col.issues.map(i => ({ t: 0, text: i.text })), csCategory, csOld: csOldByCmd });

    // positions -> typed arrays
    const positions = {};
    for (const [cl, tr] of col.tracks) {
      positions[cl] = {
        t: Int32Array.from(tr.t, v => v - t0),
        x: Float32Array.from(tr.x), y: Float32Array.from(tr.y), z: Float32Array.from(tr.z),
        yaw: Float32Array.from(tr.yaw), pitch: Float32Array.from(tr.pitch),
        flags: Uint8Array.from(tr.flags), weapon: Uint8Array.from(tr.weapon)
      };
    }

    // grenades
    const grenades = [];
    for (const key of col.grenadeOrder) {
      const g = col.grenades.get(key);
      const wName = weaponName(g.weapon);
      grenades.push({
        entity: g.entity, weapon: wName, kind: W.grenadeKind(wName) || 'other',
        launch: rel(g.launch), first: rel(g.first), last: rel(g.last),
        segments: g.segments.map(s => [s[0] - t0, s[1], s[2], s[3], s[4], s[5], s[6], s[7]]),
        detonation: g.detonation ? { t: rel(g.detonation.t), x: g.detonation.x, y: g.detonation.y, z: g.detonation.z } : null,
        thrower: null
      });
    }
    for (const d of col.detonations) {
      const wName = weaponName(d.weapon);
      grenades.push({ entity: null, weapon: wName, kind: W.grenadeKind(wName) || 'other', launch: null,
        first: rel(d.t), last: rel(d.t), segments: [], detonation: { t: rel(d.t), x: d.x, y: d.y, z: d.z }, thrower: null });
    }
    grenades.sort((a, b) => (a.first - b.first));

    // map calibration from config string 823 (compass image rectangle)
    let minimap = null;
    const mm = String(cs.get(K.CS.MINIMAP) || '').replace(/"/g, '').trim().split(/\s+/);
    if (mm.length >= 5 && mm.slice(1, 5).every(v => Number.isFinite(parseFloat(v)))) {
      minimap = { material: mm[0], corners: mm.slice(1, 5).map(parseFloat) };
    }

    const mapRaw = serverinfo.mapname || '';
    const recordDate = serverinfo.g_mapStartTime
      ? { text: serverinfo.g_mapStartTime, source: 'map start time on the server (g_mapStartTime)', heuristic: true,
          stamp: ctimeStamp(serverinfo.g_mapStartTime) }
      : fileInfo.lastModified
        ? { text: new Date(fileInfo.lastModified).toLocaleString('en-GB'), source: 'file date', heuristic: true, fileDate: true,
            stamp: localStamp(new Date(fileInfo.lastModified)) }
        : null;

    const meta = {
      fileName: fileInfo.name || null, fileSize: fileInfo.size || null,
      protocol: summary ? summary.protocol : col.protocol,
      protocolLabel: protocolLabel(summary ? summary.protocol : col.protocol),
      cleanEnd: summary ? summary.cleanEnd : false, truncated: summary ? summary.truncated : true,
      stats: summary ? summary.stats : null,
      map: mapRaw, mapKey: N.mapKey(mapRaw), mapDisplay: N.mapDisplay(mapRaw),
      gametype: serverinfo.g_gametype || '', gametypeDisplay: N.gametypeDisplay(serverinfo.g_gametype),
      fsGame, mod: fsGame.replace(/^mods\//, ''),
      ruleset: rulesetHud, promodVersion: promodHeader,
      hostname: serverinfo.sv_hostname || '', serverVersion: serverinfo.version || serverinfo.shortversion || '',
      gameVersion: cs.get(K.CS.GAME_VERSION) || '',
      povClient, povName: povClient != null ? playerName(povClient) : null,
      durationMs: endTime, firstServerTime: t0, recordDate,
      minimap, northYaw: parseFloat(cs.get(K.CS.NORTHYAW) || '0') || 0,
      weapons, dvars, attackSide, attackSideHeuristic,
      sideNames: { axis: dvars.g_TeamName_Axis || 'Axis', allies: dvars.g_TeamName_Allies || 'Allies' },
      scorelimit: dvars.ui_scorelimit != null ? parseInt(dvars.ui_scorelimit, 10) : null,
      timelimit: dvars.ui_timelimit != null ? parseFloat(dvars.ui_timelimit) : null,
      isSearchAndDestroy: (serverinfo.g_gametype || '').toLowerCase() === 'sd'
    };

    return {
      format: 'cod4-demo-viewer/1',
      meta, serverinfo, systeminfo, warnings, diagnostics,
      teams: teamList, players, rounds, initialScore: R.initialScore, halfInfo, halftimes: R.halftimes, swaps: teams.swaps,
      kills, events, chat, console: consoleLines,
      eventTypes: C4.events.EVENT_TYPES,
      positions, grenades
    };
  }

  C4.analyzeDemo = analyzeDemo;
  C4.build = { csCategory, protocolLabel };
});
