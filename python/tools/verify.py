#!/usr/bin/env python3
"""Run the extractor over demo files / folders and report integrity figures.

    py tools/verify.py <demo or folder> [...] [--csv report.csv]

Checks per demo:
  * the container reads to its end marker, no record is cut off
  * every snapshot decodes (no delta from an unavailable snapshot, no
    read past the end of a message, no unknown message opcode)
  * every obituary weapon / means-of-death resolves, every kill names known
    clients (or the world)
  * the recorder's position from the player state is continuous (a wrong
    delta or archive lookup shows up as jumps)
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cod4demo import extract  # noqa: E402

COLUMNS = ["file", "size_mb", "protocol", "seconds", "snapshots", "dropped", "issues",
           "clean_end", "truncated", "players", "kills", "unresolved_kills", "hits",
           "shots", "chat", "hud", "pov_jumps", "status"]


def check(path: Path) -> dict:
    t0 = time.time()
    d = extract(path)
    m = d.meta
    rec = m["records"]
    names = set(int(c) for c in m["players"])
    unresolved = 0
    for k in d.kills.dicts():
        bad_weapon = k["weapon"] is not None and k["weapon_name"] is None    # 0 = "none" is valid
        bad_mod = k["weapon"] is None and k["mod_name"] is None
        # attackers >= 64 are non-player entities (e.g. an exploding car)
        bad_client = k["victim"] not in names or (not k["world"] and k["attacker"] < 64
                                                  and k["attacker"] not in names)
        unresolved += bad_weapon or bad_mod or bad_client
    # continuity of the recorder's own position (not spectating, alive);
    # spawn teleports right after a (fast) map restart are expected
    restarts = [r["server_time"] for r in d.pov_commands.dicts() if r["verb"] in ("n", "B")]
    jumps = 0
    prev = None
    for r in d.pov.dicts():
        if r["spectating"] or r["pm_type"] != 0 or r["x"] is None:
            prev = None
            continue
        if prev is not None:
            # measured in the player's own command time: a client hitch stalls it
            dt = r["command_time"] - prev["command_time"]
            dist = ((r["x"] - prev["x"]) ** 2 + (r["y"] - prev["y"]) ** 2) ** 0.5
            if 0 <= dt <= 100 and dist > 60 + 1.2 * dt:   # faster than any movement
                if not any(abs(r["server_time"] - t) <= 1000 for t in restarts):
                    jumps += 1
        prev = r
    shots = sum(1 for e in d.entity_events.dicts() if e["event_name"] in ("fire_weapon", "fire_weapon_lastshot"))
    ok = (m["clean_end"] and not m["truncated"] and rec["issues"] == 0 and unresolved == 0
          and jumps == 0)
    return {
        "file": path.name, "size_mb": round(m["size_bytes"] / 1e6, 1), "protocol": m["protocol"],
        "seconds": round(time.time() - t0, 1), "snapshots": rec["snapshots"],
        "dropped": rec["snapshots_dropped"], "issues": rec["issues"],
        "clean_end": m["clean_end"], "truncated": m["truncated"], "players": len(names),
        "kills": len(d.kills), "unresolved_kills": unresolved, "hits": len(d.hits),
        "shots": shots, "chat": len(d.chat), "hud": len(d.hud), "pov_jumps": jumps,
        "status": "ok" if ok else "CHECK",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--csv", type=Path)
    args = ap.parse_args()
    files = []
    for p in args.paths:
        files.extend(sorted(p.glob("*.dm_*")) if p.is_dir() else [p])
    rows = []
    print(" | ".join(COLUMNS))
    for f in files:
        try:
            r = check(f)
        except Exception as exc:
            r = {c: "" for c in COLUMNS}
            r.update(file=f.name, status=f"ERROR {exc!r}")
        rows.append(r)
        print(" | ".join(str(r[c]) for c in COLUMNS), flush=True)
    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, COLUMNS)
            w.writeheader()
            w.writerows(rows)
    bad = [r for r in rows if r["status"] != "ok"]
    print(f"\n{len(rows) - len(bad)} of {len(rows)} demos ok")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
