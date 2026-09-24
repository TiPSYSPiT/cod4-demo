# Phase 0 – Analysis for the CoD4 Demo Viewer

Basis of this document:

* the Python extractor written in step one (`source/python`, see its README),
  which decodes all 53 sample demos without a single decoding error;
* the engine reimplementation KisakCOD, the CoD4X client/server sources and the
  CoD4-DM1 reference parser (`info/`);
* the two reference projects `info/cod-demo` and
  `info/cod4-demo-inspector-main` (read only);
* measurements on the 53 sample demos in `C:\Claude\cod4-demo\demos`
  (all CoD4X protocol 21, Promod, Search & Destroy) and the 3 fixtures of
  CoD4-DM1 (stock format, protocol 17, protocol 19; deathrun maps).

Every statement below marked "measured" was checked on these files.

Reliability levels used throughout:

| Level | Meaning | UI treatment |
|---|---|---|
| **reliable** | transmitted by the server as such | shown plain |
| **heuristic** | derived with a rule that can be wrong in edge cases | marked `≈` + tooltip with the rule |
| **not available** | not in a client demo | `n/a` + tooltip with the reason |

---

## 1. The demo format

### 1.1 Container

A `.dm_1` file is a sequence of records, each introduced by one type byte:

| Type | Record | Layout |
|---|---|---|
| 2 | protocol (CoD4X only, always first) | `uint32 protocol`, `int32 -1`, 8 reserved bytes |
| 0 | server message | `int32 message sequence`, `int32 length`, then `length` bytes: `int32 reliable acknowledge` + Huffman payload. Sequence or length −1 = end of demo |
| 1 | client archive frame | `int32 index 0–255`, `float origin[3]`, `float velocity[3]`, `int32 movementDir`, `int32 bobCycle`, `int32 serverTime`, `float angles[3]` (52 bytes incl. index) |
| 3 | reliable message (CoD4X) | `int32 length` + raw bytes (not Huffman coded); none in the samples |

Archive frames are written by the recording client at its own frame rate
(8 ms apart in the samples) and hold its predicted position and view angles.

### 1.2 Huffman compression

The payload of every server message is compressed with CoD4's **static**
Huffman code. The tree is built at start-up from a 256-entry frequency table
(`msg_hData`) with the adaptive FGK algorithm, symbols inserted in ascending
frequency. The result is fixed (256 codes, max. 11 bits), so the viewer ships
the pre-computed code table and decodes with a lookup table. Bits are read
LSB first.

### 1.3 Messages

The decompressed payload is a sequence of operations (`svc_ops_e`):

| Op | Name | Content |
|---|---|---|
| 1 | gamestate | full initial state (see 1.4) |
| 4 | serverCommand | `int32 sequence` + text (reliable command, see 1.7) |
| 6 | snapshot | delta-coded world state (see 1.5) |
| 11 | configclient | CoD4X: `int32 sequence`, `byte client`, name, clan tag |
| 5 | download | not used in demos |
| 7 | EOF | end of message |

A message usually carries some server commands followed by one snapshot; the
commands are applied before that snapshot, so they get the snapshot's time.

The bit reader has one CoD4 quirk that must be reproduced exactly: byte reads
and bit reads use separate cursors, and a bit read that reaches a byte boundary
takes the next byte at the byte cursor.

### 1.4 Gamestate and config strings

The gamestate holds: server command sequence, all **config strings**, the
**entity baselines** (delta base for entities that are new in a snapshot),
CoD4X client names/clan tags, then config data sequence (CoD4X), the
**recording client number** and a checksum feed.

Config strings are an indexed string table (MP layout of patch 1.7):

| Index | Content | Used for |
|---|---|---|
| 0 | serverinfo (`\key\value…`): `sv_hostname`, `mapname`, `g_gametype`, `fs_game`, `g_mapStartTime`, `version`, … | server name, map, mode, mod, record date |
| 1 | systeminfo (`sv_pure`, `sv_iwds`, referenced fastfiles, …) | console / info |
| 2 | game version (`cod21 …`) | protocol label |
| 11 | game end time (round timer / bomb timer) | round phases |
| 12 | map centre | legacy position decoding |
| 20–147 / 148–275 | dvar names / values sent to clients (`ui_timelimit`, `ui_scorelimit`, `g_TeamName_Axis` = `Defence`, `g_TeamName_Allies` = `Attack`, `scr_axis`, …) | mode settings, side names |
| 309–820 | localized strings (Promod HUD texts live here: 380 version header, 381 ruleset, 385–389 status lines) | ruleset, round status |
| 823 | minimap: `"compass_map_<map>" x1 y1 x2 y2` | **map calibration** |
| 830–1341 | models | – |
| 1342–1597 | sound aliases (e.g. `RU_1mc_halftime`, `promod_planted`) | halftime detection |
| 2258 | weapon list (space separated, 1-based index) | weapon names |
| ≥ 2442 | CoD4X extended strings | – |

