/* The remembered settings' migration (called first in main.js): a version per storage (localStorage and
 * sessionStorage), each step drops exactly the keys whose meaning or default changed - every other remembered setting
 * stays. Version 1 (2026-11): the start state is 3D in first person (the view and the camera are remembered under
 * new keys, written only by the viewer's own choice - the old ones were written at every start too, so they could
 * not tell a choice from the old default) and the Kill icons option is gone. */
export const SETTINGS_VERSION = 1;
const VERSION_KEY = 'cod4demo3d.settingsVersion';
const STEPS = {
  1: ['cod4demo3d.view', 'cod4demo3d.camera', 'cod4demo3d.killIcons']
};

export function migrateSettings() {
  for (const name of ['localStorage', 'sessionStorage']) {
    let S = null;
    try { S = window[name]; if (!S) continue; } catch (err) { continue; }      // (storage blocked)
    try {
      const from = Number(S.getItem(VERSION_KEY)) || 0;
      if (from >= SETTINGS_VERSION) continue;
      for (let v = from + 1; v <= SETTINGS_VERSION; v++) for (const k of STEPS[v] || []) S.removeItem(k);
      S.setItem(VERSION_KEY, String(SETTINGS_VERSION));
    } catch (err) { /* not stored */ }
  }
}
