/* UI entry point: file loading, parsing in the worker, tab routing, export. */
(function (C4) {
  'use strict';
  const { el, clear, coloured, teamClass } = C4.ui;
  const $ = id => document.getElementById(id);
  C4.tabs = C4.tabs || {};

  const state = { data: null, fileInfo: null, rendered: new Set(), current: 'scoreboard', worker: null };

  /* ---- app facade given to every tab ---- */
  const app = {
    get data() { return state.data; },
    /** player name as coloured node in the team colour */
    playerNode(cl, opts = {}) {
      const d = state.data;
      if (cl == null) return C4.ui.na('unknown player');
      if (cl === 1022) return el('span', { class: 'player dim', title: 'the world (map, falling, trigger)' }, 'World');
      if (cl >= 64) return el('span', { class: 'player dim', title: 'a non-player entity (e.g. an exploding car)' }, 'Entity ' + cl);
      const p = d.players.find(x => x.client === cl);
      if (!p) return el('span', { class: 'player dim' }, 'Client ' + cl);
      const node = coloured(p.name, 'player ' + teamClass(opts.team || p.team));
      if (opts.plain) node.querySelectorAll('span').forEach(s => { s.className = ''; });
      return node;
    },
    playerLabel(cl) {
      if (cl === 1022) return 'World';
      const p = state.data.players.find(x => x.client === cl);
      return p ? p.cleanName : (cl >= 64 ? 'Entity ' + cl : 'Client ' + cl);
    },
    team(key) { return state.data.teams.find(t => t.key === key); },
    teamName(key) {
      if (key === 'spectator') return 'Spectators';
      const t = app.team(key);
      return t ? t.name : key;
    },
    /** demo file name without .dm_1 (for download names) */
    get fileBase() { return ((state.fileInfo && state.fileInfo.name) || 'demo').replace(/\.dm_1$/i, ''); },
    /** save text as a file (Blob URL - works from file:// too) */
    download(fileName, text, type = 'application/json') {
      const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: fileName });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
    /** switch to the map tab and jump to 2 s before t */
    gotoMap(t, roundIndex) {
      showTab('map');
      if (C4.tabs.map && C4.tabs.map.seek) C4.tabs.map.seek(Math.max(0, t - 2000), roundIndex);
    }
  };
  C4.app = app;

  /* ---- loading ---- */
  function onFiles(files) {
    const f = files && files[0];
    if (!f) return;
    load(f);
  }

  async function load(file) {
    hide('error');
    clear($('warnings'));
    $('viewer').hidden = true;
    $('export-wrap').hidden = true;
    document.body.classList.remove('loaded');
    $('dropzone').hidden = true;
    $('progress').hidden = false;
    $('progress-label').textContent = 'Reading ' + file.name + ' …';
    setProgress(0);
    $('file-name').textContent = file.name;
    state.fileInfo = { name: file.name, size: file.size, lastModified: file.lastModified };
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (err) {
      return fail('The file could not be read: ' + err.message);
    }
    $('progress-label').textContent = 'Parsing ' + file.name + ' (' + (file.size / 1e6).toFixed(1) + ' MB) …';
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    const worker = C4.createParserWorker();
    if (worker) {
      state.worker = worker;
      worker.onmessage = ev => {
        const m = ev.data;
        if (m.type === 'progress') setProgress(m.value);
        else if (m.type === 'done') { worker.terminate(); state.worker = null; show(m.data); }
        else if (m.type === 'error') { worker.terminate(); state.worker = null; fail(errorText(m.message, m.invalid), m.stack); }
      };
      worker.onerror = e => {
        e.preventDefault();
        worker.terminate();
        state.worker = null;
        console.warn('Worker failed, parsing on the main thread instead.', e.message);
        parseMainThread(buffer);
      };
      worker.postMessage({ buffer, fileInfo: state.fileInfo }, [buffer]);
    } else {
      parseMainThread(buffer);
    }
  }

  function parseMainThread(buffer) {
    $('progress-label').textContent += ' (main thread - the page may freeze briefly)';
    setTimeout(() => {
      try { show(C4.analyzeDemo(new Uint8Array(buffer), state.fileInfo, setProgress)); }
      catch (err) { fail(errorText(err.message, err instanceof C4.demo.DemoError), err.stack); }
    }, 30);
  }

  function errorText(message, invalid) {
    return invalid ? message : 'The demo could not be analysed: ' + message;
  }

  function fail(message, stack) {
    if (stack) console.error(stack);
    $('progress').hidden = true;
    $('dropzone').hidden = false;
    const box = $('error');
    clear(box).append(el('strong', null, 'Error: '), message);
    box.hidden = false;
  }

  function setProgress(v) { $('progress-fill').style.width = Math.round(v * 100) + '%'; }
  function hide(id) { $(id).hidden = true; }

  /* ---- showing a demo ---- */
  function show(data) {
    state.data = data;
    state.rendered.clear();
    $('progress').hidden = true;
    $('dropzone').hidden = false;
    document.body.classList.add('loaded');
    const warn = $('warnings');
    for (const w of data.warnings) warn.append(el('div', { class: 'banner banner-warn' }, w));
    if (data.diagnostics.scoreboardMismatches.length) {
      console.debug('Scoreboard vs. own kill feed count differences (scoreboard values are shown):', data.diagnostics.scoreboardMismatches);
    }
    if (data.diagnostics.scoreboardSessions && data.diagnostics.scoreboardSessions.length) {
      console.debug('Reconnected players - the game restarts their scoreboard at 0, the sessions are summed:', data.diagnostics.scoreboardSessions);
    }
    if (data.diagnostics.teamkillsExcluded) console.debug('Team kills outside the live match time (not counted):', data.diagnostics.teamkillsExcluded);
    C4.tabs.overview.render($('overview'), app);
    $('viewer').hidden = false;
    $('export-wrap').hidden = false;
    for (const key of Object.keys(C4.tabs)) if (C4.tabs[key].reset) C4.tabs[key].reset();
    showTab(state.current || 'scoreboard');
  }

  function showTab(key) {
    state.current = key;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === key);
    for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + key);
    if (!state.data) return;
    const tab = C4.tabs[key];
    if (!tab) return;
    const panel = $('tab-' + key);
    if (!state.rendered.has(key)) {
      clear(panel);
      try { tab.render(panel, app); }
      catch (err) {
        console.error(err);
        panel.append(el('div', { class: 'banner banner-error' }, 'This tab could not be rendered: ' + err.message));
      }
      state.rendered.add(key);
    }
    if (tab.shown) tab.shown();
    for (const k of Object.keys(C4.tabs)) if (k !== key && C4.tabs[k].hidden) C4.tabs[k].hidden();
  }

  /* ---- export ---- */
  function exportJson() {
    const d = state.data;
    if (!d) return;
    const withPos = $('export-positions').checked;
    const out = Object.assign({}, d);
    if (withPos) {
      out.positions = {};
      for (const [cl, p] of Object.entries(d.positions)) {
        out.positions[cl] = Object.fromEntries(Object.entries(p).map(([k, a]) => [k, Array.from(a)]));
      }
    } else {
      out.positions = '(omitted - tick "with positions" to include them)';
    }
    app.download(app.fileBase + (withPos ? '.full' : '') + '.json', JSON.stringify(out, null, withPos ? 0 : 1));
  }

  /* ---- wiring ---- */
  function init() {
    $('file-input').addEventListener('change', e => { onFiles(e.target.files); e.target.value = ''; });
    $('file-input-2').addEventListener('change', e => { onFiles(e.target.files); e.target.value = ''; });
    $('export-btn').addEventListener('click', exportJson);
    for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
    let depth = 0;
    const isFile = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', e => { if (!isFile(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragover', e => { if (isFile(e)) e.preventDefault(); });
    window.addEventListener('dragleave', e => { if (!isFile(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('drop', e => {
      if (!isFile(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      onFiles(e.dataTransfer.files);
    });
    window.addEventListener('error', e => console.error('Unhandled error:', e.message));
    // optional (served via start.bat only): index.html?demo=<url of a .dm_1 file>
    const demoUrl = new URLSearchParams(location.search).get('demo');
    if (demoUrl && location.protocol.startsWith('http')) {
      fetch(demoUrl).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(b => load(new File([b], decodeURIComponent(demoUrl.split('/').pop()), { lastModified: Date.now() })))
        .catch(err => fail('Could not load ' + demoUrl + ': ' + err.message));
    }
  }
  init();
})(window.C4);
