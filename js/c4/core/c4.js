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

  /** Register a module. Must be self-contained: it may only use its argument. */
  C4.define = function (name, fn) {
    C4.modules.push({ name, fn });
    fn(C4);
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
