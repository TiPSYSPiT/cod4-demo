/* A demo opened from a link: another site links or redirects to the viewer with
 *
 *   ?demoUrl=<the URL-encoded https:// address of a .dm_1 file>[&name=<the name shown>][&autoplay=1]
 *
 * (the same parameters after # as well - some redirects drop the query; a query parameter wins over the hash's). The
 * file is downloaded here (fetch, streamed: progress, size limit, timeout, cancel) and handed to the same loading
 * pipeline as "Open demo" (main.js load). The server hosting the file must allow this site to read it (CORS:
 * Access-Control-Allow-Origin) - README "Opening a demo from a link". The address and the name are only ever shown as
 * text (textContent / text nodes), never as HTML. */

/** THE settings of demo links: change them here */
export const DEMO_URL_CONFIG = {
  // the hosts a link may download from: [] = every https:// host; else exact names ('raw.githubusercontent.com') or a
  // leading dot for a domain and its subdomains ('.example.com'). With a list, also narrow index.html's CSP connect-src
  allowedHosts: [],
  maxBytes: 200 * 1024 * 1024,     // the largest demo file accepted (bytes)
  timeoutMs: 120000                // the whole download (ms)
};

const KEYS = ['demoUrl', 'name', 'autoplay'];

/** a demo link's error: the message and a hint for the user (both plain text) */
export class DemoUrlError extends Error {
  constructor(message, hint, kind = 'error') { super(message); this.hint = hint; this.kind = kind; }
}

/** the link's parameters (query, else the hash) -> {demoUrl, name, autoplay} or null (no demoUrl: the app as before) */
export function demoLinkParams(loc = location) {
  const q = new URLSearchParams(loc.search);
  const h = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const get = k => (q.has(k) ? q.get(k) : h.has(k) ? h.get(k) : null);
  const raw = get('demoUrl');
  if (raw == null) return null;
  const out = {};
  for (const k of KEYS) out[k] = get(k);
  out.autoplay = out.autoplay === '1' || out.autoplay === 'true';
  out.inHash = !q.has('demoUrl');
  return out;
}

/** the demo's address, checked: absolute, https, no user name / password in it, a host the config allows -> URL; else
 *  DemoUrlError */
