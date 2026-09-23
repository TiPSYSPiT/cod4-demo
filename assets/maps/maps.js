/* Map backgrounds and calibration.
 *
 * Calibration = the world rectangle the image covers: [x1, y1, x2, y2] as in
 * config string 823 ("compass_map_<map>" x1 y1 x2 y2). The image is placed
 * axis-aligned: left = min x, right = max x, top = max y, bottom = min y
 * (no rotation / mirroring). The viewer uses the rectangle from the demo
 * itself when present; the values below are the fallback and were read from
 * the sample demos. Placement verified by overlaying 27,000-65,000 player
 * positions per map (see docs/ANALYSIS.md, section 6).
 *
 * JavaScript instead of maps.json because fetch() is blocked on file:// .
 */
window.C4MAPS = {
  mp_backlot: { image: 'backlot.png', bounds: [2896, 2616, -2400, -2680] },
  mp_crash: { image: 'crash.png', bounds: [2735, 2528, -1959, -2166] },
  mp_strike: { image: 'strike.png', bounds: [3304, 2904, -3128, -3528] },
  mp_crossfire: { image: 'crossfire.png', bounds: [8288, 1280, 640, -6368] },
  // district.png shows the same layout as citystreets.png
  mp_citystreets: { image: 'citystreets.png', altImage: 'district.png', bounds: [7712, 2816, 1376, -3520] },
  // custom map, no image available: neutral grid in the world rectangle
  mp_cluster: { image: null, bounds: [448, 5952, -4672, 832] }
};
