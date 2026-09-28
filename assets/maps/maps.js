/* Map registry: every map image in assets/maps, its display name and calibration.
 *
 * - key       = raw map name of the demo (config string 0, "mapname"), e.g. mp_crash
 * - image     = file in assets/maps (the in-game compass map, 1024 x 1024; mp_cluster 512 x 512)
 * - display   = display name (Quick Overview, export file name)
 * - bounds    = the world rectangle the image covers, [x1, y1, x2, y2] as in config string 823
 *               ("compass_map_<map>" x1 y1 x2 y2). The image is placed axis-aligned: left = min x,
 *               right = max x, top = max y, bottom = min y (no rotation / mirroring).
 *               The viewer uses the rectangle from the demo itself when present; these values are
 *               the fallback. Only maps with sample demos have one - verified by overlaying the
 *               player positions of a demo on the image (docs/ANALYSIS.md, section 6).
 * - aliases   = other raw names of the same map (custom versions seen in demos)
 *
 * JavaScript instead of maps.json because fetch() is blocked on file://. Registered with
 * C4.define, so the analysis in the worker has the display names as well.
 */
C4.define('maps', function (C4) {
  'use strict';
  const MAPS = {
    mp_backlot: { display: 'Backlot', image: 'mp_backlot.png', bounds: [2896, 2616, -2400, -2680] },
    mp_bloc: { display: 'Bloc', image: 'mp_bloc.png', bounds: null },
    mp_bog: { display: 'Bog', image: 'mp_bog.png', bounds: null },
    mp_broadcast: { display: 'Broadcast', image: 'mp_broadcast.png', bounds: null },
    mp_carentan: { display: 'Chinatown', image: 'mp_carentan.png', bounds: null },
    mp_cargoship: { display: 'Wet Work', image: 'mp_cargoship.png', bounds: null },
    mp_citystreets: { display: 'District', image: 'mp_citystreets.png', bounds: [7712, 2816, 1376, -3520] },
    mp_cluster: { display: 'Cluster', image: 'mp_cluster.png', bounds: [448, 5952, -4672, 832] },
    mp_convoy: { display: 'Ambush', image: 'mp_convoy.png', bounds: null },
    mp_countdown: { display: 'Countdown', image: 'mp_countdown.png', bounds: null },
    mp_crash: { display: 'Crash', image: 'mp_crash.png', bounds: [2735, 2528, -1959, -2166] },
    mp_crash_snow: { display: 'Winter Crash', image: 'mp_crash_snow.png', bounds: null },
    mp_creek: { display: 'Creek', image: 'mp_creek.png', bounds: null },
    mp_crossfire: { display: 'Crossfire', image: 'mp_crossfire.png', bounds: [8288, 1280, 640, -6368] },
    mp_farm: { display: 'Downpour', image: 'mp_farm.png', bounds: null },
    mp_killhouse: { display: 'Killhouse', image: 'mp_killhouse.png', bounds: null },
    mp_overgrown: { display: 'Overgrown', image: 'mp_overgrown.png', bounds: null },
    mp_pipeline: { display: 'Pipeline', image: 'mp_pipeline.png', bounds: null },
    mp_shipment: { display: 'Shipment', image: 'mp_shipment.png', bounds: null },
    mp_showdown: { display: 'Showdown', image: 'mp_showdown.png', bounds: null },
    mp_strike: { display: 'Strike', image: 'mp_strike.png', bounds: [3304, 2904, -3128, -3528] },
    mp_vacant: { display: 'Vacant', image: 'mp_vacant.png', bounds: null }
  };
  // raw names in demos that differ from the image name (Promod / league versions of a map)
  const ALIASES = { mp_backlot_x: 'mp_backlot', mp_backlot_fix: 'mp_backlot' };

  /** raw map name -> registry key: exact name, alias, then the longest known prefix ("mp_crash_x") */
  function resolve(raw) {
    const name = String(raw || '').toLowerCase();
    if (MAPS[name]) return name;
    if (ALIASES[name]) return ALIASES[name];
    let best = null;
    for (const k of Object.keys(MAPS)) if (name.startsWith(k + '_') && (!best || k.length > best.length)) best = k;
    return best;
  }
  /** registry entry of a raw map name, or null */
  function entry(raw) { const k = resolve(raw); return k ? Object.assign({ key: k }, MAPS[k]) : null; }

  C4.maps = { MAPS, ALIASES, resolve, entry, IMAGE_DIR: 'assets/maps/' };
});