Updates during the match arrive as server command `d <index> <value>` (or in
pieces `x`/`y`/`z` for long strings).

Not transmitted: strings equal to a constant table compiled into the game
executable. That table is not available in a matching version (see the Python
README, section 7.2); it only concerns unused slots in the samples.

### 1.5 Snapshots and delta compression

A snapshot contains: server time, the message it is delta-coded against
(0 = full snapshot), flags, then

1. the **player state** of the recording client (or the player it spectates),
2. the list of **entities** in the recorder's view,
3. the list of **client states** (one per connected player).

Everything is delta coded against the referenced earlier snapshot (or the
baselines). For each structure the server sends the index of the last changed
field, then for every field up to it a change bit and, if changed, the value in
one of 18 encodings (plain ints of n bits, floats sent as 13-bit integers when
possible, 16-bit angles, times relative to the snapshot time, ground entity
numbers, RGBA colours, positions). The field order comes from 18 tables with
1,047 fields (entity tables per entity type: player, corpse, item, missile,
script mover, …, event entities; player state; client state; HUD element;
objective). One misread bit breaks every following field of the demo, which
makes the decoder self-checking.

Player state extras besides its 141 fields: 5 stats (health, max health, …),
128 ammo and 128 clip counters, 16 objectives, 2 × 31 HUD elements, 128 weapon
model bytes. Position/velocity/angles of the player state are omitted when they
match the client's prediction; the client (and the parser) then takes them from
the archive frames.

### 1.6 Entities and events

* Entity numbers 0–63 are players; `eType` 1 = living player with position,
  view angles, held weapon, stance flags, animation.
* `eType ≥ 17` are **temporary event entities** (event = eType − 17). The
  client plays each of them once when it appears. Important ones:
  `obituary` (66) = kill feed, `bullet_hit` (41) / `bullet_hit_client_*`
  (42/43) = hits.
* Normal entities carry a 4-slot **event ring** (`events[]`,
  `eventSequence`): players emit `fire_weapon`, `reload`, `jump`, footsteps
  etc.; grenades emit `grenade_bounce` and their detonation.

### 1.7 Server commands

The first character selects the handler (engine: `CG_DeployServerCommand`):

| Verb | Meaning | Used for |
|---|---|---|
| `b` | scoreboard: per client score, ping, deaths, kills, assists; team scores; score limit | Scoreboard |
| `G` / `H` | team score of axis / allies | round winners, final score |
| `h` / `i` | chat all / team | Chat |
| `e` `f` `c` `g` | prints / game messages / announcements | Events, Console |
| `d` (`x y z`) | config string update | round phases, ruleset, status lines, halftime |
| `n` / `B` | (fast) map restart – Promod restarts the map every S&D round | round boundaries |
| `v` | dvars set on the recording client (`self_alive`, `opposing_alive`, `self_ready`, `waiting_on`, loadout, …) | ready status, alive counts |
| `a` `C` `J` `L` `N` `t` `u` `s` `o` `p` `q` … | weapon selection, menus, stats, sounds | Console |
| `m` | not in the stock client (Promod/CoD4X), sent right before every fast restart | Console only |

---

## 2. Protocol versions

| Kind | Identification | Differences | Tested |
|---|---|---|---|
| Stock CoD4 (1.7 / 1.8 servers) | no protocol record (DM1 calls it protocol 1) | gamestate config strings with 12-bit index coding; positions encoded relative to the map centre (16-bit or 7-bit delta); no configclient; names only in client states (16 bytes) | only one stock-format deathrun fixture (single player); **no stock S&D match demo available** |
| CoD4X protocol 17 | protocol record = 17 | CoD4X gamestate (32-bit count + index/text), configclient; positions still map-centre relative | fixture (deathrun) |
| CoD4X protocol 18+ (19, 21 seen) | protocol record | positions as raw 32-bit floats | 19: fixture; 21: all 53 match demos |

The snapshot field tables are identical for all these versions (every file
decodes). Stock 1.7 vs 1.8: the demo format carries no patch number; nothing in
the engine sources indicates a different demo/netfield layout, but without a
stock match demo this is **untested**.

Protocol-19 fixture: 32 snapshots at the start are delta-coded against a
message recorded before the demo started; the game itself cannot play them
either. The viewer reports this as "snapshots skipped" and continues.

---

## 3. Where every requested value comes from

### 3.1 Quick Overview

