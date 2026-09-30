# Map geometry for sight lines (`geometry/`)

Preprocessed collision geometry of the CoD4 maps, for line-of-sight tests in the
viewer: "% target silent & unseen" of the own-kill metrics (POV tab, docs/ANALYSIS.md
3.10) tests the sight lines of the killer's team mates against it.

The data comes from the game files (clip map of the map zones). It is not part
of the public repository - see *Repository* below.

## Files

```
geometry/
  index.json               manifest: format, build parameters, one entry per map
  <map>/collision.bin      input: clip map brushes + collision triangles (float32 positions, uint32 indices)
  <map>/collision.json     input: layout of collision.bin, triangle groups by contents flags, brush entities
  <map>/sight.bvh          output: sight-blocking triangles + BVH (format C4BV v1, below)
  <map>/sight.js           output: the same bytes as base64 - the file the viewer loads
```

`sight.js` is `C4.sight.register("<map>", "<base64>")`: fetch() is blocked on
`file://`, a script tag is not (like `assets/maps/maps.js`). `--check` verifies that
it holds exactly the bytes of `sight.bvh`.

`<map>` is the raw map name of the demo (`mp_crash`, `mp_backlot_x` …). 23 maps,
all maps of `assets/maps/` plus `mp_backlot_x`.

Regenerate (standard library only, ~2 minutes for all maps):

```
cd python
py tools/build_sight_bvh.py                  all maps
py tools/build_sight_bvh.py mp_crash         one map
py tools/build_sight_bvh.py --check 100      and compare 100 sight lines per map with brute force
```

The output is deterministic (same input, same bytes); `index.json` records the
SHA-256 of the input and of every `sight.bvh`.

## Coordinates

CoD world units (1 unit = 1 inch), +Z up, right-handed, untransformed - the same
coordinates as the positions in the demos (checked: 87-92 % of 600 player
positions per map stand within 2 units above a collision floor, none inside a
solid brush; `mp_backlot_x`, `mp_strike`, `mp_crash`, `mp_crossfire`).

## What is kept

`collision.json` groups the triangles by the brush contents flags
(KisakCOD `q_shared.h`). `sight.bvh` keeps the groups that block sight and marks
the uncertain ones with a flag bit:

| Group | Contents | Kept | Flag bit |
|---|---|---|---|
| solid | `0x1` (+ detail `0x08000000`) | yes | 0 = opaque |
| terrain | clip map collision triangles (terrain, curved patches, also walls); no contents flags | yes | 4 |
| brushmodel | brushes of brush entities (doors, destructibles, scripted objects), placed at the entity origin | yes | 2 - state at a time unknown |
| glass | `0x10` | yes | 1 - see-through |
| playerclip, weaponclip, mantle | movement / bullet clip | no - does not block sight |
| nonsolid | incl. foliage brushes `0x08000002` | no |
| trigger, sky | | no |
| water | `0x20` (3 maps) | no |

Removed as well: degenerate triangles (area < 1e-6) and duplicate triangles
(faces of touching brushes; the flags of the copies are combined, opaque wins).
Vertices are shared.

**Not in the data:** static models (xmodels: trees, bushes, cars, crates,
awnings - 1,168 to 22,311 per map). The engine traces them through their own
collision (`CM_TraceStaticModel`), the dump only has their placement. Smoke is
dynamic. A line through such objects counts as free, so "unseen" from this
geometry is understated (conservative). See-through solid brushes (window
grates, fences with solid contents) cannot be told apart - no surface flags per
triangle.

## Format C4BV v1

Little endian, all section offsets 4-byte aligned (typed-array views work
directly on the `ArrayBuffer`).

Header, 64 bytes:

| Offset | Type | Field |
|---|---|---|
| 0 | char[4] | magic `C4BV` |
| 4 | uint32 | version (1) |
| 8 | uint32 | vertex count V |
| 12 | uint32 | triangle count T |
| 16 | uint32 | node count N |
| 20 | uint32 | offset of the vertices |
| 24 | uint32 | offset of the triangle indices |
| 28 | uint32 | offset of the triangle flags |
| 32 | uint32 | offset of the nodes |
| 36 | float32[6] | bounds of the root: min x, y, z, max x, y, z |
| 60 | uint32 | LEAF_MAX used for the build |

Sections:

| Section | Layout |
|---|---|
| vertices | V × float32[3] |
| triangles | T × uint32[3] vertex indices, **in leaf order** |
| flags | T × uint8 (bit 1 glass, 2 brushmodel, 4 terrain), padded to 4 bytes |
| nodes | N × 32 bytes, depth first, node 0 = root |

Node (32 bytes):

| Offset | Type | Field |
|---|---|---|
| 0 | float32[3] | bounds min |
| 12 | float32[3] | bounds max |
| 24 | uint32 | inner node: index of the right child (the left child is the next node); leaf: first triangle |
| 28 | uint16 | triangle count (0 = inner node) |
| 30 | uint16 | split axis (0 x, 1 y, 2 z) - traverse the near child first |

JavaScript views: `Float32Array(buf, offNodes, N * 8)` for the bounds,
`Uint32Array(...)` for word 6, `Uint16Array(buf, offNodes, N * 16)` for count
(index `n * 16 + 14`) and axis (`n * 16 + 15`).

## Build

Binned surface area heuristic: 16 bins along the longest centroid axis, a node
is a leaf at ≤ 8 triangles or when the split costs more than the leaf (≤ 24
triangles), traversal cost 4 (one triangle test = 1). Measured in the browser
(2000 sight lines between real player positions, `mp_backlot_x` and
`mp_strike`):

