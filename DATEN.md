# What is inside a .dm_1 demo

The complete picture: what the parser gets out of a Call of Duty 4 demo, what is
in the file but goes unused, and what is not in there at all.

The basis is the eleven demos in `demos/` - Promod matches in Search & Destroy,
protocol 21 (CoD4X), between 2.2 MB and 17.9 MB. Together that is 310,896
snapshots, 1,942,662 frames, 26,807 server commands and 192 rounds. Every number
in this document comes from those files, not from a format description.

For the file format itself see [`FORMAT.md`](FORMAT.md); for the tool and its
tabs see [`README.md`](README.md).

---

## At a glance

| Information | Status |
|---|---|
| Server, map, game mode, mod, version, start time | **read** |
| Teams, final score, result per half | **read** |
| Players: name, team, score, kills, assists, deaths, ping | **read** |
| Who connected when, and who left the server | **read** |
| Rounds: number, half, start, duration, winner, reason | **read** |
| Kill feed: who killed whom with what, headshot, time | **read** |
| Bomb: planted, defused, picked up, dropped | **read** |
| Chat (all and team) with timestamps | **read** |
| Events: knife round, team changes, ready, timeout, halftime | **read** |
| Movement of every player with facing, 20 times a second | **read** |
| Weapon held, per player and point in time | **read** |
| Thrown grenades: type, flight path, point of impact | **read** |
| Map projection (compass image and its world coordinates) | **read** |
| Server configuration: 97 cvars incl. friendly fire, time limit | present, unused |
| Promod ruleset: allowed classes, weapons, attachments | present, unused |
| Class of the recording player | present, unused |
| Who the recording is following | present, unused |
| MSG_FRAME at full frame rate (velocity, view angles) | present, unused |
| Eight further event types | present, meaning unproven |
| Who threw a grenade | **not in the file** |
| Extent and duration of a smoke cloud | **not in the file** |
| Shots fired, accuracy | **not in the file** |
| Damage as numbers | **not in the file** |
| Health and equipment of the other players | **not in the file** |
| Anything before the recording started | **not in the file** |

---

# Part 1: What gets read

The field names match the JSON output (`py tools/py/dm1.py DEMO --json`) and are
identical in Python and JavaScript.

## Match metadata (`info`)

Sits in the gamestate, that is in the first snapshot, and can be read straight
off without any interpretation.

| Field | Example |
|---|---|
| `server` | `ARMY League Server > Mars` |
| `map` | `mp_cluster` |
| `gametype` | `sd` |
| `mod` | `mods/promod_x` |
| `ruleset` | `Knockout Knife MR12 OT3` |
| `hud` | `FPSChallenge.eu Promod V2.76` |
| `mapStart` | `Sat Sep 19 21:09:57 2026` |
| `version` | `CoD4 X - linux-i386-custom build 1229` |
| `factions` | `["arab", "usmc"]` |
| `protocol` | `21` |
| `scorelimit` | `13` |
| `povClient` / `povName` | whose view the demo was recorded from |
| `durationS` | length of the recording in seconds |

Plus some figures about the file itself: `snapshots`, `frames`, `commands`,
`configstrings`, `sizeBytes`, `cleanEof`, `obituaries`, `duplicateObituaries`.

## Teams (`teams`)

Two entries with `name`, `wins` and `halves` - the last being the rounds won per
half, for example `[11, 2]`. The team names are the clan tags taken from the
player names; without tags the naming falls back to POV team and opponents
(`taggedTeams` says which case applies).

Which player belongs to which team does not come from the name but from the
`team` field of the client state (0 = free, 1 and 2 = the playing sides,
3 = spectator). Because the sides swap at halftime, the number of swaps before a
player's first assignment is counted - otherwise late arrivals from the second
half end up in the wrong team.

## Players (`players`)

| Field | Meaning |
|---|---|
| `client` | client slot (0-63), the identity used in every other list |
| `name` | player name including colour codes |
| `team` | team name |
| `score`, `kills`, `deaths`, `assists`, `ping` | from the scoreboard |
| `hasStats` | whether the player appeared in any scoreboard |
| `joinedS`, `leftS` | second of connecting or leaving, otherwise `null` |

