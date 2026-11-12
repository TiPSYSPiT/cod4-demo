/* THE defaults of the viewer's options, and the keys they are remembered under. Nothing else names a default: graphics.js and
 * view3d.js read them here, and "Reset to defaults" (the Display and Graphics popovers) goes back to them. A saved choice wins
 * over a default; only a choice is saved (see settings.js), so a default changed here reaches everyone who never chose. */
export const DEFAULTS = {
  // the 3D camera at the start: 'fp' = first person of the demo's POV (the recording player, or the player they followed
  // then); fallback: when the demo has no POV to look through (no player state in it) - the overview over the players'
  // area, without a message
  camera: { mode: 'fp', fallback: 'orbit' },
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
    specular: 'off',         // 'on' / 'off' (Specular Lighting: the game's r_specular)
    fx: 'demo',              // 'all' / 'ambient' / 'demo' / 'off'
    viewmodel: 'on',         // 'on' / 'off'
    crosshair: 'on',         // 'on' / 'off'
    decals: 'off',           // 'on' / 'off' (World decals: the game's r_drawDecals)
    marks: 'on'              // 'on' / 'off' (Impact marks: the game's fx_marks)
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
export const CAMERA_KEY = 'cod4demo3d.camera2';     // the camera mode, stored only by the viewer's own choice

/** a display switch: the saved choice, else the default */
export function displaySwitch(key) {
  let v = null;
  try { v = localStorage.getItem(DISPLAY_KEYS[key]); } catch (err) { /* default */ }
  return v === 'on' ? true : v === 'off' ? false : DEFAULTS.display[key];
}

/** forget every saved Display and Graphics choice and the camera mode */
export function clearOptions() {
  try {
    for (const k of Object.values(DISPLAY_KEYS)) localStorage.removeItem(k);
    localStorage.removeItem(GRAPHICS_KEY);
    localStorage.removeItem(CAMERA_KEY);
  } catch (err) { /* not stored */ }
}