| Field | Source | Level |
|---|---|---|
| Final Score | round wins counted per team (3.3); cross-checked with the last `G`/`H` and scoreboard team scores | reliable |
| Team name / clan tag | CoD4X clan tag field (set in one sample) → otherwise the tag most team members share: candidates per name are `[TAG]`-style tags and every prefix (≤ 12 characters) up to a separator (space `\| / \ : . - _ ~ * # = + , ; > »`), compared case- and leetspeak-insensitively (`W@rZ/Sky` = `WarZ superb`); needs ≥ 2 players and half the team, tie → longer tag (`inf.eS` over `inf`). Symbol-only tags (`// name`) need a space. Team name = most frequent spelling; each player keeps his own spelling | **heuristic** |
| Map | CS 0 `mapname`; display name from a mapping table (`mp_crash` → "Crash", `mp_citystreets` → "District") | reliable |
| Mode | CS 0 `g_gametype` + mapping (`sd` → "Search & Destroy") | reliable |
| Ruleset | Promod: CS 381 (e.g. "Knockout Knife MR12 OT3", "Match MR12", "Strat Mode") + CS 380 version header; always `fs_game` (e.g. `mods/promod_x`). Without Promod headers: mod name only | reliable (as announced by the server) |
| Server Name | CS 0 `sv_hostname` (with colour codes) | reliable |
| Demo POV | gamestate client number + its name | reliable |
| Length | first to last snapshot server time | reliable |
| Record Date | CS 0 `g_mapStartTime` ("Sat Sep 19 21:09:57 2026") is the **map start time on the server**, not the recording start; else file date "(file date)" | **heuristic** (≈ map start) |
| Protocol | protocol record / absence → "CoD4X 21", "Stock" | reliable |

### 3.2 Scoreboard

