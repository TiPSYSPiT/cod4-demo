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
    // the bomb (S&D, DemoData.bombTrack): strong orange with a light border and its own symbol
    // (diamond; carried: a small round dot) - frag grenades are a lighter orange without a border
    BOMB: {
      color: '#ff6f00',           // fill
      edge: '#fff4e0',            // light border
      carriedRadius: 3.6,         // carried: round, smaller than a player dot (PLAYER_RADIUS_PX)
      defusedColor: '#58d68d',    // defused bomb
      size: 5,                    // half edge of the icon (screen pixels)
      unknownAlpha: 0.75,         // last known position while the position is unknown (hollow, with '?')
      pulseMs: 1000,              // planted: one pulse per second (demo time)
      explodedMs: 3000,           // exploded: burst shown this long, then hidden
      hitPx: 10                   // tooltip: mouse within this distance of the icon
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
    // heatmap (heatmap.js, heatPanel.js): radius in world units, so the spots scale with zoom and map
    HEAT: {
      CELLS: 512,                 // grid cells along the longer side of the (padded) world rectangle
      PAD: 500,                   // world units added around the map rectangle (spots at the edge)
      SAMPLE_MS: 100,             // positions: one sample per living player every 100 ms
      RADIUS: { min: 40, max: 400, step: 10, def: 150 },
      INTENSITY: { min: 0.25, max: 3, step: 0.05, def: 1 },
      MIN_VALUE: 0.06,            // below this (0..1 after normalising) the colour fades out
      ALPHA_MIN: 0.12, ALPHA_MAX: 0.85,
      STOPS: [[0, [20, 60, 255]], [0.25, [0, 210, 255]], [0.5, [40, 225, 70]], [0.75, [255, 225, 0]], [1, [255, 35, 0]]],
      THROTTLE_MS: 250,           // "Up to current time" while playing: at most 4 updates per second
      STORE_KEY: 'cod4demo.heatmap'
    },
    SPEEDS: [0.5, 1, 2, 4],
    SEEK_STEP_MS: 5000,
    // team colours: CSS variables --team-blue / --team-red (styles.css), the POV's team is blue
    // (app.teamColor); the map uses them for dots, trails, view cones, death markers, markers, heatmaps
    // video export (exportVideo.js): resolutions = output height in pixels (the width follows the view)
    EXPORT: {
      MP4_HEIGHTS: [720, 1080], GIF_HEIGHTS: [360, 480], MP4_FPS: [30, 60], GIF_FPS: [10, 15], SPEEDS: [0.5, 1, 2, 4],
      MP4_BITRATE: { 720: 5e6, 1080: 9e6 },   // target bit/s at 30 fps (60 fps: x 1.5)
      // size estimates (upper end of test exports, crossfire / backlot; the map compresses well):
      MP4_SIZE_FACTOR: 0.8,                   // the encoder used 35-80 % of the target bit rate (zoomed in: more)
      GIF_BYTES_PER_PIXEL: 0.03,              // bytes per pixel and frame (measured 0.011-0.025)
      GIF_WARN_SECONDS: 30, WARN_MB: 50,      // warn above these
      KILLFEED_MS: 5000, KILLFEED_LINES: 5    // overlay: kills of the last 5 s, at most 5 lines
    },
    ROTATION_DEFAULT: 1,          // quarter turns counter-clockwise without a stored value (90° left)
    ROTATION_KEY: 'cod4demo.mapRotation.'   // localStorage key prefix, + raw map name
  };
})(window.C4);
