# CoD4 Demo Viewer

A single-page replay viewer for **Call of Duty 4: Modern Warfare** (2007) demos (`.dm_1`,
stock CoD4 and CoD4X). Drop a demo on the page and watch the match top-down in **2D** or in
the **real map in 3D**. Toggle between the two at any time: the time, the selected player and
the filters stay as they are.

The demo is parsed in your browser (a Web Worker). Nothing is uploaded. The site is plain
HTML, CSS and JavaScript with no build step, and it runs on GitHub Pages. three.js (r170) comes
with the project in `vendor/` (see [vendor/README.md](vendor/README.md)), so it also runs offline;
nothing is loaded from other sites (the fonts, Inter and JetBrains Mono, are in `assets/fonts` too).
The 3D maps are prebuilt once with a Python script from your own game files.

![The 3D view: following a player on mp_strike](docs/screenshots/redesign/after/3d.webp)

![The 2D view of the same moment](docs/screenshots/redesign/after/2d.webp)

More: [the option popovers, the match details, the export dialogs and smaller screens](docs/screenshots/redesign/after/),
and the [UI before the redesign](docs/screenshots/redesign/before/).

---

## Run it locally

ES modules (needed for three.js) do not work from `file://`, so serve the folder:

```
cd cod4-demo3d
py -m http.server 8765
```

Open <http://127.0.0.1:8765/> and drop a `.dm_1` file on the page (or use **Open demo**).
Deep links work too: `index.html?demo=demos/my.dm_1&view=3d&t=300&focus=name` loads a demo
served from the same folder, opens the 3D view at 5:00 and selects the first player whose
name contains "name".

Tested with Chrome / Edge. Any browser with WebGL 2 and ES modules should work.

