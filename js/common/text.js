/* Text helpers: CoD colour codes, info strings, engine tokenizer. */
C4.define('text', function (C4) {
  'use strict';
  const COLOR_RE = /\^[0-9:;<=>?]/g;
  const CTRL_RE = /[\x00-\x1f\x7f]/g;

  /** Remove ^N colour codes and control / localisation marker bytes (0x14-0x16). */
  function stripColors(s) {
    return String(s == null ? '' : s).replace(COLOR_RE, '').replace(CTRL_RE, '');
  }

  /** Remove only the control / localisation marker bytes, keep colour codes. */
  function stripControl(s) {
    return String(s == null ? '' : s).replace(CTRL_RE, '');
  }

  /** "\key\value\key\value" -> object */
  function parseInfostring(s) {
    const parts = String(s || '').split('\\');
    if (parts[0] === '') parts.shift();
    const out = {};
    for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return out;
  }

  const isSpace = c => { const o = c.charCodeAt(0); return o <= 0x20 && o !== 0x14 && o !== 0x15 && o !== 0x16; };

  /** Port of Cmd_TokenizeStringInternal; the last allowed token gets the raw remainder. */
  function tokenize(text, maxTokens = 512) {
    const argv = [];
    let i = 0;
    const n = text.length;
    for (;;) {
      for (;;) {
        while (i < n && isSpace(text[i])) i++;
        if (i >= n) return argv;
        if (text.startsWith('//', i)) return argv;
        if (text.startsWith('/*', i)) {
          const j = text.indexOf('*/', i + 2);
          if (j < 0) return argv;
          i = j + 2;
          continue;
        }
        break;
      }
      if (--maxTokens === 0) { argv.push(text.slice(i)); return argv; }
      if (text[i] === '"') {
        let j = i + 1, buf = '';
        while (j < n && text[j] !== '"') {
          if (text[j] === '\\' && text[j + 1] === '"') j++;
          buf += text[j++];
        }
        argv.push(buf);
        if (j >= n) return argv;
        i = j + 1;
        if (i >= n) return argv;
      } else {
        let j = i;
        while (j < n && !isSpace(text[j]) && !(text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*'))) j++;
        argv.push(text.slice(i, j));
        i = j;
      }
    }
  }

  C4.text = { stripColors, stripControl, parseInfostring, tokenize };
});
