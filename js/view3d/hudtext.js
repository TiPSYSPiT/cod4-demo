/* The game's text for the first-person HUD and the scoreboard: the fonts (glyph tables over one image), the localized
 * strings and the materials of the server's HUD elements - maps3d/_hud/hud.json (tools/export/hud_export.py), loaded once
 * for all demos. Without them (no export) the callers keep to the browser's font. */

import { fetchJSON } from './data.js';
import { loadImage } from '../app/retry.js';

const BASE = 'maps3d/';
const FONT_SMALL = 0.25, FONT_BIG = 0.4, FONT_EXTRABIG = 0.55;      // ui_smallFont, ui_bigFont, ui_extraBigFont
// g_color_table ^0 .. ^7; ^8, ^9 the viewer's team and the other's (CL_LookupColor): the caller's, else white
const CODES = [[0, 0, 0], [1, 0.36, 0.36], [0, 1, 0], [1, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0.36, 1], [1, 1, 1]];
const NO_TEAMS = [[1, 1, 1], [1, 1, 1]];
// a text's [{+action}]: the key the player bound - not in the demo, so the game's default
const DEFAULT_KEYS = { melee: 'V', activate: 'F', attack: 'MOUSE1', gostand: 'SPACE', frag: 'G', smoke: '4' };
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const canvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
const rgb = c => 'rgb(' + c.map(v => Math.round(clamp01(v) * 255)).join(',') + ')';
const image = src => loadImage(src);

class Fonts {
  constructor(info, atlas) {
    this.atlas = atlas;
    this.fonts = {};
    for (const [name, f] of Object.entries(info)) {
      const map = new Map();
      for (const g of f.glyphs) map.set(g[0], g);
      this.fonts[name] = { name, height: f.height, map, fallback: map.get(63) || f.glyphs[0] };
    }
    this.cache = new Map();
  }
  /** UI_GetFontHandle: kind 0 default, 2 big, 3 small, 4 bold, 5 console, 6 objective; real: the size the choice goes by */
  pick(kind, real) {
    const F = this.fonts;
    if (kind === 2) return F.bigFont;
    if (kind === 3) return F.smallFont;
    if (kind === 5) return F.consoleFont;
    if (kind === 6) return F.objectiveFont;
    if (real <= FONT_SMALL) return F.smallFont;
    if (kind === 4) return real >= FONT_BIG ? F.boldFont : F.normalFont;
    if (real >= FONT_EXTRABIG) return F.extraBigFont;
    return real >= FONT_BIG ? F.bigFont : F.normalFont;
  }
  glyph(font, code) { return (code >= 32 && font.map.get(code)) || font.fallback; }
  /** the text's width (virtual units; colour codes skipped) */
  width(font, text, scale) {
    const k = scale * 48 / font.height;
    let w = 0, best = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 94 && i + 1 < text.length && /[0-9]/.test(text[i + 1])) { i++; continue; }
      if (c === 10) { best = Math.max(best, w); w = 0; continue; }
      w += this.glyph(font, c)[3] * k;
    }
    return Math.max(best, w);
  }
  /** the colour runs of a text: [[text, colour]]; teams: [^8, ^9] */
  runs(text, base, teams = NO_TEAMS) {
    const out = [];
    let cur = '', col = base;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '^' && i + 1 < text.length && /[0-9]/.test(text[i + 1])) {
        if (cur) out.push([cur, col]);
        const n = Number(text[i + 1]);
        cur = ''; col = n < 8 ? CODES[n] : teams[n - 8];
        i++;
        continue;
      }
      cur += text[i];
    }
    if (cur) out.push([cur, col]);
    return out;
  }
  /** one run at k device pixels per glyph pixel, tinted -> {canvas, ox, oy, adv} (ox / oy: the canvas' corner from the pen
   *  at the baseline, device pixels) */
  run(font, text, k, color) {
    const key = font.name + '|' + Math.round(k * 1000) + '|' + Math.round(color[0] * 255) + '.' + Math.round(color[1] * 255) + '.' + Math.round(color[2] * 255) + '|' + text;
    let r = this.cache.get(key);
    if (r) return r;
    let x = 0, minY = 0, maxY = 0, maxX = 0;
    for (const ch of text) {
      const g = this.glyph(font, ch.charCodeAt(0));
      minY = Math.min(minY, g[2]); maxY = Math.max(maxY, g[2] + g[5]); maxX = Math.max(maxX, x + g[1] + g[4]);
      x += g[3];
    }
    const w = Math.max(1, Math.ceil(Math.max(maxX, x) * k) + 2), h = Math.max(1, Math.ceil((maxY - minY) * k) + 2);
    const cv = canvas(w, h), c = cv.getContext('2d'), A = this.atlas;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    x = 0;
    for (const ch of text) {
      const g = this.glyph(font, ch.charCodeAt(0));
      if (g[4] && g[5]) c.drawImage(A, g[6] * A.width, g[7] * A.height, (g[8] - g[6]) * A.width, (g[9] - g[7]) * A.height, 1 + (x + g[1]) * k, 1 + (g[2] - minY) * k, g[4] * k, g[5] * k);
      x += g[3];
    }
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = rgb(color);
    c.fillRect(0, 0, w, h);
    r = { canvas: cv, ox: -1, oy: minY * k - 1, adv: x * k };
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(key, r);
    return r;
  }
}

