"""Cross-check every demo in a folder and list what could be read.

    py source/py/verify_all.py [ORDNER] [-o analysis/verify_all.txt]

Prueft je Demo drei Ebenen:
  1. Container   - Huffman stream readable to the end, no sync errors
  2. Contents    - are all sections filled (teams, players, rounds, kills, ...)
  3. Consistency - kill feed against scoreboard, round wins against final score
"""

from __future__ import annotations

import argparse
import collections
import io
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dm1

ROOT = pathlib.Path(__file__).resolve().parents[2]


def check(path: pathlib.Path) -> dict:
    """Parse one demo and run every check against it."""
    t0 = time.perf_counter()
    d = dm1.parse_demo(path.read_bytes(), deep=True)
    m = dm1.analyze(d)
    j = m.to_dict()
    secs = time.perf_counter() - t0
    strip = dm1.strip_colors
    info = j["info"]
    names = {p["client"]: strip(p["name"]) for p in j["players"]}
    team = {p["client"]: p["team"] for p in j["players"]}

    problems: list[str] = []

    # --- level 1: container ---------------------------------------------
    if d.snapshot_errors:
        problems.append(f"{d.snapshot_errors} snapshot sync errors")
    if not d.clean_eof:
        problems.append("no clean end of file (demo truncated?)")

    # --- level 2: contents ----------------------------------------------
    if not info["map"]:
        problems.append("no map name in the gamestate")
    if len(j["teams"]) != 2:
        problems.append(f"{len(j['teams'])} teams instead of 2")
    unnamed = [p for p in j["players"] if not strip(p["name"])]
    if unnamed:
        problems.append(f"{len(unnamed)} players without a name")
    nostats = [names[p["client"]] for p in j["players"] if not p["hasStats"]]
    if nostats:
        problems.append("no scoreboard entry: " + ", ".join(nostats))
    if not j["rounds"]:
        problems.append("no rounds detected")
    if not j["kills"]:
        problems.append("no kill feed")

    # --- level 3: consistency ---------------------------------------------
    wins = collections.Counter(r["winner"] for r in j["rounds"])
    for t in j["teams"]:
        if wins.get(t["name"], 0) != t["wins"]:
            problems.append(f"round wins {t['name']}: {wins.get(t['name'], 0)} != {t['wins']}")
    if wins.get("?"):
        problems.append(f"{wins['?']} rounds without a winner")
    lim = info["scorelimit"]
    best = max((t["wins"] for t in j["teams"]), default=0)
    if lim and best > lim:
        problems.append(f"winner has {best} rounds, the limit is {lim}")
    for r in j["rounds"]:
        if r["reason"].endswith(" eliminated") and r["reason"][:-11] == r["winner"]:
            problems.append(f"R{r['n']}: winner {r['winner']} was eliminated according to the reason")

    in_round: collections.Counter = collections.Counter()
    for r in j["rounds"]:
        for e in r["timeline"]:
            if (e.get("kind") == "kill" and not e["suicide"]
                    and team.get(e["killer"]) != team.get(e["victim"])):
                in_round[e["killer"]] += 1
    for p in j["players"]:
        if in_round.get(p["client"], 0) != p["kills"]:
            problems.append(f"kills {names[p['client']]}: feed "
                            f"{in_round.get(p['client'], 0)} != scoreboard {p['kills']}")

    unknown = sorted({k["weaponLabel"] for k in j["kills"] if k["weapon"].startswith("weapon #")})
    if unknown:
        problems.append("unknown weapon ids: " + ", ".join(unknown))
    # For a death with no attacker the killer field holds the world entity - a
    # missing name is right there, anywhere else it would be a gap.
    nameless = [k for k in j["kills"]
                if k["victim"] not in names or (not k["suicide"] and k["killer"] not in names)]
    if nameless:
        problems.append(f"{len(nameless)} kills with an unknown player")

    return {"path": path, "d": d, "j": j, "secs": secs, "problems": problems,
            "world": sum(1 for k in j["kills"] if k["suicide"]),
            "weapons": collections.Counter(k["weaponLabel"] for k in j["kills"])}


