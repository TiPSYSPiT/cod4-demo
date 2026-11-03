/* The 3D view's graphics settings (the Graphics popover of the rail): the game's lighting, the sun
 * shadows, the reflections, the effects and the first-person weapon. They take effect when the 3D map
 * is loaded, so a change rebuilds the 3D view (main.js: app.reload3d) - except a "live" one, which the
 * view applies at once. Remembered in localStorage; a URL parameter (?lighting=scene, ?shadows=off,
 * ?reflections=off, ?fx=off|ambient|demo, ?viewmodel=off, ?crosshair=off) overrides it for that page. */

const KEY = 'cod4demo3d.graphics';            // JSON {lighting, shadows, reflections, fx, viewmodel, crosshair}

/** key, URL parameter, values ([value, label, title]) - the first is the default */
export const GRAPHICS = [
  { key: 'lighting', label: 'Lighting', title: 'Game: the players, props and effects lit by the map\'s light grid, reflection probes and sun, as in the game. Simple: plain scene lights (faster).',
    values: [['game', 'Game'], ['scene', 'Simple']] },
  { key: 'shadows', label: 'Sun shadows', title: 'The sun\'s shadow map: world, props and players cast shadows (needs the game lighting)',
    values: [['on', 'On'], ['off', 'Off']] },
  { key: 'reflections', label: 'Reflections', title: 'The reflection probes of the specular maps (shiny surfaces reflect the map around them)',
    values: [['on', 'On'], ['off', 'Off']] },
  { key: 'fx', label: 'Effects', title: 'The game\'s particle effects: the map\'s ambient effects (smoke, fire, dust) and the demo\'s own (explosions, smoke grenades, impacts, muzzle flashes)',
    values: [['all', 'All'], ['ambient', 'Map only'], ['demo', 'Demo only'], ['off', 'Off']] },
  { key: 'viewmodel', label: 'First-person weapon', live: true, title: 'In the first-person camera: the weapon the player holds, in their character\'s hands - the game\'s view models and animations as the demo drives them (shots, reloads, switches, aiming down the sights with the zoom and the sniper scope, the knife), drawn over the world',
    values: [['on', 'On'], ['off', 'Off']] },
  { key: 'crosshair', label: 'Crosshair', live: true, title: 'In the first-person camera: the crosshair as in the game - its gap the weapon\'s spread (stance, movement, shots), hidden aiming down the sights and for the scoped rifles',
    values: [['on', 'On'], ['off', 'Off']] }
];
// the URL parameters' values in the settings' terms (?fx=on is not a value: ignored)
const FROM_URL = { lighting: v => v === 'scene' ? 'scene' : null, shadows: v => v === 'off' ? 'off' : null,
  reflections: v => v === 'off' ? 'off' : null, fx: v => ['off', 'ambient', 'demo'].includes(v) ? v : null,
  viewmodel: v => v === 'off' ? 'off' : null, crosshair: v => v === 'off' ? 'off' : null };

function stored() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (err) { return {}; }
}

/** the setting given by the page's URL, or null */
export function urlGraphics(key) {
  const v = new URLSearchParams(location.search).get(key);
  return v != null ? FROM_URL[key](v) : null;
}

/** the effective settings: URL parameter, else the stored choice, else the default */
export function graphics() {
  const s = stored(), out = {};
  for (const g of GRAPHICS) {
    const v = urlGraphics(g.key) || s[g.key];
    out[g.key] = g.values.some(x => x[0] === v) ? v : g.values[0][0];
  }
  return out;
}

/** remember a choice (a URL parameter still wins on pages that set it) */
export function setGraphics(key, value) {
  const s = stored();
  s[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (err) { /* not stored */ }
}
