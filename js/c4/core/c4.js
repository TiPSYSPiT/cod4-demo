/* CoD4 Demo Viewer - namespace and module registry.
 *
 * The viewer has to run from a double-clicked index.html (file://) as well as
 * from a local web server. Browsers block ES modules, fetch() and worker
 * scripts on file://, so the code is organised as classic scripts:
 *
 *   C4.define(name, fn)   registers a module; fn(C4) installs its API on C4.
 *
 * Every DOM-free module (parser, common, analysis) is registered this way. The
 * parser worker is then built from a Blob that contains the source text of
 * exactly these module functions (Function.prototype.toString), so no worker
 * file has to be loaded - which is what makes workers possible on file://.
 */
(function (root) {
  'use strict';
  const C4 = root.C4 || (root.C4 = {});
  C4.modules = C4.modules || [];

  /** Register a module. Must be self-contained: it may only use its argument. A module run again (C4.scriptsReady:
   *  a script loaded a second time) replaces its first registration - the worker gets each module once. */
  C4.define = function (name, fn) {
    const k = C4.modules.findIndex(m => m.name === name);
    if (k >= 0) C4.modules[k] = { name, fn }; else C4.modules.push({ name, fn });
    fn(C4);
  };

  /* The page's classic scripts (index.html) cannot be fetched again by the browser itself: a request the browser cancels
   * or a local server drops leaves a module out, and a demo then fails deep in the analysis ("Cannot read properties of
   * undefined (reading 'analyze')"). This script runs first and notes every script of the page that does not load; before
   * a demo is read, C4.scriptsReady() loads the first one that failed again and every script after it, in their order (a
   * later script may have used the missing one when it ran), with retries. */
  const failed = [];
  if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
    addEventListener('error', ev => {
      const s = ev.target;
      if (s && s.tagName === 'SCRIPT' && s.src && !s.dataset.retry) failed.push(s);
    }, true);
  }
  const RETRY_MS = [300, 1000, 2500];
  let ready = null;
  const loadScript = (src, k) => new Promise((ok, no) => {
    const el = document.createElement('script');
    el.dataset.retry = String(k + 1);
    el.src = src + (src.includes('?') ? '&' : '?') + 'retry=' + (k + 1);
    el.onload = () => ok();
    el.onerror = () => { el.remove(); no(new Error(src)); };
    document.head.append(el);
  });
  /** -> Promise: every classic script of the page loaded (again, if needed); rejects with the file that would not load */
  C4.scriptsReady = function () {
    if (!failed.length) return Promise.resolve();
    if (ready) return ready;
    ready = (async () => {
      const all = [...document.querySelectorAll('script[src]')].filter(s => !s.dataset.retry && s.type !== 'module');
      const first = Math.min(...failed.map(s => all.indexOf(s)).filter(i => i >= 0));
      for (const s of all.slice(first)) {
        for (let k = 0; ; k++) {
          try { await loadScript(s.getAttribute('src'), k); break; }
          catch (err) {
            if (k >= RETRY_MS.length) { ready = null; throw new Error('a file of the viewer did not load (' + s.getAttribute('src') + ') - reload the page'); }
            await new Promise(r => setTimeout(r, RETRY_MS[k]));
          }
        }
      }
      console.warn('viewer scripts loaded again after a failed request:', failed.map(s => s.getAttribute('src')).join(', '));
      failed.length = 0;
    })();
    return ready;
  };

  /**
   * Create the parser worker from the registered modules.
   * Returns null if workers are not available (the caller then parses on the
   * main thread).
   */
  C4.createParserWorker = function () {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
    const parts = ['"use strict";\nconst C4 = self.C4 = { modules: [] };\n',
      'C4.define = function (name, fn) { C4.modules.push({ name, fn }); fn(C4); };\n'];
    for (const m of C4.modules) {
      parts.push('C4.define(' + JSON.stringify(m.name) + ', ' + m.fn.toString() + ');\n');
    }
    parts.push('C4.workerMain(self);\n');
    try {
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
      const w = new Worker(url);
      // the blob URL can be released once the worker has started
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return w;
    } catch (err) {
      console.warn('Parser worker could not be created, parsing on the main thread.', err);
      return null;
    }
  };
})(typeof self !== 'undefined' ? self : this);
