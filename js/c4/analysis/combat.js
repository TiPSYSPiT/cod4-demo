/* Round combat statistics from the kills and rounds (DOM-free; build.js runs it on the finished data):
 * the opening duel (the round's first kill: first blood), trades (a kill that avenges a teammate the victim
 * killed within TRADE_MS), multikills (kills of one player in one round) and clutches (the last player of
 * a team alive against one or more enemies; won when the team wins the round). Only match rounds, only
 * kills while the round is live (up to its decision), with the scoreboard rule for credit (kdRule). The
 * players of a round are the team members the demo shows in it (a position in the round) - a player never
 * sent to the POV in a round is not counted there. */
C4.define('combat', function (C4) {
  'use strict';
  const TRADE_MS = 5000;
  const live = r => r.kind === 'round';

  /** the players of team key in round r: members with a position in it */
  function roster(d, r, key) {
    const out = [];
    for (const p of d.players) {
      if (p.team !== key) continue;
      const P = d.positions[p.client];
      if (!P || !P.t.length) continue;
      let lo = 0, hi = P.t.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (P.t[m] < r.segStart) lo = m + 1; else hi = m; }
      if (lo < P.t.length && P.t[lo] < r.segEnd) out.push(p.client);
    }
    return out;
  }

  /** sets r.combat {opening (kill index), trades [kill index], multikills [{client, kills}], clutches
   *  [{client, team, vs, t, won}]} on the match rounds, p.combat {openingKills, openingDeaths, trades,
   *  tradedDeaths, multi {2..5}, clutchesWon, clutchesPlayed, clutches [{round, vs, won}]} on the players
   *  and k.opening / k.tradeOf / k.tradedBy on the kills */
  function analyze(d) {
    const kdRule = C4.build.kdRule;
    const stats = new Map(d.players.map(p => [p.client, { openingKills: 0, openingDeaths: 0, trades: 0, tradedDeaths: 0,
      multi: { 2: 0, 3: 0, 4: 0, 5: 0 }, clutchesWon: 0, clutchesPlayed: 0, clutches: [] }]));
    const S = cl => stats.get(cl);
    for (let ri = 0; ri < d.rounds.length; ri++) {
      const r = d.rounds[ri];
      if (!live(r)) continue;
      const until = r.end != null ? r.end : r.segEnd;
      const ks = r.kills.map(i => d.kills[i]).filter(k => k.phase === 'live' && k.t <= until);
      const credited = ks.filter(k => kdRule(k).credit);
      const combat = { opening: null, trades: [], multikills: [], clutches: [] };
      // the opening duel
      const first = credited[0];
      if (first) {
        first.opening = true;
        combat.opening = first.index;
        if (S(first.attacker)) S(first.attacker).openingKills++;
        if (S(first.victim)) S(first.victim).openingDeaths++;
      }
      // trades: the killer of a teammate killed within TRADE_MS
      credited.forEach((k, i) => {
        for (let j = i - 1; j >= 0; j--) {
          const p = credited[j];
          if (k.t - p.t > TRADE_MS) break;
          if (p.attacker === k.victim && p.victimTeam === k.attackerTeam && p.victim !== k.attacker) {
            k.tradeOf = p.index;
            p.tradedBy = k.index;
            combat.trades.push(k.index);
            if (S(k.attacker)) S(k.attacker).trades++;
            if (S(p.victim)) S(p.victim).tradedDeaths++;
            break;
          }
        }
      });
      // multikills
      const per = new Map();
      for (const k of credited) per.set(k.attacker, (per.get(k.attacker) || 0) + 1);
      for (const [cl, n] of per) {
        if (n < 2) continue;
        combat.multikills.push({ client: cl, kills: n });
        if (S(cl)) S(cl).multi[Math.min(5, n)]++;
      }
      combat.multikills.sort((a, b) => b.kills - a.kills);
      // clutches: per team the moment it is down to its last player while the enemy still lives
      const keys = ['A', 'B'], alive = {};
      for (const key of keys) alive[key] = new Set(roster(d, r, key));
      if (alive.A.size && alive.B.size) {
        const done = new Set();
        const check = t => {
          for (const key of keys) {
            const other = alive[key === 'A' ? 'B' : 'A'];
            if (done.has(key) || alive[key].size !== 1 || !other.size) continue;
            done.add(key);
            const cl = [...alive[key]][0];
            const c = { client: cl, team: key, vs: other.size, t, won: r.winnerTeam === key };
            combat.clutches.push(c);
            const s = S(cl);
            if (s) { s.clutchesPlayed++; if (c.won) s.clutchesWon++; s.clutches.push({ round: ri, vs: c.vs, won: c.won }); }
          }
        };
        check(r.start != null ? r.start : r.segStart);
        for (const k of ks) {
          for (const key of keys) alive[key].delete(k.victim);
          check(k.t);
        }
      }
      r.combat = combat;
    }
    for (const p of d.players) p.combat = stats.get(p.client);
  }

  C4.combat = { analyze, TRADE_MS };
});
