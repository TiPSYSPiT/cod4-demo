/* The game's blend state (a material's state bits: source / destination factor, exported as "src/dst",
 * tools/export/export_maps.py BLEND) as three.js material options - the same factors on the colour.
 * Used by the world (mapLoader.js), the props (props.js), the script models / characters
 * (characters.js) and the effects (fx.js), so a blend mode is drawn the same everywhere.
 *  - srcalpha/invsrcalpha: three's normal blending.
 *  - one/invsrcalpha: premultiplied (three's premultipliedAlpha: the shader multiplies by alpha).
 *  - everything else exactly, e.g. invdestcolor/one (light beams, fire balls: src x (1 - dst) + dst, black
 *    adds nothing), destcolor/srccolor (2x multiply decals: 2 x src x dst), one/one, srcalpha/one,
 *    zero/srccolor (multiply).
 * The framebuffer's alpha is kept (blendSrcAlpha zero, blendDstAlpha one): three's canvas always has an
 * alpha channel and is composited with the page - a blended alpha let the page show through (the
 * black bands of docs/asset-audit.md, section 8). */
import * as THREE from 'three';

const FACTOR = {
  zero: THREE.ZeroFactor, one: THREE.OneFactor, srccolor: THREE.SrcColorFactor, invsrccolor: THREE.OneMinusSrcColorFactor,
  srcalpha: THREE.SrcAlphaFactor, invsrcalpha: THREE.OneMinusSrcAlphaFactor, destalpha: THREE.DstAlphaFactor,
  invdestalpha: THREE.OneMinusDstAlphaFactor, destcolor: THREE.DstColorFactor, invdestcolor: THREE.OneMinusDstColorFactor
};

/** the factors of a blend name -> [src, dst] names, or null (none / not a known pair) */
export function blendFactors(blend) {
  const p = typeof blend === 'string' ? blend.split('/') : null;
  return p && p.length === 2 && p[0] in FACTOR && p[1] in FACTOR ? p : null;
}

/** does the colour need its alpha multiplied in before blending? (the source factor has no alpha: one,
 *  dstcolor, invdestcolor - with an additive destination the alpha would otherwise not fade it) */
export function premultiplies(blend) {
  const f = blendFactors(blend);
  return !!f && f[1] === 'one' && (f[0] === 'one' || f[0] === 'invdestcolor');
}

/** a blend as material options (merged into the options of a three material): {} for none */
export function blendOptions(blend) {
  if (!blend) return {};
  const o = { transparent: true, depthWrite: false };
  const f = blendFactors(blend);
  if (!f || (f[0] === 'srcalpha' && f[1] === 'invsrcalpha')) return o;              // normal alpha blending
  if (f[0] === 'one' && f[1] === 'invsrcalpha') return Object.assign(o, { premultipliedAlpha: true });
  return Object.assign(o, {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: FACTOR[f[0]], blendDst: FACTOR[f[1]],
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    // the built-in materials multiply by alpha in the shader for the additive ones (PREMULTIPLIED_ALPHA)
    premultipliedAlpha: premultiplies(blend)
  });
}

/** is it a multiply (the destination scaled by the source colour: no lightmap on such decals) */
export function isMultiply(blend) {
  const f = blendFactors(blend);
  return !!f && ((f[0] === 'zero' && f[1] === 'srccolor') || (f[0] === 'destcolor' && (f[1] === 'zero' || f[1] === 'srccolor')));
}
