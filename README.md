# CoD4 Demo Viewer

A local web app for Call of Duty 4 (2007) demos (`.dm_1`, stock CoD4 and CoD4X).
The demo is parsed completely in the browser - nothing is uploaded - and shown in
a quick overview plus seven tabs: Scoreboard, Round by Round, Kills per Round,
Chat, Console, Events and a 2D Map replay.

Plain HTML, CSS and JavaScript. No framework, no build step, no external library.

---

## Start

**Double-click `index.html`.** That is all - the viewer is built to run from
`file://` (see "Why classic scripts" below).

Alternatively run **`start.bat`**: it starts a local web server on
<http://127.0.0.1:8080/index.html> (needs Python 3; falls back to opening
`index.html` directly if Python is missing).

Then drop a `.dm_1` file onto the page or use **Open demo**.

Tested with Chromium (Chrome / Edge). Firefox should work (Blob workers and
canvas are standard); it was not tested.

---

## Using it

### Quick overview

Final score (rounds won in S&D, per half; "recording started at x:y" when the
demo begins mid-match), map (raw and display name), mode, ruleset (Promod's
HUD header, e.g. *Knockout Knife MR12 OT3*, plus the mod folder), protocol,
server name with colour codes, demo POV, length, record date - compact above
the tabs (the score block and two rows of four items); long values are cut with
an ellipsis, the full value is the tooltip.

**Team colours:** the POV's team is blue, the other team red (a spectator POV:
the team shown first in the scoreboard is blue) - in every tab (scoreboard, kill
lists, rounds, map, timeline, heatmaps). The colour belongs to the team, not to
the side, so it stays after the halftime swap. Defined once in `styles.css`
(`--team-blue`, `--team-red`; `main.js` points `--team-a` / `--team-b` at them
per demo, the map reads them with `app.teamColor`). The own-kill metrics keep
their own scheme (all players grey, the POV highlighted).

### Game phases

Every event has a phase: warm-up, knife round, live, halftime, timeout,
aftermatch. **Only the regular match time ("live") counts** for Scoreboard,
Kills per Round and the numbered rounds in Round by Round. The match ends with
the round win that fulfils the win condition of the ruleset (MR12: 13 wins; at
12:12 overtime, 3 rounds per side, until a winner is decided) - rounds the
server plays after it are "aftermatch". Round by Round shows the knife round /
warm-up and the aftermatch as marked sections without a round number; Events,
Chat, Console and Map show a phase badge (Warmup, Knife, Halftime, Timeout,
After) instead of the round. Details: `docs/ANALYSIS.md`, section 4.

### Tabs

