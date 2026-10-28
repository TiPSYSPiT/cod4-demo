/* Why a module could not be loaded. A failed dynamic import says little: Chromium reports "Failed to
 * fetch dynamically imported module: <the top module>" when ANY module of the chain is missing, not
 * served as JavaScript or not reachable - also when it is a dependency. This walks the chain the way
 * the browser does (static imports, the page's import map) with fetch() and names the first file that
 * fails and why; when every file downloads, the problem is inside a module (the browser's own message
 * names it: SyntaxError, a missing export) or an old copy in the browser cache. */

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^;'"`]+?\s+from\s+)?(['"])([^'"]+)\1/g;

/** the page's import map ({imports}) or {} */
function importMap() {
  try { return JSON.parse(document.querySelector('script[type=importmap]').textContent) || {}; } catch (err) { return {}; }
}

/** a specifier as the browser resolves it from `from` (absolute URL), or null (not in the import map) */
export function resolveSpecifier(spec, from) {
  if (/^(\.{0,2}\/|[a-z][\w+.-]*:)/i.test(spec)) return new URL(spec, from).href;
  const map = importMap().imports || {};
  if (map[spec]) return new URL(map[spec], document.baseURI).href;
  const prefix = Object.keys(map).filter(k => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return prefix ? new URL(map[prefix] + spec.slice(prefix.length), document.baseURI).href : null;
}

const short = url => { try { const u = new URL(url); return u.origin === location.origin ? u.pathname.replace(/^\//, '') : url; } catch (err) { return url; } };

/**
 * walk the module chain from `url` (absolute) -> {ok: true, modules} or {ok: false, url, via, reason, text}
 * reason: 'missing' (HTTP 404 / 410), 'http' (another status), 'type' (not served as JavaScript),
 * 'network' (no response), 'unresolved' (a bare specifier the import map does not map)
 */
export async function checkModuleChain(url, limit = 200) {
  const seen = new Set(), queue = [{ url, via: null }], order = [];
  while (queue.length && seen.size < limit) {
    const { url: u, via } = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    order.push(u);
    let r;
    try { r = await fetch(u, { cache: 'no-cache' }); }
    catch (err) { return { ok: false, url: u, via, reason: 'network', text: short(u) + ' could not be downloaded (' + err.message + ')' + (via ? ' - imported by ' + short(via) : '') + '.' }; }
    if (!r.ok) {
      const missing = r.status === 404 || r.status === 410;
      return { ok: false, url: u, via, reason: missing ? 'missing' : 'http',
        text: short(u) + (missing ? ' is not on the server (HTTP ' + r.status + ')' : ' failed with HTTP ' + r.status) + (via ? ' - imported by ' + short(via) : '') +
          (missing ? '. The site\'s copy is incomplete: upload that file.' : '.') };
    }
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/javascript|ecmascript/i.test(type)) {
      return { ok: false, url: u, via, reason: 'type', text: short(u) + ' is served as "' + (type || 'no type') + '"' + (via ? ' - imported by ' + short(via) : '') +
        '. Modules must be sent as text/javascript (check the web server\'s MIME types).' };
    }
    const src = (await r.text()).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(IMPORT_RE)) {
      const next = resolveSpecifier(m[2], u);
      if (!next) return { ok: false, url: u, via, reason: 'unresolved', text: short(u) + ' imports "' + m[2] + '", which the page\'s import map does not resolve.' };
      if (!seen.has(next)) queue.push({ url: next, via: u });
    }
  }
  return { ok: true, modules: seen.size, order };
}

/** every file downloads, yet the chain does not load: import the modules one by one, the imported
 *  ones first (a fresh copy of each: ?modulecheck), and name the first that fails -> text or null */
async function findBrokenModule(order) {
  for (const u of [...order].reverse()) {
    try { await import(u + (u.includes('?') ? '&' : '?') + 'modulecheck=' + Date.now()); }
    catch (err) { return short(u) + ': ' + (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : err); }
  }
  return null;
}

/** the text for a failed dynamic import of `url` (relative to the page or absolute): the real reason */
export async function explainImportError(url, err) {
  const abs = new URL(url, document.baseURI).href;
  let c;
  try { c = await checkModuleChain(abs); } catch (e) { c = null; }
  if (c && !c.ok) return c.text;
  const msg = err && err.message ? err.message : String(err);
  if (c && c.ok) {
    const broken = await findBrokenModule(c.order).catch(() => null);
    if (broken) return 'a module is broken - ' + broken;
    return 'all ' + c.modules + ' files of ' + short(abs) + ' and its imports download, but the browser could not load them: ' + msg +
      (/fetch/i.test(msg) ? ' - probably an old copy in the browser cache or an interrupted request: reload with Ctrl+F5' : '');
  }
  return msg;
}