export class HudText {
  constructor(data, atlas, images) {
    this.data = data;
    this.fonts = new Fonts(data.fonts, atlas);
    this.images = images;              // image name -> Image
    this.tints = new Map();
  }
  /** a localized string: a reference -> its text; "REF\x15param\x14REF2..." with &&1, &&2 (\x15: a plain text, as a script's
   *  setText("...") stores it) */
  localize(s) {
    if (!s) return '';
    return this.translate(s).replace(/\{\+(\w+)\}/g, (m, k) => (Object.hasOwn(DEFAULT_KEYS, k) ? DEFAULT_KEYS[k] : k));
  }
  translate(s) {
    const S = this.data.strings, get = k => (Object.hasOwn(S, k) ? S[k] : null);
    const parts = s.split(/([\x14\x15])/), head = parts[0], params = [];
    for (let i = 1; i < parts.length; i += 2) { const v = parts[i] === '\x14' ? get(parts[i + 1]) : null; params.push(v != null ? v : parts[i + 1]); }
    if (!head) return params.join('');
    const out = get(head);
    return (out != null ? out : head).replace(/&&(\d)/g, (m, n) => (params[n - 1] != null ? params[n - 1] : ''));
  }
  width(str, scale, s, kind = 0, real = scale * s) { return this.fonts.width(this.fonts.pick(kind, real), str, scale) * s; }
  /** a text at a device position (x: the pen, y: the baseline) -> its width (device pixels). scale: virtual, s: device pixels
   *  per virtual unit, color [r, g, b] (^ codes switch it; teams: [^8, ^9]), style 3: shadowed - one screen pixel, as the game's
   *  (RB_DrawText: ofs 1 in x and y, black with the text's alpha) */
  draw(g, str, x, y, scale, s, color, alpha = 1, style = 3, kind = 0, real = scale * s, teams = NO_TEAMS) {
    if (!str || alpha <= 0) return 0;
    const F = this.fonts, font = F.pick(kind, real), k = scale * 48 / font.height * s;
    const shadow = style === 3 ? 1 : 0;
    let py = y, total = 0;
    g.save();
    g.globalAlpha = clamp01(alpha);
    for (const line of str.split('\n')) {
      let px = x;
      for (const [t, c] of F.runs(line, color, teams)) {
        if (shadow) { const r = F.run(font, t, k, [0, 0, 0]); g.drawImage(r.canvas, Math.round(px + r.ox + shadow), Math.round(py + r.oy + shadow)); }
        const r = F.run(font, t, k, c);
        g.drawImage(r.canvas, Math.round(px + r.ox), Math.round(py + r.oy));
        px += r.adv;
      }
      total = Math.max(total, px - x);
      py += scale * 48 * s;
    }
    g.restore();
    return total;
  }
  /** a material of the HUD elements in a device rectangle, tinted, with alpha */
  pic(g, material, x, y, w, h, color, alpha) {
    const M = this.data.materials, name = String(material).toLowerCase();
    if (!Object.hasOwn(M, name) || alpha <= 0) return false;
    g.save();
    g.globalAlpha = clamp01(alpha);
    if (M[name] == null) { g.fillStyle = rgb(name === 'black' ? [0, 0, 0] : color); g.fillRect(x, y, w, h); }
    else { const img = this.tinted(M[name], color); if (img) g.drawImage(img, x, y, w, h); }
    g.restore();
    return true;
  }
  tinted(name, color) {
    const img = this.images.get(name);
    if (!img || color.every(c => c >= 0.999)) return img || null;
    const key = name + '|' + color.map(c => c.toFixed(2)).join(',');
    let cv = this.tints.get(key);
    if (!cv) {
      cv = canvas(img.width, img.height);
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = rgb(color);
      c.fillRect(0, 0, img.width, img.height);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(img, 0, 0);
      if (this.tints.size > 64) this.tints.clear();
      this.tints.set(key, cv);
    }
    return cv;
  }
}

let loading = null;
/** hud.json, the font image and the HUD elements' images (once) -> HudText, or null without the export */
export function loadHudText() {
  if (!loading) {
    loading = (async () => {
      try {
        const d = await fetchJSON(BASE + '_hud/hud.json').catch(() => null);
        if (!d || !d.fonts || !d.images[d.fontImage]) return null;
        const atlas = await image(BASE + d.images[d.fontImage].file), images = new Map();
        await Promise.all(Object.values(d.materials).filter(Boolean).map(async n => {
          if (d.images[n]) { try { images.set(n, await image(BASE + d.images[n].file)); } catch (err) { /* drawn as nothing */ } }
        }));
        return new HudText(d, atlas, images);
      } catch (err) {
        console.warn('HUD text not available:', err.message);
        return null;
      }
    })();
  }
  return loading;
}

/** the config strings the HUD reads over time (DemoData psHud.elems.cs) -> (index, t) => the value at t */
export function configStrings(d) {
  const E = d.psHud && d.psHud.elems, cs = new Map();
  if (E) {
    for (const [i, v] of Object.entries(E.cs.init)) cs.set(Number(i), [[-Infinity, v]]);
    for (const [t, i, v] of E.cs.changes) { if (!cs.has(i)) cs.set(i, []); cs.get(i).push([t, v]); }
  }
  return (i, t) => { const a = cs.get(i); let v = ''; if (a) for (const [ct, cv] of a) { if (ct <= t) v = cv; else break; } return v; };
}
