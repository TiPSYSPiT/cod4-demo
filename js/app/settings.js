/* The remembered settings' migration (called first in main.js): a version per storage (localStorage and
 * sessionStorage), each step drops exactly the keys whose meaning or default changed - every other remembered setting
 * stays. A step's entry is a key (dropped), or [key, field]: one field of a key holding a JSON object (the graphics
 * choices) dropped, the others kept.
 * Version 1 (2026-11): the start state is 3D in first person (the view and the camera are remembered under
 * new keys, written only by the viewer's own choice - the old ones were written at every start too, so they could
 * not tell a choice from the old default) and the Kill icons option is gone.
 * Version 2 (2026-11): the camera's default (POV: first person of the demo's own view) is now set in defaults.js and
 * applies to everyone once - a camera chosen before starts in POV again; a choice made after is remembered as before.
 * The graphics option Specular Lighting (r_specular) starts at its default, off; the Reflections option is part of it now
 * (its stored choice dropped). */
export const SETTINGS_VERSION = 2;
const VERSION_KEY = 'cod4demo3d.settingsVersion';
const STEPS = {
  1: ['cod4demo3d.view', 'cod4demo3d.camera', 'cod4demo3d.killIcons'],
  2: ['cod4demo3d.camera2', ['cod4demo3d.graphics', 'specular'], ['cod4demo3d.graphics', 'reflections']]
};

/** drop one field of a key that holds a JSON object */
function dropField(S, key, field) {
  const raw = S.getItem(key);
  if (raw == null) return;
  let o = null;
  try { o = JSON.parse(raw); } catch (err) { return; }
  if (!o || typeof o !== 'object' || !(field in o)) return;
  delete o[field];
  S.setItem(key, JSON.stringify(o));
}

export function migrateSettings() {
  for (const name of ['localStorage', 'sessionStorage']) {
    let S = null;
    try { S = window[name]; if (!S) continue; } catch (err) { continue; }      // (storage blocked)
    try {
      const from = Number(S.getItem(VERSION_KEY)) || 0;
      if (from >= SETTINGS_VERSION) continue;
      for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
        for (const k of STEPS[v] || []) { if (Array.isArray(k)) dropField(S, k[0], k[1]); else S.removeItem(k); }
      }
      S.setItem(VERSION_KEY, String(SETTINGS_VERSION));
    } catch (err) { /* not stored */ }
  }
}
