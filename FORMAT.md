# The .dm_1 file format

How the container is built, how the snapshots are decoded, and what each of that
was verified against. For getting started see [README.md](README.md), for the
data that can be read out see [DATEN.md](DATEN.md).

## File format (verified against these demos)

The container is a sequence of records, each preceded by a type byte:

| Type | Name | Contents |
|-----|------|--------|
| 0 | MSG_SNAPSHOT | `int seq`, `int size`, `int dummy`, then `size-4` Huffman bytes. `seq == -1` = end of demo |
| 1 | MSG_FRAME | `int seq` + 48 bytes of client archive: origin[3], velocity[3], movementDir, bobCycle, commandTime, angles[3] |
| 2 | MSG_PROTOCOL | `uint32 protocol`, `int legacyEnd`, `uint64 reserved` (always the first record) |
| 3 | MSG_RELIABLE | not used here |

The snapshot payload is compressed as a **whole byte stream** with a static
Huffman code (CoD4 frequency table `msg_hData_COD4`, tree built through the
adaptive FGK algorithm in ascending order of frequency). After decompression come
byte-aligned svc opcodes:

```
0 nop | 1 gamestate | 2 configstring | 3 baseline | 4 serverCommand
5 download | 6 snapshot | 7 EOF | 8 steamcommands | 9 statscommands
10 configdata | 11 configclient
```

`svc_serverCommand` = `int seq` + NUL-terminated string. Without snapshot decoding
a message is only read up to the first `svc_snapshot` (that is where the delta
entity coding starts) - in the CoD4 protocol server commands always come before
it.