| Tab | What it shows |
|---|---|
| **Scoreboard** | Per team (sorted by score, every column sortable), Clan, Player, Score, K, A, D, K/D, HS % (headshot kills / kills from the kill feed), TK (team kills while a match round is live - not in warm-up, pauses or the knife round), TKd (times killed by a teammate - the same team kills seen from the victim), Nade K / Nade D (kills with / deaths by frag grenades, from the kill feed), Plants, Defuses (from the bomb messages), team totals, POV badge, "left" badge for players who left early, spectators below. |
| **Round by Round** | Every round as a card (click to open): winner, reason, duration, score after the round, sides. Halftime divider. Inside: kills (`R7 · 01:23 · Killer → Victim · Weapon`, HS / Teamkill / Suicide / Falling / World / Car explosion) and bomb plant / defuse. |
| **Kills per Round** | Players × rounds matrix, colour intensity by kills, 3K/4K outlined, 5K red. |
| **Chat** | Time, round, All/Team badge, player, message; filter All / Team, search. |
| **Console** | Everything the server sent: prints, game messages, chat, config string and dvar changes, scores, restarts, menu / sound commands, system info. Type chips, search. |
| **Events** | Player ready, connected, disconnected, joined / left the server, attack / defence eliminated, bomb planted / defused, kills, halftime, timeout (+ optional: joined team, bomb picked up / dropped). Search, type chips with counts, player filter. |
| **Map** | 2D replay, see below. |
| **POV** | The recording player: key figures, then three views - *Health & rounds*, *Opponents & weapons* (the POV's damage statistics) and *Own-kill metrics* (POV and team mates) - live match time only, see below. |

A click on a kill or bomb event in *Round by Round* or *Events*, or on a marker
in the *POV* health chart, opens the map 2 seconds before it.

### POV

Key figures on top (damage taken / dealt, hits taken / dealt, headshots,
kills / deaths, own kills of the POV), then three views; the last one opened
stays selected.

* **Overview:** damage taken (split: enemies / team mates / self = own grenade,
  fall, suicide / other or unknown source), hits taken, hits dealt, headshots,
  kills / deaths. **Damage dealt is `n/a`:** the server sends the POV no damage
  value for his own hits, only the hit marker.
* **Per round** (click a row: chart shows that round), **per opponent** (damage
  and hits on the POV, kills both ways; *hits by the POV* per player ≈ from his
  own bullet impacts - the shooter is transmitted, the victim is the nearest
  player to the impact), **per weapon** (damage taken
  per attacker weapon / cause; hits and kills per weapon of the POV) with the
  killfeed icons.
* **Health chart** (SVG): health of the POV, markers for damage taken, hits
  dealt, kills, deaths and round borders, grey = not live or the POV spectates.
  Filter *Whole match* / one round.
* **Exact:** health (player state), the damage counter (`damageEvent` +1 and
  `damageCount` = health lost for every hit), attacker and weapon of bullet hits
  on the POV (`EV_BULLET_HIT_CLIENT_*`), kills and deaths (kill feed), the number
  of hits dealt (the hit-marker sound `mp_hit_alert` the server plays for the POV),
  the POV's own bullet impacts (`EV_BULLET_HIT`, shooter in `otherEntityNum`) with
  their head flag (headshot hits dealt). The lethal hit counts with the health
  left (e.g. 40 → 0), not its raw damage.
* **≈:** damage without a hit event (own grenade or fall when the damage has no
  attacker direction; explosion with unknown thrower otherwise), the weapon of a
  dealt hit without own impact (the weapon the POV held; his own grenade when it
  just detonated), headshot hits taken (sound `bullet_impact_headshot_2`), the
  victim of an own impact (nearest player within 80 units - right for 681 of 682
  POV kills in the samples). Impacts and hit markers are two sources: impacts
  are bullets only, hit markers every damage incl. grenades.
* Only phase *live* counts, as in the scoreboard; the kills follow the
  scoreboard's rule. The data is `DemoData.povDamage` (overview, rounds,
  opponents, weapons, timeline) - the tab, the chart and the JSON export use
  this one object. Checked by `tools/selftest.html` (sums, K, 100 HP per death).

**Own-kill metrics** (view 3 - `DemoData.ownKills`, `js/analysis/ownKills.js`): only
the POV and the POV's team mates. The team is the team key (A / B) from the team
membership, so the halftime side swap does not change it; a player who changed
teams counts only for the kills made while in the POV's team. The POV is always
the top row (badge *POV*). A POV without a team (spectator / shoutcaster) gets a
note and a selector for the team to evaluate. Counted: the kills of the live match
time (no warm-up, timeout, halftime, aftermatch), no team kills, suicides or world
kills.

Each kill is either **excluded** (not estimated) or **evaluated**:

| Excluded because | Rule |
|---|---|
| not an aim kill | grenade, launcher, knife, explosive, car - no crosshair to judge |
| no shot seen | no fire event / bullet impact / clip decrement of the killer (fallback: firing flag of a sample) in the 300 ms before |
| killer / victim not continuously in the snapshots | a data gap > 150 ms in the window 550 ms before the kill up to the kill |

An evaluated kill is an **own kill** when the crosshair was within 10° of the victim
at the shot. The metrics are computed over the own kills:

| Column | Rule |
|---|---|
| Data coverage | evaluated kills / all kills of the player, e.g. `24/31`; the tooltip lists the excluded kills and why |
| Own kills (n) | evaluated kills with the crosshair ≤10° at the shot (the tooltip counts the ones more than 10° off) |
| % crosshair ≤3° at -0.5 s | share of the own kills with the crosshair within 3° of the victim 0.5 s before the kill |
| Median crosshair error at -0.5 s | median angle view direction ↔ victim 0.5 s before the kill |
| % target silent | share of the own kills whose victim sent no sound event in the 2 s before (footsteps, shots, jump, landing, reload, weapon switch, grenade, melee, pickup); only victims in the snapshots for the whole 2 s |
| Median distance | kill distance in world units |
| % target silent & unseen (**optional**) | shown with the checkbox above the table (off by default): the victim was silent and no living team mate of the killer saw it in the 2 s before - at no sample was the victim inside a team mate's view cone (±40° horizontal / ±35° vertical) **with a free sight line through the map geometry** (`geometry/<map>/sight.js`, [docs/GEOMETRY.md](docs/GEOMETRY.md); eye → the victim's feet, chest or head). ≈: static models (trees, bushes, cars, crates) and smoke are not in the geometry, glass and doors do not block, so the share is understated. Without geometry for the map the column falls back to the cone alone (marked *rough*, no walls). Only kills whose living team mates were all in the snapshots for the whole 2 s count; `ownKills.sight` in the JSON says which method was used |

**Crosshair error (≈):** the real 3D angle (pitch and yaw together) between the view
direction and the line eye → nearest point of the victim's upper body (chest to
head). View and position of the POV (and of a followed player) come from the player
state, those of the others from the entity (16-bit angles, 0.0055°). Values between
two snapshots are interpolated (yaw over the shortest way), a sample exactly at the
time is used as is (kill times lie on the 50 ms snapshot grid). Eye = feet + the
real view height of the player state, else 60 / 40 / 11 by stance; target segment
feet + 44…58 / 30…40 / 8…12 (stand / crouch / prone), lean ignored. Shot source per
kill: the latest of fire event, bullet impact, clip decrement (followed player), else
the firing flag - the note under the table counts them.

*ALL (POV team)* is the same over the players shown, with the ratio player ÷ ALL
marked from 1.3× (▲) and up to 0.7× (▼). Rows with fewer than 15 evaluated kills
are grey - their values say little. Bar charts per metric with the ALL line, POV
first. All thresholds are in `RULES` in `ownKills.js` (300 ms, 10°, 3°, -0.5 s, 2 s,
150 ms, 15). The view says it: **an indication, no proof** - small samples vary a
lot (with 20 own kills a share of 54 % lies between 35 and 70 % by chance).
"Unseen" is a line-of-sight test against the collision geometry, not the rendered
picture - see the limits above.

### Map