export function checkDemoUrl(raw) {
  const bad = new DemoUrlError('Invalid or non-HTTPS demo URL.',
    'The link must contain the full, URL-encoded https:// address of a .dm_1 file, e.g. ?demoUrl=https%3A%2F%2Fexample.com%2Fmatch.dm_1.');
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (err) { throw bad; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw bad;
  const allow = DEMO_URL_CONFIG.allowedHosts;
  const host = url.hostname.toLowerCase();
  if (allow.length && !allow.some(a => (a.startsWith('.') ? host === a.slice(1) || host.endsWith(a) : host === a.toLowerCase()))) {
    throw new DemoUrlError('Demo host not allowed: ' + url.hostname + '.', 'This viewer only opens demo links from: ' + allow.join(', ') + '.');
  }
  return url;
}

/** the name shown and used for exports: the parameter, else the last part of the address; plain text, no path, no
 *  control characters, at most 120 characters */
export function demoName(name, url) {
  let n = name;
  if (!n) { try { n = decodeURIComponent(url.pathname.split('/').pop() || ''); } catch (err) { n = url.pathname.split('/').pop(); } }
  n = String(n || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim().slice(0, 120);
  return n || 'demo.dm_1';
}

/** the first bytes a CoD4 / CoD4X demo starts with (parser/demo.js): a message record - type 0, sequence >= 0, length
 *  4 .. 0x20000 - or a protocol record (type 2, the protocol number, 12 more bytes) followed by a message record.
 *  -> true / false, or null while too few bytes are there to tell */
export function looksLikeDemo(b, final = false) {
  const need = b[0] === 2 ? 26 : 9;
  if (b.length < 1 || b.length < need) return final ? false : null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const message = at => b[at] === 0 && dv.getInt32(at + 1, true) >= 0 && dv.getInt32(at + 5, true) >= 4 && dv.getInt32(at + 5, true) <= 0x20000;
  if (b[0] === 0) return message(0);
  if (b[0] === 2) return dv.getUint32(1, true) < 1000 && message(17);
  return false;
}

/** download the demo: fetch without referrer or cookies, the body read as a stream - progress (fraction, or null when
 *  the size is unknown), the size limit, the first bytes checked, the timeout and signal (cancel) -> File; else
 *  DemoUrlError (kind 'cancelled' for a cancel) */
export async function downloadDemo(url, name, { onProgress = () => {}, signal } = {}) {
  const cfg = DEMO_URL_CONFIG, ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, cfg.timeoutMs);
  const onCancel = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onCancel); }
  const tooLarge = () => new DemoUrlError('File too large.',
    'The demo is larger than ' + Math.round(cfg.maxBytes / 1048576) + ' MB, the limit of this viewer. Download it and open it with "Open demo" instead.');
  const invalid = () => new DemoUrlError('Not a valid CoD4 demo (.dm_1) file.',
    'The address does not point to a CoD4 demo recording - check the link, or download the file and open it with "Open demo".');
  const aborted = () => (timedOut
    ? new DemoUrlError('Download timed out.', 'The server did not deliver the demo within ' + Math.round(cfg.timeoutMs / 1000) + ' s. Try again later, or download it and open it with "Open demo".')
    : new DemoUrlError('Download cancelled.', 'Open the link again to retry, or open a demo file.', 'cancelled'));
  try {
    let res;
    try {
      res = await fetch(url.href, { signal: ctrl.signal, referrerPolicy: 'no-referrer', credentials: 'omit', mode: 'cors', redirect: 'follow' });
    } catch (err) {
      if (ctrl.signal.aborted) throw aborted();
      throw await networkError(url);
    }
    if (!res.ok) throw new DemoUrlError('Download failed (HTTP ' + res.status + ').',
      res.status === 404 ? 'The demo is not at this address (any more) - check the link.' : 'The server hosting the demo refused or failed the request. Try again later.');
    const length = Number(res.headers.get('Content-Length')) || 0;
    // (gzip: Content-Length is the compressed size - the bytes received are counted too)
    if (length > cfg.maxBytes) throw tooLarge();
    const chunks = [];
    let received = 0, checked = false;
    if (!res.body || !res.body.getReader) {               // (no stream: the whole body at once)
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf); received = buf.length;
    } else {
      const reader = res.body.getReader();
      let head = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (received > cfg.maxBytes) { reader.cancel().catch(() => {}); throw tooLarge(); }
        if (!checked) {                                   // the first bytes: a demo, or stop now (an HTML page, an image ...)
          const h = new Uint8Array(head.length + value.length); h.set(head); h.set(value, head.length); head = h.slice(0, 64);
          const ok = looksLikeDemo(h);
          if (ok === false) { reader.cancel().catch(() => {}); throw invalid(); }
          checked = ok === true;
        }
        onProgress(length ? Math.min(1, received / length) : null, received);
      }
    }
    const blob = new Blob(chunks);
    if (!checked && !looksLikeDemo(new Uint8Array(await blob.slice(0, 64).arrayBuffer()), true)) throw invalid();
    onProgress(1, received);
    return new File([blob], name, { lastModified: lastModified(res) });
  } catch (err) {
    if (err instanceof DemoUrlError) throw err;
    if (ctrl.signal.aborted) throw aborted();
    throw new DemoUrlError('Download failed: ' + err.message, 'The connection broke off. Try again, or download the demo and open it with "Open demo".');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCancel);
  }
}

/** the file date for the match info (as a file opened from the disk has one): Last-Modified, else now */
function lastModified(res) {
  const t = Date.parse(res.headers.get('Last-Modified') || '');
  return Number.isFinite(t) ? t : Date.now();
}

/** a fetch that failed without an answer: CORS (the server answers, but not to this site - an opaque no-cors HEAD
 *  request gets through) or the network (no server at all) */
async function networkError(url) {
  let reachable = false;
  try {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 8000);
    await fetch(url.href, { method: 'HEAD', mode: 'no-cors', referrerPolicy: 'no-referrer', credentials: 'omit', signal: c.signal });
    clearTimeout(t);
    reachable = true;
  } catch (err) { /* not reachable */ }
  if (reachable) {
    return new DemoUrlError('Download blocked by CORS: the server hosting the demo does not allow loading from this site.',
      'The site that hosts the file has to send the header Access-Control-Allow-Origin (e.g. *) for it. Until then, download the demo and open it with "Open demo".');
  }
  return new DemoUrlError('Download failed: the server could not be reached.',
    'Check the address and your internet connection, then try again - or download the demo and open it with "Open demo".');
}
