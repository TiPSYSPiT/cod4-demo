/* Fetching the exported data (maps3d/): every JSON and binary file of the 3D view goes through here.
 *  - Cache-busting: maps3d/manifest.json (tools/check_deploy.py manifest) has size and hash of every
 *    file; the URL gets ?v=<hash>, so a JSON header and its binary are always the same version (a
 *    browser or CDN cache never mixes an old one with a new one). Without a manifest: plain URLs.
 *  - Checks: HTTP status, an HTML page (a 404 page served as data) or a Git LFS pointer instead of the
 *    data, the received length against the manifest's / the header's, the views into a buffer
 *    (offset, length, alignment). A failure throws a DataError with a precise message and logs URL,
 *    status, type, size and SHA-256 to the console.
 *  - Binaries are read as a stream into chunks: Content-Length is the size on the wire, and GitHub
 *    Pages gzips (Content-Encoding) - a buffer sized from it cut world.bin short ("Invalid typed array
 *    length"). The progress uses the expected size from the manifest or the caller. */

const BASE = 'maps3d/';
let manifest = null, manifestLoading = null;

export class DataError extends Error {}

/** maps3d/manifest.json, once (revalidated: no-cache) -> manifest or null */
export function loadDataManifest() {
  if (!manifestLoading) {
    manifestLoading = fetch(BASE + 'manifest.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null)).then(m => (manifest = m && m.files ? m : null))
      .catch(() => null);
  }
  return manifestLoading;
}

/** the manifest's entry [size, hash] of a maps3d URL (or null) */
function entryOf(url) {
  if (!manifest || !url.startsWith(BASE)) return null;
  return manifest.files[url.slice(BASE.length).split('?')[0]] || null;
}

/** a maps3d URL with its version (?v=hash), for fetches and texture loaders */
export function dataUrl(url) {
  const e = entryOf(url);
  return e ? url + (url.includes('?') ? '&' : '?') + 'v=' + e[1] : url;
}

const name = url => url.split('?')[0];
const isText = url => /\.(json|md|txt)$/i.test(name(url));

/** what came instead of the data: 'an HTML page' / 'a Git LFS pointer' / null */
function sniff(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64)).trimStart();
  if (head.startsWith('version https://git-lfs')) return 'a Git LFS pointer';
  if (/^<(!doctype|html|head|body)/i.test(head)) return 'an HTML page';
  return null;
}

async function sha256(bytes) {
  try {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) { return 'n/a'; }
}

/** log a failed file (URL, status, type, size, hash) and throw the message */
async function fail(url, r, bytes, message) {
  console.error('data file failed:', message, { url, status: r && r.status, type: r && r.headers.get('content-type'),
    encoding: r && r.headers.get('content-encoding'), size: bytes ? bytes.byteLength : null, sha256: bytes ? await sha256(bytes) : null });
  throw new DataError(message);
}

/** fetch a maps3d file (versioned URL, status checked) -> Response */
export async function fetchData(url, opts) {
  await loadDataManifest();
  let r;
  try { r = await fetch(dataUrl(url), opts); } catch (err) { return fail(url, null, null, name(url) + ': ' + err.message); }
  if (!r.ok) return fail(url, r, null, name(url) + ': HTTP ' + r.status + (r.status === 404 ? ' (not found - not deployed?)' : ''));
  return r;
}

/** a JSON file -> object (an HTML page or an LFS pointer named as such) */
export async function fetchJSON(url, opts) {
  const r = await fetchData(url, opts);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const what = sniff(bytes);
  if (what) return fail(url, r, bytes, name(url) + ': received ' + what + ' (' + bytes.byteLength + ' bytes) instead of JSON');
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch (err) { return fail(url, r, bytes, name(url) + ': not valid JSON (' + bytes.byteLength + ' bytes: ' + err.message + ')'); }
}

/** a binary file -> ArrayBuffer, its length checked against `expected` (the caller's, from a header)
 *  or the manifest's size; onProgress(0..1) while it streams */
export async function fetchBinary(url, { expected = 0, onProgress = null } = {}) {
  const r = await fetchData(url);
  const e = entryOf(url);
  const want = expected || (e && !isText(url) ? e[0] : 0);
  let bytes;
  if (r.body && onProgress) {
    const reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (want) onProgress(Math.min(1, got / want));
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
  } else bytes = new Uint8Array(await r.arrayBuffer());
  const what = sniff(bytes);
  if (what && (!want || bytes.byteLength !== want)) return fail(url, r, bytes, name(url) + ': received ' + what + ' (' + bytes.byteLength + ' bytes) instead of the data');
  if (want && bytes.byteLength !== want) {
    return fail(url, r, bytes, name(url) + ': expected ' + want.toLocaleString('en') + ' bytes, received ' + bytes.byteLength.toLocaleString('en') +
      (bytes.byteLength < want ? ' (cut short or an old version)' : ' (another version)'));
  }
  return bytes.buffer;
}

/** a typed array view into a fetched buffer, checked: offset aligned, inside the buffer */
export function checkedView(T, buf, offset, count, what) {
  const end = offset + count * T.BYTES_PER_ELEMENT;
  if (offset % T.BYTES_PER_ELEMENT || end > buf.byteLength || offset < 0 || count < 0) {
    throw new DataError(what + ': ' + T.name + ' view of ' + count + ' elements at byte ' + offset +
      (offset % T.BYTES_PER_ELEMENT ? ' is not aligned' : ' needs ' + end.toLocaleString('en') + ' bytes, the file has ' + buf.byteLength.toLocaleString('en')));
  }
  return new T(buf, offset, count);
}
