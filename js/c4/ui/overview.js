/* Quick Overview: the score pill over the view (the score at the playback time, the round, map and
 * mode) and the match facts for the info popover (main.js): the final score on request, map, mode,
 * ruleset, server, POV, length, date, protocol. */
(function (C4) {
  'use strict';
  const { el, clear, coloured, fmtTime, na, approx } = C4.ui;

  /** one compact item: "LABEL value · sub" on one line, cut with an ellipsis; the full text is the tooltip */
  function card(label, value, sub, cls) {
    const node = el('div', { class: 'ov-item ' + (cls || '') },
      el('span', { class: 'ov-label' }, label),
      el('span', { class: 'ov-value' }, value, sub ? el('span', { class: 'ov-sub' }, ' · ', sub) : null));
    node.title = label + ': ' + node.querySelector('.ov-value').textContent.replace(/\s+/g, ' ').trim();
    return node;
  }

  const FINAL_KEY = 'cod4demo3d.showFinalScore';
  let live = null;                   // the score card's live parts (render -> update)

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  /** the score at the playback time (Replay: rounds won so far), the round it is in ('Round 8', ...)
   *  and the round time ('01:23') */
  function update(score, roundText, roundTime) {
    if (!live) return;
    if (live.A) {
      setText(live.A, String(score && score.A != null ? score.A : 0));
      setText(live.B, String(score && score.B != null ? score.B : 0));
    }
    setText(live.round, roundText || '');
    setText(live.time, roundTime || '');
  }

  /** root: the score pill; info: the box of the match facts (the info popover) */
  function render(root, app, info) {
    const d = app.data, m = d.meta;
    clear(root);
    clear(info);
    live = null;

    // final score
    const [A, B] = d.teams;
    const played = d.rounds.filter(r => r.kind === 'round');
    let scoreCard;
    if (played.length) {
      // the team's shape (▲ / ◆) next to its colour: readable without telling the colours apart
      const teamLabel = (t, cls) => el('span', { class: 'score-team ' + cls, title: t.name + (t.nameHeuristic ? '' : ' (no common clan tag found)') },
        app.teamMark ? app.teamMark(t.key) : null, t.name, t.nameHeuristic ? approx('team name from the common name prefix of the players') : null);
      const halves = [];
      const hi = d.halfInfo;
      const n = Math.max(A.halves.length, B.halves.length);
      const first = A.halves.findIndex((v, i) => v != null || B.halves[i] != null);
      for (let i = Math.max(0, first); i < n; i++) {
        const label = hi.unknown ? 'half ?' : (i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : (i + 1) + 'th') + ' half';
        const partial = i === first && hi.firstPartial;
        halves.push([label + ' ' + (A.halves[i] || 0) + ':' + (B.halves[i] || 0),
          partial ? [' ', approx('this half started before the recording - only its recorded rounds' + (hi.heuristic ? '; half number from the ruleset (MR/OT) and the start score' : ''))] : null]);
      }
      const initial = d.initialScore.A + d.initialScore.B;
      // the score at the playback time (update(), from the replay) - the final score only on request,
      // so the replay does not give the result away
      const liveA = el('span', null, String(d.initialScore.A || 0)), liveB = el('span', null, String(d.initialScore.B || 0));
      const finalLine = el('div', { class: 'score-halves' },
        'Final ' + A.wins + ' : ' + B.wins + '  ·  ', halves.map((h, i) => [i ? '  ·  ' : '', h]), initial ? '  ·  recording started at ' + d.initialScore.A + ':' + d.initialScore.B : '');
      finalLine.title = finalLine.textContent;
      const toggle = el('button', { class: 'score-final-toggle', type: 'button', title: 'The result of the match (a spoiler while you watch)' });
      const showFinal = on => {
        finalLine.hidden = !on;
        toggle.textContent = on ? 'Hide final score' : 'Show final score';
        toggle.setAttribute('aria-expanded', String(on));
        try { localStorage.setItem(FINAL_KEY, on ? 'on' : 'off'); } catch (err) { /* not stored */ }
      };
      toggle.onclick = () => showFinal(finalLine.hidden);
      let stored = null;
      try { stored = localStorage.getItem(FINAL_KEY); } catch (err) { /* default */ }
      showFinal(stored === 'on');
      root.append(teamLabel(A, 'a'),
        el('span', { class: 'score-num', title: 'rounds won up to the playback time' + (m.isSearchAndDestroy ? '' : ' (rounds of the round logic)') }, liveA, el('i', null, ':'), liveB),
        teamLabel(B, 'b'));
      scoreCard = el('div', { class: 'ov-final' }, el('div', { class: 'ov-final-head' }, el('h4', null, 'Final score'), toggle), finalLine);
      live = { A: liveA, B: liveB };
    } else {
      root.append(el('span', { class: 'score-none' }, 'Score ', na(m.isSearchAndDestroy ? 'no complete round in the demo' : 'no rounds detected - round logic is built for Search & Destroy')));
      scoreCard = null;
      live = {};
    }
    // the meta part: round, round time, map and mode
    live.round = el('b'); live.time = el('span', { class: 'mono' });
    root.append(el('span', { class: 'meta' }, el('span', { class: 'meta-round' }, live.round, ' ', live.time),
      el('span', { class: 'opt' }, (m.mapDisplay || m.map || '?') + ' · ' + (m.gametypeDisplay || m.gametype || '?'))));

    const ruleset = m.ruleset
      ? [m.ruleset, el('span', { class: 'dim' }, m.mod ? '  (' + m.mod + ')' : '')]
      : (m.mod ? m.mod : na('no ruleset announced and no mod (fs_game) set'));
    const date = m.recordDate
      ? [m.recordDate.text, ' ', m.recordDate.fileDate ? el('span', { class: 'dim' }, '(file date)') : approx(m.recordDate.source + ' - the demo stores no recording date')]
      : na('the demo stores no date and the file date is unknown');

    const items = el('div', { class: 'ov-items' });
    info.append(scoreCard || '', items);
    items.append(
      card('Map', m.mapDisplay || na('no map name'), m.map),
      card('Mode', m.gametypeDisplay || na('no game type'), m.gametype),
      card('Ruleset', ruleset, m.promodVersion || null),
      card('Protocol', m.protocolLabel, m.gameVersion ? m.gameVersion.split(' ')[0] : null),
      card('Server name', m.hostname ? coloured(m.hostname) : na('no sv_hostname in the serverinfo'), m.serverVersion || null),
      card('Demo POV', m.povClient != null ? app.playerNode(m.povClient) : na('no recording client number'), m.povClient != null ? 'client ' + m.povClient : null),
      card('Length', fmtTime(m.durationMs), (m.stats ? m.stats.snapshots.toLocaleString('en') + ' snapshots' : '')),
      card('Record date', date, null)
    );
    // the "≈" marks explain themselves on hover - say so once, under the facts, where any is shown
    if (root.querySelector('.approx') || info.querySelector('.approx')) {
      info.append(el('div', { class: 'ov-legend', title: 'Values marked ≈ are heuristic: the demo does not state them, they are derived. Hover a mark for how.' },
        el('span', { class: 'approx' }, '≈'), ' heuristic value - hover a mark for how it was derived'));
    }
  }

  C4.tabs.overview = { render, update };
})(window.C4);
