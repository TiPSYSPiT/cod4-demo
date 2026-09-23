/* Worker entry point. The worker is created from a Blob that contains all
 * registered modules (see core/c4.js) and then calls C4.workerMain(self). */
C4.define('workerMain', function (C4) {
  'use strict';

  /** typed arrays of the positions can be transferred instead of copied */
  function transferList(data) {
    const list = [];
    for (const p of Object.values(data.positions)) for (const a of Object.values(p)) list.push(a.buffer);
    return list;
  }

  C4.workerMain = function (scope) {
    scope.onmessage = ev => {
      const { buffer, fileInfo } = ev.data;
      try {
        let last = 0;
        const data = C4.analyzeDemo(new Uint8Array(buffer), fileInfo, frac => {
          if (frac - last >= 0.01 || frac === 1) { last = frac; scope.postMessage({ type: 'progress', value: frac }); }
        });
        scope.postMessage({ type: 'done', data }, transferList(data));
      } catch (err) {
        scope.postMessage({ type: 'error', message: err && err.message ? err.message : String(err),
          invalid: err instanceof C4.demo.DemoError, stack: err && err.stack });
      }
    };
  };
  C4.transferList = transferList;
});