Two subtleties that only showed up on the demos themselves:

* The **last** scoreboard is not the most complete one. Anyone who leaves before
  the match ends is missing from it. Each player therefore takes the last
  scoreboard they themselves appear in - otherwise they would show zeroes
  everywhere.
* The last scoreboard can be older than the last round. Kills and deaths
  therefore come from the kill feed (team kills excluded); `statsSource` and
  `scoreboardStale` make that visible. Across all eleven demos both routes agree
  exactly for every single player.

Across all demos: 114 players, of which 0 without a scoreboard entry, 12 with a
recorded departure and 5 with a recorded arrival during the recording.

## Rounds (`rounds`)

Per round `n`, `half`, `startS`, `durS`, `winner`, `reason`, `score` and `bomb`.
In these demos `reason` is `<team> eliminated`, `Bomb exploded` or
`Bomb defused`; `Time expired` is possible but did not occur. All 192 rounds are
`exact` - start and end are in the data stream and were not estimated. The sum of
the round wins matches the final score in every demo.

`timeline` is what happened inside the round:

* `kind: "kill"` with `killer`, `victim`, `weapon`, `weaponLabel`, `headshot`,
  `suicide`, `first` (opening kill)
* `kind: "bomb"` with `action` (bomb planted / defused) and `player`
* `kind: "down"` with the number of players still alive per side, where the
  server reports it

## Kill feed (`kills`)

The most involved part, because it is not text in the data stream but has to be
decoded out of the snapshots. Obituaries are event entities (event 66) with
`attackerEntityNum` = killer, `otherEntityNum` = victim, `eventParm` = weapon.

The weapon id is a 1-based index into the server's weapon list (config string
2258, 42 to 44 entries). Values from 128 on are not a weapon but
`128 + means-of-death`:

| Value | Meaning | Shown as |
|---|---|---|
| 135 | `MOD_MELEE` | Knife |
| 136 | `MOD_HEAD_SHOT` | Headshot |
| 139 | `MOD_FALLING` | Fall damage |
| 140 | `MOD_SUICIDE` | Suicide / world |

Headshot and suicide were the way in; knife and fall are proven by the demos
themselves: 135 falls almost exclusively in warmup and knife phases, and for 139
the attacker is always the world entity 1022. Both sit in the means-of-death enum
at exactly position 7 and 11, which pins down the whole table.

Deaths with no attacker (own grenade, a fall, a map hazard) are marked
`suicide: true` and count as a kill for nobody.

Across all eleven demos: 1592 obituaries in the data stream, 1578 kills after
removing duplicates, 13 different weapons, 133 headshots, 105 deaths with no
attacker, and not a single unknown weapon id.

Duplicates happen because temp entities get re-transmitted across several
snapshots. The same killer, the same victim, less than two seconds apart is
merged - in S&D a victim cannot die twice within one round.

## Movement and map (`map`)

Positions come from two sources, which the parser merges:

* the **delta entities** of the other players (entity numbers below 64 belong to
  that client slot, `eType == 1` means a living player),
* the **MSG_FRAME records** for the player currently being followed - he does not
  appear as an entity, because from the engine's point of view he is you.

The player state does carry his position as well, but it is no good for this: for
your own player the client predicts the movement and the server only sends the
occasional correction. In `demo0025` there are 11,598 player-state samples for the
POV, but only **118 of them change the position** - one per cent. The jumps in
between are 132 units on median, 3661 at the extreme. Drawn as a movement track
that is a hop from point to point, while everyone else moves smoothly.

The MSG_FRAME records, on the other hand, carry the recording player's position
at client frame rate - 123,723 points eight milliseconds apart, with a step size
of one unit. Thinned down to 40 milliseconds that gives the same density the
other players have:

| | Step size (median) | Step = 0 |
|---|---|---|
| POV from the player state | 0.0 units | 99 % |
| POV from the frames | 1.4 to 5.8 units | 29 to 46 % |
| the other players | 5.8 to 8.5 units | 11 to 17 % |

Which frame belongs to whom is still told by the `ClientNum` of the player-state
sample before it; after your own death that is the team mate being spectated.

