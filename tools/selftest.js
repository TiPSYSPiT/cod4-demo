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

  /** plausibility warnings (the demo is readable, but a count does not add up) */
  function plausibility(d) {
    const warn = [];
    const W = window.C4.weapons;
    // 1. frag grenade kills in Round by Round (match rounds, phase live) == sum of Nade K / Nade D,
    //    counted with the same central rule (C4.weapons.isFragGrenadeKill)
    const rbr = [];
    d.rounds.forEach(r => { if (r.kind === 'round') for (const ki of r.kills) rbr.push(d.kills[ki]); });
    const nades = rbr.filter(k => k.phase === 'live' && W.isFragGrenadeKill(k));
    const expK = nades.filter(k => !k.teamkill && !k.suicide && !k.world && !k.entityAttacker).length;
    const expD = nades.filter(k => !k.world).length;
    const sumK = d.players.reduce((a, p) => a + (p.nadeKills || 0), 0);
    const sumD = d.players.reduce((a, p) => a + (p.nadeDeaths || 0), 0);
    if (sumK !== expK) warn.push('Nade K ' + sumK + ' != frag grenade kills in Round by Round ' + expK);
    if (sumD !== expD) warn.push('Nade D ' + sumD + ' != frag grenade deaths in Round by Round ' + expD);
    // 2. bomb (S&D): at most one plant and one defuse per round, and the scoreboard's Plants /
    //    Defuses == the plants / defuses of the match rounds in Round by Round (live phase)
    if (d.meta.isSearchAndDestroy) {
      const liveBomb = (r, action) => r.bomb.filter(b => b.action === action && C4.rounds.phaseAt(d.phases, b.t) === 'live').length;
      for (const r of d.rounds) {
        const p = r.bomb.filter(b => b.action === 'planted').length, df = r.bomb.filter(b => b.action === 'defused').length;
        if (p > 1 || df > 1) warn.push('round ' + r.label + ': ' + p + ' plants / ' + df + ' defuses (S&D allows one)');
      }
      const match = d.rounds.filter(r => r.kind === 'round');
      const rbrP = match.reduce((a, r) => a + liveBomb(r, 'planted'), 0), rbrD = match.reduce((a, r) => a + liveBomb(r, 'defused'), 0);
      const sbP = d.players.reduce((a, p) => a + (p.plants || 0), 0), sbD = d.players.reduce((a, p) => a + (p.defuses || 0), 0);
      const unresolved = (d.diagnostics.bombUnresolved || []).length;      // no player to credit
      if (sbP + sbD + unresolved !== rbrP + rbrD || sbP > rbrP || sbD > rbrD) warn.push('Plants / Defuses ' + sbP + ' / ' + sbD + ' != Round by Round ' + rbrP + ' / ' + rbrD + (unresolved ? ' (' + unresolved + ' unresolved names)' : ''));
    }
    // 3. weapon list vs weapon indices: thrown missiles must be grenades, the defuse kit kills nobody
    const odd = d.grenades.filter(g => g.segments.length && W.isNonMissileWeapon(g.weapon)).length;
    const kit = d.kills.filter(k => W.isDefuseKitWeapon(k.weaponName)).length;
    if (odd || kit) warn.push('weapon list does not match the weapon indices (' + odd + ' thrown "car/bomb" missiles, ' + kit + ' defuse-kit kills)');
    return warn;
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
    const plaus = plausibility(d);
    for (const w of plaus) console.warn('[plausibility] ' + name + ': ' + w);
    const st = d.meta.stats || {};
    const played = d.rounds.filter(r => r.kind === 'round').length;
    const r = {
      name, mb: +(size / 1e6).toFixed(1), protocol: d.meta.protocol, ms, snapshots: st.snapshots,
      dropped: st.snapshotsDropped, players: d.players.length, rounds: played,
      score: d.teams[0].wins + ':' + d.teams[1].wins,
      server: d.diagnostics.serverScore ? d.diagnostics.serverScore.A + ':' + d.diagnostics.serverScore.B : '',
      kills: d.kills.length, sbMismatch: d.diagnostics.scoreboardMismatches.length,
      mismatches: d.diagnostics.scoreboardMismatches, events: d.events.length, chat: d.chat.length,
      grenades: d.grenades.length, killSig: killSignature(d.kills), problems, plausibility: plaus, warnings: d.warnings,
      teams: d.teams.map(t => t.name), ruleset: d.meta.ruleset, map: d.meta.map
    };
    results.push(r);
    const cells = [r.name, r.mb, r.protocol, r.ms, r.snapshots, r.dropped, r.players, r.rounds, r.score, r.server,
      r.kills, r.sbMismatch, r.events, r.chat, r.grenades, r.killSig];
    tr.innerHTML = cells.map(c => '<td>' + c + '</td>').join('') +
      '<td class="' + (problems.length ? 'bad' : (plaus.length || r.sbMismatch ? 'warn' : 'ok')) + '">' +
      (problems.join('; ') || (plaus.length ? 'warning: ' + plaus.join('; ') : 'ok')) + '</td>';
    tbody.append(tr);
  }

  window.__plausibility = plausibility;       // for tests of the check itself

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
