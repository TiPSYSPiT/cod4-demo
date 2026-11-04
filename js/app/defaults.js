/* THE defaults of the viewer's options, and the keys they are remembered under. Nothing else names a default: graphics.js and
 * view3d.js read them here, and "Reset to defaults" (the Display and Graphics popovers) goes back to them. A saved choice wins
 * over a default; only a choice is saved (see settings.js), so a default changed here reaches everyone who never chose. */
export const DEFAULTS = {
  display: {
    players: 'models',       // 'models' / 'simple'
    props: 'high',           // 'high' / 'low' / 'boxes' / 'off'
    xray: 'off',             // 'off' / 'players' / 'names'
    viewLines: false,
    rings: false,
    enemyNames: true,
    killfeed: true,
    hud: true,
    items: true,
    casings: true,
    tracers: false,
    sound: true,
    volume: 0.3
  },
  graphics: {
    lighting: 'game',        // 'game' / 'scene'
    shadows: 'on',           // 'on' / 'off'
    reflections: 'off',      // 'on' / 'off'
    fx: 'demo',              // 'all' / 'ambient' / 'demo' / 'off'
    viewmodel: 'on',         // 'on' / 'off'
    crosshair: 'on'          // 'on' / 'off'
  }
};

// localStorage: the switches 'on' / 'off', the others their value; the graphics one JSON object of the choices
export const DISPLAY_KEYS = {
  players: 'cod4demo3d.players', props: 'cod4demo3d.props', xray: 'cod4demo3d.xray',
  viewLines: 'cod4demo3d.viewLines', rings: 'cod4demo3d.rings', enemyNames: 'cod4demo3d.enemyNames',
  killfeed: 'cod4demo3d.killfeed', hud: 'cod4demo3d.hud', items: 'cod4demo3d.items', casings: 'cod4demo3d.casings',
  tracers: 'cod4demo3d.tracers', sound: 'cod4demo3d.sound', volume: 'cod4demo3d.sound.volume'
};
export const GRAPHICS_KEY = 'cod4demo3d.graphics';

/** a display switch: the saved choice, else the default */
export function displaySwitch(key) {
  let v = null;
  try { v = localStorage.getItem(DISPLAY_KEYS[key]); } catch (err) { /* default */ }
  return v === 'on' ? true : v === 'off' ? false : DEFAULTS.display[key];
}

/** forget every saved Display and Graphics choice */
export function clearOptions() {
  try {
    for (const k of Object.values(DISPLAY_KEYS)) localStorage.removeItem(k);
    localStorage.removeItem(GRAPHICS_KEY);
  } catch (err) { /* not stored */ }
}