| Field | Contents |
|---|---|
| `compass` | name of the compass image, e.g. `compass_map_mp_cluster` |
| `bounds` | the four world coordinates of its corners, from config string 823 |
| `center` | map centre from config string 12 |
| `weapons` | the server's weapon list, spelled out |
| `tracks` | client number -> `[[t, x, y, z, yaw, weaponId], ...]` |

`weaponId` is the weapon **currently held**, indexed into `weapons`. It sits in
the same entity as the position and changes with every weapon switch - reaching
for the pistol mid-duel is visible. Not to be confused with the loadout: which
weapons a player carries is not in the demo.

`t` counts hundredths of a second since the start of the demo, the coordinates
are rounded to whole units - a map does not need more. Across all eleven demos
that is 1,656,616 positions.

Measured over a single round, the gap between two points is 0.05 seconds on
median for **every** player, so a full 20 hertz. There are gaps, though - the
player was not visible to the recording player then, and the server did not send
him.

Over a whole demo (`Match_mp_backlot_x_f3MQE16i`, 40,060 samples every quarter
second across all living players) it looks like this:

| Situation | Share | Shown as |
|---|---|---|
| position current (younger than 1.5 s) | 81.3 % | filled marker |
| older, but from the same life | 4.8 % | hollow marker |
| never transmitted during this life | 13.9 % | nothing |

The hollow marker matters: the player is alive, but his last known spot is no
longer current. So does the limit to the life currently running - without it a
player the server never sent during this round would show up at his spot from an
earlier round. The oldest value produced that way was 217 seconds out, several
rounds off; with the limit it is at most the 48.9 seconds of one round.

Whoever is dead disappears - the end of a life comes from the kill feed.

The map geometry itself is **not** in the demo, the compass image is a game file.
If it is available under `web/maps/<map>.png`, it is used as the floor plan: it
covers exactly the world rectangle from config string 823 and can therefore be
placed into that rectangle without any conversion. Verified on `mp_strike` and
`mp_backlot_x` by laying the occupancy grid of the visited cells over the image:
the areas coincide, and the visited cells stop exactly at the marked playfield
boundary.

The file name follows from the map name without `mp_` and without a suffix -
`mp_backlot_x` becomes `backlot.png`. With no image the display falls back to the
floor plan it builds itself; that is also the case for the single file under
`dist/`, which brings no images along.

Without an image the positions draw the floor plan by themselves. The display
lays an occupancy grid of 48 units edge length over the map and counts which
cells anyone ever stood in. Cells with visits are walkable, all others are wall;
single holes are closed (six of eight neighbours walkable) and single specks are
removed (at most one walkable neighbour). The area is then drawn light and every
edge between walkable and not walkable dark - corridors, rooms and doorways come
out cleanly. The grid is computed once per map.

What appears as wall is not necessarily one: areas nobody entered during this
match stay dark too. So the floor plan shows the **walked** part of the map, not
its geometry.

## Grenades (`map.grenades`)

Thrown grenades are entities of their own, of type `ET_MISSILE`. Which kind is
told by their `weapon` field through the same weapon list as the kill feed.

Every throw carries a field `lerp.u.missile.launchTime`. That is the key which
tells the instances apart - entity numbers get reused during a match, the throw
time does not. Entries transmitted without a launchTime (eight of them across
four demos) stay out, because two throws could not otherwise be separated.

| Field | Contents |
|---|---|
| `kind` | `frag`, `smoke`, `flash` or `other` |
| `weapon` | weapon name, spelled out |
| `path` | `[[t, x, y, z], ...]`, `t` in hundredths since the start - transmitted points only |
| `impact` | `[x, y, z]` of the impact |
| `impactS` | time of the impact |
| `predicted` | whether `impact` is computed rather than transmitted |

Across all eleven demos that is **2971 throws**: 1852 frags, 1011 smokes and 108
flashes, together 12,406 path points. Spread over 192 rounds that is 9.6 frags per
round - with ten players carrying one frag each, almost the full yield.

Four things matter here:

* **The transmitted path usually ends before the impact.** For frags it reaches
  1971 units and 3.2 seconds on median, so almost to the detonation. For
  **smokes it stops immediately**: one single point on median, zero units, zero
  seconds - only the moment of the throw is transmitted, at 886 units per second
  of remaining speed. The last point is therefore still at the thrower.
* **The impact is therefore computed** when it is not transmitted. The last known
  state gives position, velocity and time; from there the throwing parabola is
  carried on until it falls back to throwing height. The gravity for that is not
  guessed but measured from the demos: across 838 trajectory segments the median
  is 778, with 64 per cent within 800 plus/minus five per cent - the CoD4 default,
  the downward bias coming from bounces.

  How well that lands can be checked on frags, because there the real impact is
  transmitted. Across 393 throws, each computed from the moment of the throw:

  | Method | Median | 75 % | 90 % |
  |---|---|---|---|
  | taking the throwing point as the target | 1967 units | 2205 | 2355 |
  | parabola down to throwing height | **172 units** | 298 | 386 |
  | parabola down to a floor-height grid | 156 units | 261 | 355 |

  Throwing height is what is used: sixteen units worse than the more elaborate
  floor grid, but without an extra data structure. The rest of the error is
  walls - the parabola does not know about them. A computed impact is drawn with
  a **dashed** outline, a transmitted one solid.
* **The smoke cloud itself is not transmitted.** There is no entity for it - the
  client renders it from the event. So the demo can say *where* and *when* a smoke
  went off, not how long or how wide it stood. The display therefore puts a filled
  disc at the ignition point. Its radius is a fixed screen size - 15 pixels for
  smoke, 10 for frag and flash - and says nothing about the effect; the same goes
  for the dwell time of ten and two seconds respectively. While in the air only
  the path is drawn, without a marker: the circle appears when it goes off.
* **Who threw it is not in there.** Four routes were checked, none of them leads
  anywhere:

  1. The `ClientNum` field of the grenade only ever carries 0 or 64 - never a
     client index. `attackerEntityNum` and `otherEntityNum` stay empty as well.
  2. The **weapon held** by a player never becomes a grenade: in CoD4 the
     offhand runs separately and is not transmitted.
  3. **Events on the player entity** - counted properly through `eventSequence`
     down to 34,139 genuine events - contain no marker for a throw. With 308
     throws and a chance expectation of 7 per cent, no event id gets beyond 52
     per cent coincidence, and none of those occurs anywhere near 308 times.
  4. Attribution through the **nearest player** at the moment of the throw is
     right 59 per cent of the time - measured against the killers from the frag
     obituaries, which know the thrower beyond doubt for lethal frags. Even
     taking only the cases where one player is clearly nearest, it stays at 61
     per cent: at the spawn the team mates stand too close together.

  Four attributions in ten would be wrong. The display therefore leaves the
  column empty instead of claiming a name.

The flight path itself is coarsely sampled: the server sends only a few support
points (often three to seven) and the client extrapolates the rest from the start
value, the velocity and gravity. The transmitted points are connected in straight
lines rather than assuming a parabola between them.

## What the display derives from it

The following are not in the demo but are computed from the tracks in the map
tab. They are analysis, not raw data:

* **Lives.** Search & Destroy has no respawns, so every round is exactly one life
  per player: it begins with the round start and ends with their own death from
  the kill feed, or with the round.
* **Opening routes.** The first ten seconds of each life, resampled down to
  twelve support points so that two runs become comparable. Two routes count as
  the same when their support points are less than 700 units apart on average.
* **Predictability (0-100).** Seventy per cent how often the most common opening
  route recurs, thirty per cent how tightly those runs overlap. With fewer than
  three usable runs no value is formed. The number is a measure of that
  definition, not a judgement of the player.
* **Hotspots.** Dwell time per 160-unit cell, bundled by the nearest callout of
  your own (up to 700 units away).
* **Engagement distance.** Distance between killer and victim at the moment of
  the kill. It can only be formed when a position exists for **both** - for
  opponents outside the recording player's view that is not always the case. The
  display therefore states how many kills were skipped.

Your own callouts are placed on the map by you; they live in the viewer's browser
(`localStorage`, per map name) and not in the demo.

## Chat (`chat`)

