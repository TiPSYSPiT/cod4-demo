/* Team identity, side swaps and clan tags.
 *
 * The client state says which side (axis / allies) a player is on. Teams swap
 * sides at halftime (and possibly after the knife round), so a team is defined
 * by its members: a "swap" is a moment when most playing clients change side
 * together; a player's team is his side normalised by the number of swaps
 * before that moment. Team A = the team on the axis side at the start. */
C4.define('teams', function (C4) {
  'use strict';
  const { stripColors } = C4.text;
  const SWAP_WINDOW = 5000;

  function analyzeTeams(col, firstTime, lastTime) {
    // per client: list of [t, team]
    const byClient = new Map();
    for (const e of col.teamTimeline) {
      if (!byClient.has(e.client)) byClient.set(e.client, []);
      byClient.get(e.client).push([e.t, e.team]);
    }
    // side flips 1 <-> 2
    const flips = [];
    for (const [client, list] of byClient) {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1][1], b = list[i][1];
        if ((a === 1 && b === 2) || (a === 2 && b === 1)) flips.push({ t: list[i][0], client });
      }
    }
    flips.sort((a, b) => a.t - b.t);
    const playingAt = t => {
      let n = 0;
      for (const list of byClient.values()) {
        let team = -1;
        for (const [tt, tm] of list) { if (tt <= t) team = tm; else break; }
        if (team === 1 || team === 2) n++;
      }
      return n;
    };
    // clusters of flips, each flip at most SWAP_WINDOW after the previous one
    // (players switch one after another, measured spread up to 8 s)
    const clusters = [];
    for (const f of flips) {
      const last = clusters[clusters.length - 1];
      if (last && f.t - last.end <= SWAP_WINDOW) { last.end = f.t; last.clients.add(f.client); }
      else clusters.push({ t: f.t, end: f.t, clients: new Set([f.client]) });
    }
    const swapClusters = clusters.filter(cl => {
      const playing = playingAt(cl.t - 1);
      return cl.clients.size >= 2 && cl.clients.size >= 0.6 * playing;
    });
    const swaps = swapClusters.map(cl => cl.t);
    /** swaps completed before t (a swap counts once it has fully happened) */
    const swapsBefore = t => { let n = 0; for (const s of swapClusters) if (s.end <= t) n++; return n; };
    /** swaps that apply to a side value a client holds from t0 on */
    const swapsFor = (client, t0) => {
      let n = 0;
      for (const s of swapClusters) {
        if (s.end < t0) n++;
        else if (t0 >= s.t && t0 <= s.end && s.clients.has(client)) n++;   // his own flip within the swap
      }
      return n;
    };

    // normalised team per client, weighted by time
    const teamOf = new Map();
    const membership = new Map();       // client -> [{t0, t1, key}]
    for (const [client, list] of byClient) {
      const weight = { A: 0, B: 0 };
      const spans = [];
      for (let i = 0; i < list.length; i++) {
        const [t0, side] = list[i];
        const t1 = i + 1 < list.length ? list[i + 1][0] : lastTime;
        if (side !== 1 && side !== 2) continue;
        const parity = swapsFor(client, t0) % 2;
        const norm = parity ? 3 - side : side;
        const key = norm === 1 ? 'A' : 'B';
        weight[key] += Math.max(1, t1 - t0);
        spans.push({ t0, t1, key });
      }
      membership.set(client, spans);
      if (weight.A || weight.B) teamOf.set(client, weight.A >= weight.B ? 'A' : 'B');
      else teamOf.set(client, 'spectator');
    }

    /** side ('axis' / 'allies') of team key at time t */
    const sideOf = (key, t) => {
      const odd = swapsBefore(t) % 2 === 1;
      if (key === 'A') return odd ? 'allies' : 'axis';
      return odd ? 'axis' : 'allies';
    };
    /** team key playing a side at time t */
    const teamOnSide = (side, t) => (sideOf('A', t) === side ? 'A' : 'B');
    /** raw side of a client at time t from the client states: 1 axis, 2 allies, else 0/3/-1 */
    const rawSideAt = (client, t) => {
      const list = byClient.get(client);
      if (!list) return -1;
      let side = -1;
      for (const [tt, tm] of list) { if (tt <= t) side = tm; else break; }
      return side;
    };
    /** team key a client belonged to at time t (from his membership spans) */
    const teamAt = (client, t) => {
      const spans = membership.get(client) || [];
      for (const s of spans) if (t >= s.t0 && t < s.t1) return s.key;
      return teamOf.get(client) || null;
    };

    return { swaps, swapClusters, teamOf, membership, sideOf, teamOnSide, rawSideAt, teamAt, byClient };
  }

  /* ---- clan tags and team names (heuristic) ---- */

  // characters that can end a clan tag: "ALPHA Shooter", "W@rZ/Sky", "inf.eS NATHZN", "=TAG= x", "RL|x"
  const SEP = /[\s|/\\:.\-_~*#=+,;>»«•·]/;
  const TRAIL = /[\s|/\\:.\-_~,;<([{]+$/;   // connectors / opening brackets dropped from the end of a shown tag
  // comparison key, case- and leetspeak-insensitive: "W@rZ" = "WarZ" = "warz"
  const LEET = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't' };
  const tagKey = tag => tag.toLowerCase().replace(/[@43!105$7]/g, c => LEET[c]).replace(/[^a-z0-9]/g, '');

  /** possible clan tags of one name: every prefix up to a separator (at most 12 characters,
   * the player's own name must follow) and an explicit [TAG] - as Map key -> spelling */
  function tagCandidates(name, cod4xTag) {
    const out = new Map();
    const add = spelling => {
      const s = spelling.replace(TRAIL, '').trim();
      const k = tagKey(s);
      if (k.length < 2) return;
      if (!out.has(k) || s.length > out.get(k).length) out.set(k, s);
    };
    if (cod4xTag) add(stripColors(cod4xTag));
    const e = explicitTag(name);
    if (e) add(e);
    for (let i = 1; i < name.length && i <= 12; i++) {
      if (!SEP.test(name[i]) || !/[A-Za-z0-9]/.test(name.slice(i + 1))) continue;
      const head = name.slice(0, i);
      // a tag of symbols only ("// COOKIE") needs a space after it and is compared as written
      if (/\s/.test(name[i]) && !/[A-Za-z0-9]/.test(head) && head.trim().length >= 2 && !/\s/.test(head.trim())) {
        const s = head.trim();
        if (!out.has('sym:' + s)) out.set('sym:' + s, s);
      } else add(head);
    }
    return out;
  }

  /** explicit tag patterns: [TAG]name, (TAG)name, TAG|name, TAG.name ... */
  function explicitTag(name) {
    let m = name.match(/^\s*[[({<]([^\])}>]{1,12})[\])}>]/);
    if (m) return m[0].trim();
    m = name.match(/^\s*([^\s|]{1,12})\s*\|/);
    if (m) return m[1];
    return '';
  }

  /**
   * players: [{client, cleanName, cod4xTag}], grouped by team key.
   * Returns {tags: Map client -> {tag, heuristic}, teamNames: {A, B}}.
   */
  function clanTags(playersByTeam) {
    const tags = new Map();
    const teamNames = {};
    for (const key of Object.keys(playersByTeam)) {
      const members = playersByTeam[key];
      const cands = new Map(members.map(p => [p.client, tagCandidates(p.cleanName, p.cod4xTag)]));
      // the tag shared by most members (at least 2 and half the team); tie -> the longer tag
      // ("inf" and "inf.eS" are shared by all -> "inf.eS")
      const count = new Map(), spellings = new Map();
      for (const c of cands.values()) {
        for (const [k, s] of c) {
          count.set(k, (count.get(k) || 0) + 1);
          if (!spellings.has(k)) spellings.set(k, new Map());
          spellings.get(k).set(s, (spellings.get(k).get(s) || 0) + 1);
        }
      }
      let best = null;
      for (const [k, n] of count) {
        if (!best || n > count.get(best) || (n === count.get(best) && k.length > best.length)) best = k;
      }
      if (best && count.get(best) < Math.max(2, Math.ceil(members.length / 2))) best = null;
      // team name: the most frequent spelling ("W@rZ" x4 beats "WarZ" x1)
      let teamTag = '';
      if (best) {
        let bn = 0;
        for (const [s, n] of spellings.get(best)) if (n > bn) { teamTag = s; bn = n; }
      }
      for (const p of members) {
        if (p.cod4xTag) { tags.set(p.client, { tag: stripColors(p.cod4xTag), heuristic: false }); continue; }
        const c = cands.get(p.client);
        // the player's own spelling of the team tag ("WarZ superb" -> "WarZ")
        if (best && c.has(best)) { tags.set(p.client, { tag: c.get(best), heuristic: true }); continue; }
        const e = explicitTag(p.cleanName);
        tags.set(p.client, e ? { tag: e, heuristic: true } : { tag: '', heuristic: false });
      }
      teamNames[key] = teamTag ? { name: teamTag, heuristic: true } : null;
    }
    return { tags, teamNames };
  }

  C4.teams = { analyzeTeams, clanTags, tagKey };
});