In the gamestate (protocol 21 = CoD4X) the config strings come first
(`int count`, then `int idx` + string), then the baselines, and **after those**
the player info as `svc_configclient` blocks (`byte clientnum`, name, clan tag).
Because the baselines are skipped, the parser finds the players by pattern search
in the decompressed buffer. At the end of the gamestate: `int configSeq`,
`int clientNum` (= the demo's POV), `int checksumFeed`.

### Server commands (determined empirically)

| Cmd | Meaning |
|-----|-----------|
| `b` | scoreboard: `b <n> <scoreSideA> <scoreSideB> <scorelimit>` + n x `<client> <score> <ping> <deaths> <?> <kills> <assists>` |
| `d` | config string update: `d <index> <value>` |
| `v` | set client cvars (Promod: `self_alive`/`opposing_alive`, weapon restrictions, ...) |
| `f` | game message (bomb planted/defused, team joined, ...) |
| `h` | chat (global), `i` = team / quick-message chat |
| `G`/`H` | team score side A / side B (they swap at halftime) |
| `e` | print, carries `EXE_LEFTGAME` among other things |
| `m`, `n`, `a`, `C`, `s`, `t`, `L`, `u`, `N`, `J`, `g`, `K` | Promod-internal control commands for HUD and menus; they carry no match information of their own |

Config strings that matter for Promod: `11` round timer **and** bomb timer, `156`
bomb planted, `380/381` HUD headers, `385/387/388` status lines ("Strat Time",
"Attack eliminated", ...), `0/1` serverinfo/systeminfo. Promod prefixes its HUD
strings with a control character `0x15` - removed before display.

## Verification

Perl, JavaScript and Python were checked independently against the same demo:

* Huffman tree: 513 nodes, maximum code length 11 bits, SHA-256 of the structure
  identical in all three implementations (`920d1ece...`, see `dm1.py --selftest`).
* `commands.tsv` (1562 commands) and `configstrings.tsv` (595 entries) are byte
  for byte identical between Perl and Python.
* Match analysis identical: 10 players, 15 rounds, ALPHA 13:2 RL (11+2 / 1+1),
  the same K/D/assists/score, the same chat.

## Kill feed

Obituaries sit in the snapshots as event entities: `eType >= 17` selects the
`EventEntityStateFields` table, which holds `attackerEntityNum` (killer),
`otherEntityNum` (victim) and `eventParm`. To get at them the complete delta
stream has to be decoded - player state, every entity, every client state,
snapshot by snapshot, or the bit stream goes out of step.

`eventParm` is the weapon id; the names are in config string 2258 (1-based).
Values from 128 on are not a weapon but `128 + means-of-death`: `135` = knife,
`136` = headshot, `139` = fall damage, `140` = suicide or a death caused by the
world. The full table is derived in [DATEN.md](DATEN.md).

Temp entities can be re-transmitted across several snapshots, so the same pairing
within 2 seconds is only counted once.

### How this was verified

Demos checked: all eleven in `demos/` - Backlot, Strike and Cluster recordings
between 4 and 23 rounds, including ones with substitutions. All of them run
through without a sync error, and `tools/py/verify_all.py` reports every one of
them as complete and consistent.

* **Bit stream:** all 310,896 snapshots run through without a single sync error -
  one wrong field and the stream would derail immediately.
* **Kills per player:** within the rounds the feed matches the scoreboard exactly
  for every one of the 114 players. The differences outside the rounds are
  explainable: restart deaths before round 1 and kills during the halftime break,
  which Promod does not score.
* **Weapon mapping through distance:** median distance between killer and victim -
  M40A3 2887, Remington 700 2378, frag 1752, AK-47 708, AK-74u 625,
  Desert Eagle 333, Winchester 1200 **177**. Every weapon sits where it belongs.
* **Python vs JavaScript:** given identical input both versions produce the same
  result field for field - teams, players, every round with winner/reason/score,
  every kill, chat, events, movement tracks and grenades.

### Joins and departures

The server reports both in plain text: `f "MP_CONNECTED<name>"` on connecting and
`e "<name> EXE_LEFTGAME"` on leaving - both with CoD4 localisation control
characters (`0x14`, `0x15`) in the text, which is why the match runs against a
cleaned copy. The JSON carries `joinedS` and `leftS` per player, the interface
shows them next to the name. Cross-check: the client states in the snapshots end
on the same second.

### Team detection

What counts is the side assignment from the client states (`team`: 1/2 are
playing, 0/3 are free or spectator), not the clan tag. That excludes spectators
and groups teams whose tag has no space in it (`[SaG]BALDONERO`) correctly. The
team name comes from the common prefix of the members' names. One thing matters:
players who only join after halftime get their first assignment on the swapped
side - the number of side swaps before that is therefore taken out (and the
halftime marker arrives twice, so it has to be debounced). Without snapshot data
it falls back to the clan tag.

### Comparison with Riyondev/cod4-dm1-tools

The container description originally came from that project's README. Its source
was read through as well; nothing was taken from it, because its kill feed is
weaker: it derives deaths from corpse entities (`ET_PLAYER_CORPSE`) appearing and
guesses the victim from the nearest living player ("best-effort victim") - with no
killer and no weapon. Here killer, victim and weapon come straight from the
obituary event.

What the comparison did confirm is the meaning of the client-state team values
(0 = free, 1 = axis, 2 = allies, 3 = spectator), on which team detection is
built, as well as `ET_PLAYER = 1` / `ET_PLAYER_CORPSE = 2`.

It also exposed a gap both projects had: world coordinates were only read as raw
floats for CoD4X (protocol > 17). Older protocols encode them against the map
centre from config string 12 - that path is now implemented from the C++
reference (`read_origin_float`), but untested for lack of a demo with protocol
<= 17. For the demos at hand (all protocol 21) nothing changes, verified across
all eleven.

### Pitfalls that turned up along the way

* The config string index of the halftime sound is **map- and mod-dependent**
  (1364 in one demo, 1362 in another). The value is therefore matched, not the
  index. With no halftime the side assignment never flips and the final score
  turns nonsensical (16:0 instead of 13:3).
* The side -> team mapping is tracked along and corrects itself at every round
  that was decided beyond doubt, rather than relying on a single marker.
* Whoever leaves the server before the end is **missing from the last
  scoreboard** - score and assists therefore come from the last scoreboard the
  player still appears in. Otherwise NATHZN in the Backlot demo showed a score of
  0 instead of 88.
* The **last scoreboard can be older than the last round** - the server does not
  necessarily send another one after the match ends. Kills and deaths therefore
  come from the kill feed, by the same rule the scoreboard uses: only within the
  rounds, and team kills do not count for the shooter.
* For headshots the engine sends the hit type instead of the weapon, so for those
  kills the weapon is not known.

## Not implemented

HUD elements and objectives are decoded because the bit stream requires it, but
they are not evaluated. The same used to apply to positions - those are now used
for the map view, see [DATEN.md](DATEN.md).

Format reference: <https://github.com/Iswenzz/CoD4-DM1>
