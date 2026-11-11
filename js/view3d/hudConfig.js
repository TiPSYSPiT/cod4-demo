/* The HUD's console variables (dvars) by their game names - the compass and the waypoints (hud.js) read them only from here.
 *
 * USER: the player's own settings (config_mp.cfg "seta ..."), applied as the engine applies them:
 *   waypointIconWidth / Height   DrawOffscreenViewableWaypoint (cg_hudelem.cpp 1376): virtual 640 x 480 units times
 *                                scaleVirtualToReal (x: min(height * 4 / 3, width) / 640, y: height / 480), then the
 *                                off-screen scale and GetScaleForDistance
 *   compassSize                  CG_CompassCalcDimensions (cg_compass.cpp 704): the width and height of every compass item
 *                                (its x / y stay), and the size of the icons on it
 *   compassPlayer* / Friendly* / Objective*  the icons' sizes in virtual units, times compassSize (cg_compass.cpp 1392,
 *                                1984, 1900)
 * ENGINE: the client's defaults for the dvars the drawing uses as well (cg_compass.cpp CG_CompassRegisterDvars,
 * cg_hudelem.cpp, KisakCOD). compassMaxRange: the stock map scripts set it ("setdvar compassmaxrange 1800" ...), but on the
 * server only - it is no system info dvar and the demos' system info does not carry it - so the client keeps its default. */
export const DVARS = Object.freeze({
  // --- USER (config_mp.cfg)
  waypointIconWidth: 10,
  waypointIconHeight: 10,
  compassSize: 1,
  compassPlayerWidth: 12,
  compassPlayerHeight: 12,
  compassFriendlyWidth: 10,
  compassFriendlyHeight: 10,
  compassObjectiveWidth: 14,
  compassObjectiveHeight: 14,

  // --- ENGINE defaults (cg_compass.cpp)
  compassMaxRange: 2500,                 // world units across the compass map's height (CG_WorldPosToCompass: pixPerInch = h / range)
  compassRotation: 1,                    // the map turns with the view
  compassClampIcons: 1,                  // friendlies / enemy pings held at the map's edge
  compassSoundPingFadeTime: 2,           // s: a firing ping fades over it
  compassObjectiveMaxRange: 2048,
  compassObjectiveMinAlpha: 1,           // (objectives stay at alpha 1 at any distance)
  compassObjectiveDrawLines: 1,          // lines to an OBJST_CURRENT objective (the MP scripts set "active" ones only)
  compassTickertapeStretch: 0.5,         // the share of the tape (of 360 degrees) the tickertape shows

  // --- ENGINE defaults (cg_hudelem.cpp)
  waypointOffscreenPointerWidth: 25,
  waypointOffscreenPointerHeight: 12,
  waypointOffscreenPointerDistance: 30,
  waypointOffscreenDistanceThresholdAlpha: 30,
  waypointOffscreenPadLeft: 103,
  waypointOffscreenPadRight: 0,
  waypointOffscreenPadTop: 0,
  waypointOffscreenPadBottom: 30,
  waypointOffscreenRoundedCorners: 1,
  waypointOffscreenCornerRadius: 105,
  waypointOffscreenScaleLength: 500,
  waypointOffscreenScaleSmallest: 1,
  waypointDistScaleRangeMin: 1000,
  waypointDistScaleRangeMax: 3000,
  waypointDistScaleSmallest: 0.8,
  waypointTweakY: -17,
  waypointPlayerOffsetProne: 30,
  waypointPlayerOffsetCrouch: 56,
  waypointPlayerOffsetStand: 74,
});

/** the viewer's stand-in for what it cannot know: a firing ping stays at full alpha for the length of the fire sound
 *  (CG_CompassAddWeaponPingInfo: SND_GetKnownLength), then fades over compassSoundPingFadeTime - the sound's length is not in the
 *  export, so the fade starts at the shot */
export const PING_HOLD_MS = 0;

/* The compass items (virtual 640 x 480 units, aligned left / top: rect ... 1 1). The stock menu as compiled into common_mp.ff
 * (ui_mp/compass_old.menu: menudef.h MINIMAP_X_MP 4, MINIMAP_Y_MP 7, MINIMAP_W_MP / H_MP 102, COMPASS_SIZE_MP 125, item origin
 * 2 11); Promod's ui_mp/hud.menu "Compass_old" has the same items with MINIMAP_ORIGIN 6 6. */
const X = 4, Y = 7, W = 102, H = 102, SIZE = 125;
const items = ([ox, oy]) => ({
  back: [X - 14 + ox, Y - 6 + oy, SIZE, SIZE],              // minimapBG            CG_PLAYER_COMPASS_BACK     minimap_background
  tickerBorder: [X + ox, Y - 15 + oy, W, 14],               // minimapTickerBorder  CG_PLAYER_COMPASS_BACK     minimap_tickertape_background
  ticker: [X + ox, Y - 12 + oy, W, 9],                      // minimapTicker        CG_PLAYER_COMPASS_TICKERTAPE_NO_OBJ  minimap_tickertape_mp
  map: [X + ox, Y + oy, W, H],                              // mini_map, compasspointers, compassfriendlies, compassenemies, compassplayer
});
export const COMPASS_MENU = Object.freeze({ stock: items([2, 11]), promod: items([6, 6]) });