def report(res: dict, out: io.StringIO) -> None:
    """Write the check report for one demo."""
    p, d, j = res["path"], res["d"], res["j"]
    info, strip = j["info"], dm1.strip_colors
    w = out.write
    top = res["weapons"].most_common(6)
    w(f"=== {p.name} ===\n")
    w(f"  File        {info['sizeBytes']:,} bytes, read in {res['secs']:.1f}s\n")
    w(f"  Match       {info['map']} | {info['gametype']} | {info['mod'] or '-'} | "
      f"protocol {info['protocol']}\n")
    w(f"  Server      {info['server'] or '-'}\n")
    w(f"  Ruleset     {info['ruleset'] or '-'}\n")
    w(f"  Container   {d.snapshots:,} snapshots, {d.frames:,} frames, {d.baselines} baselines, "
      f"{info['configstrings']} config strings\n")
    w(f"              sync errors {d.snapshot_errors}, clean end of file: "
      f"{'yes' if d.clean_eof else 'NO'}\n")
    w(f"  Result      {j['teams'][0]['name']} {j['teams'][0]['wins']} : "
      f"{j['teams'][1]['wins']} {j['teams'][1]['name']}   (halves "
      f"{j['teams'][0]['halves']} / {j['teams'][1]['halves']}, limit {info['scorelimit']})\n")
    w(f"  Read        {len(j['players'])} players, {len(j['rounds'])} rounds, "
      f"{len(j['kills'])} kills ({info['duplicateObituaries']} duplicates removed, "
      f"{res['world']} of them without an attacker), "
      f"{len(j['chat'])} chat, {len(j['events'])} events\n")
    w(f"  POV         {strip(info['povName']) or '-'} | length "
      f"{info['durationS'] // 60}:{info['durationS'] % 60:02d} min\n")
    w(f"  Weapons     {len(res['weapons'])} different: "
      f"{', '.join(f'{k} {v}' for k, v in top)}"
      f"{' ...' if len(res['weapons']) > 6 else ''}\n")
    w("  CHECK       " + ("everything read and consistent\n" if not res["problems"]
                          else "PROBLEMS:\n"))
    for x in res["problems"]:
        w("   - " + x + "\n")
    w("\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="Cross-check every demo in a folder.")
    ap.add_argument("folder", nargs="?", type=pathlib.Path, default=ROOT / "demos")
    ap.add_argument("-o", "--out", type=pathlib.Path, default=ROOT / "analysis" / "verify_all.txt")
    args = ap.parse_args()

    demos = sorted(args.folder.glob("*.dm_1"))
    if not demos:
        raise SystemExit(f"no .dm_1 files in {args.folder}")

    out = io.StringIO()
    out.write(f"Cross-check of {len(demos)} demos from {args.folder.name}/\n")
    out.write("=" * 68 + "\n\n")
    results = []
    for path in demos:
        print(f"... {path.name}", file=sys.stderr, flush=True)
        res = check(path)
        results.append(res)
        report(res, out)

    bad = [r for r in results if r["problems"]]
    out.write("=" * 68 + "\n")
    out.write(f"{'Demo':<34}{'Snaps':>8}{'Err':>5}{'Players':>8}{'Rnd':>5}"
              f"{'Kills':>7}{'Chat':>6}{'Ev':>5}  Status\n")
    for r in results:
        j = r["j"]
        out.write(f"{r['path'].name:<34}{r['d'].snapshots:>8,}{r['d'].snapshot_errors:>5}"
                  f"{len(j['players']):>8}{len(j['rounds']):>5}{len(j['kills']):>7}"
                  f"{len(j['chat']):>6}{len(j['events']):>5}  "
                  f"{'ok' if not r['problems'] else 'PROBLEM'}\n")
    out.write("=" * 68 + "\n")
    out.write(f"{len(results) - len(bad)} of {len(results)} demos read completely "
              f"and consistently.\n")
    if bad:
        out.write("Flagged: " + ", ".join(r["path"].name for r in bad) + "\n")

    text = out.getvalue()
    print(text)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8", newline="\n")
    print(f"-> {args.out}", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
