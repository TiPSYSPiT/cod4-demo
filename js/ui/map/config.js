/* Map tab constants. Radii and lengths are in world units (1 unit ~ 1 inch),
 * so they scale with the map; durations in milliseconds.
 *
 * Grenade effect sizes and smoke duration are NOT in the demo (the client
 * renders the effects itself); the values below are display constants.
 * Visibility is computed from demo time (detonation time from the demo), so it
 * is independent of the playback speed and of seeking. */
(function (C4) {
  'use strict';
  const SMOKE_RADIUS = 220;          // world units (was 300, -27 %); frag / flash use 120
  const SMOKE_DURATION_MS = 10000;   // smoke circle visible for exactly 10 s from the detonation
  const SMOKE_FADE_MS = 1000;        // ... fading out during the last second
  C4.mapConfig = {
    SMOKE_RADIUS, SMOKE_DURATION_MS, SMOKE_FADE_MS,
    GRENADE: {
      smoke: { color: '#a9b0b8', radius: SMOKE_RADIUS, duration: SMOKE_DURATION_MS, fade: SMOKE_FADE_MS, label: 'Smoke' },
      frag: { color: '#ff8a1f', radius: 120, duration: 1500, fade: 800, label: 'Frag' },
      flash: { color: '#ffe44f', radius: 120, duration: 1500, fade: 800, label: 'Flash' },
      concussion: { color: '#b48cff', radius: 120, duration: 1500, fade: 800, label: 'Stun' },
      other: { color: '#e0e0e0', radius: 90, duration: 1200, fade: 600, label: 'Other' }
    },
    GRAVITY: 800,                 // g_gravity default, units/s^2 (trajectory evaluation)
    TRAIL_MS: 5000,               // recent trail length
    GAP_MS: 500,                  // a data gap longer than this breaks trails and interpolation
    JUMP_UNITS: 260,              // a position jump larger than this between samples (respawn, teleport)
    STALE_MS: 1200,               // a player not sent for this long is hidden (or drawn as last known)
    LAST_KNOWN_MAX_MS: 30000,     // "last known position" is shown for at most this long
    DEATH_MARKER_MS: 5000,        // X marker at the death position
    VIEW_LENGTH: 150,             // view direction cone length
    VIEW_HALF_ANGLE: 22,          // degrees
    PLAYER_RADIUS_PX: 5.5,        // player dot (screen pixels)
    HEAT_CELLS: 240,              // heatmap grid resolution (cells along the longer side)
    SPEEDS: [0.5, 1, 2, 4],
    SEEK_STEP_MS: 5000,
    TEAM_HUES: { A: [8, 22, 36, 48, 0, 16, 30, 42], B: [205, 190, 220, 180, 232, 198, 212, 186] }
  };
})(window.C4);
