/* Loading with retries: the browser cancels a request now and then (net::ERR_ABORTED, seen in batches while the 3D view loads
 * its hundreds of files), and a local server can drop one under load. A file loaded once - a data list, a HUD or kill feed image -
 * is tried again (0.4 / 1.2 / 2.4 s later) instead of leaving a part of the view without it for the session; an HTTP error is
 * final (a missing file stays missing). A file given up is named in the console. */
const DELAYS = [400, 1200, 2400];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** fetch(url, opts) -> Response (also a non-ok one: the caller decides); a network error is tried again, then thrown */
export async function fetchRetry(url, opts) {
  for (let k = 0; ; k++) {
    try { return await fetch(url, opts); }
    catch (err) {
      if (k >= DELAYS.length || (opts && opts.signal && opts.signal.aborted)) { console.warn('not loaded:', url, '-', err.message); throw err; }
      await sleep(DELAYS[k]);
    }
  }
}

/** an image -> Promise<HTMLImageElement>; a failed load is tried again with a new element, then rejected */
export function loadImage(src) {
  return new Promise((ok, no) => {
    const attempt = k => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => {
        if (k < DELAYS.length) setTimeout(() => attempt(k + 1), DELAYS[k]);
        else { console.warn('image not loaded:', src); no(new Error('image not loaded: ' + src)); }
      };
      img.src = src;
    };
    attempt(0);
  });
}