| Leaf min / max, cost | `mp_backlot_x` | Nodes | ms per sight line |
|---|---|---|---|
| 2 / 8, 1 | 9.24 MB | 169,385 | 0.0014 |
| 4 / 16, 2 | 6.34 MB | 78,795 | 0.0014 |
| 6 / 16, 3 | 5.85 MB | 63,345 | 0.0014 |
| **8 / 24, 4** (used) | **5.41 MB** | **49,685** | **0.0015** |

Same speed, so the smallest file. The earlier brute-force test with a 2D grid
needed 1.2-6 ms per sight line.

## Result

| Map | Source tris | Kept | Nodes | Depth | sight.bvh |
|---|---|---|---|---|---|
| mp_backlot | 241,309 | 196,703 | 49,487 | 27 | 5.39 MB |
| mp_backlot_x | 241,729 | 197,199 | 49,685 | 27 | 5.41 MB |
| mp_bloc | 244,957 | 207,380 | 49,031 | 27 | 5.42 MB |
| mp_bog | 103,369 | 84,910 | 22,095 | 25 | 2.39 MB |
| mp_broadcast | 165,120 | 119,677 | 30,467 | 27 | 3.32 MB |
| mp_carentan | 458,803 | 392,916 | 106,137 | 27 | 10.99 MB |
| mp_cargoship | 146,797 | 95,646 | 24,711 | 24 | 2.69 MB |
| mp_citystreets | 320,806 | 268,656 | 66,945 | 28 | 7.39 MB |
| mp_cluster | 182,933 | 140,386 | 37,037 | 24 | 3.84 MB |
| mp_convoy | 286,552 | 205,653 | 52,865 | 27 | 5.62 MB |
| mp_countdown | 161,076 | 118,266 | 33,037 | 28 | 3.43 MB |
| mp_crash | 156,807 | 113,696 | 29,273 | 24 | 3.09 MB |
| mp_crash_snow | 157,935 | 116,224 | 29,631 | 25 | 3.15 MB |
| mp_creek | 193,279 | 127,825 | 36,541 | 27 | 3.73 MB |
| mp_crossfire | 240,159 | 189,894 | 49,517 | 28 | 5.26 MB |
| mp_farm | 178,101 | 113,730 | 28,893 | 26 | 3.04 MB |
| mp_killhouse | 206,003 | 143,687 | 34,815 | 28 | 4.00 MB |
| mp_overgrown | 200,614 | 152,413 | 38,713 | 29 | 4.15 MB |
| mp_pipeline | 183,308 | 147,952 | 37,633 | 25 | 4.07 MB |
| mp_shipment | 36,351 | 17,295 | 4,445 | 20 | 0.50 MB |
| mp_showdown | 136,269 | 107,409 | 30,431 | 25 | 3.11 MB |
| mp_strike | 297,656 | 246,421 | 61,975 | 28 | 6.68 MB |
| mp_vacant | 71,453 | 37,281 | 9,587 | 22 | 1.01 MB |

Together 97.7 MB (`sight.js` 130 MB); the viewer loads one map at a time:
`sight.js` of `mp_crash` (4.1 MB) in 42 ms, `mp_strike` (8.9 MB) in 69 ms,
`mp_carentan` (14.7 MB) in 143 ms, including the base64 decoding; only the last
map is kept in memory.

## Use in the viewer

1. The analysis (worker) decides "unseen" with the view cone and collects the
   candidate sight lines: every sample of the 2 s window with the victim inside a
   living team mate's cone - the team mate's eye and the victim's feet (+8),
   chest and head (`DemoData.sightJob`, internal).
2. `main.js` loads `geometry/<map>/sight.js` (`C4.sight.load`; the map name must
   match `[A-Za-z0-9_-]`, else no geometry) and calls `C4.ownKills.applySight`:
   a kill is "seen" as soon as one line of one candidate is free. Each line is
   shortened by 4 units at both ends (eye or target touching a wall); triangles
   flagged glass or brush entity are ignored (`RULES.sightSkip`). The summaries
   are rebuilt, `sightJob` is removed.
3. `DemoData.ownKills.sight` records the method: `geometry` (map, kills tested,
   lines, kills changed from the cone verdict, ms) or `cone` with the reason (no
   file for the map). The POV tab labels the column accordingly.

The geometry can only turn a "seen" into "unseen" or unknown, never the reverse
(checked by `tools/selftest.html` on all 60 demos).

## Verification

* `--check`: every triangle in exactly one leaf, children inside their parent,
  triangle set equal to the source selection; 100 sight lines per map (eye
  height above a floor triangle → chest height above another floor triangle,
  100-3000 units, 72-99 % hit geometry): first hit of the BVH = brute force over
  all triangles in 2,300 of 2,300 lines.
* Browser (JavaScript reader, ordered traversal): 2000 sight lines between real
  player positions each on `mp_backlot_x` and `mp_strike` - first hit equal to
  the brute-force grid test in all 4,000; the 64 sample cases of the geometry
  check (clear view / wall between, 4 maps) give the same result as before.

## Repository

`geometry/` holds data extracted from the game files (≈320 MB with the input
files). It should not go into the public repository; suggested `.gitignore`
entry (repository root = `source/`):

```
# CoD4 map geometry extracted from the game files - not for the public repo
/geometry/
```
