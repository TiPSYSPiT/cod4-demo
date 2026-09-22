"""Inventory: what is in the demos, and how much of it gets used?

    py source/py/inventory.py [ORDNER]

Walks every demo in a folder and counts what occurs in the data stream:

  * svc opcodes, including the places where the parser would bail out
  * server commands by verb, split into "a rule in dm1.py matches" and
    "ignored"
  * event entities by event id (66 is the kill feed)
  * config strings: the server's cvar table (names from 20 on, values at an
    offset of +128) and whatever else is occupied

That makes it possible to check whether the parser misses anything - and what
could additionally be read.
"""

from __future__ import annotations

import argparse
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dm1

ROOT = pathlib.Path(__file__).resolve().parents[2]
#: Offset between a cvar name and its value in the config string table.
CVAR_VALUE_OFFSET = 128
CVAR_FIRST = 20

svc_hist: collections.Counter = collections.Counter()
stop_reason: collections.Counter = collections.Counter()


def counting_read_message(buf, seq, ftime, out, snaps):
    """Like dm1._read_message, but counts opcodes and bail-out points."""
    r = dm1._Reader(buf)
    while r.rc < len(buf):
        cmd = r.byte()
        svc_hist[cmd] += 1
        if cmd in (dm1.SVC_EOF, -1):
            return
        if cmd == dm1.SVC_SERVERCOMMAND:
            cseq = r.int32()
            out.commands.append(dm1.ServerCommand(seq, ftime, cseq, r.string()))
            if r.ovf:
                stop_reason["overflow after serverCommand"] += 1
                return
        elif cmd == dm1.SVC_GAMESTATE:
            out.gamestates += 1
            dm1._read_gamestate(r, buf, out, snaps)
        elif cmd == dm1.SVC_CONFIGCLIENT:
            r.int32()
            cn = r.byte()
            name = r.string()
            r.string()
            if 0 <= cn < 64 and name:
                out.players[cn] = name
            if r.ovf:
                stop_reason["overflow after configclient"] += 1
                return
        elif cmd == dm1.SVC_SNAPSHOT:
            if snaps is None:
                return
            snaps.parse_snapshot(r, seq)
            if r.ovf:
                stop_reason["overflow after snapshot"] += 1
                return
        elif cmd == dm1.SVC_NOP:
            continue
        else:
            stop_reason[f"unknown svc opcode {cmd}"] += 1
            return


def main() -> int:
    ap = argparse.ArgumentParser(description="What is in the demos, and what gets read?")
    ap.add_argument("folder", nargs="?", type=pathlib.Path, default=ROOT / "demos")
    args = ap.parse_args()
    demos = sorted(args.folder.glob("*.dm_1"))
    if not demos:
        raise SystemExit(f"no .dm_1 files in {args.folder}")

    dm1._read_message = counting_read_message
    rules = [v for k, v in vars(dm1).items()
             if k.startswith("_RE_") and isinstance(v, re.Pattern)]

    verbs: collections.Counter = collections.Counter()
    unused: collections.Counter = collections.Counter()
    sample: dict[str, str] = {}
    events: collections.Counter = collections.Counter()
    cs_last: dict[int, str] = {}

    for path in demos:
        print(f"... {path.name}", file=sys.stderr, flush=True)
        d = dm1.parse_demo(path.read_bytes(), deep=True)
        for c in d.commands:
            text = dm1._CTRL.sub("", c.text)
            verb = text.split(" ", 1)[0][:12] or "(leer)"
            verbs[verb] += 1
            if not any(rx.search(c.text) or rx.search(text) for rx in rules):
                unused[verb] += 1
                sample.setdefault(verb, text[:110])
        for e in d.events:
            events[e.event] += 1
        for idx, val in d.configstrings.items():
            if val:
                cs_last[idx] = val

    print("=== svc opcodes ===")
    for op, n in sorted(svc_hist.items()):
        print(f"  {op:>4}: {n:,}")
    print("  bail-out points:", dict(stop_reason) or "none")

    print("\n=== server commands (verb: total / of those with no matching rule) ===")
    for verb, n in verbs.most_common(30):
        u = unused[verb]
        note = "  ignored" if u == n else ("  partly ignored" if u else "")
        print(f"  {verb:<14} {n:>6} / {u:>6}{note}")
        if u:
            print(f"        e.g. {sample[verb]}")

    print("\n=== event entities (66 = kill feed) ===")
    for ev, n in events.most_common():
        note = "  <- used" if ev == dm1.OBITUARY_EVENT else ""
        print(f"  Event {ev:>4}: {n:>7}{note}")

    print("\n=== the server's cvar table (name from CS 20 on, value at +128) ===")
    pairs = [(i, cs_last[i], cs_last.get(i + CVAR_VALUE_OFFSET))
             for i in sorted(cs_last) if CVAR_FIRST <= i < CVAR_FIRST + CVAR_VALUE_OFFSET]
    have = [p for p in pairs if p[2] is not None]
    print(f"  {len(have)} of {len(pairs)} names have a value")
    for i, name, val in have:
        if re.search(r"friendlyfire|allowvote|motd|hostname|scr_|timelimit|scorelimit"
                     r"|bomb_timer|TeamName|fallDamage", name):
            print(f"    {i:>4}/{i + CVAR_VALUE_OFFSET:<5} {name:<26} = {val!r}")

    used = {12, 152, 153, dm1.CS_WEAPON_LIST}
    print(f"\n  config strings occupied: {len(cs_last)}, of those used: {len(used)} {sorted(used)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
