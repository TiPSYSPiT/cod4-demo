/* Round detection for (Promod) Search & Destroy.
 *
 * Observed sequence per round (docs/ANALYSIS.md, section 4):
 *   'm' + 'n' fast restart  -> strat time -> config string 11 (round timer) set
 *   -> round live -> team score G (axis) / H (allies) increases -> status line
 *   "Attack eliminated" / "Defence eliminated" / "Time Elapsed" (not sent by every
 *   Promod version) -> next restart.
 * Knife round: status line "Knife Round" right after the restart.
 * Halftime: announcer sound config string "*_halftime" + all players swap side.
 * All times are ms since the first snapshot. */
C4.define('rounds', function (C4) {
  'use strict';
  const { stripColors } = C4.text;

  const STATUS_INDEX = i => (i >= 380 && i <= 400) || i === 733;
  const SOUND_INDEX = i => i >= 1342 && i <= 1597;
  const BOMB_RE = /^MP_EXPLOSIVES_(PLANTED|DEFUSED|RECOVERED|DROPPED)_BY(.*)$/;

  function analyzeRounds(ctx) {
    const { commands, csChanges, teams, kills, attackSide, endTime, clients } = ctx;
    const defenceSide = attackSide === 'axis' ? 'allies' : 'axis';
    const status = [];            // {t, text}
    const halftimeSounds = [];
    const timers = [];            // {t, value}
    for (const ch of csChanges) {
      if (STATUS_INDEX(ch.index)) {
        const text = stripColors(ch.value).trim();
        if (text) status.push({ t: ch.t, text });
      } else if (SOUND_INDEX(ch.index) && /halftime/i.test(ch.value || '')) {
        if (!halftimeSounds.length || ch.t - halftimeSounds[halftimeSounds.length - 1] > 3000) halftimeSounds.push(ch.t);
      } else if (ch.index === 11) {
        timers.push({ t: ch.t, value: parseInt(ch.value, 10) || 0 });
      }
    }
    const restarts = [];
    for (const c of commands) {
      if ((c.d.verb === 'n' || c.d.verb === 'B') && (!restarts.length || c.t - restarts[restarts.length - 1] > 1000)) restarts.push(c.t);
    }
    // the server re-sends (and at halftime swaps) the scores around every restart:
    // changes there are never round wins
    const nearRestart = t => restarts.some(r => Math.abs(t - r) <= 1000);

    // team scores per side: G / H commands, the scoreboard 'b' only as starting value
    const bomb = [];              // {t, action, name}
    const scoreEvents = [];       // round wins: {t, side, axis, allies}
    const scoreObs = [];          // {t, axis, allies}
    const cur = { axis: null, allies: null };
    for (const c of commands) {
      const v = c.d.verb;
      if (v === 'G' || v === 'H') {
        const side = c.d.team, val = c.d.score;
        if (val == null) continue;
        if (cur[side] != null && val === cur[side] + 1 && !nearRestart(c.t)) {
          cur[side] = val;
          scoreEvents.push({ t: c.t, side, axis: cur.axis, allies: cur.allies });
        }
        cur[side] = val;
        scoreObs.push({ t: c.t, axis: cur.axis, allies: cur.allies });
      } else if (v === 'b') {
        if (cur.axis == null && c.d.scoreAxis != null) cur.axis = c.d.scoreAxis;
        if (cur.allies == null && c.d.scoreAllies != null) cur.allies = c.d.scoreAllies;
        scoreObs.push({ t: c.t, axis: cur.axis, allies: cur.allies });
      } else if (v === 'f') {
        const m = stripColors(c.d.text).match(BOMB_RE);
        if (m) bomb.push({ t: c.t, action: m[1].toLowerCase(), name: m[2].trim() });
      }
    }
    const scoreBefore = t => {
      let s = null;
      for (const o of scoreObs) { if (o.t < t) s = o; else break; }
      return s;
    };

    // segments between restarts (the demo may start in the middle of one)
    const bounds = [0, ...restarts.filter(t => t > 0), endTime + 1];
    const segments = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      if (bounds[i + 1] - bounds[i] < 200) continue;
      segments.push({ start: bounds[i], end: bounds[i + 1] });
    }

    const rounds = [];
    for (const seg of segments) {
      const inSeg = t => t >= seg.start && t < seg.end;
      const segStatus = status.filter(s => inSeg(s.t));
      const knife = segStatus.some(s => s.t - seg.start < 3000 && /knife round/i.test(s.text));
      const timer = timers.find(x => inSeg(x.t) && x.value > 0);
      const win = scoreEvents.find(e => inSeg(e.t));
      const segBomb = bomb.filter(b => inSeg(b.t));
      if (!knife && !timer && !win) continue;          // warm-up, ready-up, strat mode ...
      const r = {
        kind: knife ? 'knife' : 'round',
        segStart: seg.start, segEnd: Math.min(seg.end, endTime),
        start: timer ? timer.t : seg.start,             // live start (after strat time)
        end: win ? win.t : null,
        winnerSide: win ? win.side : null, winnerTeam: null,
        reason: null, reasonSource: null, reasonHeuristic: false,
        complete: !!win, bomb: segBomb, statusLines: segStatus.map(s => s.text),
        startedBeforeRecording: seg.start === 0 && !restarts.includes(0)
      };
      if (win) r.winnerTeam = teams.teamOnSide(win.side, win.t - 1);
      r.kills = kills.filter(k => k.t >= seg.start && k.t < seg.end).map(k => k.index);
      if (win) decideReason(r, win, segStatus, segBomb);
      rounds.push(r);
    }

    /** reason: explicit status line / bomb message first, else derived from the S&D rules */
    function decideReason(r, win, segStatus, segBomb) {
      const near = segStatus.filter(s => s.t >= win.t - 1500 && s.t <= win.t + 4000);
      const has = re => near.some(s => re.test(s.text));
      const planted = segBomb.some(b => b.action === 'planted' && b.t <= win.t);
      const defused = segBomb.some(b => b.action === 'defused' && b.t <= win.t + 500);
      const attackWon = win.side === attackSide;
      if (defused) { r.reason = 'Bomb defused'; r.reasonSource = 'bomb message'; return; }
      if (has(/attack eliminated/i)) { r.reason = 'Attack eliminated'; r.reasonSource = 'status line'; return; }
      if (has(/defen[cs]e eliminated/i)) { r.reason = 'Defence eliminated'; r.reasonSource = 'status line'; return; }
      if (has(/time elapsed/i)) { r.reason = 'Time'; r.reasonSource = 'status line'; return; }
      // no status line: count the deaths per side in the kill feed (obituaries reach every client)
      const allDead = side => {
        const alive = new Set(clients.filter(c => teams.rawSideAt(c, r.start) === (side === 'axis' ? 1 : 2)));
        if (!alive.size) return false;
        for (const ki of r.kills) {
          const k = kills[ki];
          if (k.t <= win.t + 100) alive.delete(k.victim);
        }
        return alive.size === 0;
      };
      r.reasonHeuristic = true;
      r.reasonSource = 'derived from kill feed and bomb messages (the server sent no status line)';
      // attack wins by elimination or explosion; defence by elimination, defuse or time
      if (attackWon) r.reason = !allDead(defenceSide) && planted ? 'Bomb exploded' : 'Defence eliminated';
      else r.reason = planted ? 'Bomb defused' : (allDead(attackSide) ? 'Attack eliminated' : 'Time');
    }

    // Score resets: the sum of both team scores drops (a halftime swap keeps the sum).
    // Rounds before the last reset that is followed by a round belong to a previous
    // match or warm-up phase (e.g. the demo starts at the end of a public round).
    // (G and H arrive one after the other: evaluate only the last observation of a burst)
    let prevSum = null, lastReset = null;
    for (let i = 0; i < scoreObs.length; i++) {
      const o = scoreObs[i];
      if (i + 1 < scoreObs.length && scoreObs[i + 1].t - o.t < 500) continue;
      if (o.axis == null || o.allies == null) continue;
      const sum = o.axis + o.allies;
      if (prevSum != null && sum < prevSum && rounds.some(r => r.kind === 'round' && r.segStart > o.t)) lastReset = o.t;
      prevSum = sum;
    }
    if (lastReset != null) for (const r of rounds) if (r.kind === 'round' && r.segEnd <= lastReset + 1000) r.kind = 'prematch';

    // halftime markers
    const halftimes = halftimeSounds.slice();
    if (!halftimes.length && teams.swaps.length) {
      // no announcer: a side swap between two rounds is the halftime (heuristic)
      for (const s of teams.swaps) if (rounds.some(r => r.kind === 'round' && r.start < s)) halftimes.push(s);
    }

    // score before the first observed round (the recording may start mid-match):
    // the team scores right before its win, or at its start if it has no win
    const firstRound = rounds.find(r => r.kind === 'round');
    const before = firstRound ? scoreBefore(firstRound.end != null ? firstRound.end : firstRound.segStart + 1) : null;
    const initial = { A: 0, B: 0 };
    if (before && before.axis != null && before.allies != null && (before.axis || before.allies)) {
      const aSide = teams.sideOf('A', firstRound.segStart);
      initial.A = aSide === 'axis' ? before.axis : before.allies;
      initial.B = aSide === 'axis' ? before.allies : before.axis;
    }
    let n = initial.A + initial.B;
    const score = { A: initial.A, B: initial.B };
    for (const r of rounds) {
      r.half = 1 + halftimes.filter(h => h < r.segStart + 1).length;
      if (r.kind === 'knife') r.label = 'K';
      else if (r.kind === 'prematch') r.label = 'P';
      else { n++; r.number = n; r.label = String(n); }
      if (r.kind === 'round' && r.winnerTeam) score[r.winnerTeam]++;
      r.scoreAfter = { A: score.A, B: score.B };
      const sideA = teams.sideOf('A', r.start);
      r.sides = { A: sideA === attackSide ? 'attack' : 'defence', B: sideA === attackSide ? 'defence' : 'attack' };
      r.duration = r.end != null ? r.end - r.start : null;
    }

    // the server's own team scores at the last round win
    let serverScore = null;
    // (knife round wins are shown by the server but do not count for the match)
    const lastWin = scoreEvents.filter(e => rounds.some(r => r.kind === 'round' && r.end === e.t)).pop();
    if (lastWin) {
      const aSide = teams.sideOf('A', lastWin.t - 1);
      serverScore = { A: aSide === 'axis' ? lastWin.axis : lastWin.allies, B: aSide === 'axis' ? lastWin.allies : lastWin.axis };
    }
    return { rounds, halftimes, halftimeFromSound: halftimeSounds.length > 0, bomb, status, restarts,
      finalScore: score, initialScore: initial, serverScore, lastRoundEnd: lastWin ? lastWin.t : null };
  }

  C4.rounds = { analyzeRounds };
});