If the 3D view can't start, the page says why and stays in 2D. A failed module load is checked
file by file (`js/app/moduleCheck.js`: the browser itself only says "Failed to fetch dynamically
imported module" for any missing file of the chain): the message names the file that is not on the
server (HTTP 404, e.g. *js/view3d/graphics.js is not on the server - imported by js/view3d/view3d.js*),
is not served as JavaScript, or cannot be reached (three.js: the `vendor/` folder not served, or the
CDN unreachable if you switched the import map to the CDN alternative noted in `index.html`); when
every file downloads, the module that is broken (a syntax error, a missing export). The 3D view's
own start errors keep their message; the full stack trace is in the browser console.
`py -m http.server` sends no cache headers, so after updating the files a browser may keep old
copies: reload with `Ctrl+F5` if the page behaves oddly.

## Using it

The view fills the window; the panels float over it ("Minimal / clean", the design of
[cod2-demo](https://github.com/TiPSYSPiT/cod2-demo) and of `design-proposals/02-minimal-clean`).
Every choice below is remembered in the browser.

**Shared by both views**

| Part | What it does |
|---|---|
| Top bar | The file name, the **2D / 3D** toggle (key `V`), **Match details** (chart icon: scoreboard, round by round, chat, events), **Export JSON** (file icon), the GitHub link, **Open demo** |
| Score pill | Top centre: the teams (▲ the POV's team in blue, ◆ the other in red - the shapes tell them apart without the colours), the score at the playback time, the round and its time, map and mode |
| Rail | The icon bar on the left; each icon opens a popover (`Esc` or a click outside closes it). **Layers**: names, trails (5 s), kill lines, last known position, grenade types (smoke / frag / flash). The view's own popovers follow (2D: **Heatmap**; 3D: **Camera**, **Display**, **Graphics**, below). **Match info** at the bottom: **Show final score** (the result and the halves), map, mode, ruleset, server, POV, length, record date, protocol (`≈` marks heuristic values - hover one for how it was derived), the map data (file, triangle counts, load time) and the keyboard shortcuts |
| Drawer | On the right, hideable (the panel icon), its two sections foldable. **Teams**: round, status, side, score and the players alive (bars) per team; per player the weapon in hand (its icon) and K / D up to now. **Click a player to select them** (highlighted in 2D and 3D; the 3D follow and first-person cameras use the selection; also with `Tab` and `Enter`). The eye shows or hides a player, the team name the team, *All* / *None* everyone, the chart icon opens the player's stats. **Kill feed & bomb**: kills (attacker, weapon icon, headshot, victim) and plant / defuse of the range; the entry at the playback time is highlighted and kept in view, later ones are dimmed; click one to jump to 2 s before it |
| Player bar | At the bottom: ⏪ / ⏩ 5 s (`←` / `→`), play / pause (`Space`), the time (under it the round and its time), the timeline - the rounds as segments (underlined in the winner's colour once played), kills as ticks (the blue team's above, the red team's below), bomb plants (orange) and defuses (green), halftime lines; drag to scrub, strat time is skipped -, **Range** (whole match or one round), the speed (0.5–4×), **[ ]** the start / end of an export range at the current time (keys `I` / `O`; again to clear), **Export video** (MP4 / GIF of the 2D or the 3D view, below) |
| Match details | The cod4-demo tabs over the view. Clicking a kill or bomb event closes the overlay and jumps there |

Warnings about the demo appear as toasts under the score pill (each one can be dismissed). Below a
window width of 1100 px the page becomes one column: the view, the player bar under it, the drawer
below.

**2D:** the in-game compass image placed with the world rectangle from the demo (config
string 823). It shows players with team colours, names and view cones, trails, kill lines,
death crosses, grenade arcs and clouds, and the bomb (S&D). Wheel zooms, dragging pans,
double-click resets. `Q` / `E` rotate the map in 90° steps (the map tools bottom right: zoom and
rotation). The **Heatmap** popover (rail) offers positions, kills, deaths, grenade landings, smokes and shots, filtered by team,
side and player. Its video export (*Export video*: MP4 / GIF of the 2D map, with an overlay of
round, score and the kill feed) draws the kill feed with the same weapon icons as the 3D one.

**3D:** the map geometry from the game files (textures and baked lightmaps, shaded with the
formulas of the game's own compiled shaders: the lightmaps' light direction with the normal maps,
the sun on the sun's surfaces, reflections and the sun's highlight; the sun's shadow map lets the
players cast shadows), the map's sky, the effects - the map's ambient ones (smoke, fire, dust,
falling paper, rain, insects: its own effect placements) and the demo's (grenade and rocket
explosions, smoke grenade clouds, flashbangs, blood, muzzle flashes, the bullets' impacts and
holes on the walls (also where a bullet comes out of a wall), scorch marks, debris such as glass
shards, wood splinters and the spent smoke grenade, the shell casings of every shot, the smoke trails
of rockets and launched grenades, scripted effects such as the bomb and the burning barrels), played
like the game's effect system at the demo time, bouncing off the world and the props,
their lights lighting the world and the players (**Graphics** popover: *Effects* All / Map only / Demo only / Off; `?fx=off` / `ambient` / `demo` in the URL does the same), the props
(static models: trees, cars, crates, …) with their real geometry, colour maps and vertex colours
(foliage's tint and shading; a tree's shadow-caster cards only cast the sun's shadow, as in the game;
the ground decals fade by their vertex alpha - see [docs/asset-audit.md](docs/asset-audit.md);
`?audit=1` colours every asset (also the effects' sprites) by the audit's status and names the one you click, `&cam=x,y,z,yaw,pitch`
opens the free camera there), the map's
script models (destructible cars, the gametypes' objects such as the bomb case, mirrors and
corkboards the scripts spawn) in the state the demo records - an exploding car jumps, tilts and is
swapped for its burnt-out model, and stands intact again after the next round start; the cars
stop bullets and debris with their own collision surfaces where they stand at that moment - and the
bomb sites A / B. The **Props** selector (Display popover) switches between *Models* (LOD 0), *Models (low detail)*
(each model's lowest LOD), see-through *Boxes* of the model bounds (foliage green) and *Off*. The
Match info popover shows the triangle counts and load times. Players are capsules in the team colour:
standing, crouched or lying prone, with an aim line using their real pitch. Kill lines,
death crosses, grenade arcs, smoke clouds and the bomb are drawn too. The **kill feed** (Display popover:
*Kill feed*, on by default, remembered) shows the kills and bomb plants / defuses of the last 5 s of
the round under the score pill, left of the drawer, newest at the bottom, like the game's obituaries: killer, weapon icon,
headshot icon, victim in the team colours, the drawer's icons and rules (suicide, falling, car,
knife, grenades; a *Teamkill* / *Bomb* tag; a weapon without an icon by name), on a dark row that
stays readable over bright maps. Entries fade out over their last 0.8 s; the feed depends only on
the replay time, so pausing, seeking and the speed need nothing special. *Kill icons* (off by
default) puts the weapon icon over each death cross. Cameras (`C` cycles):

**Sound** (Display popover: *Game sounds* and the volume, remembered; the browsers start audio only
after a click, `?sound=off` in the URL leaves it out): the game's sounds, played with the replay
and heard at the camera - every player's shots, reloads, weapon raises, melee, footsteps, jumps and
landings on the surface they stand on (quieter with *specialty_quieter*, as in the game), the bullet
impacts (the demo's on players and the traced ones on the world, also where a bullet leaves a wall),
bullets passing close by the camera (the game's whizby: within 140 units of a shot's path),
grenade bounces and explosions by surface, and what the server plays: the bomb's plant, ticking and
explosion, quick chat, burning and exploding cars (`EV_SOUND_ALIAS`, the entities' loop sounds), the
POV's own local sounds (the announcer, the hit marker), the map's createfx loop sounds (wind,
insects, machines) and the ambient track when the server sets one. Each sound is played as the
game's sound system does it (`SND_PlaySoundAlias`): one of the alias's variants at random by its
probability, its volume and pitch ranges, not started beyond its maximum distance, the distance
attenuation of its falloff curve, panned left / right by the camera; in the first-person camera the
followed player hears his own shots and steps (the `_plr` aliases). Seeking, pausing and the
playback speed (0.25-4×, pitched) keep it in step; a sound that started just before the new
position plays from its middle.

| Camera | Controls |
|---|---|
| Orbit | Left drag rotates, right drag pans, wheel zooms. Click a player to select them |
| Free fly | Drag to look, `W A S D` to move, `R` / `F` (or `E` / `Q`) for up / down, `Shift` for fast, wheel sets the speed |
| Follow player | Travels with the selected player (or the POV's followed player). Drag to turn around them |
| First person | The selected player's eyes with their view angles |

**X-Ray** (Display popover or key `X`, remembered): *Off*, *Players* - the living players behind walls,
props and smoke as a translucent silhouette in the team colour with a brighter rim (the selected player
in orange), in both player modes and every camera (in first person not the camera's own player); what
is in sight keeps its normal look, also the visible part of a player half behind a wall - or *Players
+ names*: also every living player's name (even with Layers → Names off); a player of whom nothing is in
sight gets his name on a badge in the team colour with the team's shape (▲ / ◆), and names that would
overlap are moved apart. The players hidden with the eye, the team name or *None* stay hidden. Dead
players, grenades and the bomb are not shown through walls. The technique: after the frame two passes
over the players only - their visible surface marks the stencil, then their hidden parts (depth test
"greater", stencil not marked) are drawn translucent; one occlusion query per player decides the badge.
Cost: 0.3-0.6 ms of GPU time per frame at 1920 × 1080 with 8 players (NVIDIA T400; ~13 ms without).
The 3D video export has an *X-Ray* option, by default the view's mode, so the video looks like the view
(silhouettes, badges and the moved names).

**Players: Simple / Models** (Display popover, remembered): *Simple* draws the capsules described
above. *Models* draws each player's real character:
- body and head exactly as the demo records them (client state); on the six demo maps USMC vs
  Arab OpFor, switching at halftime
- animated with the animations the game itself played: every player sample of the demo carries
  the player's legs and torso animation (the entity's `legsAnim` / `torsoAnim`). The legs
  animation drives the whole body (idle, aim, walk, run, sprint, crouch, crawl, jumps and
  landings, mantles, stance changes, bomb plants, grenade throws ...), a torso animation (fire,
  reload, melee, grenade) plays over the upper body. Pistols, the RPG and grenades have their own
  sets, as in the game. Moving animations play at the game's rate (measured speed / the
  animation's move speed, clamped like the game). Changes blend
  like in the game: over the blend time of `mp/playeranim.script`, else 120 / 170 / 250 ms by
  movement and at least 400 ms while the stance changes
- turned like in the game (`js/view3d/controllers.js`): the legs follow the view or the movement
  direction with the game's tolerance and swing speed, the spine and neck turn the upper body back
  to the view; the torso pitches with the view pitch; lean (`leanf`) rolls and shifts the torso;
  prone players tilt with the slope (`fTorsoPitch` / `fWaistPitch`)
- deaths: the demo's corpse entities play the death animation the server chose and stay until
  the round ends (a body that was already lying when the recorder first saw it shows the end
  pose, as in the game); a kill whose corpse the demo does not hold falls with a death clip chosen
  from the movement for as long as the death markers are shown (5 s)
- the weapon in the hands (the world model of the weapon the demo says they hold, with the
  silenced and grenade-launcher variants)
- lit like in the game (`js/view3d/lighting.js`): the map's light grid at the player's lighting
  origin (a directional "ambient cube" per grid point, trilinear between the 8 points around the
  player, with the game's sight traces against the map's collision model for the points it
  flags) plus the sun where it reaches them - dark in a dark room, sunlit on a roof. Props get
  the same lighting per placement. Normal maps shape the light, specular maps add the sun's
  highlight and the reflection of the map's reflection probes (the probe the game picks: the
  nearest probe of the player's DPVS cell). The world reflects its probes too, and its normal
  maps shade the baked light with the light direction stored in the lightmaps. All of it uses the
  formulas of the game's own shaders, read from the compiled shaders in the fast files
  (`tools/export/d3dshader.py`). The sun's shadow map: players, the world and the props cast
  shadows, as in the game. The **Graphics** popover (rail, 3D) switches the *Lighting* (Game /
  Simple: the plain scene lights), the *Sun shadows*, the *Reflections* and the *Effects*; a change
  reloads the 3D map (time, selection and the other options stay) and helps slow graphics cards.
  The same in the URL, which wins for that page: `?lighting=scene`, `?reflections=off`, `?shadows=off`, `?fx=off`;
  `?maps=off` drops the normal / specular maps. `?shadows=off` drops the
  shadow maps (the sun's near and far partition, and the lamps' maps: the 4 lamps the game would
  pick, faded in and out like the game). The light grid is read as the game reads it: its full 56-colour block per grid
  point (a 4 × 4 × 4 volume texture), the primary light the game picks (the sun or a lamp, with the
  light's falloff and cone) and its visibility; the map's lamps light the world too; detail maps
  and the fog the server sends (config string 9; none in the sample demos)
- a team-coloured ring at the feet

Animation and weapon follow the demo time, so seeking, pausing and the playback speed always
show the same frame. Samples without animation state fall back to a choice from the movement
(speed, direction, stance); without the exported animations (`maps3d/_characters/anims.*`) the
static stance poses of Phase 1 are used. The clips a demo uses are loaded when *Models* is
switched on.

Labels, selection, aim line, kill lines and all cameras work as in Simple; in first person the
followed player's own model is hidden. A player whose model is missing, or who is not currently
sent by the server, is drawn as a capsule, with a notice when models are missing.

| Player models | |
|---|---|
| Supported | the real body + head per player and time (42 models of USMC, SAS, OpFor, Spetsnaz/OpForce), skeleton + skin weights (up to 4 bones), colour maps; the game's own legs / torso animation of every sample (242 player animations of the game: locomotion, jumps, mantles, stance changes, fire, reload, melee, grenades, bomb plants, deaths; rifle, pistol, RPG and grenade sets) with the game's blend times; the game's angle controllers (leg yaw, torso yaw / pitch, neck / head, lean, prone slope); corpses with the server's death animation; 52 world weapon models |
| Not supported (yet) | mounted turret animations (not in `common_mp.ff`); of the effects: the elements of the class "emission" (14 elements; no spawn path found in the game's code), the game's physics for the 25 elements that use it (they bounce like the others) |
| Not drawn, as in the game | scopes, red dots and grips on the weapons in third person: the game has no world models for them (only silenced and grenade-launcher variants, which are drawn) |

| Sound | |
|---|---|
| Supported | 1,433 shared aliases (weapons, impacts and footsteps for all 29 surface types, explosions, the announcer and quick chat of the four factions, the gametypes' sounds) + 53-75 per map; shots, weapon handling, footsteps / jumps / landings, bullet impacts (entry and exit), bullets passing by (whizby), grenade bounces and explosions, the server's sound alias events and loop sounds, the POV's local sounds, createfx loop sounds, the ambient track; random variant / volume / pitch, distance and falloff curve, restricted channels, secondary and chain aliases, master / slave ducking (the announcer and quick chat lower impacts and footsteps), random start points; the MP4 export and the WebM fallback |
| Not supported (yet) | the effects' sound elements (8 in all maps, half of them unnamed); Promod's own sounds (`promod_planted` ...) are not in the stock files. The game's 3D positioning is done by its sound library (Miles), whose mixing is not public: here stereo panning by the direction. The game sets no reverb in multiplayer (no reverb command in any sample demo) |
| Silent, as in the game | the aliases that play the game's `null.wav` (e.g. the exits of large-calibre bullets) |

Cost (NVIDIA T400): 10 animated players with weapons take ~2 ms per frame instead of ~1.2 ms
with capsules; animating is ~0.07 ms per character. Switching *Models* on loads the models and the
demo's clips in 0.5-0.8 s locally. Details, a 42-character test and the flicker check:
[docs/validation.md](docs/validation.md#player-animations-3d).

Maps without exported data fall back to the compass image as a ground plane, and the view
says so.

**Video export (3D).** *Export video* in the 3D view opens a dialog:

| Option | Choices |
|---|---|
| Range | the timeline selection (the **[ ]** markers), the current round, or around a kill (any kill of the range; seconds before / after) |
| Format | MP4 (H.264) or GIF |
| Resolution | 1920 × 1080, 1280 × 720, 854 × 480 or the current viewport (GIF: 854 × 480, 640 × 360, 480 × 270, viewport) |
| Frame rate | 60 / 30 / 15 fps (GIF 15 / 10) |
| Speed | 0.5×, 1×, 2× |
| Quality | MP4: high / medium / low bit rate; GIF: 256 colours with or without dithering, 128, 64 colours |
| Camera | the view's current camera mode and position (orbit, free, follow, first person) with the selected player, and Simple / Models |
| Overlays | name labels (and bomb site letters), kill feed (with the weapon icons, as in the view), bomb / kill markers in the scene (with the weapon icons when *Kill icons* is on), score and timer, a title (map, mode, round) |
| Sound | the game's sounds at the export's camera (MP4; the WebM fallback too; not GIF) |

Before it starts, the dialog shows the size, frame count, video length, an estimated file size and
the file name (e.g. `mp_strike_sd_round02_YYT-VICTORVONDOOM-kill.mp4`), and warns about large GIFs.
The video is rendered offline, frame by frame: every frame advances the demo time by speed / fps,
the scene is rendered at the chosen size (independent of the window) and copied onto a canvas
where the overlays are drawn. So the video plays smoothly at its frame rate even when the computer
renders a few frames per second. Before the first frame, the export walks once over the range so
that every model, animation, effect and texture it needs is loaded. While it runs, the view shows
the frames as a preview, with a progress bar, the time left and *Cancel*. Afterwards (or on
cancel) the replay is back at its time, camera, selection and display settings.

Encoding: MP4 with the browser's WebCodecs `VideoEncoder` (H.264) and a small MP4 writer of this
project (`js/c4/ui/map/mp4mux.js`); GIF with this project's GIF encoder in a Web Worker
(`js/c4/ui/map/gifenc.js`, per-frame palettes, optional Floyd-Steinberg dithering). Neither needs a
library. Without H.264 in WebCodecs the browser's `MediaRecorder` records WebM instead, in real
time; the dialog says so. The sound of an MP4 is rendered after the frames, for the camera of
every frame: `js/view3d/sound.js` places every sound of the range in an `OfflineAudioContext`
(48 kHz stereo, the volume and panning following the camera path), and WebCodecs `AudioEncoder`
encodes it (AAC-LC 160 kbit/s, else Opus) into the MP4's audio track. The WebM fallback records in
real time, so it takes the live sound: played frame by frame for the export's camera into the
recording's audio track (Opus) instead of the speakers. GIF is silent.

| Browser (tested 2026-10) | MP4 (H.264) | GIF | Notes |
|---|---|---|---|
| Chrome 155, Edge 155 | yes, with AAC sound | yes | |
| Firefox 158 | yes, with Opus sound (no AAC encoder) | yes | rendering about 1.5 × slower than Chrome on the same machine |
| Browsers without WebCodecs H.264 (e.g. older Firefox) | WebM via MediaRecorder, recorded in real time | yes | the WebM has no duration in its header, and a computer that renders slower than the frame rate makes it longer and uneven ([docs/validation.md](docs/validation.md#video-export-3d)) |
| Safari | not tested | not tested | |

Speed on an NVIDIA T400: 27-55 ms per frame at 720p (Chrome / Edge), 45-85 ms in Firefox -
a 36 s round at 1280 × 720, 30 fps takes 40-55 s. Test results:
[docs/validation.md](docs/validation.md#video-export-3d).

## What a demo contains (and does not)

A client demo is the recording player's network view. Other players only exist while the
server sent them, so positions have gaps: stale players are hidden, or drawn hollow with
"last known position". Health and damage are only known for the recording player. The
grenade thrower is not in the demo. The weapon of a headshot kill is derived. Sabotage has
no sample demo, so bomb events are shown for S&D only. Details:
[docs/findings.md](docs/findings.md) and cod4-demo's `ANALYSIS.md`.

## Validation

All 69 sample demos (32.8 hours, 6 maps) pass the validation in
[docs/validation.md](docs/validation.md):
- every playing client (692) has a player model, and none is missing
- all 1.59 million samples of living players play the game's own animation of the sample (legs /
  torso), whose stance matches the stance flags in 99.9 %; every firearm held has a weapon model;
  11,531 of 11,532 deaths are animated, 11,348 of them with the demo's corpse entity
- no flickering of the player models: a frame-by-frame probe over all demos (play, pause,
  scrubbing, all camera modes) finds no model / capsule flips, no reversing pose jumps and no
  degenerate skeletons; the game's angle controllers give finite angles on all 1.59 million
  samples
- 0 parse failures and 0 errors
- no duplicate kills, and round wins equal the final and server scores
- no position outside the compass rectangle
- 83-88 % of all live positions standing on a world or prop surface of the 3D map, 0.5-1.3 % on a
  script model (the cars, in the state the demo records); 6.8 % of the traced bullet hits land on a car, 4.4 % of the traced shots stop at a player's hit boxes (in the animated pose), and 28.3 % of the server's flesh impacts have a traced shot that a player stops (the recorder's own shots: 41.5 %)
- sound: 99.9 % of 244,004 shots, all 612,909 footsteps, 96.7 % of the traced world impacts (the
  rest are silent in the game too) and all 48,672 server sound events play an exported alias; every
  audio file decodes
- the map assets of the 6 maps against the game's data ([docs/asset-audit.md](docs/asset-audit.md),
  `tools/audit/asset_audit.py`): no box fallbacks, no mirrored placements; after the fixes (image
  references and image names by reference, shadow casters, vertex colours, decal alpha, normal maps,
  transparent texels, material handles - local shifts and other zones -, the canvas alpha, wavelet
  images, textures from other zones, chains placed between their neighbours, geometric twins) 100 % of
  the static models, 99.2 % of the world materials (the rest: the HDR portals, which draw nothing) and 99.8 % of
  the script models are ok - before 61 %, 89 % and 48 %; materials the game never draws (no lit or
  emissive technique, e.g. `wc/caulk_shadow`) are hidden, and the bombsites' brush models, which the
  parser had named after unrelated XModels (a flag floating at mp_strike's site A), are not drawn;
  every blend mode is drawn with the game's own factors (`js/view3d/blend.js`: the floodlight beams in
  front of mp_citystreets' mosque were black panels), and a texture that fails to load is drawn neutral
  grey with a warning, never black

The report also lists the known issues (map changes during a recording, recordings that start
mid-match, three deaths without a killfeed entry) and the performance before and after the real
props. Re-run it with `tools/validate/validate.html` (see the report for the command).
`tools/validate/export3d.html` tests the 3D video export (9 cases: kill clips as MP4 and GIF, a
whole round, a timeline selection, Simple and Models, follow / free / first-person cameras, the
WebM fallback, cancel). Each file is decoded again and checked for length, frame count,
black or flickering frames, and the replay state afterwards; the MP4's sound track is decoded too
(length, loudness), and the WebM fallback's Opus track. It passes in Chrome, Edge and Firefox (sound: AAC in Chrome, Opus in Firefox).

## Exporting the 3D maps (Python)

`tools/export/export_maps.py` reads the map fast files of a CoD4 install and writes
`maps3d/`. It needs **Python 3.10+** and **Pillow with WebP** (`pip install pillow`). There
is no other dependency: the fast file parser is a copy of cod4-ff in `tools/export/cod4ff`
(with small changes: materials keep their state bits and constants, the GfxWorld and clip map
readers keep the reflection probes and the collision AABB trees / partitions).

```
py tools/export/export_maps.py --game "C:/Games/Call of Duty 4"                  all mp_*.ff
py tools/export/export_maps.py --game "C:/Games/Call of Duty 4" --map mp_strike  one map
```

| Option | Meaning |
|---|---|
| `--game DIR` | The install folder (with `zone/<language>/` and `main/`). Usermaps in `usermaps/<map>/<map>.ff` (e.g. `mp_backlot_x`, `mp_cluster`) are found too, with their own `.iwd` |
| `--map NAME` | Only this map (repeatable) |
| `--usermaps` | All custom maps of `usermaps/` (see "Custom maps" below) |
| `--minimap-only` | Only the 2D maps: `minimap.json` of each map, the compass image and the registry of the custom maps |
| `--out DIR` | Output folder (default `maps3d/` in the project) |
| `--tex-size N` | Maximum texture edge in pixels (default 512) |
| `--map-tex-size N` | Maximum edge of normal and specular maps (default 256) |
| `--force` | Re-encode textures that are already in the shared cache |
| `--force-models` | Re-export the player and weapon models even if they are up to date (their materials) |
| `--fx-only` | Only the effects: each map's `fx.json`, the shared `_fx/common.json` and the effects' debris models in `_characters/` (and the textures of their materials) |
| `--prop-collision` | Only the props' collision triangles of each map (`props_coll.bin`, the `collision` entry of `props.json`) |
| `--script-models` | Only the script models of each map (`entities.json` → `scriptModels`, their models in `_characters/`, their collision `script_coll.bin`) |
| `--characters-only` | Only the player models (body / head) of each map, with their hit boxes |
| `--sounds-only` | Only the sounds: `maps3d/_sound/aliases.json`, each map's `sounds.json` and the audio files in `maps3d/_sound/` |
| `--force-sounds` | Re-encode the audio files that are already in `maps3d/_sound/` |
| `--lightgrid-only` | Only the lighting data of each map: `lightgrid.bin`, `sight.bin`, `probes.webp`, `cells.bin`, `lightmap<N>_secondary/_primary.webp`, `sky.webp`, the sun and their entries in `world.json` |
| `--anims-only` | Only the player animations and weapon models of `common_mp.ff` |

### Custom maps (usermaps)

A custom map is a folder `usermaps/<map>/` in the game folder with `<map>.ff` (the map),
`<map>_load.ff` and `<map>.iwd` (its images and sounds); whatever it does not bring itself comes
from the stock files (`main/*.iwd`, `common_mp.ff`), as in the game. To add one:

1. Put the folder into `<game>/usermaps/` (e.g. `mp_coastal/mp_coastal.ff` + `.iwd`).
2. Export it - in 3D and 2D, one command for all custom maps, no code to change:

```bash
py tools/export/export_maps.py --game "C:/Games/Call of Duty 4" --usermaps
```

3. Check it - without a demo of the map: `tools/validate/mapcheck.html?map=<map>` shows the 3D map from
   above under its compass image and tests every spawn point and bomb site (on the floor of the 3D map,
   inside the 2D map); with demos: `tools/validate/validate.html`. And the assets:
   `py tools/audit/asset_audit.py --game ... --map <map>`.
4. Deploy as below (push, then `py tools/check_deploy.py check --url ...`).

The 2D map: the export reads the map's script (`maps/mp/<map>.gsc`: the compass material of
`setupMiniMap`) and entity string (the two `minimap_corner` entities, `northyaw`) and computes the
rectangle the game's `maps/mp/_compass.gsc` sends as config string 823 - for the six maps with demos it
is exactly the demos' rectangle. The compass image comes from the map's `.iwd` (`assets/maps/<map>.png`);
maps the hand-written registry `assets/maps/maps.js` does not know are listed in the generated
`assets/maps/usermaps.js` (display name from the map name: custom maps carry no localized name). The
player models follow the demo, as on every map (the map script's teams, e.g. Russians against OpFor on
mp_manorhouse, are only what the server uses). Added this way: **mp_coastal** (Coastal),
**mp_manorhouse** (Manorhouse), **mp_marketcenter** (Marketcenter) - see docs/validation.md
("Custom maps without a demo").

Per map it writes:

- `minimap.json`: the 2D map - compass material and image, the world rectangle (`bounds`, as
  config string 823), the corners and `northyaw` it comes from
- `world.bin/json`: positions, normals, vertex colours, UVs, lightmap UVs, the reflection probe
  of each vertex and indices, with one draw group per material and lightmap (alpha test, blend
  and culling come from the material state bits; normal and specular map and the reflection
  constants `envMapParms` of the material)
- `lightmap<N>.webp` (a composite for the scene lighting) and the game's own lightmaps as its
  shaders read them: `lightmap<N>_secondary.webp` (RGBA, two layers: light without / with
  direction, the direction in alpha) and `lightmap<N>_primary.webp` (the sun's visibility,
  lossless); `world.json` carries the sun as the shaders get it (`sunDiffuse`, direction)
- `lightgrid.bin` (model lighting, below), `sight.bin` (the brushes and terrain triangles that
  block the light grid's sight traces), `probes.webp` (the reflection probes: a row of six
  64 × 64 cube faces per probe) and `cells.bin` (the DPVS cell tree with each cell's probes)
- `props.bin/json`: static model placements plus the model geometry (LOD 0 and the lowest
  LOD) with one material and colour map per surface, see below; `props_coll.bin`: every prop
  model's collision triangles with their surface types (what the game's bullet traces hit: a
  palm tree only its trunk, grass nothing), for the 3D view's bullet and debris traces (only these:
  `--prop-collision`)
- `sky.webp`: the six faces of the map's sky cube (the GfxWorld's sky image from the `.iwd`)
- `fx.json`: the map's effects - the createfx placements (`maps/createfx/<map>_fx.gsc`), the
  map's impact table (which effect a bullet or grenade makes on which surface) and every effect
  definition of the map zone, with their materials (`tools/export/fx_export.py`, below); the effects
  of `common_mp.ff` the demos play (weapons, impacts, gametypes) are in the shared
  `maps3d/_fx/common.json`
- `entities.json`: spawns, bomb sites and the script models (`script_model` entities of the map's
  entity string: model, origin, angles, `targetname`, `destructible_type`) with each model's
  bounds; the models themselves (kind `script`) in `_characters/`: the map zone's own models, the
  script models' and those the scripts precache (`precacheModel`: the bomb case), 459 models, 8.0 MB;
  `script_coll.bin`: the collision
  triangles of every model a script entity can show (its spawn model, the destructible's other states
  and parts, the precached ones; 3,500-33,000 triangles, 0.1-1.2 MB per map) for the bullet and debris
  traces
- `sounds.json`: the map's sounds (below)
- an entry in `maps3d/index.json`

**Player characters.** Every `body_mp_*` / `head_mp_*` XModel of a map zone is written once into
the shared `maps3d/_characters/`:
- LOD 0 geometry, skin indices and weights
- the skeleton: bone names, hierarchy and the bind pose from `baseMat`
- one colour map per surface

The head shares the body's bones by name, as in the game. Each body and head model also carries its
hit boxes (`hitBoxes`: the `XBoneInfo` of every bone with a hit volume - the box in the bone's space,
the bounding sphere), which the 3D view's traced shots hit. 42 models from the 23 maps, 6.3 MB.
Structures and the skinning formula are in [docs/findings.md](docs/findings.md).

**Light grid.** `tools/export/light_grid.py` decodes the map's `GfxLightGrid` (the game's model
lighting) into `maps3d/<map>/lightgrid.bin`: per grid point (32 × 32 × 64 units) its colour set,
its primary light and the game's trace flags, per colour set a six-face summary;
0.3-1.8 MB per map, 18 MB for all 23. The full 56 colours of every colour set are in
`lightgrid_colors.webp` (lossless, 20 MB for all 23). `world.json` → `lights`: the map's primary
lights (`ComWorld`: the sun and the lamps with position, colour, cone, radius and the falloff ramp
of their light def). The light grid's sight traces need the collision model:
`tools/export/sight.py` writes the world brushes and terrain / patch triangles that block them
(`CONTENTS_SOLID | 0x2000`) into `sight.bin`, 0.1-3.3 MB per map, 34 MB for all 23. The
reflection probes (`probes.webp`, 1.7 MB for all 23) are the cube maps the map compiler
rendered, decoded from the game's RGBM format. Only these: `--lightgrid-only`.

**Player animations and weapons** come from `common_mp.ff` (read once per export run; only
these: `--anims-only`):
- `tools/export/xanim.py` decodes `XAnimParts` (quantised rotation / translation keys and the
  root motion). Each clip's stride (root motion per cycle) keeps the feet in step.
- `tools/export/animtree.py` rebuilds the game's player anim tree from the rawfiles
  `animtrees/multiplayer.atr` and `mp/playeranim.script`: the index the demo sends as
  `legsAnim` / `torsoAnim` → animation name (303 entries). How the engine numbers the tree, and
  how the result was checked against the demos, is in [docs/findings.md](docs/findings.md).
- `anims_export.py` writes every animation of that tree that `common_mp.ff` holds (242 of 286;
  the missing ones are mounted-turret animations): `maps3d/_characters/anims.json` (clip list,
  tracks, the anim tree; 1.2 MB, 0.26 MB compressed), the 37 core clips of the movement-based
  fallback in `anims.bin` (1.5 MB) and every other clip in `anims/<name>.bin` (205 files,
  5.9 MB), loaded per demo.
- `weapons_export.py` exports the world weapon models (52, 2.5 MB) like the characters and
  writes `weapons.json`: base weapon → plain / silenced / grenade-launcher model. The mapping is
  a table, not read from the game's WeaponDefs.
- The effects' debris models (kind `fx`: glass shards, wood splinters, rocks, shell casings, the
  spent smoke grenade and flashbang, the fruit stands' watermelon chunks ...; 33 models, 0.18 MB)
  are exported the same way: every model an effect definition of `common_mp.ff` or of a map's
  `fx.json` draws (those only a map zone holds from that zone).

**Sounds.** `tools/export/sound_export.py` reads the sound alias lists (`snd_alias_list_t`) of
`localized_common_mp.ff` (2,769 lists: weapons, impacts, footsteps, explosions, voices) and of each
map zone, and the game's channel table (`soundaliases/channels.def`: which channels are 3D,
which restricted). The sounds a replay can play are exported: the client code's tables (impacts,
explosions, footsteps and landings for every surface type, gear rattle, melee), the weapons' sound
fields, the aliases the gametype and map scripts name (string literals, also composed: the
faction's prefix + `1mc_lastalive`), the map zone's aliases the zone itself refers to, the createfx
loop sounds and the ambient track - with their secondary and chain aliases. `maps3d/_sound/aliases.json`
holds the 1,433 every map shares (0.8 MB), each map's `sounds.json` its own 53-77 (25-38 kB), the
emitters (`createLoopSound` placements) and the ambient track. The audio: a loaded sound's PCM is
inline in the fast file, a streamed one is `sound/<dir>/<name>` in the `.iwd` archives. WAV files are
written as IMA ADPCM (4 bits per sample, a quarter of the PCM; decoded by `sound.js` itself), MP3
files are copied. 1,177 files, 101 MB for all 23 maps, of which 55 MB are the maps' ambient tracks
(MP3). How the alias lists are found and their shared parts resolved:
[docs/findings.md](docs/findings.md#9-sound).

**Props (static models).** `tools/export/xmodel.py` reads the XModels of the map zone, and of
`common_mp.ff` for models the map places but does not store. That covers surfaces, LODs,
vertices (position, normal, UV) and triangles. Models that share vertex or index buffers, and
material handles that point back at a material loaded earlier, are resolved by rebuilding the
fast file's memory blocks (see [docs/findings.md](docs/findings.md)). Each model's geometry is
stored once and drawn with `THREE.InstancedMesh` for all its placements.

| | Supported | Not supported |
|---|---|---|
| Geometry | LOD 0 + lowest LOD, rigid and skinned surfaces (static props are in bind pose) | animated models, bones |
| Materials | colour, normal and specular map (WebP, shared with the world), alpha test, blending, culling; lit like the game's static models (light grid at the centre of each placement + sun) with the reflection probe of each placement | |
| Fallback | a model that cannot be read is drawn as a box and listed in the export summary (`props drawn as boxes: …`) and in `index.json → propFallback` | |

On the 23 maps of a German retail install, every placed model gets real geometry except one
placement on mp_creek, whose model name is unknown. 0–33 LOD 0 surfaces per map have no
resolved material and are drawn grey. Cost on the six maps with demos: +3.1 to +5.8 MB of
download (props.bin/json), 70-120 ms to load and build locally, and 0.6-1.3 million triangles
in under 1.3 ms per frame on an NVIDIA T400. The *low detail* option halves the triangles. Full
table: [docs/validation.md](docs/validation.md#performance-before-and-after-real-props).
Textures are shared by all maps in `maps3d/_textures/`. Mp_strike takes about 14 s and
19 MB plus textures. All 26 maps of a German retail install (21 stock maps plus the usermaps
`mp_backlot_x`, `mp_cluster`, `mp_coastal`, `mp_manorhouse` and `mp_marketcenter`) take about 12 minutes (twice that the first time, when the
textures are encoded; the sounds add about 3 minutes the first time, for the ADPCM encoding). That is
about 894 MB in total (the three newest usermaps 131 MB of it - mp_coastal alone has 3.1 million prop
triangles at LOD 0), close to the 1 GB a GitHub Pages site may have; of it 77 MB are the 3,795 shared textures of world, props, players and weapons (colour maps up to 512 px, normal and specular
maps up to 256 px: `--map-tex-size`). The format is described at the top of
the script and in [docs/findings.md](docs/findings.md).

A demo's map is matched by its raw name (`mp_backlot_x` uses its own export). Unknown
Promod or league variants fall back to the stock map through the aliases in
`assets/maps/maps.js`.

**Ambient effects.** `tools/export/fx_export.py` reads the map's createfx placements and the
FX definitions (`FxEffectDef` / `FxElemDef`: spawn timing, life, velocity and visual state curves,
atlas, materials) of the map zone and `common_mp.ff`, resolving the materials the definitions refer
to by reconstructing the fast file's memory block. `js/view3d/fx.js` evaluates the game's effect
update in closed form: every element alive at the demo time, with the game's random table, spawn
times, velocity integration, gravity, colour / size / rotation curves, atlas frames, distance fade
and light, drawn as the game's sprites. 952 placements of 107 definitions on the 21 stock maps;
the two usermaps have none. The same system plays what the demo records: the parser keeps every
detonation (with the surface it hit and its normal), every bullet impact the demo holds and every
scripted effect, and the 3D view picks the effect the game would (the weapon's explosion effect and
the impact table's effect for the surface, the weapon's muzzle flash at its `tag_flash`). The
impacts of the bullets on the world are not in the demo - every client traces the bullets itself -
so the 3D view traces them as the game's client does (`js/view3d/trace.js`): from the frame the
client shows when the shot arrives (the snapshot before), seeded with the recorder's command time,
for other players from the weapon's `tag_flash` in the shooter's animated pose along its view angles
with the spread the client guesses (stance, speed, aiming down the sights by the legs animation), for
the recorder's own shots from its eye with the spread of its player state - against the world's
triangles with their surface types - and plays the impact table's effect where they hit (`?shots=server`
in the URL ends a shot at the server's flesh hit of that shooter instead: no wall impacts behind a
victim the server says was hit - not what the game's client draws). A traced bullet stops at a
living player - at the game's hit boxes of the player's body and head models (every bone's box, in
the player's animated pose at the shot: the same animations and angle controllers as the drawn
model, also with *Players: Simple*) - and leaves nothing there - the
server's flesh impact in the demo is drawn instead - then goes on through the body as the flesh
depth allows, as the game's client does it (`MASK_SHOT`, `sv_clientSideBullets`). Marks (bullet holes,
scorch marks: the effects' `decal` elements) stay on the surfaces until the round ends. Bullets
pass through walls as the game's client lets them (`FireBulletPenetrate`: the game's depth table per
weapon and surface, the wall's depth up to its inner face) and leave the exit effects. The props
stop bullets and debris with their own collision surfaces (`XModelCollSurf_s`: the triangles the
game's traces hit, with their surface types). Colliding elements are simulated once from their
spawn (`FX_CollisionResponse`: traced every 50 ms, mirrored and slowed at each hit, at rest on a
floor, an effect on impact such as the flashbang's smoke); elements with an emitted effect spawn it
along their path (`FX_ProcessEmitting`: the dust puffs of brick and rock impacts); the `model`
elements draw their debris models, lit by the light grid. Every shot ejects the weapon's casing at
its `tag_brass` (`worldShellEjectEffect`; the game spawns them only within 100 units of the camera).
Rockets and launched grenades carry their weapon's trail effect along their path (`projTrailEffect`
on the projectile, stopped at the detonation), with the trail elements drawn as the game's
ribbons (`FX_DrawTrail`). The effects' lights become up to 4 dynamic lights of the world and the
models. Details:
[docs/findings.md](docs/findings.md#7-the-sky-and-the-ambient-effects).

## Possible next steps

- `com_barrel_benzin`'s label (mp_citystreets, 8 triangles): its image reference stays unresolved in
  every zone (docs/asset-audit.md, "Not supported / left").
- 34 prop surfaces on the 17 other maps without a material and without a geometric twin
  (docs/asset-audit.md, section 13).

## Hosting on GitHub Pages

1. Before every push run

```bash
py tools/check_deploy.py manifest
```

   It writes `maps3d/manifest.json` (size and hash of every data file; an export refreshes it too)
   and runs `tools/check_imports.py`: the module graph of `index.html` and the test pages - every
   import resolves to a file with exactly that upper / lower case (Windows does not care, GitHub Pages
   does), every imported name is exported, the import map is valid and comes first, every
   `<script src>` exists. Push **every** file it names: a module missing on the site breaks the 3D
   view. Check another copy (e.g. your git checkout) with `py tools/check_imports.py --root <folder>`.
2. Create a repository and push this folder (its root becomes the site root). Included:
   `.nojekyll` (without it Jekyll would drop `maps3d/_textures/` and the other `_` folders) and
   `.gitattributes` (text with LF, all data types binary - never converted). **Do not use Git LFS**
   for the data: Pages would serve the LFS pointer files instead of the data.
3. **Settings → Pages → Build and deployment:** either *Deploy from a branch* (`main`, `/ (root)`) or
   *GitHub Actions* with the "Static HTML" workflow (it uploads the repository as it is).
4. Wait until the deployment has finished (the Actions tab), then check the live site against the
   local files:

```bash
py tools/check_deploy.py check --url https://<user>.github.io/<repo>/
```

   It downloads every file `index.html` needs (`check_imports.py --url`: the modules, the classic
   scripts, the stylesheet and its fonts - a missing one is named with its HTTP status), compares the
   manifests, every data file's size and the content of the code, the JSON headers and the maps'
   binaries (`--full`: every file, ~750 MB; `--map mp_strike`: one map and the shared folders), and
   names every file that is missing, different, an HTML page (a 404) or an LFS pointer.
5. Open `https://<user>.github.io/<repo>/`.

**Loading** (`js/view3d/data.js`): every data file is requested as `file?v=<hash>` from the
manifest, so a header (`world.json`) and its binary (`world.bin`) always come in the same version,
never one from the browser's or the CDN's cache (Pages caches for 10 minutes) and one new. Pages
serves the files gzip-compressed: `Content-Length` is then the compressed size, so the binaries are
read as a stream and checked against the size the manifest or their header gives (a loader that sized
its buffer from `Content-Length` cut `world.bin` short on Pages: "Invalid typed array length:
932169"). A file that is missing (HTTP 404), an HTML page or an LFS pointer, or has another length
is reported with its name, e.g. *mp_strike/world.bin: expected 13,018,860 bytes, received 3,599,463
(cut short or an old version)*, and logged to the console with URL, status, type, size and SHA-256;
the view falls back to the compass image as the ground.

`demos/` and `.claude/` are in `.gitignore`. **`maps3d/` is committed** so the published site
shows the real maps. It is extracted game content: read [maps3d/NOTICE.md](maps3d/NOTICE.md),
and leave the folder out (add `/maps3d/` to `.gitignore`) if you do not want to publish it.
The site then falls back to the 2D image as the ground. Individual files stay far below GitHub's
100 MB limit (the largest `world.bin`, mp_carentan, is 21 MB; the largest `props.bin`, mp_farm,
5.7 MB; the largest file is mp_manorhouse's world.bin, 23 MB). The whole site is about 0.9 GB (maps3d 894 MB, 101 MB of it the sounds), just below the 1 GB a Pages site may have - before adding more custom maps, lower `--tex-size` or leave a map out (the viewer falls back to its 2D image as the ground).

## Layout

```
index.html               the page (classic scripts for the parser, ES modules for the app)
css/styles.css           the one stylesheet: design tokens (:root - colours, team and timeline
                         colours, type, spacing, radii, shadows, z-index), controls, then one
                         section per component; assets/fonts: Inter, JetBrains Mono (OFL)
js/c4/                   from cod4-demo: parser, analysis (DemoData), UI pieces (scoreboard,
                         rounds, chat, events, 2D renderer, heatmap, video export); additions in
                         analysis/collect.js + build.js: player models, animation state per
                         sample, corpses
js/app/main.js           file loading (worker), app facade, 2D/3D toggle, the rail and its
                         popovers, the drawer, details overlay, keys
js/app/moduleCheck.js    why a module did not load: the file of the chain that is missing,
                         not JavaScript or unreachable, else the broken module
js/app/match.js          Match: DemoData prepared for playback - positions at time t, trails,
                         grenade arcs, bomb, rounds (shared by both views)
js/app/replay.js         Replay: the one playback state (time, range, selection, filters),
                         player bar, timeline, Layers popover, drawer (teams, kill feed)
js/c4/ui/killfeed.js     the kill feed overlay of the 3D view (DOM) and of both video exports
                         (canvas), with C4.weapons.killIcons - the drawer's icon mapping
js/view2d/view2d.js      2D view
js/view3d/               view3d (scene, loop, Camera / Display / Graphics popovers), graphics
                         (the Graphics settings), xray (players through walls: stencil +
                         silhouette passes, label declutter), exportVideo3d (the 3D video export:
                         dialog, offline rendering, overlays, encoders), mapLoader (maps3d -> three.js),
                         props (instanced prop models / boxes), actors (players: capsules or
                         models, corpses, weapons), characters (skinned player models, stance
                         poses, animation clips), animator (which clip a player plays at t and
                         the game's blend rules), controllers (the game's leg / torso / head
                         angles, lean, prone slope), lighting (the light grid with its sight
                         traces, reflection probes, normal / specular maps: the game's lighting
                         of players and props, the world's reflections), shadows (the sun's
                         shadow map), sky (the sky cube), fx (the effects: the map's and the
                         demo's, the game's effect system), effects (markers, grenades), cameras,
                         scriptModels (the map's script models in the demo's states), sound (the
                         game's sounds: live with Web Audio, offline for the MP4 export), audit
                         (?audit=1: the assets coloured by the asset audit's status), blend (the
                         game's blend factors for every renderer)
assets/maps/             compass images + calibration (maps.js);  assets/killfeed/  weapon icons
vendor/three/            three.js r170 (three.module.js, OrbitControls) - see vendor/README.md
tools/check_deploy.py    maps3d/manifest.json (sizes, hashes) and the check of the deployed site
tools/check_imports.py   the module graph: missing files, case, exports, import map (--url: the site)
tools/shoot.py           headless Edge / Chrome screenshots and test runs (Python stdlib only)
maps3d/                  exported maps (see above)
tools/export/            export_maps.py, xmodel.py + props_export.py (prop models),
                         cod4ff (fast file parser, copy of cod4-ff)
tools/export/            ... characters_export.py (player models with skeleton and skin weights),
                         xanim.py + animtree.py + anims_export.py (player animations and the
                         game's anim tree), weapons_export.py, light_grid.py (model lighting),
                         sight.py (the collision the light grid's sight traces test),
                         d3dshader.py (lists / disassembles the game's compiled shaders),
                         fx_export.py (effects: createfx placements, FX definitions, the impact
                         table, the weapons' effects), sound_export.py (sound aliases and audio),
                         image_refs.py (the images materials name by reference)
tools/audit/             asset_audit.py: the map assets against the game's data -> docs/asset-audit.md,
                         maps3d/<map>/audit.json
tools/characters/        preview.html: stance poses / animation clips of a character (dev tool)
tools/probes/            orient.html: how the reflection probe faces map to world directions
                         (dev tool)
tools/validate/          validate.html: every demo through the parser + plausibility,
                         map-alignment, player-model and animation checks -> docs/validation.md;
                         export3d.html: the 3D video export's test cases
docs/findings.md         how demos and maps are read
docs/validation.md       validation report over all sample demos
docs/asset-audit.md      the map assets (trees, bushes, decals ...): root causes and fixes
docs/screenshots/        before / after screenshots of the asset audit
```

## Credits and licence

GPL-3.0 (see `LICENSE`). The demo parser, analysis and 2D UI are taken from **cod4-demo**,
whose snapshot decoding follows [Iswenzz/CoD4-DM1](https://github.com/Iswenzz/CoD4-DM1)
(GPL-3.0). The fast file parser is **cod4-ff**. Engine facts (vertex layout, state bits,
lightmap layout) were checked against KisakCOD. three.js is MIT (`vendor/three/LICENSE`). Ideas for the 3D view come
from cod4-demo-inspector. Call of Duty is a trademark of Activision; this project is not
affiliated with Activision or Infinity Ward.
