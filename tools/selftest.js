/* Parser self test: runs C4.analyzeDemo on demos and checks plausibility. */
(function () {
  'use strict';
  const results = window.__selftest = [];
  const tbody = document.querySelector('#out tbody');
  const status = document.getElementById('status');
  let useWorker = false;
  document.getElementById('worker').onclick = () => { useWorker = !useWorker; status.textContent = 'worker: ' + useWorker; };

  /** FNV-1a over the kill feed, for comparison with the Python extractor */
  function killSignature(kills) {
    let h = 0x811c9dc5;
    const s = kills.map(k => k.attacker + ',' + k.victim + ',' + (k.mod ? 128 + (window.C4.constants.MEANS_OF_DEATH.indexOf(k.mod)) : k.weapon)).join(';');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  function analyzeInWorker(buffer, fileInfo) {
    return new Promise((resolve, reject) => {
      const w = C4.createParserWorker();
      if (!w) return reject(new Error('no worker'));
      w.onmessage = ev => {
        if (ev.data.type === 'done') { w.terminate(); resolve(ev.data.data); }
        else if (ev.data.type === 'error') { w.terminate(); reject(new Error(ev.data.message)); }
      };
      w.onerror = e => { w.terminate(); reject(new Error(e.message)); };
      w.postMessage({ buffer, fileInfo }, [buffer]);
    });
  }

  function check(d) {
    const problems = [];
    // events chronological, no NaN / undefined
    let prev = -Infinity;
    for (const e of d.events) {
      if (!Number.isFinite(e.t)) problems.push('event time NaN');
      if (e.t < prev) problems.push('events not sorted');
      prev = e.t;
      if (/undefined|NaN/.test(e.text)) problems.push('event text: ' + e.text);
    }
    for (const k of d.kills) if (!Number.isFinite(k.t)) problems.push('kill time NaN');
    for (const p of d.players) if (!p.name || /undefined/.test(p.name)) problems.push('player name ' + p.client);
    for (const c of d.chat) if (!Number.isFinite(c.t)) problems.push('chat time');
    const played = d.rounds.filter(r => r.kind === 'round');
    const wins = { A: d.initialScore.A, B: d.initialScore.B };
    for (const r of played) if (r.winnerTeam) wins[r.winnerTeam]++;
    if (wins.A !== d.teams[0].wins || wins.B !== d.teams[1].wins) problems.push('round wins != final score');
    if (d.diagnostics.serverScore && (d.diagnostics.serverScore.A !== wins.A || d.diagnostics.serverScore.B !== wins.B)) problems.push('final score != server score');
    return [...new Set(problems)];
  }

  async function run(name, buffer, size) {
    const t0 = performance.now();
    let d, err = null;
    try {
      const fileInfo = { name, size };
      d = useWorker ? await analyzeInWorker(buffer, fileInfo) : C4.analyzeDemo(new Uint8Array(buffer), fileInfo);
    } catch (e) { err = e; }
    const ms = Math.round(performance.now() - t0);
    const tr = document.createElement('tr');
    if (err) {
      tr.innerHTML = '<td>' + name + '</td><td colspan="16" class="bad">' + err.message + '</td>';
      tbody.append(tr);
      results.push({ name, error: err.message, stack: err.stack });
      return;
    }
    const problems = check(d);
    const st = d.meta.stats || {};
    const played = d.rounds.filter(r => r.kind === 'round').length;
    const r = {
      name, mb: +(size / 1e6).toFixed(1), protocol: d.meta.protocol, ms, snapshots: st.snapshots,
      dropped: st.snapshotsDropped, players: d.players.length, rounds: played,
      score: d.teams[0].wins + ':' + d.teams[1].wins,
      server: d.diagnostics.serverScore ? d.diagnostics.serverScore.A + ':' + d.diagnostics.serverScore.B : '',
      kills: d.kills.length, sbMismatch: d.diagnostics.scoreboardMismatches.length,
      mismatches: d.diagnostics.scoreboardMismatches, events: d.events.length, chat: d.chat.length,
      grenades: d.grenades.length, killSig: killSignature(d.kills), problems, warnings: d.warnings,
      teams: d.teams.map(t => t.name), ruleset: d.meta.ruleset, map: d.meta.map
    };
    results.push(r);
    const cells = [r.name, r.mb, r.protocol, r.ms, r.snapshots, r.dropped, r.players, r.rounds, r.score, r.server,
      r.kills, r.sbMismatch, r.events, r.chat, r.grenades, r.killSig];
    tr.innerHTML = cells.map(c => '<td>' + c + '</td>').join('') +
      '<td class="' + (problems.length ? 'bad' : (r.sbMismatch ? 'warn' : 'ok')) + '">' + (problems.join('; ') || 'ok') + '</td>';
    tbody.append(tr);
  }

  document.getElementById('files').onchange = async ev => {
    for (const f of ev.target.files) { status.textContent = 'reading ' + f.name; await run(f.name, await f.arrayBuffer(), f.size); }
    status.textContent = 'done';
  };

  // ?auto=<folder url> : test every .dm_1 of a served directory listing
  const auto = new URLSearchParams(location.search).get('auto');
  if (auto) {
    (async () => {
      const listing = await (await fetch(auto)).text();
      const files = [...new Set([...listing.matchAll(/href="([^"]+\.dm_1)"/g)].map(m => m[1]))];
      const only = new URLSearchParams(location.search).get('only');
      for (const f of files) {
        if (only && !decodeURIComponent(f).includes(only)) continue;
        status.textContent = 'reading ' + decodeURIComponent(f);
        const buf = await (await fetch(auto + f)).arrayBuffer();
        await run(decodeURIComponent(f), buf, buf.byteLength);
      }
      status.textContent = 'done';
      window.__selftestDone = true;
    })();
  }
})();
