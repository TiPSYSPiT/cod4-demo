# CoD4 Demo Inspector

Reads Call of Duty 4 demos (`.dm_1`) and turns them into a match: teams, player
stats, a round-by-round breakdown, a kill feed with weapons, the chat log, and a
playable map with everyone's movement.

Two ways in, same analysis:

* **In the browser** - drop a demo onto the page, that is it. The file never
  leaves your machine; everything runs locally.
* **On the command line** - `py tools/py/dm1.py DEMO` prints a text report,
  `--json` writes the full data.

Both are independent implementations of the same logic and are checked against
each other: for the same file they have to produce the same result field for
field.

---

## The interface

Above every tab sit the final score of both teams with their halves, and a box
with the map, game mode, ruleset, server, recording point of view, length and
protocol version.

### Players

One table per team with team tag, name, score, kills, assists, deaths and K/D,
with the team totals underneath. The recording player is marked as POV; anyone
who joined mid-match or left early gets the time next to their name.

Kills and deaths come from the kill feed, not from the scoreboard - the last
scoreboard in a demo is often older than the last round.

### Round by round

Every round as a block: number, half, winner, reason (elimination, bomb
exploded, bomb defused), running score and duration. Inside it, the round as it
happened - who killed whom with what, headshots and opening kills highlighted,
plus bomb actions and, where the server reports them, how many players each side
had left.

### Kills per round

A matrix of players against rounds: how many kills each player had in which
round, with total kills and deaths along the edge. Rounds whose boundaries are
not exactly in the data stream are marked.

### Map

The map as a floor plan, playable along a timeline. If an image for the map sits
under `web/maps/`, it is used and placed exactly onto the world rectangle;
otherwise the display builds the floor plan from the positions itself - cells
nobody ever entered become wall.

* **Timeline** with a round picker or the whole match, playback, and speeds from
  0.5x to 4x.
* **Players** as a dot in the team colour with facing, name and the weapon
  currently held. A hollow marker means the server is not sending them right
  now, so the spot is the last one known. Whoever is dead disappears.
* **Overlay** either as a short trail of the last five seconds, as a heatmap of
  one player or of both teams, or off.
* **Kills** as a line from killer to victim with the weapon name, and a cross on
  the victim.
* **Throws** with their flight path and a marker where they go off - frag, smoke
  and flash in their own colours. A dashed circle means the impact is computed:
  the server often stops transmitting the flight path before it lands.
* **Your own callouts** can be placed on the map, renamed and dragged around.
  They live in the viewer's browser and apply per map.

Clicking a player - on the map or in the bar above it - highlights them and
opens their analysis:

| | |
|---|---|
| Opening routes | the first ten seconds of each life, grouped into routes |
| Hotspots | where they linger, bundled by your own callouts |
| Death spots | where they fall and to which weapon, plus their most common killers |
| Distances | distance to the victim per weapon |
| Predictability | 0 to 100, with one line on how the number came about |

### Chat

The chat log with timestamps, separated into team chat and open chat.

### Events

A deliberately short list: connects and disconnects, team changes, the ready
message, eliminations, bomb planted and defused, timeout, halftime and every
kill. Searchable. Everything else in the message stream stays out.

### Raw data

The complete server command stream with time and sequence number, filterable,
plus the analysis as JSON to copy.

---

## Command line

```bash
py tools/py/dm1.py demos/example.dm_1
```

| Option | Effect |
|---|---|
| `--json FILE` | the full analysis as JSON |
| `--tracks` | include the movement tracks (large, hence not the default) |
| `--report FILE` | write the text report to a file |
| `--raw DIR` | config strings and commands as TSV |
| `--selftest` | check the Huffman table against its fingerprint |

## Tools

| File | Purpose |
|---|---|
| `tools/py/dm1.py` | parser and command line, standard library only |
| `tools/py/snapshot.py` | snapshot decoding: delta entities, player state, client state |
| `tools/py/netfields.py` | field tables, generated from the reference |
| `tools/py/gen_netfields.py` | generates `netfields.py` and `web/js/netfields.js` |
| `tools/py/check.py` | check a single demo for consistency |
| `tools/py/verify_all.py` | check a whole folder |
| `tools/py/inventory.py` | what is in the data stream, and what of it gets read |
| `tools/py/build_single.py` | bundle `web/` into one HTML file |
| `tools/*.pl` | older Perl version, kept as an independent reference |

The web interface lives under `web/` and uses no third-party libraries.
`py tools/py/build_single.py` turns it into a single file under `dist/`.

## Checking

```bash
py tools/py/verify_all.py demos
```

Three levels: does the Huffman stream run cleanly to the end of the file, are
all sections filled, and do the kill feed and the scoreboard agree for every
single player? The last point is the real safeguard - the two sources come from
completely different parts of the file.

## Further reading

Both documents are in German:

* [DATEN.md](DATEN.md) - what can be read out of a demo, what is in there but
  goes unused, and what is not in the file at all
* [FORMAT.md](FORMAT.md) - container, Huffman, snapshots, and how each of those
  was verified

## Licence

GPL-3.0, see [LICENSE](LICENSE). The snapshot decoding follows the reference
implementation [Iswenzz/CoD4-DM1](https://github.com/Iswenzz/CoD4-DM1), which is
under the same licence.

The map images under `web/maps/` are not part of this project and remain under
the terms of their respective authors.
