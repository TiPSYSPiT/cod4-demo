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

  function commonPrefix(list) {
    if (!list.length) return '';
    let p = list[0];
    for (const s of list.slice(1)) while (p && !s.startsWith(p)) p = p.slice(0, -1);
    return p;
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
      const names = members.map(p => p.cleanName);
      // 1. common prefix of all members (at least 2 members, >= 2 characters)
      let prefix = '';
      if (members.length >= 2) {
        // the tag must end at a separator: "ALPHA Shooter" + "ALPHA Sho" -> "ALPHA", never "ALPHA Sho"
        const SEP = /[\s|\])>.:\-_~]/;
        prefix = commonPrefix(names);
        if (prefix && !SEP.test(prefix[prefix.length - 1])) {
          let k = prefix.length - 1;
          while (k >= 0 && !SEP.test(prefix[k])) k--;
          prefix = k >= 0 ? prefix.slice(0, k + 1) : '';
        }
        prefix = prefix.replace(/[\s|.:\-_~]+$/, '');
        if (prefix.replace(/[^A-Za-z0-9]/g, '').length < 2) prefix = '';
      }
      // 2. first word shared by the majority
      if (!prefix && members.length >= 2) {
        const count = new Map();
        for (const n of names) {
          const w = explicitTag(n) || (n.match(/^(\S{2,12})\s+\S/) || [])[1];
          if (w) count.set(w, (count.get(w) || 0) + 1);
        }
        let best = '', bestN = 0;
        for (const [w, n] of count) if (n > bestN) { best = w; bestN = n; }
        if (bestN >= Math.max(2, Math.ceil(members.length / 2))) prefix = best;
      }
      for (const p of members) {
        if (p.cod4xTag) { tags.set(p.client, { tag: stripColors(p.cod4xTag), heuristic: false }); continue; }
        if (prefix && p.cleanName.startsWith(prefix)) { tags.set(p.client, { tag: prefix, heuristic: true }); continue; }
        const e = explicitTag(p.cleanName);
        tags.set(p.client, e ? { tag: e, heuristic: true } : { tag: '', heuristic: false });
      }
      teamNames[key] = prefix ? { name: prefix, heuristic: true } : null;
    }
    return { tags, teamNames };
  }

  C4.teams = { analyzeTeams, clanTags };
});