* **Range:** whole match or a single round. **Play / Pause**, speeds 0.5×, 1×,
  2×, 4×, **timeline** with kill markers (colour of the killer's team), bomb
  plant (yellow) / defuse (green) and round starts.
* **Strat time / countdown is skipped.** A round starts at its live start
  (config string 11 set = end of the strat time, 6 s after the restart in every
  sample round); in the round view the clock and the timeline start there at
  00:00. *Whole match* jumps over the countdown phases (dark on the timeline)
  while the clock keeps the real match time; ← / dragging backwards into a
  countdown lands at the end of the previous round. Knife rounds have no strat
  time (kills from 0.9 s after the restart), so they start at the restart.
* **Reset per round:** trails, grenade paths, detonation circles, death markers
  and last known positions are only drawn for the round containing the current
  time - when playing, seeking and rewinding. The heatmap covers the range
  chosen (the round, or *Whole match*), phase "live" only.
* **Keys:** Space = play / pause, ← / → = ±5 s.
* **Trails:** last 5 s, fading, broken at data gaps > 0.5 s, jumps and new
  rounds.
* **Map tools** (top right of the map, under the clock): zoom + / − (around
  the centre) and **Heatmap** - the button opens a floating options panel over
  the right of the map (closes with the button, Escape or a click outside; the
  button is highlighted while a heatmap is shown). All settings are stored in
  localStorage (team and players by name).
  * *Heatmap:* Off, Positions (living players, sampled every 100 ms from the
    live start of each round, so snapshot rate and data gaps do not weigh the
    result; no dead players, no spectators), Kills (killer spots: the killer's
    position at the kill; no team kills / suicides - the scoreboard rule),
    Deaths (the victim's position), Grenade landings (detonations of frag,
    flash, stun), Smokes (smoke detonations), Shots fired (the shooter's
    position at every shot seen).
  * *Team*, *Side* (attacking / defending in that round - sides swap at
    halftime), *Player* (dropdown with checkboxes, grouped by team) filter by the
    causer: killer, victim (deaths), thrower, shooter. Grenades without a known
    thrower (the thrower is estimated, ≈) are only in the unfiltered view.
  * *Look:* Radius (world units - the spots scale with zoom and map),
    Intensity (gain), *Keep players visible* (off: only the heatmap on the map).
    *Up to current time* / *Full range* (the whole round or match chosen).
  * Legend: colour scale low → high and n (points drawn); events without a
    known position are counted and named, not drawn. Tooltip: based on the data
    visible in this POV demo - other players only while the POV saw them.
  * Rendering: counts on a world grid (512 cells along the longer side),
    blurred with a Gaussian of the radius (three box blurs), normalised to the
    maximum of the filtered data (square root, times the intensity), coloured
    blue → cyan → green → yellow → red with a transparent background; drawn
    with the map's matrix, so it lies exactly on the map in every rotation and
    zoom. The points of a category are computed once; "Up to current time"
    adds them incrementally (while playing at most 4 updates per second).
    A video export draws the heatmap of the view (not the panel).
* **Rotation:** the map turns in 90° steps (⟲ / ⟳ in the toolbar, keys Q / E),
  default 90° to the left, stored per map (localStorage). One transform in the
  renderer (world → screen matrix with the rotation) moves the image, players,
  trails, view directions, grenades, the bomb, death markers and heatmaps
  together; labels stay upright. Turning keeps zoom, pan and the playback.
* **Round table** (right, above the event list; × collapses it, *Round table*
  shows it again): round number and status (in progress, won by … (reason),
  strat time, halftime …) at the playback time - in *Whole match* the round of
  the current time. One card per team (scoreboard order): team colour, name,
  rounds won so far, side (ATTACK / DEFENCE), players alive. Per player: the
  weapon in hand (readable name, "-" when dead), K and D up to the current time
  (the scoreboard rule, phase "live" only, `C4.build.kdRule`), POV badge; dead
  players of the round greyed and struck through. Click a row = show / hide the
  player on the map (hidden rows dimmed), click a team name = the whole team,
  *All* / *None*; hover a row = the player is highlighted on the map (all
  players of a team have the same colour).
* **Player stats** (bar chart icon in each row of the round table): a popup next
  to the icon (always inside the window; one at a time - another icon switches
  the player; × / Escape / click outside closes it; the icon of the open popup
  stays highlighted). *Match* = the whole match, phase "live" only (the
  scoreboard rule; a difference to the game's scoreboard is marked), *This round* =
  the round at the playback time. Kills, deaths, K/D, headshots (count and %),
  frags / flashes / smokes thrown (≈, see grenades), shots fired (seen: only fire
  events in the demo - every shot of the POV and of the player it follows,
  others only while in the POV's snapshots), kills per weapon (killfeed icon,
  sorted; the sum is the kills).
* **Players on the map:** one colour per team; names on / off; view direction
  cone; ring = firing; white ring = the player the POV follows; X = death
  position (5 s); "Last known position" draws players the server stopped
  sending as hollow dots (same life only).
* **Grenades:** flight path (from the transmitted trajectory) and detonation:
  smoke grey and large, frag orange, flash yellow, stun purple. All grenades
  are shown - the thrower is not in the demo. For the player stats a thrower
  is estimated (≈, `grenades[].thrower` / `throwerHeuristic`): only for a grenade
  seen from its launch (≤ 150 ms), the nearest living player within 96 units and
  at least 32 units nearer than the next one; other grenades stay unassigned. Smoke: radius 220 units, visible
  for exactly 10 s from the detonation with a 1 s fade-out (`SMOKE_RADIUS`,
  `SMOKE_DURATION_MS`, `SMOKE_FADE_MS` in `js/ui/map/config.js`), computed from
  demo time, so it is correct at every speed and after seeking.
* **Bomb** (Search & Destroy, `DemoData.bombTrack`): strong orange diamond with
  a light border (`BOMB` in `js/ui/map/config.js`) - lying at the start position
  or where it was dropped; carried: a small round dot (smaller than a player
  dot) next to the carrier with an orange ring (also when the carrier is not
  shown), pulsing when planted, green when defused, a burst for 3 s when it
  exploded. Tooltip: state, carrier, site and the source of the position. A
  defending POV does not see the carrier: the last known position is drawn
  hollow with "?" ("Bomb position unknown (not visible to POV)"). Details:
  `docs/ANALYSIS.md`, section 3.11.
* **Zoom** with the mouse wheel, **pan** by dragging, double-click resets.
* **Export** (button in the playback controls): the current view as MP4 or GIF -
  exactly what the map shows (rotation, zoom / pan, players shown, mode,
  grenades, bomb), without the controls or popups. Range: *Whole round* (the
  round of the current position from its live start, without the countdown) or
  *Custom range* (mm:ss in the clock of the view, *Set from slider*); the range
  is marked green on the timeline. MP4 720p / 1080p at 30 / 60 fps, GIF 360p /
  480p at 10 / 15 fps, speed 0.5× - 4×, optional overlay (round, round time,
  score, kill feed of the last 5 s). Rendered frame by frame from the demo time
  (independent of the playback and the computer's speed; countdowns skipped as
  in the playback), progress in %, *Cancel*, the page stays usable. The dialog
  shows the size estimate first and warns for a GIF > 30 s or > 50 MB.
  MP4: WebCodecs `VideoEncoder` (H.264) + an own muxer (`mp4mux.js`); without
  H.264 encoding the browser records WebM with `MediaRecorder` instead, in real
  time (said in the dialog). GIF: own encoder (`gifenc.js`, in a worker: a
  median-cut palette per frame, only the changed rectangle, unchanged pixels
  transparent). File name: the export name + round + range, e.g.
  `…_crossfire_R9.mp4`, `…_crossfire_R9_0130-0215.gif` (range in round time).
* **Event list** on the right: kills and bomb events of the range; click jumps
  2 s before, the current event is highlighted and followed.

### Download score (JSON)

The button above the scoreboard saves `YYYYMMDD_TeamA_vs_TeamB_map.json`
(e.g. `20260914_infeS_vs_WrZ_strike.json`): record date (else the file date),
the team names as in the scoreboard (upper team first; clan tag or "Team A"),
the map without `mp_`. Names are cleaned for file names: no colour codes,
brackets or special characters, spaces and `_` become `-`, `_` only separates
the parts, an empty part becomes `unknown`. The rule is
`C4.exportName.buildExportFileName(data, {suffix, ext})` in
`js/common/exportName.js`, for later exports. Top level:
`map` (raw name, e.g. `mp_strike`), `recordDate` (`YYYYMMDDHHMMSS`) with
`recordDateSource` (`g_mapStartTime` = map start on the server, or `file date`
- the demo stores no recording date), `halves` (per half `half` number,
`score` "3:9", `rounds` [3, 9] in the order of `teams`, `complete`: false if
the half started before the recording). A recording that starts mid-match adds
`recordingStartedAt` ("9:7") and `halfNumberSource`: the half number then comes
from the ruleset (MR12 = 12 rounds per half, OT3) and the start score (≈).
Then per team the
clan / team name, `roundsWon`, the players sorted by score (`name`, `score`,
`kills`, `assists`, `deaths`, `kd`, `nadeKills`, `nadeDeaths`, `tk`, `teamKilled`, `hsPercent`, `plants`, `defuses`,
`pov: true` for the recording player) and `teamTotal`. Values as in the
table; `kd` rounded to 2 decimals, `hsPercent` to whole percent (`null`
without kills). Spectators are not included.

### Export JSON

Downloads `DemoData` (everything the UI shows), including the section
`bombTrack` (bomb state over time: `t`, `state`, position, `carrier`, `site`, `source`), `weaponLists` (weapon index -> name over time, for the weapon a player holds), `ownKills` (own-kill metrics: `rules`, `reasons`, `povTeam`, `sight` (how "unseen" was decided), `teams.<A|B>` with `all`, `players` - POV first - `shotSources` and `kills` per kill with `excluded` / `evaluated` / `own`, `shotSource`, `errShot`, `errEarly`) and
`povDamage` (POV tab: `overview`, `rounds`, `opponents`, `weapons`,
`timeline` with the health curve and the damage / hit / kill / death events).
Tick *with positions* to include the per-player position arrays (~5 MB for a
16-minute match).

### Markers

* `n/a` - the value is not in the demo; the tooltip says why.
* `≈` - heuristic value; the tooltip names the rule.

---

## Known limitations

What a client demo does not contain, and what is derived, is documented in
detail in [`docs/ANALYSIS.md`](docs/ANALYSIS.md). In short:

* **Other players only while the POV sees them.** Positions have gaps; trails
  are not drawn across them. Obituaries are broadcast, so the kill feed is
  complete.
* **Grenade thrower: not in the demo** - grenades are shown for everyone; the
  thrown-grenade counts of the player stats are estimated (≈) and leave
  grenades without a clear thrower out (their number is in the tooltip).
* **Smoke size and duration** are display constants (`js/ui/map/config.js`).
* **Per-player ready status: not in the demo** - shown are the POV's own
  status, anonymous "a player is ready (waiting on N)" steps and "All Players
  are Ready!".
* **Headshot kills** carry no weapon in the obituary (`MOD_HEAD_SHOT` instead).
  The weapon comes from the killer's lethal head hit (`EV_BULLET_HIT`, the shooter
  and the weapon are in it) when the POV saw it, else from the killer's held
  weapon (≈), else "Unknown weapon" - a headshot is never a weapon
  (`C4.weapons.killWeapon`). `kills[].weaponSource`: obituary / impact / held.
* **Clan tags / team names** come from common name prefixes (≈).
* **Record date** is the map start time on the server (≈), or the file date.
* **Round reason** without a Promod status line (e.g. `fps_promod_285`
  *Match MR12*) is derived from the S&D rules, kill feed and bomb messages (≈).
* **Scoreboard:** the game's scoreboard is shown. If the last scoreboard is
  older than the last round, kills / deaths after it are added from the kill
  feed (≈). Differences between scoreboard and own count are logged with
  `console.debug`. A player who reconnects restarts at 0 in the game's
  scoreboard.
* **Round logic is built for (Promod) Search & Destroy.** Other game modes show
  scoreboard, chat, console, events and the map, but no rounds.
* **Stock 1.7 / 1.8 match demos were not available for testing**; only a stock
  deathrun fixture was decoded. The protocol is supported, round detection on
  stock servers is untested.
* **Maps without a sample demo** (bloc, bog, broadcast, chinatown, wet work,
  ambush, countdown, winter crash, creek, downpour, killhouse, overgrown,
  pipeline, shipment, showdown, vacant) have an image but no verified
  calibration - they are placed with the rectangle of the demo (config string
  823); without it the neutral grid is shown.
* The recording may start mid-match; earlier rounds are then missing (the
  overview says so, round numbers continue from the real count).

---

## Tests

`tools/selftest.html` runs the complete analysis on demos and checks:
every snapshot decoded; round wins = final score = the server's team scores;
events chronological; no NaN / undefined; kills per player = scoreboard kills
(differences listed). Open it and choose demo files, or - served via
`start.bat` - `tools/selftest.html?auto=<folder url>`.

Results on the 53 sample demos (`C:\Claude\cod4-demo\demos`): all decoded
without an error, all final scores consistent with the server scores, kill
feeds identical to the independent Python extractor (`python/`) for all 53
demos. See `docs/ANALYSIS.md`, section 9.

---

## Layout

```
source/
  index.html            the app
  start.bat             optional local web server
  README.md             this file
  css/styles.css
  js/
    core/c4.js          namespace, module registry, Blob worker factory
    parser/             tables, huffman, msg (bit reader), delta, demo (container)
    common/             text (colour codes, tokenizer), constants, servercmd, names
    analysis/           collect (one pass), teams, rounds, events, weapons, povDamage, ownKills, build (DemoData), worker
    ui/                 dom helpers, overview and one file per tab
    ui/map/             config (radii, durations), renderer, heatmap (+ heatPanel), playback, statsPopup,
                        exportVideo (+ mp4mux, gifenc: own MP4 muxer and GIF encoder), mapTab
    main.js             file loading, worker, tabs, export
  assets/maps/          map images (mp_*.png, the in-game compass maps) + maps.js (registry:
                        image, display name, calibration, aliases)
  assets/killfeed/      killfeed icons (pointing left -> right); mapping in js/analysis/weapons.js
  tools/selftest.html   parser self test in the browser
  docs/ANALYSIS.md      demo format and where every value comes from
  docs/GEOMETRY.md      map geometry for sight lines: sight.bvh format, build, checks
  geometry/             map collision geometry, sight.bvh + sight.js per map (from the game files, not in
                        the public repo; built by python/tools/build_sight_bvh.py, loaded by js/analysis/sight.js)
  maps/                 original map images (reference, unchanged)
  python/               Python extractor (step 1) - see python/README.md
```

### Why classic scripts and maps.js

Browsers block ES modules, `fetch()` and worker scripts on `file://`. So the
code uses classic `<script>` files that register themselves on a global `C4`
namespace; the parser worker is created from a Blob that contains the source of
the DOM-free modules; the calibration is `assets/maps/maps.js` instead of a
`maps.json`. This makes a double-click on `index.html` enough.

### Map calibration

`assets/maps/maps.js` is the only map list: raw map name → image, display name
(Quick Overview, export file name), world rectangle the image covers
(`[x1, y1, x2, y2]`, image axis-aligned: left = min x, top = max y) and aliases
for custom versions (`mp_backlot_x` → `mp_backlot`). It is a `C4.define` module,
so the analysis in the worker uses the same display names. The viewer prefers
the rectangle from the demo itself (config string 823); an image is only drawn
with a real calibration, never on a rectangle guessed from the positions.
Verified with the new 1024 px compass images on backlot, crash, strike,
crossfire, citystreets and cluster by overlaying real player positions.

### Killfeed icons

`js/analysis/weapons.js` holds the one mapping weapon / means of death → icon
(`C4.weapons.killIcons(kill)`), including the visible content box of every icon,
so all icons are scaled to the same height. Round by Round, Map → Kills & bomb
and Events show "Killer [weapon] [headshot] Victim"; a weapon without an icon
is shown by name (`C4.weapons.killText(kill)`). The same file holds the weapon
rules used everywhere: `isFragGrenadeKill` (Nade K / D), `isBombKill`,
`isCarKill`, `isDefuseKitWeapon`, `isNonMissileWeapon` - no other file compares
weapon names.

### Damaged demos

A damaged part in the middle of a file (e.g. a broken download) does not stop
the reading: the reader skips to the next valid records, says how many bytes
were skipped and goes on. Chat, scores and round results behind it are shown;
positions and kills behind it are missing, because each snapshot builds on the
previous one. Details: [docs/ANALYSIS.md](docs/ANALYSIS.md).

## Licence

GPL-3.0, see [LICENSE](LICENSE). The snapshot decoding follows the reference
implementation [Iswenzz/CoD4-DM1](https://github.com/Iswenzz/CoD4-DM1), which is
under the same licence.

The map images under `source/maps/` are not part of this project and remain under
the terms of their respective authors.