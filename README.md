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
server name with colour codes, demo POV, length, record date.

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

A click on a kill or bomb event in *Round by Round* or *Events* opens the map
2 seconds before it.

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
  time - when playing, seeking and rewinding. Heatmaps: current round only in
  the round view, cumulative in *Whole match* (without countdown phases).
* **Keys:** Space = play / pause, ← / → = ±5 s.
* **Modes:** *Recent trail* (last 5 s, fading, broken at data gaps > 0.5 s,
  jumps and new rounds), *Heatmap player* (selected players), *Heatmap team*
  (two colours) - accumulated over the range up to the current time.
* **Players:** list grouped by team with All / None / team toggle; fixed colour
  per player in the team's hue; names on / off; view direction cone; ring =
  firing; X = death position (5 s); "Last known position" draws players the
  server stopped sending as hollow dots (same life only).
* **Grenades:** flight path (from the transmitted trajectory) and detonation:
  smoke grey and large, frag orange, flash yellow, stun purple. All grenades
  are shown - the thrower is not in the demo. Smoke: radius 220 units, visible
  for exactly 10 s from the detonation with a 1 s fade-out (`SMOKE_RADIUS`,
  `SMOKE_DURATION_MS`, `SMOKE_FADE_MS` in `js/ui/map/config.js`), computed from
  demo time, so it is correct at every speed and after seeking.
* **Zoom** with the mouse wheel, **pan** by dragging, double-click resets.
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

Downloads `DemoData` (everything the UI shows). Tick *with positions* to
include the per-player position arrays (~5 MB for a 16-minute match).

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
* **Grenade thrower: not in the demo** - grenades are shown for everyone.
* **Smoke size and duration** are display constants (`js/ui/map/config.js`).
* **Per-player ready status: not in the demo** - shown are the POV's own
  status, anonymous "a player is ready (waiting on N)" steps and "All Players
  are Ready!".
* **Headshot kills** carry no weapon; the killer's held weapon is shown with ≈.
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
* **mp_cluster** has no background image (neutral grid in the calibrated
  rectangle).
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
    analysis/           collect (one pass), teams, rounds, events, weapons, build (DemoData), worker
    ui/                 dom helpers, overview and one file per tab
    ui/map/             config (radii, durations), renderer, heatmap, playback, mapTab
    main.js             file loading, worker, tabs, export
  assets/maps/          map images + maps.js (calibration)
  tools/selftest.html   parser self test in the browser
  docs/ANALYSIS.md      demo format and where every value comes from
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

`assets/maps/maps.js` maps each map to its image and the world rectangle the
image covers (`[x1, y1, x2, y2]`, image axis-aligned: left = min x, top =
max y). The viewer prefers the rectangle from the demo itself (config string
823), so every demo is calibrated even for maps without an image. Verified on
backlot, crash, strike, crossfire and citystreets by overlaying real player
positions.

## Licence

GPL-3.0, see [LICENSE](LICENSE). The snapshot decoding follows the reference
implementation [Iswenzz/CoD4-DM1](https://github.com/Iswenzz/CoD4-DM1), which is
under the same licence.

The map images under `source/maps/` are not part of this project and remain under
the terms of their respective authors.