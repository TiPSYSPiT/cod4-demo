/* The 3D view's graphics settings (the Graphics popover of the rail): the game's lighting, the sun
 * shadows, the reflections, the effects and the POV weapon. They take effect when the 3D map
 * is loaded, so a change rebuilds the 3D view (main.js: app.reload3d) - except a "live" one, which the
 * view applies at once. Remembered in localStorage; a URL parameter (?lighting=scene, ?shadows=off,
 * ?reflections=on, ?fx=all|ambient|demo|off, ?viewmodel=off, ?crosshair=off) overrides it for that page. The defaults:
 * app/defaults.js. */
import { DEFAULTS, GRAPHICS_KEY as KEY } from '../app/defaults.js';

/** key, URL parameter, values ([value, label, title]) */
export const GRAPHICS = [
  { key: 'lighting', label: 'Lighting', title: 'Game: the players, props and effects lit by the map\'s light grid, reflection probes and sun, as in the game. Simple: plain scene lights (faster).',
    values: [['game', 'Game'], ['scene', 'Simple']] },
  { key: 'shadows', label: 'Sun shadows', title: 'The sun\'s shadow map: world, props and players cast shadows (needs the game lighting)',
    values: [['on', 'On'], ['off', 'Off']] },
  { key: 'reflections', label: 'Reflections', title: 'The reflection probes of the specular maps (shiny surfaces reflect the map around them)',
    values: [['on', 'On'], ['off', 'Off']] },
  { key: 'fx', label: 'Effects', title: 'The game\'s particle effects: the map\'s ambient effects (smoke, fire, dust) and the demo\'s own (explosions, smoke grenades, impacts, muzzle flashes)',
    values: [['all', 'All'], ['ambient', 'Map only'], ['demo', 'Demo only'], ['off', 'Off']] },
  { key: 'viewmodel', label: 'POV weapon', live: true, title: 'In the first-person camera: the weapon the player holds, in their character\'s hands - the game\'s view models and animations as the demo drives them (shots, reloads, switches, aiming down the sights with the zoom and the sniper scope, the knife), drawn over the world',
    values: [['on', 'On'], ['off', 'Off']] },
  { key: 'crosshair', label: 'Crosshair', live: true, title: 'In the first-person camera: the crosshair with the game\'s images - its gap the weapon\'s spread (stance, movement, jumps, shots), hidden aiming down the sights, sprinting and for the scoped rifles',
    values: [['on', 'On'], ['off', 'Off']] },
  // the game's r_drawDecals: the map's decal layers - the world surfaces that lie on another surface (GfxSurface flag 2: signs,
  // graffiti, posters, dirt, stains, cracks; world.json groups "decal"). Off: fewer draw calls and blended layers
  { key: 'decals', label: 'World decals', live: true, url: false, title: 'The map\'s decal layers (the game\'s r_drawDecals): signs, graffiti, posters, dirt, stains and cracks painted over the walls and floors. Off: the plain surfaces underneath, and a faster view (fewer draw calls and blended layers)',
    values: [['on', 'On'], ['off', 'Off']] },
  // the game's fx_marks: the marks effects leave (fx.js addMarks / drawMarks)
  { key: 'marks', label: 'Impact marks', live: true, url: false, title: 'The marks shots and explosions leave for the round (the game\'s fx_marks): bullet holes, blood and grenade craters',
    values: [['on', 'On'], ['off', 'Off']] }
];
const known = (key, v) => GRAPHICS.find(g => g.key === key).values.some(x => x[0] === v);

function stored() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (err) { return {}; }
}

/** the setting given by the page's URL, or null */
export function urlGraphics(key) {
  if (GRAPHICS.find(g => g.key === key).url === false) return null;    // (an option without a URL parameter)
  const v = new URLSearchParams(location.search).get(key);
  return v != null && known(key, v) ? v : null;       // (?fx=on is not a value: ignored)
}

/** the effective settings: URL parameter, else the stored choice, else the default */
export function graphics() {
  const s = stored(), out = {};
  for (const g of GRAPHICS) {
    const v = urlGraphics(g.key) || s[g.key];
    out[g.key] = known(g.key, v) ? v : DEFAULTS.graphics[g.key];
  }
  return out;
}

/** remember a choice (a URL parameter still wins on pages that set it) */
export function setGraphics(key, value) {
  const s = stored();
  s[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (err) { /* not stored */ }
}
