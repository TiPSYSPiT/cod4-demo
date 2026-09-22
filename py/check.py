"""Consistency check of one demo: kill feed against scoreboard, rounds against the final score."""
import sys, pathlib, collections, re
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dm1

path = pathlib.Path(sys.argv[1])
d = dm1.parse_demo(path.read_bytes(), deep=True)
m = dm1.analyze(d)
j = m.to_dict()
strip = dm1.strip_colors
names = {p["client"]: strip(p["name"]) for p in j["players"]}
team = {p["client"]: p["team"] for p in j["players"]}
print(f"=== {path.name} ===")
print(f"  {d.snapshots} snapshots, sync errors: {d.snapshot_errors}, clean EOF: {d.clean_eof}, "
      f"baselines: {d.baselines}")
print(f"  {j['info']['obituaries']} obituaries ({j['info']['duplicateObituaries']} duplicates removed), "
      f"{len(j['rounds'])} rounds, POV: {strip(j['info']['povName'])}")
print(f"  Final {j['teams'][0]['name']} {j['teams'][0]['wins']} : "
      f"{j['teams'][1]['wins']} {j['teams'][1]['name']}   halves "
      f"{j['teams'][0]['halves']} / {j['teams'][1]['halves']}")

problems = []
# 1) round wins = final score
wins = collections.Counter(r["winner"] for r in j["rounds"])
for t in j["teams"]:
    if wins.get(t["name"], 0) != t["wins"]:
        problems.append(f"round wins {t['name']}: {wins.get(t['name'],0)} != {t['wins']}")
if wins.get("?"):
    problems.append(f"{wins['?']} rounds without a winner")
# 2) final score plausible for the MR format
lim = j["info"]["scorelimit"]
mx = max(t["wins"] for t in j["teams"])
if lim and mx > lim:
    problems.append(f"winner has {mx} rounds, the limit is {lim}")
# 3) reason matches the winner
for r in j["rounds"]:
    if r["reason"].endswith(" eliminated") and r["reason"][:-11] == r["winner"]:
        problems.append(f"R{r['n']}: winner {r['winner']} was eliminated according to the reason")
# 4) kill feed within the rounds against the scoreboard
in_round = collections.Counter()
for r in j["rounds"]:
    for e in r["timeline"]:
        if (e.get("kind") == "kill" and not e["suicide"]
                and team.get(e["killer"]) != team.get(e["victim"])):
            in_round[e["killer"]] += 1
print(f"\n  {'Player':<20} {'Feed':>5} {'Scoreboard':>11}")
for p in j["players"]:
    v, sb = in_round.get(p["client"], 0), p["kills"]
    mark = "" if v == sb else "   <-- differs"
    if v != sb:
        problems.append(f"kills {names[p['client']]}: feed {v} != scoreboard {sb}")
    print(f"  {names[p['client']]:<20} {v:>5} {sb:>11}{mark}")
# 5) team kills / unknown weapons
tk = [k for k in j["kills"] if not k["suicide"] and team.get(k["killer"]) == team.get(k["victim"])]
unknown = collections.Counter(k["weaponLabel"] for k in j["kills"] if k["weapon"].startswith("weapon #"))
print(f"\n  team kills: {len(tk)} | unknown weapon ids: {dict(unknown) or 'none'}")
if unknown:
    problems.append("unknown weapon ids: " + ", ".join(sorted(unknown)))
print(f"  weapons: {dict(collections.Counter(k['weaponLabel'] for k in j['kills']).most_common())}")
print("\n  RESULT:", "everything consistent" if not problems else "PROBLEMS:")
for x in problems:
    print("   -", x)
