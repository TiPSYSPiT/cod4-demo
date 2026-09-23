# cod4demo — extract everything from Call of Duty 4 demos

`cod4demo` is a Python package that reads Call of Duty 4: Modern Warfare (2007,
IW3) demo files (`.dm_1`) and extracts all the data they contain: the container
records, the gamestate, every config string, every reliable server command,
and every snapshot, fully delta-decoded (player state, all entities, all client
states). On top of that it builds ready-to-use tables: players, kill feed,
bullet hits, shots, chat, scoreboards, positions, grenades, HUD, objectives and
more.

* Pure Python, **standard library only**, Python 3.9 or newer
* Stock CoD4 demos and CoD4X demos (protocol 17, 19, 21 tested)
* Output as CSV, JSON Lines or JSON, or use it as a library
* About 10–17 s for a 15–20 MB match demo (5 s for 8 MB)

This is step one of the demo inspector/analyzer project: getting the data out.
Round detection, statistics and visualisation build on these tables later.

---

## Contents

1. [Quick start](#1-quick-start)
2. [Command line](#2-command-line)
3. [Using it as a library](#3-using-it-as-a-library)
4. [Output reference: all tables and columns](#4-output-reference)
5. [How a demo is built (what the parser reads)](#5-how-a-demo-is-built)
6. [What can be read — overview](#6-what-can-be-read)
7. [What cannot be read (yet)](#7-what-cannot-be-read-yet)
8. [Verification](#8-verification)
9. [Project layout](#9-project-layout)
10. [Sources and licence](#10-sources-and-licence)

---

## 1. Quick start

```bash
cd C:\Claude\cod4-demo\source\python
py -m cod4demo ..\..\demos\demo0025.dm_1
```

writes `out\demo0025\` with `summary.json` and one CSV file per table.

```bash
py -m cod4demo --info ..\..\demos\demo0025.dm_1
```

prints a summary without writing anything:

```
file        demo0025.dm_1  (8,662,227 bytes)
protocol    21 - CoD4X
server      ARMY League Server > Mars  (CoD4 X - linux-i386-custom build 1229 Sep 18 2026)
map / mode  mp_cluster / sd   fs_game mods/promod_x
recorder    client 0 = ALPHA z1nkARY'
length      987.7 s of server time, 19,732 snapshots, 123,723 archive frames
integrity   clean end True, truncated False, snapshots dropped 0, issues 0
tables:
  kills                        119
  hits                         236
  player_positions         133,589
  ...
```

No installation is needed; run it from the `source\python` folder (or put that
folder on `PYTHONPATH`).

---

## 2. Command line

```
py -m cod4demo DEMO [DEMO|FOLDER ...] [options]
```

| Option | Effect |
|---|---|
| `-o DIR`, `--out DIR` | Output folder. One demo: files go straight into `DIR`. Several demos: one sub-folder per demo. Default `out\<demo name>\`. |
| `--format csv\|jsonl\|json` | `csv` (default): one CSV per table. `jsonl`: one JSON Lines file per table. `json`: all tables in one `tables.json`. |
| `--tables a,b,c` | Only write these tables (e.g. `--tables kills,hits,chat`). |
| `--full` | Additionally write `snapshots_full.jsonl`: the complete decoded state of **every snapshot** (see [4.8](#48-snapshots_fulljsonl---full)). Large: roughly 50 × the demo size. |
| `--info` | Print a summary, write nothing. |
| `--selftest` | Rebuild the Huffman tree from the engine's frequency table and compare it with the shipped table. |
| `-q`, `--quiet` | No progress output. |

A folder argument processes every `*.dm_*` file in it.

`summary.json` always contains the metadata (see [4.1](#41-summaryjson)) and a
list of all tables with their row counts, columns and a one-line description.

To check a whole folder of demos for decoding problems:

```bash
py tools\verify.py ..\..\demos --csv verify.csv
```

---

## 3. Using it as a library

### High level: `extract()`

```python
import sys
sys.path.insert(0, r"C:\Claude\cod4-demo\source\python")
from cod4demo import extract, write_all

data = extract(r"C:\Claude\cod4-demo\demos\demo0025.dm_1")

print(data.meta["map"], data.meta["gametype"], data.meta["pov_name"])
for k in data.kills.dicts():                 # every table: .columns, .rows, .dicts()
    print(k["server_time"], k["attacker_name"], k["weapon_name"], k["victim_name"])

print(data.serverinfo["sv_hostname"])        # parsed config string 0
print(data.systeminfo["sv_pure"])            # parsed config string 1
print(data.tables.keys())                    # all table names

write_all(data, "out/demo0025", fmt="csv")   # same files as the command line
```

`extract(path, full_output=None, progress=None)`

* `full_output`: path of a JSON Lines file that receives the full per-snapshot
  dump (as `--full`).
* `progress`: callable receiving a fraction between 0 and 1.

A `Table` has `.name`, `.columns`, `.rows` (lists in column order),
`.description`, `len(table)` and `.dicts()` (generator of dicts). Rows are
kept as lists rather than dicts to keep memory low.

### Low level: `DemoParser`

`DemoParser` walks the file and yields one event object per item, in file
order. Nothing is interpreted beyond what the game client itself does while
reading.

```python
from cod4demo import DemoParser, Gamestate, ServerCommand, Snapshot, ArchiveFrame
from cod4demo.states import entity_dict, ps_dict, client_dict

for ev in DemoParser("demo.dm_1"):
    if isinstance(ev, Gamestate):
        print(len(ev.configstrings), "config strings, recorder =", ev.client_num)
    elif isinstance(ev, ServerCommand):
        print(ev.server_time, ev.text)
    elif isinstance(ev, Snapshot):
        ps = ps_dict(ev.ps)                          # 141 fields + stats, named and typed
        for number, raw in ev.entities:              # complete entity list of this snapshot
            ent = entity_dict(raw)                   # named per entity type
        for number, raw in ev.clients:
            cl = client_dict(raw)
```

| Event | Content |
|---|---|
| `ProtocolInfo` | CoD4X protocol record: `protocol`, `legacy_end`, `reserved` |
| `ArchiveFrame` | client archive record: `index`, `origin`, `velocity`, `movement_dir`, `bob_cycle`, `server_time`, `angles` |
| `Gamestate` | `configstrings` {index: text}, `baselines` {entity: raw state}, `clients` {client: (name, clan tag)}, `server_command_seq`, `server_config_seq`, `client_num` (recorder), `checksum_feed` |
| `ConfigClient` | name / clan tag update outside the gamestate |
| `ServerCommand` | `seq`, `text`, `server_time`, `message_seq` |
| `Snapshot` | `server_time`, `message_seq`, `delta_num`, `snap_flags`, `ps` (`PlayerState`), `entities`, `clients`, `info.changed_entities`, `info.removed_entities`, `info.changed_clients` |
| `ReliableMessage` | raw CoD4X reliable record (`command`, `data`) |
| `Download` | raw `svc_download` payload |
| `ParseIssue` | anything that could not be decoded, with offset and reason |
| `DemoEnd` | `clean` (end marker found), `truncated` |

`DemoParser(path, decode_snapshots=False)` skips snapshot decoding and only
reads gamestate, config strings and server commands (much faster).

Raw state values are 32-bit patterns exactly as the engine keeps them;
`cod4demo.states` converts them (`entity_dict`, `entity_delta_dict`, `ps_dict`,
`client_dict`, `hud_dict`, `objective_dict`, `flag_names`, `perk_names`).

---

## 4. Output reference

Conventions for all tables:

* **`server_time`** is the server clock in milliseconds (as in the snapshots).
  The first snapshot's time is in `summary.json` → `meta.first_server_time`;
  subtract it for "seconds into the demo".
* **Client numbers** (0–63) identify players everywhere. Names are in the
  `names` table and in `summary.json` → `meta.players`.
* **Entity numbers** (0–1023): 0–63 are the players, 1022 is the world,
  1023 means "none".
* **Weapon numbers** index the server's weapon list (config string 2258,
  1-based; `summary.json` → `meta.weapons`). Every `weapon` column has a
  `weapon_name` next to it.
* Coordinates are game units (about one inch), angles are degrees.
* Empty cells mean "not known / not transmitted".
* Names and texts keep CoD4 colour codes (`^1`) and localisation markers
  (bytes 0x14–0x16) exactly as sent. Only `chat.message`,
  `game_messages.text` and `meta.hostname_clean` are cleaned; the `raw`
  columns next to them keep the original.

### 4.1 `summary.json`

| Key | Content |
|---|---|
| `meta.file`, `size_bytes`, `sha1` | the file |
| `meta.protocol`, `protocol_kind` | 1 = stock CoD4 (no protocol record), 17 = CoD4X with legacy origin encoding, 18+ = CoD4X |
| `meta.clean_end`, `truncated` | end marker found / last record cut off |
| `meta.records` | counts: records, messages, archive frames, snapshots, dropped snapshots, server commands, gamestates, decompressed bytes, issues |
| `meta.decode_errors` | snapshots the delta decoder had to drop |
| `meta.gamestate` | server command sequence, config data sequence, recorder client number, checksum feed, number of config strings and baselines |
| `meta.pov_client`, `pov_name` | the recording player |
| `meta.first_server_time`, `last_server_time`, `duration_s` | snapshot time span |
| `meta.first_archive_time`, `last_archive_time` | archive frame time span |
| `meta.map`, `gametype`, `hostname`, `hostname_clean`, `fs_game`, `server_version`, `game_version`, `map_start_time` | from config strings 0 and 2 |
| `meta.map_center` | config string 12 |
| `meta.minimap` | config string 823: compass material and the world coordinates of its corners (to place positions on a minimap image) |
| `meta.weapons` | the server's weapon list (index 1 = first entry) |
| `meta.players` | client → name, clan tag, last team |
| `meta.event_counts` | how often each event type occurred |
| `meta.tables` | rows per table |
| `serverinfo`, `systeminfo` | config strings 0 and 1 parsed into key/value pairs (all server and system cvars sent to clients: `sv_hostname`, `g_gametype`, `mapname`, `sv_maxclients`, `version`, `sv_pure`, `sv_iwds`, `sv_referencedFFNames`, …) |
| `tables` | every table with rows, columns, description |

### 4.2 Server data

**`configstrings`** — final state of every config string that was transmitted.
`index`, `category` (see below), `category_offset`, `value`, `source`
(`gamestate`, `update`, `gamestate+update`), `updates` (number of later
changes), `last_update_time`.

Categories (MP layout of patch 1.7): `serverinfo` 0, `systeminfo` 1,
`game_version` 2, `message` 3, `scores1/2` 4–5, `culldist` 6, `sunlight` 7,
`sundir` 8, `fogvars` 9, `motd` 10, `gameendtime` 11, `mapcenter` 12,
`vote_*` 13–18, `multi_mapwinner` 19, `codinfo_name` 20–147,
`codinfo_value` 148–275, `enemy_crosshair` 276, `use_trigger_string` 277–308,
`localized_string` 309–820, `ambient` 821, `northyaw` 822, `minimap` 823,
`visionset_naked/night` 824–825, `nightvision` 826,
`location_selection_material` 827–829, `model` 830–1341,
`sound_alias` 1342–1597, `effect` 1598–1697, `effect_tag` 1698–1953,
`shellshock` 1954–1969, `script_menu` 1970–2001, `server_material` 2002–2257,
`weaponfiles` 2258, `status_icon` 2259–2266, `head_icon` 2267–2281,
`tag` 2282–2313, `items` 2314, and `extended` for CoD4X indexes ≥ 2442.

**`configstring_changes`** — every update after the gamestate (server command
`d`, or the `x`/`y`/`z` pieces of a long string): `server_time`,
`message_seq`, `index`, `category`, `old_value`, `new_value`. Mods keep a lot
of live state here (Promod: round status lines, HUD headers, bomb timer).

**`dvars`** — the dvars the server announces to clients (config strings 20–147
hold the names, +128 the values): `index`, `name`, `value`. For example
`ui_friendlyfire`, `ui_timelimit`, `ui_scorelimit`, `scr_axis`, `scr_allies`,
`g_TeamName_Axis`, `bg_fallDamageMinHeight`, all movement physics dvars.

**`server_commands`** — every reliable server command, raw: `server_time`,
`message_seq`, `cmd_seq`, `verb` (first character), `name`, `text`.

| Verb | Name | Meaning |
|---|---|---|
| `b` | scoreboard | `b <n> <axis> <allies> <limit>` + n × `<client> <score> <ping> <deaths> <status icon> <kills> <assists>` |
| `d` | configstring | config string update |
| `x` `y` `z` | big_configstring_* | long config string in pieces |
| `h` / `i` | chat / team_chat | chat line |
| `c` `e` `f` `g` | announcement / game_message / bold_game_message | messages (kill feed texts, "joined", bomb planted, damage feedback …) |
| `G` / `H` | team_score_axis / _allies | team score |
| `I` | client_score | single score update |
| `v` | set_client_dvars | dvars set on the recording client |
| `a` / `C` | select_weapon / set_equipped_offhand | weapon index for the recorder |
| `B` / `n` | map_restart / map_restart_persist | (fast) restart, e.g. every S&D round |
| `J` `K` `L` `N` `t` `u` `o` `p` `q` `r` `s` `k` `j` `D` `E` `F` | menus, stats, music, sounds, reverb, dynamic entity destruction | see `constants.SERVER_COMMANDS` |
| `w` | disconnect | disconnect reason |
| other | unknown | not handled by the stock client; in the samples only `m` (no arguments, sent right before every fast restart); kept raw |

**`chat`** — `server_time`, `scope` (`all`/`team`), `sender_client`,
`sender_name`, `message` (clean text), `raw`. The sender is not a separate
field in the protocol; it is recovered by matching the known player names at
the start of the line (prefixes such as `(GAME_DEAD)` or a team name are
skipped). Quick messages appear as their localisation key
(`QUICKMESSAGE_GREAT_SHOT`).

**`game_messages`** — `server_time`, `verb`, `kind`, `text` (clean), `raw`.

**`scoreboards`** / **`scoreboard_entries`** — every scoreboard the server sent
(`count`, team scores, score limit) and one row per player: `client`, `name`,
`score`, `ping`, `deaths`, `kills`, `assists`, `status_icon`.

**`team_scores`** (`team`, `score`), **`client_scores`** (`client`, `score`),
**`client_dvars`** (`name`, `value`), **`pov_commands`** (`verb`, `name`,
`args` as JSON list).

### 4.3 Players

**`names`** — every name / clan tag announcement: `server_time` (empty = in
the gamestate), `client`, `name`, `clantag`, `source` (`gamestate`,
`configclient`, `client_state`). CoD4X sends full names and clan tags via
the gamestate / configclient and leaves the client state's name empty; stock
servers use the client state, which carries only the first 16 bytes of a name.

**`client_states`** — a row whenever a player's client state changes:
`team` (0 free, 1 axis, 2 allies, 3 spectator) and `team_name`, `netname`,
`rank`, `prestige`, `perks` (bit mask) and `perk_names`, `modelindex`,
`attached_models`, `attached_tags`, `max_sprint_time_mult`,
`attached_veh_ent`, `attached_veh_slot`, `changed` (field names that changed,
`new`, or `removed` when the client left).

**`player_positions`** — the position of every player in every snapshot:

| Column | Meaning |
|---|---|
| `server_time`, `client` | |
| `source` | `entity` (the player as seen by the recorder) or `playerstate` (the player the recorder is / follows) |
| `transmitted` | the entity was sent in this snapshot (otherwise unchanged since the last one) |
| `x` `y` `z` | position (feet) |
| `pitch` `yaw` `roll` | view angles |
| `weapon`, `weapon_name` | weapon **held** |
| `eflags` | raw entity flags |
| `stance` | `stand` / `crouch` / `prone` (eFlags 0x4 / 0x8) |
| `firing` | eFlags 0x40 (the animation code's "firing" condition) |
| `dead` | eFlags 0x20000, or a dead player state |
| `lean` | lean fraction (−1 … 1) |
| `movement_dir` | movement direction relative to the view (signed value as sent) |
| `legs_anim`, `torso_anim` | animation numbers as sent |
| `ground_entity` | entity stood on (1022 = world, 1023 = in the air) |
| `torso_pitch`, `waist_pitch` | |

A player only appears while the server sends them to the recorder (see
[7](#7-what-cannot-be-read-yet)).

### 4.4 The recording player

**`pov`** — the player state, one row per snapshot. It belongs to the
recorder, or to the teammate the recorder spectates after dying (`client`,
`spectating`).

`pm_type` / `pm_type_name` (normal, spectator, intermission, dead …),
`pm_flags` / `pm_flags_names` (prone, ducked, mantle, ladder, sight_aiming,
sprinting, jumping, …), `eflags`, `stance`, `health`, `max_health`, `x y z`,
`vx vy vz` (velocity), `pitch yaw roll`, `weapon` / `weapon_name` (held),
`weaponstate` / `weaponstate_name` (ready, firing, reloading, sprint_loop …),
`offhand` / `offhand_name`, `weapons_mask` and **`inventory`** (all weapons the
player carries), `perks`, `ads_frac` (0 = hip, 1 = aiming down sights),
`lean`, `view_height`, `damage_event` / `damage_yaw` / `damage_pitch` /
`damage_count` (damage taken: direction and amount indicator),
`grenade_time_left` (cooking), `shellshock_index` / `shellshock_time`,
`killcam_entity`, `cursor_hint`, `spawn_count`, `ident_client` (player under
the crosshair), `command_time`, `origin_source`.

`origin_source` tells where position, velocity and angles come from: `sent`
(transmitted in this snapshot), `archive` (not sent because they matched the
client's own prediction; like the game, the parser takes them from the
archive frame of that command time) or `previous` (no archive frame for that
time, the previous values are kept as the engine does; empty before the first
known position).

**`pov_ammo`** — every change of the 128 ammo and 128 clip counters:
`server_time`, `kind` (`ammo` / `clip`), `slot`, `value`. The slot is the
weapon's ammo/clip index from the weapon definition files (not in the demo);
a clip counter that drops by one is one shot of the recorder.

**`pov_archive`** — the client archive frames: the recorder's own predicted
position, velocity, view angles, movement direction and bob cycle at the
recorder's frame rate (8 ms apart in the sample demos): `index`, `server_time`, `x y z`, `vx vy vz`,
`pitch yaw roll`, `movement_dir`, `bob_cycle`. This is the most precise view
track of the recorder (aim movement).

**`hud`** — a row whenever a HUD element of the player state changes (game
scripts draw scores, timers, logos and messages with them): `list`
(`current`/`archival`), `slot`, `type` / `type_name` (text, value, material,
timer_down, clock_up, waypoint …; `free` = removed), `text` and `text_string`
(resolved through the localized-string config strings), `label` /
`label_string`, `value`, `x y z`, `color` (R G B A), `material` /
`material_name`, `font`, `font_scale`, `align_org`, `align_screen`, `time`,
`duration`, `target_entity`, `sort`, `flags`, `fields` (all fields as JSON).

**`objectives`** — a row whenever one of the 16 objectives changes:
`slot`, `state` / `state_name` (empty, active, invisible, done, current,
failed), `x y z`, `icon` / `icon_name` (e.g. `compass_waypoint_defend_a`),
`entity`, `team`.

### 4.5 Combat

**`kills`** — the kill feed (every obituary event):

| Column | Meaning |
|---|---|
| `attacker`, `attacker_name`, `attacker_team` | killer: a client number, 1022 = world, other numbers ≥ 64 = a non-player entity (e.g. an exploding car, named `<entity N: type>`) |
| `victim`, `victim_name`, `victim_team` | |
| `weapon`, `weapon_name` | weapon index; empty when a means of death is sent instead; `0`/`none` when the server sent no weapon |
| `mod`, `mod_name` | means of death, only sent for knife (`MOD_MELEE`), headshot (`MOD_HEAD_SHOT`), crush, falling, suicide and impact |
| `headshot`, `suicide`, `world`, `teamkill` | flags |
| `attacker_x/y/z`, `victim_x/y/z`, `distance` | last known positions (at most 1 s old); empty when unknown |
| `event_parm` | raw value |

For a headshot the server sends `MOD_HEAD_SHOT` instead of the weapon, so the
weapon of a headshot kill is not in the obituary (it can usually be taken
from `player_positions.weapon` of the attacker).

**`hits`** — bullet hits on players:

| `kind` | Source event | Who receives it | Content |
|---|---|---|---|
| `seen` | `EV_BULLET_HIT` on flesh | everyone except the victim, if in view | attacker, weapon, **headshot flag**, hit position; victim **inferred** (nearest player to the impact, `victim_inferred = 1`, `victim_distance`) |
| `taken` | `EV_BULLET_HIT_CLIENT_SMALL/LARGE` | only the victim | attacker, weapon, victim (the recorder or the player it spectates), hit position |

**`entity_events`** — every event the game client would play, from three sources:

| `source` | Meaning |
|---|---|
| `event_entity` | temporary event entities (obituary, bullet hits, sounds, effects, explosions …); `fields` holds all their transmitted fields as JSON |
| `entity` | the 4-slot event ring of normal entities (players: `fire_weapon`, `reload`, `jump`, `footstep_*`, `landing:<surface>`, `melee_*`, `raise_weapon`, …; grenades: `grenade_bounce`, `grenade_explode`) |
| `playerstate` | the event ring of the player state (the recorder / followed player) |

Columns: `server_time`, `message_seq`, `source`, `entity`, `entity_type`,
`client`, `event`, `event_name`, `event_parm`, `x y z`, `other_entity`,
`attacker_entity`, `weapon`, `weapon_name`, `surf_type`, `resolved`
(sound alias or effect name for sound/fx events), `ring_lost` (events of that
ring overwritten before this snapshot, see [7](#7-what-cannot-be-read-yet)),
`fields`.

Counting `fire_weapon` + `fire_weapon_lastshot` of source `entity` per client
gives the **shots fired** by every player while visible to the recorder.

**`missiles`** — every missile entity (grenades, projectiles) in every
snapshot: `entity`, `transmitted`, `weapon`, `weapon_name`, `launch_time`,
`tr_type` (trajectory type: 5 = gravity, 0 = at rest), `tr_time`, `x y z`
(trajectory base), `vx vy vz` (trajectory velocity), `ground_entity`, `eflags`.
With the trajectory the flight path between transmitted points can be
computed: for `tr_type` 5, `pos(t) = base + vel·dt`, minus `½·800·dt²` on z,
with `dt = (t − tr_time) / 1000` seconds.

**`grenades`** — one row per thrown missile (entity number + launch time):
`weapon`, `launch_time`, `first_time`, `last_time`, start position and
velocity, last position, number of transmitted `points`, and
`explode_time` / `explode_x/y/z` when a `grenade_explode` / `flashbang_explode`
event was seen for it. Smoke grenades usually stop being transmitted right
after the throw.

### 4.6 Other entities

**`entities`** — the lifetime of every non-player, non-event entity:
`entity`, `entity_type` (player_corpse, item, missile, script_mover, fx,
loop_fx, general …), `first_time`, `last_time`, `snapshots`, `client` (for
corpses: whose corpse), `weapon`, `index`, `model` (script movers / general
entities: model name from config strings), first and last position. Corpses
give death positions; items are dropped weapons and pickups.

**`baselines`** — the entity baselines of the gamestate: `entity`,
`entity_type`, `fields` (JSON).

### 4.7 Technical

**`snapshots`** — one row per snapshot: `message_seq`, `server_time`,
`delta_num` (−1 = full snapshot), `snap_flags`, `num_entities`,
`num_clients`, `changed_entities`, `removed_entities`, `changed_clients`,
`ps_client`, `ps_origin_from_archive`.

**`issues`** — anything that could not be decoded: `offset` (byte offset of
the record), `message_seq`, `text`. Empty for all sample demos except one
fixture (see [8](#8-verification)).

### 4.8 `snapshots_full.jsonl` (`--full`)

One JSON object per snapshot with **everything** the decoder holds:

* `ps`: all 141 player state fields by name, `stats`, `ammo`, `ammoclip`,
  `objectives`, `hud_archival`, `hud_current`, `weaponmodels`
* `entities`: every entity of the snapshot with all fields that are non-zero,
  named according to its entity type, plus `transmitted`
* `removed_entities`
* `clients`: every client state

Use it when a field is needed that no table covers.

---

## 5. How a demo is built

The format was reconstructed from the engine (KisakCOD), the CoD4X client
source (demo recording and playback) and the CoD4-DM1 reference parser, and
then confirmed on the sample demos.

### Container

A `.dm_1` file is a sequence of records, each starting with one type byte:

| Type | Record | Layout |
|---|---|---|
| 2 | protocol (CoD4X only, first record) | `uint32 protocol`, `int32 -1`, 8 reserved bytes |
| 0 | server message | `int32 message sequence`, `int32 length`, `length` bytes: `int32 reliable acknowledge` + Huffman-coded payload. Sequence −1 / length −1 = end of demo |
| 1 | client archive | `int32 index (0–255)`, `float origin[3]`, `float velocity[3]`, `int32 movementDir`, `int32 bobCycle`, `int32 serverTime`, `float angles[3]` |
| 3 | reliable (CoD4X) | `int32 length` + raw data (not Huffman coded) |

The payload of a server message is compressed with CoD4's static Huffman code
(tree built from the engine's `msg_hData` frequency table; `huffman.py`) and
contains a sequence of operations:

| Op | Name | Content |
|---|---|---|
| 1 | gamestate | server command sequence; config strings (CoD4X: count + index/text pairs; stock: 12-bit index coding); entity baselines; CoD4X client names; then config data sequence, recorder client number, checksum feed |
| 4 | serverCommand | `int32 sequence` + text |
| 6 | snapshot | server time, delta reference, flags, delta-coded player state, entity list, client list |
| 11 | configclient | CoD4X name / clan tag update |
| 5 | download | file download (not used in demos) |
| 7 | EOF | end of message |

### Snapshots

Snapshots are delta coded: each field is either unchanged or sent with one of
18 encodings (floats as small integers, angles as 16 bit, times
relative to the snapshot, ground entity, RGBA colours …). The field layout per
entity type comes from 18 tables with 1,047 fields in total
(`_netfields.py`, generated by `tools/gen_netfields.py` and cross-checked
against a second, independent source). One wrong bit and every following field
of the demo would be garbage; `verify.py` reports any snapshot the decoder
cannot follow.

The player state carries, besides its 141 fields: 5 stats (health, max
health …), 128 ammo and 128 clip counters, 16 objectives, 2 × 31 HUD elements
and 128 weapon model bytes. Predicted fields (position, velocity, angles) are
left out when they match the client's prediction; the archive records supply
them then, exactly as the game does.

CoD4X up to protocol 17 (and stock CoD4) encode positions relative to the map
centre (config string 12); newer CoD4X protocols send raw floats. Both are
implemented.

---

## 6. What can be read

| Information | Status | Where |
|---|---|---|
| Protocol, integrity, record counts | read | `summary.json` |
| Server name, map, game type, mod, versions, map start time, all server/system cvars | read | `summary.json`, `configstrings`, `dvars` |
| All transmitted config strings and their changes over time | read | `configstrings`, `configstring_changes` |
| Every reliable server command | read, decoded where the meaning is known | `server_commands` + specialised tables |
| Player names, clan tags, teams, rank, prestige, perks, join/leave | read | `names`, `client_states`, `meta.players` |
| Recording player (POV) and whom it spectates | read | `meta.pov_client`, `pov.client`, `pov.spectating` |
| Scoreboards (score, kills, deaths, assists, ping) and team scores | read | `scoreboards`, `scoreboard_entries`, `team_scores` |
| Chat (all/team) with sender | read (sender by name matching) | `chat` |
| Game messages, announcements | read | `game_messages` |
| Kill feed: killer, victim, weapon or means of death, headshot, suicide, teamkill | read | `kills` |
| Kill distances | derived from positions | `kills.distance` |
| Bullet hits: attacker, weapon, headshot, position (seen by recorder) | read; victim inferred | `hits` (`seen`) |
| Bullet hits taken by the recorder / followed player | read | `hits` (`taken`) |
| Shots fired by every visible player | read | `entity_events` (`fire_weapon`) |
| Reloads, weapon switches, jumps, landings, footsteps, knife swings of visible players | read | `entity_events` |
| Positions, view angles, stance, held weapon, lean, animations of every visible player, every snapshot | read | `player_positions` |
| Death positions | read (corpses) | `entities` (player_corpse) |
| Grenades and projectiles: weapon, launch time, trajectory, explosion time and place | read | `missiles`, `grenades` |
| Dropped weapons / items, script movers, effects | read | `entities` |
| POV: health, damage direction and amount indicator, full inventory, ammo and clip, held weapon, weapon state, ADS, sprint, stance, perks, shellshock | read | `pov`, `pov_ammo` |
| POV: position and aim at client frame rate | read | `pov_archive` |
| POV HUD (scores, timers, hit markers, script messages) | read | `hud` |
| Objectives (e.g. bomb sites) | read | `objectives` |
| Sound and effect events (names resolved) | read | `entity_events.resolved` |
| Everything else in the snapshots | read, unnamed | `snapshots_full.jsonl` |

---

## 7. What cannot be read (yet)

### 7.1 Not in the file at all

A client demo is a recording of what the server sent to **one** client. What
the server never sent cannot be recovered:

* **Players outside the recorder's view.** The server only sends entities in
  the recorder's potential visibility set. Positions, shots, reloads etc. of
  players it cannot see are missing for that time; `player_positions` has gaps
  there. Only the recorder (or the player it spectates) is complete.
* **Health, ammo, inventory of other players.** The full player state exists
  only for the recorder / the player it follows.
* **Damage amounts** for other players. Hits are in the file (`hits`), damage
  numbers are not. For the recorder, `pov.health` and `damage_count` show it.
* **Who threw a grenade.** The missile entity carries no owner, and no event
  on the thrower's entity marks the throw (only the recorder's own
  `use_offhand` appears).
* **Size and duration of smoke clouds** — the client renders them from the
  explosion event; only place and time are known.
* **The recorder's inputs** (keys, mouse, buttons): user commands are not
  stored in demos.
* **Anything before the recording started or after it stopped**, voice chat
  (not recorded), map geometry (only the map name and minimap corners).

### 7.2 In the file, but not (fully) interpreted yet

* **Constant config strings.** The server leaves out config strings whose
  value equals a table built into the game executable; the client fills them
  in from that table. The only available copy (KisakCOD) does not match the
  PC 1.7 index layout (for example it places the weapon list at index 2271,
  real demos have it at 2258), so it is not used. Affected are mostly unused
  localized-string, model and material slots; a HUD text or icon referring to
  such an index shows the index but no string.
* **Localised texts.** Messages, HUD texts and quick messages arrive as
  localisation keys (`QUICKMESSAGE_GREAT_SHOT`, `MP_CONNECTED`); the English
  text is in the game's localisation files, not in the demo.
* **Ammo slots.** `pov_ammo` gives the ammo/clip index, not the weapon; the
  mapping is in the weapon definition files of the game.
* **Model, animation and sound indices** are given as numbers or config
  string names; turning them into geometry or animation names needs game files.
* **Player-state events are a sample.** The recorder's player-state event
  ring has only 4 slots but, while the player is alive, advances by 10–30
  per snapshot (engine-internal events such as `stance_force_stand` /
  `reset_ads` are queued continuously). Most of them are overwritten before a
  snapshot is sent (`ring_lost`); the game's own playback loses them too.
  Other players' entity event rings are different: in `demo0025` they
  overflowed in 0.045 % of snapshots, so their events are essentially
  complete. Use `pov_ammo` (clip decrements) for exact shot counts of the
  recorder.
* **Hit victims seen from outside** are inferred (nearest player to the
  impact within 80 units), marked `victim_inferred`.
* **Chat senders** are recovered by name matching; a name change in the same
  moment, or two players with the same name, can defeat it (`sender_client`
  empty).
* **Non-stock server commands** (in the samples only `m`) are kept raw in
  `server_commands` but not decoded.
* **Unnamed flag bits.** Only eFlags bits whose meaning is confirmed in the
  engine code are named (crouch, prone, firing, dead, turret); other bits are
  given as numbers (`bitN`).
* **CoD4X reliable records** (type 3) and `svc_download` are kept raw
  (`issues` notes them); none of the sample demos contains one.
* **Analysis.** Rounds, halves, round winners, first kills, trades, clutches,
  per-player statistics and map views are not part of this step; everything
  they need is in the tables (`pov_commands` restarts, `team_scores`,
  `configstring_changes`, `game_messages`, `kills`, `hits`, positions).

### 7.3 Tested scope

* Tested on CoD4X protocol 21 (53 match demos, Promod S&D), protocol 19 and 17
  and stock 1.6 (deathrun fixtures of CoD4-DM1). Other CoD4X protocol versions
  should work if their field tables are unchanged, but are untested.
* The legacy position encoding (stock / protocol ≤ 17) is verified on map
  entities only; the fixtures contain no other players.
* Other game modes than S&D read the same way (the tables are generic), but
  were not in the sample set.

---

## 8. Verification

`tools\verify.py` runs the extractor over a set of demos and checks:

1. the container reads to its end marker, no record is cut off;
2. every snapshot is decoded (no delta from an unavailable snapshot, no read
   past a message end, no unknown message operation);
3. every kill resolves to known clients and a known weapon or means of death;
4. the recorder's own position is continuous (a decoding error or a wrong
   archive lookup would show up as jumps; spawn teleports right after a round
   restart are excluded).

Result on the 53 sample demos plus the 3 CoD4-DM1 fixtures: see
[8.1](#81-results).

Independent cross-check against the existing JavaScript/Python project in
`C:\Claude\cod4-demo\info\cod-demo` (different code, same demo `demo0025`):

* kill feed: all 119 kills identical (attacker, victim, weapon/means of death,
  same order);
* player positions: identical point counts per player and identical
  positions and held weapons; yaw differs only by rounding.

The Huffman table is rebuilt from the engine's frequency table by
`--selftest` and was compared with the tree of the existing implementation
(identical codes for all 256 symbols). The net field tables were compared
entry by entry with KisakCOD's decompiled tables (identical).

### 8.1 Results

56 files, 630 MB, 1,386,449 decoded snapshots, read in 450 s in total
(`verification.csv` holds the full report):

| | 53 match demos (protocol 21) | 3 CoD4-DM1 fixtures (1.6, 17, 19) |
|---|---|---|
| clean end marker, nothing truncated | 53 / 53 | 3 / 3 |
| snapshots decoded | 1,385,079 of 1,385,079 | 1,370 of 1,402 |
| decoding issues | 0 | 32 (all in the protocol-19 fixture, see below) |
| kills (all resolved) | 6,988 | 1 |
| bullet hits | 15,404 | 0 |
| `fire_weapon` events (all sources) | 147,133 | 7 |
| position jumps of the recorder | 0 | 1 (deathrun teleport, explicitly transmitted) |

**55 of 56 files pass every check.** The one flagged file is the protocol-19
fixture `1.9.dm_1`: right after its first full snapshot (message 114) the
server keeps sending the snapshots of messages 115–148 delta-coded against message 111, which
was received before the recording started and is therefore not in the file.
The game's own demo player cannot decode those 32 snapshots either ("delta from
invalid frame"); from message 149 on, the server sends a full snapshot and
everything decodes again. That fixture also contains a teleport of the
deathrun map, which the continuity check reports.

<details>
<summary>Per-file results</summary>

| Demo | MB | Protocol | Snapshots | Dropped | Kills | Hits | fire_weapon | Chat | Time (s) | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.6.dm_1 | 0.4 | 1 | 420 | 0 | 1 | 0 | 3 | 0 | 0.2 | ok |
| 1.7.dm_1 | 0.5 | 17 | 755 | 0 | 0 | 0 | 0 | 0 | 0.2 | ok |
| 1.9.dm_1 | 0.2 | 19 | 195 | 32 | 0 | 0 | 4 | 2 | 0.2 | CHECK |
| ^8inf_vs_myquest_^9backlot.dm_1 | 18.3 | 21 | 41,464 | 0 | 211 | 454 | 4515 | 94 | 11.7 | ok |
| ^8inf_vs_myquest_^9strike.dm_1 | 12.8 | 21 | 29,100 | 0 | 132 | 319 | 2917 | 44 | 10.6 | ok |
| ^8infes_^9alpha.dm_1 | 16.6 | 21 | 37,773 | 0 | 195 | 436 | 3495 | 34 | 13.8 | ok |
| ^8lafine_^9backlot.dm_1 | 19.4 | 21 | 44,115 | 0 | 188 | 427 | 4373 | 49 | 12.6 | ok |
| ^8lafine_^9cluster.dm_1 | 14.0 | 21 | 31,849 | 0 | 158 | 301 | 2390 | 37 | 8.4 | ok |
| ^8lafine_^9knife.dm_1 | 2.6 | 21 | 5,712 | 0 | 27 | 32 | 378 | 17 | 2.0 | ok |
| ^8lafine_^9strike.dm_1 | 18.8 | 21 | 42,181 | 0 | 190 | 379 | 3351 | 41 | 15.9 | ok |
| ^9inf_^8warz.dm_1 | 10.4 | 21 | 23,452 | 0 | 114 | 283 | 3715 | 23 | 8.6 | ok |
| backlot_deox1st.dm_1 | 8.5 | 21 | 19,153 | 0 | 107 | 282 | 3338 | 45 | 5.7 | ok |
| cas1_backlot.dm_1 | 16.1 | 21 | 36,333 | 0 | 212 | 478 | 4251 | 75 | 10.5 | ok |
| cas1_city.dm_1 | 16.0 | 21 | 36,201 | 0 | 174 | 346 | 3460 | 39 | 15.6 | ok |
| cas1_crash.dm_1 | 0.3 | 21 | 622 | 0 | 2 | 3 | 97 | 1 | 0.2 | ok |
| cas1_knife.dm_1 | 1.4 | 21 | 3,081 | 0 | 6 | 0 | 134 | 10 | 0.8 | ok |
| cas1_knife2.dm_1 | 0.5 | 21 | 896 | 0 | 7 | 1 | 41 | 2 | 0.3 | ok |
| cas1_strike.dm_1 | 16.4 | 21 | 37,357 | 0 | 161 | 295 | 2774 | 37 | 13.7 | ok |
| demo0024.dm_1 | 14.7 | 21 | 34,204 | 0 | 168 | 404 | 3639 | 17 | 9.7 | ok |
| demo0025.dm_1 | 8.7 | 21 | 19,732 | 0 | 119 | 236 | 1703 | 21 | 5.3 | ok |
| demo0026.dm_1 | 13.7 | 21 | 31,619 | 0 | 165 | 332 | 3001 | 20 | 11.2 | ok |
| deox.dm_1 | 18.1 | 21 | 41,064 | 0 | 241 | 536 | 6067 | 54 | 12.0 | ok |
| deox_map2.dm_1 | 10.8 | 21 | 24,852 | 0 | 119 | 234 | 2486 | 18 | 9.2 | ok |
| deox_map3_cluster.dm_1 | 14.0 | 21 | 31,831 | 0 | 166 | 362 | 2776 | 51 | 9.3 | ok |
| deoxstrike2nd.dm_1 | 16.0 | 21 | 36,607 | 0 | 198 | 459 | 4733 | 69 | 13.3 | ok |
| FPS_324087_mp_backlot_x_BDaN.dm_1 | 7.2 | 21 | 14,058 | 0 | 96 | 210 | 2029 | 9 | 4.4 | ok |
| FPS_324089_mp_crash_E6Hk.dm_1 | 17.3 | 21 | 34,565 | 0 | 163 | 374 | 3729 | 16 | 10.2 | ok |
| FPS_324092_mp_strike_pdy1.dm_1 | 8.5 | 21 | 16,489 | 0 | 111 | 213 | 1713 | 16 | 6.5 | ok |
| FPS_327111_mp_crash_bFjF.dm_1 | 15.0 | 21 | 28,263 | 0 | 159 | 412 | 3951 | 36 | 8.9 | ok |
| inf_vs_myquest_knife.dm_1 | 1.7 | 21 | 3,634 | 0 | 33 | 55 | 584 | 14 | 1.1 | ok |
| lafine_knife.dm_1 | 2.0 | 21 | 4,347 | 0 | 10 | 12 | 237 | 4 | 1.4 | ok |
| Match_mp_backlot_x_8xQPAHh5.dm_1 | 10.5 | 21 | 20,796 | 0 | 140 | 352 | 2848 | 25 | 6.5 | ok |
| Match_mp_backlot_x_f3MQE16i.dm_1 | 17.9 | 21 | 40,747 | 0 | 207 | 449 | 4432 | 27 | 11.7 | ok |
| Match_mp_backlot_x_uGGDzj83.dm_1 | 12.0 | 21 | 24,038 | 0 | 136 | 318 | 2887 | 16 | 7.3 | ok |
| Match_mp_backlot_x_uR4pgAiK.dm_1 | 10.6 | 21 | 20,796 | 0 | 140 | 353 | 2856 | 35 | 6.5 | ok |
| Match_mp_backlot_x_ZTIXQWnu.dm_1 | 17.9 | 21 | 40,747 | 0 | 207 | 450 | 4424 | 49 | 11.8 | ok |
| Match_mp_cluster_6Bp3FC6s.dm_1 | 0.3 | 21 | 612 | 0 | 0 | 0 | 0 | 0 | 0.1 | ok |
| Match_mp_cluster_HWybxCU0.dm_1 | 16.3 | 21 | 36,813 | 0 | 188 | 371 | 3331 | 30 | 11.7 | ok |
| Match_mp_cluster_jOZum75b.dm_1 | 12.6 | 21 | 28,242 | 0 | 8 | 0 | 178 | 0 | 5.8 | ok |
| Match_mp_crash_5xynbeJD.dm_1 | 14.7 | 21 | 33,638 | 0 | 178 | 387 | 3674 | 9 | 9.8 | ok |
| Match_mp_crash_c5l9TsrJ.dm_1 | 10.2 | 21 | 23,112 | 0 | 149 | 311 | 2871 | 14 | 6.2 | ok |
| Match_mp_crash_eCMiGVlm.dm_1 | 16.1 | 21 | 32,652 | 0 | 165 | 397 | 3462 | 24 | 9.9 | ok |
| Match_mp_crossfire_0JILLpdq.dm_1 | 15.6 | 21 | 35,420 | 0 | 175 | 403 | 4122 | 14 | 11.2 | ok |
| Match_mp_crossfire_FXrJV0U6.dm_1 | 9.6 | 21 | 19,720 | 0 | 93 | 238 | 2346 | 7 | 5.7 | ok |
| Match_mp_crossfire_Q4yUjGvh.dm_1 | 16.6 | 21 | 37,976 | 0 | 191 | 428 | 5454 | 60 | 11.6 | ok |
| Match_mp_strike_3A39ZNZr.dm_1 | 12.6 | 21 | 28,500 | 0 | 154 | 374 | 3368 | 14 | 10.8 | ok |
| Match_mp_strike_Bl3Yj3WC.dm_1 | 12.6 | 21 | 28,707 | 0 | 128 | 303 | 2828 | 8 | 10.4 | ok |
| Match_mp_strike_BpCHnb5O.dm_1 | 11.1 | 21 | 25,657 | 0 | 127 | 249 | 1959 | 39 | 9.3 | ok |
| Match_mp_strike_DR1ux4gv.dm_1 | 12.4 | 21 | 28,706 | 0 | 128 | 306 | 2827 | 11 | 10.2 | ok |
| Match_mp_strike_JsjiwJTx.dm_1 | 20.0 | 21 | 40,006 | 0 | 176 | 414 | 4419 | 48 | 15.1 | ok |
| Match_mp_strike_KG4JQgq7.dm_1 | 12.7 | 21 | 25,098 | 0 | 146 | 305 | 2451 | 27 | 9.7 | ok |
| Match_mp_strike_nxzWi1lO.dm_1 | 1.6 | 21 | 2,985 | 0 | 11 | 0 | 211 | 11 | 1.2 | ok |
| Match_mp_strike_qPN2I122.dm_1 | 12.7 | 21 | 25,098 | 0 | 146 | 303 | 2443 | 28 | 10.0 | ok |
| Match_mp_strike_TjLEPKo1.dm_1 | 2.2 | 21 | 5,006 | 0 | 28 | 62 | 614 | 6 | 1.9 | ok |
| sleedy_backlot.dm_1 | 17.9 | 21 | 40,747 | 0 | 207 | 450 | 4424 | 49 | 11.9 | ok |
| sleedy_strike.dm_1 | 12.4 | 21 | 28,706 | 0 | 128 | 306 | 2827 | 11 | 10.0 | ok |

</details>

---

## 9. Project layout

```
source/
  README.md                overview of all parts (web front end + Python)
  index.html, css/, js/    web front end (separate part)
  python/
    README.md              this file
    verification.csv       result of tools/verify.py over all sample demos
    cod4demo/
      __init__.py            public API: extract, write_all, DemoParser, events
      __main__.py, cli.py    command line
      parser.py              container records, messages, gamestate, events
      delta.py               delta decoding: player state, entities, clients, HUD, objectives
      bitmsg.py              bit/byte reader with CoD4 msg_t semantics
      huffman.py             Huffman tree builder, decoder, self test
      _huffman_table.py      pre-computed code table (generated)
      _netfields.py          net field tables (generated)
      states.py              named, typed views of raw states
      servercmd.py           server command decoding, engine tokenizer semantics
      text.py                colour codes, info strings, tokenizer
      constants.py           engine enums: events, entity types, config string layout, flags …
      extract.py             one-pass extraction into tables
      export.py              CSV / JSONL / JSON writers
    tools/
      gen_netfields.py       generates _netfields.py from NetFields.cpp (+ KisakCOD cross-check)
      verify.py              integrity check over many demos
```

## 10. Sources and licence

* **KisakCOD** (open-source reimplementation of CoD4): message reading,
  config string layout, server command handling, event / entity / flag enums,
  client event logic, tokenizer.
* **CoD4X client and server source**: demo file format (recording and
  playback), CoD4X gamestate, protocol record, configclient.
* **Iswenzz/CoD4-DM1**: net field tables and the reference demo reader.
* **info\cod-demo** (TiPSYSPiT/cod4-demo) and **cod4-demo-inspector**:
  prior work on the format; used as independent cross-check.

The net field tables and several algorithms are taken from GPL-3.0 projects
(CoD4-DM1, KisakCOD); this package is therefore distributed under the GPL-3.0
as well.