| Value | Source | Level |
|---|---|---|
| Score, K, A, D, ping | `b` scoreboard, per player its last appearance (players who left are missing from later scoreboards) | reliable, but the last scoreboard can be older than the last round |
| Own count (fallback) | kills/deaths from the kill feed within counted rounds; team kills and suicides give no kill; deaths by the world (falling) are **not** deaths (measured: Promod's scoreboard does not count them) | reliable input, counting rule = heuristic |
| Stale last scoreboard | the server does not always send a scoreboard after the last round: kills/deaths after a player's last scoreboard entry are added from the kill feed (≈) | heuristic |
| Scoreboard reset | after the match the map restarts and the scoreboard drops to all zeros: scoreboards after the last round that are all zero are ignored | reliable |
| K/D | computed | – |
| Nade K / Nade D | not in the scoreboard: kills whose obituary weapon is `frag_grenade_mp` (cooked or not - the obituary names the same weapon), same kill events and rules as the own K/D count (match rounds). Nade K: credited kills only (no team kills, no suicides); Nade D: every death by a frag grenade, also by an own or a team mate's grenade. Martyrdom (`frag_grenade_short_mp`) and the grenade launcher (`gl_*`) are not counted - both are in some weapon lists, but no sample has a kill with them; no sample sends `MOD_GRENADE*` instead of the weapon | reliable |
| HS % | not in the scoreboard: headshot kills (`MOD_HEAD_SHOT`) / kills, both from the kill feed with the counting rule above (match rounds; no team kills / suicides). Only the recorded rounds - for a recording that starts mid-match the base is smaller than the scoreboard's K | reliable |
| Half number (recording starts mid-match) | halftimes before the recording are not in the demo and no dvar gives the rounds per half: taken from the ruleset (`MR12` = 12 rounds per half, `OT3` = 3 rounds per overtime half; all samples with a recorded halftime switch before round 13) and the score at the start. The half the recording starts in is marked incomplete. Without MR in the ruleset the number is unknown (`half ?`) | **heuristic** |
| Record date stamp | `g_mapStartTime` (ctime, server local time) parsed by hand to `YYYYMMDDHHMMSS`, else the file date in local time | heuristic (no recording date in the demo) |
| TK (team kills) | not in the scoreboard: kill feed, killer and victim on the same side at the time of the kill (raw client state), credited to the killer. **Running match only**: between the live start (CS 11) and the round win of a match round. Warm-up, pauses (timeouts), strat mode and ready-up are segments without a round; the knife round is excluded like for K/D. Samples: 210 team kills, 168 outside rounds, 7 in knife rounds, 0 in strat time or after a round win, 35 counted. Excluded counts: `diagnostics.teamkillsExcluded` | reliable |
| Plants / Defuses | not in the scoreboard: `f "MP_EXPLOSIVES_PLANTED_BY<name>"` / `…DEFUSED_BY<name>`, name → client, match rounds only (warm-up / strat mode excluded). Unresolved names: `diagnostics.bombUnresolved` | reliable |
| Team, spectators | client state `team` (1 axis, 2 allies, 3 spectator); Promod "Shoutcaster" = spectator | reliable |
| Left early | message `<name> EXE_LEFTGAME` and removal of the client state | reliable |
| Clan | see 3.1 | heuristic |

### 3.3 Round by Round

| Value | Source | Level |
|---|---|---|
| Round start | fast restart `n` (every Promod S&D round) and CS 11 round timer set | reliable |
| Round end | the next `G`/`H` score change, or the status line "Attack eliminated" / "Defence eliminated" / "Time Elapsed" (CS 385–389) | reliable |
| Winner side | which of `G` (axis) / `H` (allies) increased | reliable |
| Winner team | side → players on that side at that time (client state `team`) → team | reliable |
| Sides (Attack/Defence) | `g_TeamName_Axis` / `_Allies` dvars (samples: axis = Defence, allies = Attack) + `Joined Attack/Defence` messages | reliable |
| Reason | "Bomb defused" = `MP_EXPLOSIVES_DEFUSED_BY…`; status line "Attack eliminated" / "Defence eliminated" / "Time Elapsed". **`fps_promod_285` "Match MR12" sends no status lines** (measured): then derived from the S&D rules - attack wins by elimination or explosion, defence by elimination, defuse or time; "all dead" from the kill feed | reliable with status line / bomb message, otherwise **heuristic** (≈) |
| Recording starts mid-match | team scores before the first observed round win (e.g. 9:7) → round numbers continue from there, final score = start score + observed wins | reliable |
| Pre-match round | the demo may start with the end of a round before the match (scores reset afterwards: the sum of both team scores drops) → shown as "P", not counted | reliable |
| Duration | round start (timer set) → round end | reliable |
| Score after round | running count | reliable |
| Knife round | CS 385 "Knife Round" – shown as round "K" before round 1 | reliable (Promod) |
| Halftime | announcer sound config string `*_halftime` **and** all players swap team (client states) | reliable |
| Timeline | kill feed, bomb plant/defuse messages | reliable |

### 3.4 Kills (Round by Round, Kills per Round, Events, Map)

| Value | Source | Level |
|---|---|---|
| Killer, victim | obituary event entity (`attackerEntityNum`, `otherEntityNum`); obituaries are broadcast to every client, so the feed is complete | reliable |
| Weapon | obituary `eventParm` = weapon index into CS 2258 | reliable |
| Headshot | `eventParm` = 0x80 + `MOD_HEAD_SHOT` | reliable |
| Weapon of a headshot kill | **not in the obituary** (the server sends the means of death instead); taken from the killer's held weapon at that time if visible | **heuristic** |
| Knife | `MOD_MELEE` | reliable |
| Suicide | attacker = victim (`MOD_SUICIDE`, or own grenade) | reliable |
| Falling | `MOD_FALLING`, attacker = world (1022) | reliable |
| World / trigger | attacker = world with weapon index 0 (`MOD_TRIGGER_HURT` is not sent separately, so trigger vs. other world deaths are indistinguishable) | reliable "world", trigger **not distinguishable** |
| Teamkill | attacker and victim on the same team (client states) | reliable |
| Car explosion | weapon `destructible_car` (measured: 10 kills in 3 demos) | reliable |
| Bomb explosion kill | weapon `briefcase_bomb_mp` expected; **not observed** in the samples | unverified |
| Kill position / distance | last known positions of both players (≤ 1 s old) | reliable when visible, else n/a |

### 3.5 Chat

`h` = all, `i` = team; text `[(prefix)]Name^7: message`. Only what the POV
received (team chat of the other team is not sent to it). Sender = matching the
known player names at the start of the line (prefixes like `(GAME_DEAD)`,
`(Defence)` are skipped) – **heuristic**, in practice exact (all 21 lines of
`demo0025` resolved). Quick messages arrive as localisation keys
(`QUICKMESSAGE_GREAT_SHOT`); the viewer shows a readable text for the known
keys.

### 3.6 Console

Everything that is in the demo: all server commands (prints `e`/`f`,
announcements `c`/`g`, chat, config string changes with old → new value, dvars
set on the POV client `v`, restarts, menus, sounds), the systeminfo/serverinfo,
parse warnings. Player name where the text contains one. **Not available:**
commands typed by other players (never sent) and the POV's own console input
(user commands are not recorded).

### 3.7 Events

| Event | Source | Level |
|---|---|---|
| player connected | client state of a slot appears (CoD4X: plus configclient) | reliable |
| player disconnected | client state of a slot disappears | reliable |
| player joined the server | message `MP_CONNECTED<name>` | reliable |
| player left the server | message `<name> EXE_LEFTGAME` | reliable |
| attack eliminated / defence eliminated | Promod status lines (CS 385/387/388/389) | reliable (Promod) |
| bomb planted / defused | `MP_EXPLOSIVES_PLANTED_BY<name>` / `…DEFUSED_BY<name>` | reliable |
| player kills player | obituary | reliable |
| halftime | see 3.3 | reliable |
| timeout called | message `Timeout called by <name>` | reliable |
| player ready | **per player not available.** In the demo: the POV's own status (`v self_ready 0/1`), the number of players still not ready (`v waiting_on N`) and the global "All Players are Ready!" status line | POV only / global |

Connected vs. joined **are distinguishable** (measured in
`Match_mp_crossfire_Q4yUjGvh`: the slot appears 6.0 s before
`MP_CONNECTED`; at the end of a match slots disappear without a leave
message). Disconnected and left usually happen in the same snapshot, but slot
removals without a message also occur (map end, time-outs). Additional,
not requested but available: "joined team" (`<name> Joined Attack/Defence/
Shoutcaster`), bomb picked up / dropped.

### 3.8 Map tab

| Value | Source | Level |
|---|---|---|
| Positions of other players | player entities, ~20 per second | reliable **while in the POV's view**; gaps otherwise (the reference project `info/cod-demo` measured on one full demo: position current 81 %, older than 1.5 s 5 %, not sent at all during that life 14 % of the living players' time) |
| Position of the POV / spectated player | player state (+ archive frames, 125 Hz for the POV itself) | reliable |
| View direction | entity `apos` yaw / player state view angles | reliable |
| Stance, firing, held weapon | entity flags (`0x4` crouch, `0x8` prone, `0x40` firing) and weapon field | reliable |
| Death position | victim's last position; corpse entity | reliable when visible |
| Alive / dead | kill feed + round start | reliable |
| Grenade flight | missile entity: launch time, trajectory base + velocity (gravity 800); positions at each transmission | reliable (computed curve between transmitted points) |
| Grenade detonation | event on the grenade entity with the grenade weapon: frag = `grenade_explode`, smoke = `custom_explode`, flash = `flashbang_explode` (measured 553 / 290 / 48 in 3 demos) | reliable |
| Grenade type | missile `weapon` field (`frag_grenade_mp`, `smoke_grenade_mp`, `flash_grenade_mp`; `concussion_grenade_mp` not in any sample weapon list) | reliable |
| **Grenade thrower** | **not in the demo.** The missile carries no owner, no event marks the throw on the thrower (only the POV's own `use_offhand`). Nearest player at launch was right in only ~60 % of the cases in the reference project's measurement | **not available** (heuristic only) |
| Smoke duration / size | **not in the demo** (client-side effect) → constant | n/a, constant |

---

## 4. Detection rules in detail

**Kills.** One kill per obituary event entity, played once when the entity
appears in a snapshot (exactly as the client does) – no time-window
de-duplication needed; 119 kills in `demo0025`, identical to the reference
project's result after its de-duplication.

**Weapons.** Weapon index `w` → `CS2258.split(' ')[w-1]`; readable names via a
mapping table (`ak47_mp` → "AK-47", suffixes `_silencer`/`_reflex`/`_acog`,
MOD names `MOD_FALLING` → "Falling"). Index 0 → "none".

**Round ends (Promod S&D).** A round runs from the fast restart (`n`) to the
next team score change (`G`/`H`). The reason is taken from, in this order: bomb
defused message → bomb planted and attack won ("Bomb exploded") → status line
"Attack/Defence eliminated" → status line "Time Elapsed". The knife round is
marked by status line "Knife Round"; strat time by "Strat Time".

**Live start (end of strat time).** Config string 11 (game end time) is set
when the round timer starts; in the same snapshot the status line "Strat Time"
is cleared. Checked on all 53 sample demos: in every regular round CS 11 is set
exactly 6000 ms after the fast restart, the first player movement follows in
the next snapshot (+50–100 ms), and no kill lies between restart and CS 11.
Knife rounds get no CS 11 and have no strat time (kills from 0.9 s after the
restart; the "Knife Round" banner is cleared after 6 s but players already
fight), so their live start is the restart. A round already running when the
recording starts begins at the first snapshot (or at CS 11 if the recording
starts inside the strat time, e.g. +5850 ms). No heuristic is involved. The map
replay skips `[restart, live start)` and uses it as 00:00 of the round.

**Bomb plant/defuse.** `f "MP_EXPLOSIVES_PLANTED_BY<name>"`,
`…DEFUSED_BY<name>`, also `RECOVERED` (picked up) and `DROPPED`. The name is
matched to a client.

**Halftime.** Config string update of a sound alias containing `halftime`
(index differs per map/mod, e.g. 1360–1362) followed by all players swapping
between axis and allies. Only the first occurrence per swap counts.

**Timeouts.** `f "Timeout called by <name>"` (22 occurrences in the samples).

**Ready status.** See 3.7 – per-player ready is not in a client demo.

**Colour codes.** `^0`–`^9` (and Promod's `^:` `^;` …) plus localisation marker
bytes 0x14–0x16 are stripped for search/sort and rendered as colours in names.

---

## 5. Grenades

* Thrown grenades are entities of type `missile` with the grenade weapon,
  trajectory type gravity, launch time, trajectory base and velocity. Identity
  = entity number + launch time (entity numbers are reused).
* The server transmits a new trajectory at each bounce (`grenade_bounce`
  events); between transmissions the path is computed:
  `pos = base + vel·dt`, `z −= ½·800·dt²`.
* Detonation: the grenade entity disappears and **one snapshot later (always
  50 ms, measured on all 177 throws of `demo0025`)** a separate event entity
  with the same grenade weapon fires `grenade_explode` (frag) /
  `custom_explode` (smoke) / `flashbang_explode` (flash) at the detonation
  point. The viewer links it to the grenade of the same weapon that vanished
  last (nearest first); explosion time and position are exact.
* Smoke: the cloud itself is not an entity – its duration and radius are
  constants of the viewer (configurable in `map/config.js`, marked as such).
* Concussion grenades do not appear in the samples (not allowed by Promod);
  if present they would be `concussion_grenade_mp`; their detonation event is
  unverified.

---

## 6. Maps and calibration

**Images** (`source/maps`, identical copies in both reference projects):
`backlot.png`, `citystreets.png`, `crash.png`, `crossfire.png`,
`district.png`, `strike.png` – PNG, 1000 × 1000 px. Naming: map name without
`mp_` and without mod suffix (`mp_backlot_x` → `backlot`).
`citystreets.png` and `district.png` show the same layout (different files);
`mp_citystreets` is the map called "District" in game.

**Calibration.** No calibration file exists in the reference projects – and
none is needed: every demo carries the world rectangle of the compass image in
config string 823, e.g. `"compass_map_mp_crash" 2735 2528 -1959 -2166`. The
image covers exactly that rectangle, axis-aligned: image left = min x, image
right = max x, image top = max y, image bottom = min y (world y up), no
rotation (`northyaw` CS 822 = 0 in all samples).

**Verified** (overlaying 27,000–65,000 real player positions per map on the
images): the tracks follow the corridors exactly on backlot, crash, strike,
crossfire and citystreets (both images). A 90° variant (CoD4's compass "up =
+X" convention) visibly does not fit, so these images are already oriented
north-up in world coordinates.

`assets/maps/maps.js` holds per map: image file and the rectangle from CS 823
as fallback/documentation; the viewer uses the rectangle from the demo when
present. (It is a `.js` file instead of `maps.json` because `fetch()` is
blocked on `file://` and the viewer must run from a double-clicked
`index.html`.)

**Maps without calibration:** none of the sample maps - every demo carries CS
823. **Maps without image:** `mp_cluster`. A demo without CS 823 and an unknown
map falls back to a grid fitted to the bounding box of all positions.

| Map in the samples | Image | Calibration |
|---|---|---|
| mp_backlot_x | backlot.png | CS 823 (2896 2616 / −2400 −2680) – verified |
| mp_crash | crash.png | CS 823 (2735 2528 / −1959 −2166) – verified |
| mp_strike | strike.png | CS 823 (3304 2904 / −3128 −3528) – verified |
| mp_crossfire | crossfire.png | CS 823 (8288 1280 / 640 −6368) – verified |
| mp_citystreets | citystreets.png (district.png) | CS 823 (7712 2816 / 1376 −3520) – verified |
| **mp_cluster** (custom map) | **no image** | CS 823 present (448 5952 / −4672 832) → neutral grid in that rectangle |

---

## 7. Not available or heuristic – summary

**Not available in a client demo**

* Per-player ready status (only POV status, count of not-ready players,
  "all ready").
* Grenade thrower.
* Positions / actions of players outside the POV's view (gaps).
* Smoke cloud duration and size.
* Weapon of a headshot kill in the obituary.
* Trigger-hurt vs. other world deaths.
* Input/console commands of any player.
* Team chat of the opposing team.
* Exact recording start date (only map start time on the server).

**Heuristic (marked `≈`)**

* Clan tag / team name from name prefixes.
* Record date = map start time.
* Chat sender (name matching).
* Weapon of headshot kills (killer's held weapon).
* Round reason when no Promod status line is present.
* Own kill/death count used only as scoreboard fallback.

**Untested**

* Stock 1.7 / 1.8 match demos (none available).
* Game modes other than S&D and servers without Promod (round logic relies on
  fast restarts, `G`/`H` scores and Promod status lines).
* Bomb explosion kills and concussion grenades (not in the samples).

---

## 8. Findings during implementation

Measured on the sample demos while building the viewer; they changed rules
above.

* **Side swaps are spread out.** After the knife round the players switch
  sides one after another over up to 8 s. A swap is therefore a cluster of
  side changes (each within 5 s of the previous one) covering at least 60 % of
  the playing clients; every player is normalised with his own change.
* **Team kills** are decided by the sides of both players at the moment of the
  kill (client states), not by the team overall.
* **Scores:** `G`/`H` are sent one after the other; at halftime they swap (axis
  11 → 1, allies 1 → 11). Changes within 1 s of a restart are never round wins;
  score sums are only evaluated after a complete burst.
* **Knife round wins** raise the side's score on the server (e.g. 0 → 1) and are
  reset afterwards; they are not counted for the match.
* **Falling deaths** do not count as deaths in the Promod scoreboard.
* **Status lines** ("Attack eliminated" ...) are sent by `promod_x` V2.76 but not
  by `fps_promod_285` "Match MR12".

---

## 9. Test results

`tools/selftest.html` over all 53 sample demos (browser, main thread, 11 s in
total): **no decoding error, no plausibility problem** (round wins = final
score = the server's team scores at the last round, events chronological, no
NaN / undefined). The kill feed of every demo is **identical** to the
independent Python extractor (`python/`, FNV signature over attacker, victim,
weapon for all 53 demos).

Kills per player = scoreboard kills in 48 of 53 demos. The 5 others:
`TjLEPKo1` (recording starts at 9:7 - the scoreboard contains the earlier
rounds), `FXrJV0U6`, `Q4yUjGvh`, `JsjiwJTx` (one player each reconnected -
the game's scoreboard restarts at 0 for him), `HWybxCU0` (2 players off by 1).
The scoreboard values are shown; the differences are logged with
`console.debug`.

| Demo | MB | ms | Rounds | Final score | Server | Kills | Scoreboard diffs |
|---|---|---|---|---|---|---|---|
| ^8inf_vs_myquest_^9backlot | 18.3 | 310 | 23 | 13:10 | 13:10 | 211 | 0 |
| ^8inf_vs_myquest_^9strike | 12.8 | 249 | 16 | 13:3 | 13:3 | 132 | 0 |
| ^8infes_^9alpha | 16.6 | 323 | 21 | 8:13 | 8:13 | 195 | 0 |
| ^8lafine_^9backlot | 19.4 | 325 | 24 | 11:13 | 11:13 | 188 | 0 |
| ^8lafine_^9cluster | 14.0 | 201 | 19 | 6:13 | 6:13 | 158 | 0 |
| ^8lafine_^9knife | 2.6 | 45 | 0 (knife) | – | – | 27 | 0 |
| ^8lafine_^9strike | 18.8 | 364 | 19 | 6:13 | 6:13 | 190 | 0 |
| ^9inf_^8warz | 10.4 | 182 | 16 | 13:3 | 13:3 | 114 | 0 |
| backlot_deox1st | 8.5 | 127 | 15 | 13:2 | 13:2 | 107 | 0 |
| cas1_backlot | 16.1 | 249 | 22 | 9:13 | 9:13 | 212 | 0 |
| cas1_city | 16.0 | 375 | 20 | 7:13 | 7:13 | 174 | 0 |
| cas1_crash | 0.3 | 6 | 0 | – | – | 2 | 0 |
| cas1_knife | 1.4 | 20 | 0 (knife) | – | – | 6 | 0 |
| cas1_knife2 | 0.5 | 8 | 1 | 1:0 | 1:0 | 7 | 0 |
| cas1_strike | 16.4 | 304 | 16 | 3:13 | 3:13 | 161 | 0 |
| demo0024 | 14.7 | 216 | 22 | 9:13 | 9:13 | 168 | 0 |
| demo0025 | 8.7 | 119 | 15 | 13:2 | 13:2 | 119 | 0 |
| demo0026 | 13.7 | 247 | 20 | 13:7 | 13:7 | 165 | 0 |
| deox | 18.1 | 285 | 24 | 13:11 | 13:11 | 241 | 0 |
| deox_map2 | 10.8 | 187 | 16 | 13:3 | 13:3 | 119 | 0 |
| deox_map3_cluster | 14.0 | 195 | 19 | 13:6 | 13:6 | 166 | 0 |
| deoxstrike2nd | 16.0 | 283 | 23 | 10:13 | 10:13 | 198 | 0 |
| FPS_324087_mp_backlot_x_BDaN | 7.2 | 139 | 13 | 13:0 | 13:0 | 96 | 0 |
| FPS_324089_mp_crash_E6Hk | 17.3 | 346 | 20 | 7:13 | 7:13 | 163 | 0 |
| FPS_324092_mp_strike_pdy1 | 8.5 | 168 | 15 | 2:13 | 2:13 | 111 | 0 |
| FPS_327111_mp_crash_bFjF | 15.0 | 303 | 23 | 13:10 | 13:10 | 159 | 0 |
| inf_vs_myquest_knife | 1.7 | 38 | 0 (knife) | – | – | 33 | 0 |
| lafine_knife | 2.0 | 39 | 0 (knife) | – | – | 10 | 0 |
| Match_mp_backlot_x_8xQPAHh5 | 10.5 | 186 | 18 | 5:13 | 5:13 | 140 | 0 |
| Match_mp_backlot_x_f3MQE16i | 17.9 | 281 | 23 | 13:10 | 13:10 | 207 | 0 |
| Match_mp_backlot_x_uGGDzj83 | 12.0 | 203 | 18 | 5:13 | 5:13 | 136 | 0 |
| Match_mp_backlot_x_uR4pgAiK | 10.6 | 232 | 18 | 5:13 | 5:13 | 140 | 0 |
| Match_mp_backlot_x_ZTIXQWnu | 17.9 | 277 | 23 | 13:10 | 13:10 | 207 | 0 |
| Match_mp_cluster_6Bp3FC6s | 0.3 | 4 | 1 (incomplete) | 0:0 | – | 0 | 0 |
| Match_mp_cluster_HWybxCU0 | 16.3 | 253 | 20 | 7:13 | 7:13 | 188 | 2 |
| Match_mp_cluster_jOZum75b | 12.6 | 143 | 0 | – | – | 8 | 0 |
| Match_mp_crash_5xynbeJD | 14.7 | 226 | 22 | 13:9 | 13:9 | 178 | 0 |
| Match_mp_crash_c5l9TsrJ | 10.2 | 153 | 19 | 13:6 | 13:6 | 149 | 0 |
| Match_mp_crash_eCMiGVlm | 16.1 | 295 | 22 | 9:13 | 9:13 | 165 | 0 |
| Match_mp_crossfire_0JILLpdq | 15.6 | 252 | 23 | 13:10 | 13:10 | 175 | 0 |
| Match_mp_crossfire_FXrJV0U6 | 9.6 | 150 | 18 | 12:6 | 12:6 | 93 | 1 |
| Match_mp_crossfire_Q4yUjGvh | 16.6 | 302 | 22 | 13:9 | 13:9 | 191 | 2 |
| Match_mp_strike_3A39ZNZr | 12.6 | 233 | 20 | 7:13 | 7:13 | 154 | 0 |
| Match_mp_strike_Bl3Yj3WC | 12.6 | 266 | 16 | 13:3 | 13:3 | 128 | 0 |
| Match_mp_strike_BpCHnb5O | 11.1 | 221 | 16 | 6:9 | 6:9 | 127 | 0 |
| Match_mp_strike_DR1ux4gv | 12.4 | 220 | 16 | 13:3 | 13:3 | 128 | 0 |
| Match_mp_strike_JsjiwJTx | 20.0 | 414 | 20 | 13:7 | 13:7 | 176 | 1 |
| Match_mp_strike_KG4JQgq7 | 12.7 | 246 | 20 | 13:7 | 13:7 | 146 | 0 |
| Match_mp_strike_nxzWi1lO | 1.6 | 41 | 1 | 1:0 | 1:0 | 11 | 0 |
| Match_mp_strike_qPN2I122 | 12.7 | 267 | 20 | 13:7 | 13:7 | 146 | 0 |
| Match_mp_strike_TjLEPKo1 | 2.2 | 41 | 4 (from round 17) | 13:7 | 13:7 | 28 | 9 |
| sleedy_backlot | 17.9 | 296 | 23 | 13:10 | 13:10 | 207 | 0 |
| sleedy_strike | 12.4 | 243 | 16 | 13:3 | 13:3 | 128 | 0 |

Comparison with the reference project `info/cod-demo` on `demo0025`: same
final score (ALPHA 13 : 2 RL), same 15 rounds, same per-player kills / deaths
(e.g. ALPHA Shooter 19 / 5), same kill feed.

---

## 10. Test data

`C:\Claude\cod4-demo\demos`: 53 demos, 0.3–20 MB, CoD4X protocol 21, Promod
(`promod_x`, `fps_promod_285/288`), S&D on backlot_x, crash, strike, crossfire,
citystreets, cluster; rulesets "Knockout (Knife) MR12 OT3", "Match MR12",
"Strat Mode"; includes knife rounds, halftimes, timeouts, substitutions,
spectators/shoutcasters, and very short demos. Reference results for
comparison: `info/cod-demo` (JS + Python) – kill feed of `demo0025` identical
with the Python extractor.