`tS`, `scope` (`all` or `team`) and `text`. Across all demos 312 messages, 187 of
them in team chat. The raw text contains the game's control characters (prefixes
for dead/alive, colour codes); the display clears them away, while the JSON output
still holds them exactly as the server sent them.

## Events (`events`)

A deliberately short list with exactly these entries: player connected, player
left the server, joined attack, joined defence, All Players are Ready!, attack
eliminated, defence eliminated, bomb planted, bomb defused, timeout called by,
halftime, and every kill as `PlayerXY kills PlayerYZ`.

Everything else in the message stream (grenade selection, hit feedback, bomb
picked up / dropped, time elapsed) stays out. `knifeS` additionally holds the
time of the knife round, where there was one - in 8 of the 11 demos.

---

# Part 2: What else is in there

An inventory across all eleven demos (`py tools/py/inventory.py`) shows what
occurs in the data stream and how much of it the parser reads. The result up
front: not a single unknown svc opcode, not one place where the parser bails out -
the container is read completely. What stays unused is the following.

## The complete server configuration

The config strings from index 20 on are a cvar table: the name sits at index `n`,
the value at `n + 128`. In every demo that is 97 pairs, of which two are read so
far (`scr_axis` and `scr_allies`).

| Cvar | Value in demo0025 | Meaning |
|---|---|---|
| `ui_friendlyfire` | `1` | friendly fire on |
| `ui_timelimit` | `1.75` | round time in minutes |
| `ui_scorelimit` | `13` | round limit |
| `ui_bomb_timer` | `0` | bomb timer |
| `ui_hostname` / `ui_motd` | | server name and greeting |
| `g_TeamName_Axis` / `_Allies` | `Defence` / `Attack` | side names |
| `bg_fallDamageMinHeight` / `MaxHeight` | `140` / `350` | fall damage |

Plus the whole movement physics (sprint, lean, mantle, bob). That is irrelevant
for a match report, but it does document that the match was played on default
values.

## The Promod ruleset

The `v` commands carry the permissions the match was played under:
`axis_allow_sniper "0"`, `allies_allow_specops "0"`,
`weap_allow_flash_grenade "1"`, `attach_allow_pistol_silencer "1"` and more. That
would allow stating per match which classes, weapons and attachments were
allowed - today that only follows indirectly from the name of the ruleset.

## Class and view of the recording player

* `v loadout_curclass "sniper"` occurs 396 times, so on every class change.
* The player state carries a `ClientNum` field. In `backlot_deox1st` it holds the
  recording player 78 per cent of the time and a team mate for the rest - that is
  the spectating phase after his own death. Time of death and survival time of
  the POV player per round could be derived from it, entirely without the kill
  feed.

## The full frame rate of the MSG_FRAME records

The frames now provide the track of the POV player (see part 1), though thinned
to 40 milliseconds there. In the original they come eight milliseconds apart and
carry velocity and view angles alongside the position. For aim movement or
micro-positioning the full resolution would be the more precise source - for a
map it adds nothing and costs six times the data points.

## Further event types

Besides the obituary (event 66, 1592 times) eight more event ids occur, together
12,555 times: 3, 41, 61, 43, 44, 42, 35, 36. Some carry a weapon id and a surface
type, which points at hit and impact effects. Their meaning could **not** be
proven from the data, however - unlike the means of death. So no claim about them
is made here. For a shot statistic their number would not be enough anyway.

One exception: **event 44 is a grenade bouncing**. It sits in the `events[]`
fields of the grenade entities themselves, with the surface type as its parameter
- and only there. The map view does not need it, since the flight path is
available anyway.

## Mod-specific commands

The verbs `J`, `s`, `a`, `C`, `m`, `n`, `u`, `L`, `N`, `t`, `g`, `K` (around 3850
occurrences in total) are Promod-internal control commands for HUD and menus.
Having gone through them, they carry no match information that is not already in
the scoreboards, the round status and the kill feed.

---

# Part 3: What is not in the file

None of this can be recovered with any amount of effort, because the server never
sends it to the client.

* **Shots fired and accuracy.** The `weaponShotCount` field in the player state is
  not a running counter - across a whole demo it stays between 0 and 4 - and with
  14,147 of them there are far too few event entities to represent single shots.
  An accuracy cannot be computed from a client demo, for anyone.
* **Damage as numbers.** Hit feedback only exists as a text message for the
  recording player himself, not as a value per hit that could be evaluated.
* **The loadout.** Which weapons a player picked is not in the demo - only which
  one he is holding. For the recording player `loadout_curclass` additionally
  reveals the chosen class, for everyone else it does not.
* **Health and equipment of the other players.** The full player state only comes
  for the POV player. His health is moreover not in the field table but in the
  `stats` block, which is read while decoding but then discarded.
* **Anything before the recording started.** A demo started mid-match simply does
  not contain the earlier rounds.
* **Voice chat.** Switched off on these servers (`sv_voice 0`), and voice data
  does not end up in a demo anyway.

## Limits of the analysis

Not a shortcoming of the file but of the parser:

* Only **Promod Search & Destroy** has been verified. Other game modes have
  different round messages; metadata, players, chat and kill feed would work there
  too, the round logic not necessarily.
* All available demos are **protocol 21 (CoD4X)**. Older protocols (<= 17) encode
  world coordinates differently; that path is implemented from the C++ reference
  but untested, for lack of a matching demo.
* The config string index for halftime depends on map and mod, so the content is
  matched instead of a fixed index.

---

# How this is backed up

`tools/py/verify_all.py` works through three levels:

1. **Container** - does the Huffman stream run to the end of the file without a
   snapshot going out of step, and does the file end cleanly?
2. **Contents** - are all sections filled: map, two teams, every player with a
   name and a scoreboard entry, rounds, kill feed, every weapon id resolved,
   every kill attributed to a known player?
3. **Consistency** - do the round wins match the final score, does the reason fit
   the winner, is the round limit respected, and does the kill feed agree with the
   scoreboard kills for **every single player**?

Point 3 is the real safeguard: the kill feed and the scoreboard come from
completely different parts of the file - one from the delta-coded snapshots, the
other from plain-text server commands. That they agree exactly across 114 players
is only explicable if both are read correctly.

On top of that: the Python and the JavaScript version produce the same result
field for field, for all eleven demos. A mistake in just one of the two
implementations shows up immediately.

```bash
py tools/py/verify_all.py demos
```

```bash
py tools/py/inventory.py demos
```

## Result of the cross-check

| Demo | Snapshots | Sync errors | Players | Rounds | Kills | Chat | Events | Status |
|---|---|---|---|---|---|---|---|---|
| backlot_deox1st.dm_1 | 19154 | 0 | 10 | 15 | 107 | 45 | 112 | ok |
| demo0024.dm_1 | 34205 | 0 | 10 | 22 | 168 | 17 | 174 | ok |
| demo0025.dm_1 | 19733 | 0 | 10 | 15 | 119 | 21 | 119 | ok |
| demo0026.dm_1 | 31620 | 0 | 10 | 20 | 165 | 20 | 177 | ok |
| deoxstrike2nd.dm_1 | 36608 | 0 | 10 | 23 | 196 | 69 | 211 | ok |
| Match_mp_backlot_x_f3MQE16i.dm_1 | 40748 | 0 | 12 | 23 | 206 | 27 | 218 | ok |
| Match_mp_backlot_x_ZTIXQWnu.dm_1 | 40748 | 0 | 12 | 23 | 206 | 49 | 216 | ok |
| Match_mp_strike_Bl3Yj3WC.dm_1 | 28708 | 0 | 10 | 16 | 128 | 8 | 134 | ok |
| Match_mp_strike_BpCHnb5O.dm_1 | 25658 | 0 | 10 | 15 | 127 | 39 | 129 | ok |
| Match_mp_strike_DR1ux4gv.dm_1 | 28707 | 0 | 10 | 16 | 128 | 11 | 133 | ok |
| Match_mp_strike_TjLEPKo1.dm_1 | 5007 | 0 | 10 | 4 | 28 | 6 | 31 | ok |

11 of 11 demos read completely and consistently. The detailed report is in
[`analysis/verify_all.txt`](analysis/verify_all.txt).
