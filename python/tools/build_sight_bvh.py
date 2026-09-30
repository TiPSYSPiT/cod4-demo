#!/usr/bin/env python3
"""Build the sight-line geometry of the web viewer: one BVH file per map.

    py tools/build_sight_bvh.py                 all maps in ../geometry
    py tools/build_sight_bvh.py mp_crash ...    only these maps
    py tools/build_sight_bvh.py --check         build, then compare BVH ray casts with brute force

Input:  geometry/<map>/collision.bin + collision.json (clip map brushes and collision triangles,
        grouped by contents flags - see docs/GEOMETRY.md).
Output: geometry/<map>/sight.bvh (format C4BV, see docs/GEOMETRY.md), geometry/<map>/sight.js (the same
        bytes as base64 for the viewer: fetch() is blocked on file://, a script tag is not) and
        geometry/index.json.

Only the groups that block sight are kept (SIGHT_GROUPS); player / weapon clip, mantle, sky,
triggers and non-solid brushes are dropped. Degenerate and duplicate triangles are removed,
vertices are shared. The BVH is built with a binned surface area heuristic. Output is
deterministic (same input -> same bytes). Standard library only.
"""

from __future__ import annotations

import argparse
import array
import base64
import hashlib
import json
import math
import random
import struct
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True

GEOMETRY = Path(__file__).resolve().parents[2] / "geometry"

MAGIC = b"C4BV"
VERSION = 1
HEADER_SIZE = 64
NODE_SIZE = 32

# group of collision.json -> triangle flag bits (0 = opaque world brush)
FLAG_GLASS = 1          # contents glass: blocks bullets, see-through
FLAG_BRUSHMODEL = 2     # brush entity (door, destructible, scripted object): state at a time unknown
FLAG_TERRAIN = 4        # clip map collision triangle (terrain, curved patches, walls) - no contents flags
SIGHT_GROUPS = {"solid": 0, "terrain": FLAG_TERRAIN, "brushmodel": FLAG_BRUSHMODEL, "glass": FLAG_GLASS}

# BVH build
# (leaf 8 / 24, traversal cost 4: file 40 % smaller than 2 / 8 / 1, same speed in the browser - see docs/GEOMETRY.md)
SAH_BINS = 16
LEAF_MAX = 24           # at most this many triangles per leaf
LEAF_MIN = 8            # always a leaf at or below this
COST_TRAVERSE = 4.0     # SAH cost of one node visit relative to one triangle test
MIN_AREA = 1e-6         # triangles with a smaller area (square units) are dropped as degenerate


def load_collision(folder: Path):
    meta = json.loads((folder / "collision.json").read_text(encoding="utf-8"))
    raw = (folder / "collision.bin").read_bytes()
    if len(raw) != meta["byteLength"] or not meta.get("littleEndian", True):
        raise ValueError(f"{folder.name}: collision.bin does not match collision.json")
    a = meta["attributes"]
    pos = array.array("f"); pos.frombytes(raw[a["position"]["offset"]:a["position"]["offset"] + a["position"]["length"]])
    idx = array.array("I"); idx.frombytes(raw[a["index"]["offset"]:a["index"]["offset"] + a["index"]["length"]])
    if sys.byteorder != "little":
        pos.byteswap(); idx.byteswap()
    return meta, raw, pos, idx


def select_triangles(meta, pos, idx):
    """sight-blocking triangles as vertex tuples + flags; degenerate / duplicate ones dropped"""
    stats = {"source": len(idx) // 3, "kept": 0, "degenerate": 0, "duplicate": 0, "groups": {}}
    seen = {}                       # sorted vertex triple -> position in tris
    tris, flags = [], []
    for g in meta["groups"]:
        if g["name"] not in SIGHT_GROUPS:
            continue
        fl = SIGHT_GROUPS[g["name"]]
        n = 0
        for t in range(g["start"] // 3, (g["start"] + g["count"]) // 3):
            v = [tuple(pos[idx[t * 3 + k] * 3:idx[t * 3 + k] * 3 + 3]) for k in range(3)]
            e1 = [v[1][i] - v[0][i] for i in range(3)]
            e2 = [v[2][i] - v[0][i] for i in range(3)]
            cx = e1[1] * e2[2] - e1[2] * e2[1]; cy = e1[2] * e2[0] - e1[0] * e2[2]; cz = e1[0] * e2[1] - e1[1] * e2[0]
            if (cx * cx + cy * cy + cz * cz) ** 0.5 * 0.5 < MIN_AREA:
                stats["degenerate"] += 1
                continue
            key = tuple(sorted(v))
            j = seen.get(key)
            if j is not None:        # same triangle twice (faces of touching brushes): keep one, opaque wins
                flags[j] &= fl
                stats["duplicate"] += 1
                continue
            seen[key] = len(tris)
            tris.append(v); flags.append(fl); n += 1
        stats["groups"][g["name"]] = n
    stats["kept"] = len(tris)
    return tris, flags, stats


def build_bvh(tris):
    """binned SAH BVH. Returns (nodes, order): nodes = [minx, miny, minz, maxx, maxy, maxz, offset, count, axis]
    in depth-first order (left child = next node, offset = right child for inner nodes / first triangle of
    `order` for leaves)."""
    n = len(tris)
    mn = [[min(t[0][a], t[1][a], t[2][a]) for t in tris] for a in range(3)]
    mx = [[max(t[0][a], t[1][a], t[2][a]) for t in tris] for a in range(3)]
    cen = [[(mn[a][i] + mx[a][i]) * 0.5 for i in range(n)] for a in range(3)]
    nodes, order = [], []

    def bounds(ids):
        return ([min(map(mn[a].__getitem__, ids)) for a in range(3)], [max(map(mx[a].__getitem__, ids)) for a in range(3)])

    def area(lo, hi):
        dx, dy, dz = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]
        return dx * dy + dy * dz + dz * dx

    def leaf(slot, ids):
        nodes[slot][6] = len(order); nodes[slot][7] = len(ids)
        order.extend(ids)

    stack = [(list(range(n)), None)]           # (triangle ids, parent slot waiting for its right child)
    while stack:
        ids, parent = stack.pop()
        slot = len(nodes)
        if parent is not None:
            nodes[parent][6] = slot
        lo, hi = bounds(ids)
        nodes.append([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], 0, 0, 0])
        m = len(ids)
        if m <= LEAF_MIN:
            leaf(slot, ids); continue
        # split axis: the longest extent of the centroids
        clo = [min(map(cen[a].__getitem__, ids)) for a in range(3)]
        chi = [max(map(cen[a].__getitem__, ids)) for a in range(3)]
        ax = max(range(3), key=lambda a: chi[a] - clo[a])
        ext = chi[ax] - clo[ax]
        if ext <= 0:                           # all centroids in one point: split by count
            if m <= LEAF_MAX:
                leaf(slot, ids); continue
            left, right = ids[:m // 2], ids[m // 2:]
        else:
            k = SAH_BINS / ext
            bins = [[] for _ in range(SAH_BINS)]
            c = cen[ax]
            for i in ids:
                b = int((c[i] - clo[ax]) * k)
                bins[b if b < SAH_BINS else SAH_BINS - 1].append(i)
            bb = [bounds(b) if b else None for b in bins]
            # sweep: area * count of the left part (prefix) and the right part (suffix)
            pre, suf = [None] * SAH_BINS, [None] * SAH_BINS
            acc, cnt = None, 0
            for s in range(SAH_BINS):
                if bb[s]:
                    acc = bb[s] if acc is None else ([min(acc[0][a], bb[s][0][a]) for a in range(3)], [max(acc[1][a], bb[s][1][a]) for a in range(3)])
                    cnt += len(bins[s])
                pre[s] = (area(*acc) * cnt) if acc else 0.0
            acc, cnt = None, 0
            for s in range(SAH_BINS - 1, -1, -1):
                if bb[s]:
                    acc = bb[s] if acc is None else ([min(acc[0][a], bb[s][0][a]) for a in range(3)], [max(acc[1][a], bb[s][1][a]) for a in range(3)])
                    cnt += len(bins[s])
                suf[s] = (area(*acc) * cnt) if acc else 0.0
            pa = area(lo, hi) or 1.0
            best, split = None, None
            for s in range(1, SAH_BINS):
                nl = sum(len(b) for b in bins[:s])
                if nl == 0 or nl == m:
                    continue
                cost = COST_TRAVERSE + (pre[s - 1] + suf[s]) / pa
                if best is None or cost < best:
                    best, split = cost, s
            if m <= LEAF_MAX and (split is None or best >= m):      # a leaf is cheaper (leaf cost = m tests)
                leaf(slot, ids); continue
            if split is None:
                left, right = ids[:m // 2], ids[m // 2:]
            else:
                left = [i for b in bins[:split] for i in b]; right = [i for b in bins[split:] for i in b]
        nodes[slot][8] = ax
        stack.append((right, slot))            # popped after the whole left subtree
        stack.append((left, None))
    return nodes, order


def write_bvh(path: Path, tris, flags, nodes, order):
    verts, vindex, tri_idx = [], {}, array.array("I")
    for t in order:
        for v in tris[t]:
            j = vindex.get(v)
            if j is None:
                j = vindex[v] = len(verts); verts.append(v)
            tri_idx.append(j)
    vbuf = array.array("f", [c for v in verts for c in v])
    fbuf = bytes(flags[t] for t in order)
    fbuf += b"\0" * (-len(fbuf) % 4)
    nbuf = bytearray()
    for nd in nodes:
        nbuf += struct.pack("<6fIHH", *nd[:6], nd[6], nd[7], nd[8])
    if sys.byteorder != "little":
        vbuf.byteswap(); tri_idx.byteswap()
    off_v = HEADER_SIZE
    off_i = off_v + len(vbuf) * 4
    off_f = off_i + len(tri_idx) * 4
    off_n = off_f + len(fbuf)
    root = nodes[0]
    header = struct.pack("<4sIIIIIIII6fI", MAGIC, VERSION, len(verts), len(order), len(nodes), off_v, off_i, off_f, off_n, *root[:6], LEAF_MAX)
    data = header + vbuf.tobytes() + tri_idx.tobytes() + fbuf + bytes(nbuf)
    path.write_bytes(data)
    depth = bvh_depth(nodes)
    return {"bytes": len(data), "vertices": len(verts), "triangles": len(order), "nodes": len(nodes), "depth": depth,
            "sha256": hashlib.sha256(data).hexdigest(), "bounds": [round(x, 3) for x in root[:6]]}


def write_script(folder: Path, data: bytes):
    """geometry/<map>/sight.js: C4.sight.register('<map>', '<base64 of sight.bvh>') (js/analysis/sight.js)"""
    text = ("/* Sight-line geometry of " + folder.name + " - GENERATED by python/tools/build_sight_bvh.py, do not edit.\n"
            " * C4BV v1 (docs/GEOMETRY.md) as base64; map geometry from the game files. */\n"
            "C4.sight.register(" + json.dumps(folder.name) + ", '" + base64.b64encode(data).decode("ascii") + "');\n")
    raw = text.encode("ascii")
    (folder / "sight.js").write_bytes(raw)
    return {"file": folder.name + "/sight.js", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def bvh_depth(nodes):
    best, stack = 0, [(0, 1)]
    while stack:
        i, d = stack.pop()
        best = max(best, d)
        if nodes[i][7] == 0:
            stack.append((i + 1, d + 1)); stack.append((nodes[i][6], d + 1))
    return best


# ---------- reading + ray casting (for --check; the viewer does the same in JavaScript) ----------

def read_bvh(path: Path):
    data = path.read_bytes()
    magic, ver, nv, nt, nn, ov, oi, of, on = struct.unpack_from("<4sIIIIIIII", data, 0)
    if magic != MAGIC or ver != VERSION:
        raise ValueError(f"{path}: not a {MAGIC.decode()} v{VERSION} file")
    v = array.array("f"); v.frombytes(data[ov:ov + nv * 12])
    ix = array.array("I"); ix.frombytes(data[oi:oi + nt * 12])
    fl = data[of:of + nt]
    nodes = [struct.unpack_from("<6fIHH", data, on + i * NODE_SIZE) for i in range(nn)]
    tris = [tuple(tuple(v[ix[t * 3 + k] * 3:ix[t * 3 + k] * 3 + 3]) for k in range(3)) for t in range(nt)]
    return tris, fl, nodes


def seg_tri(o, d, t):
    """Moeller-Trumbore on the segment o + s*d, s in [0, 1] -> s or None"""
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
    e1x, e1y, e1z = bx - ax, by - ay, bz - az
    e2x, e2y, e2z = cx - ax, cy - ay, cz - az
    px, py, pz = d[1] * e2z - d[2] * e2y, d[2] * e2x - d[0] * e2z, d[0] * e2y - d[1] * e2x
    det = e1x * px + e1y * py + e1z * pz
    if -1e-9 < det < 1e-9:
        return None
    inv = 1.0 / det
    tx, ty, tz = o[0] - ax, o[1] - ay, o[2] - az
    u = (tx * px + ty * py + tz * pz) * inv
    if u < 0 or u > 1:
        return None
    qx, qy, qz = ty * e1z - tz * e1y, tz * e1x - tx * e1z, tx * e1y - ty * e1x
    w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
    if w < 0 or u + w > 1:
        return None
    s = (e2x * qx + e2y * qy + e2z * qz) * inv
    return s if 0 <= s <= 1 else None


def first_hit_bvh(tris, nodes, o, d):
    inv = [1.0 / c if c else float("inf") for c in d]
    best, stack = None, [0]
    while stack:
        i = stack.pop()
        n = nodes[i]
        t0, t1 = 0.0, 1.0 if best is None else best
        for a in range(3):
            if d[a] == 0:
                if o[a] < n[a] or o[a] > n[a + 3]:
                    break
                continue
            ta, tb = (n[a] - o[a]) * inv[a], (n[a + 3] - o[a]) * inv[a]
            if ta > tb:
                ta, tb = tb, ta
            t0, t1 = max(t0, ta), min(t1, tb)
            if t0 > t1:
                break
        else:
            if n[7]:
                for t in range(n[6], n[6] + n[7]):
                    s = seg_tri(o, d, tris[t])
                    if s is not None and (best is None or s < best):
                        best = s
            else:
                stack.append(n[6]); stack.append(i + 1)
    return best


def check(folder: Path, rays: int, seed: int = 1):
    """structure checks, then the first hit of random sight lines: BVH vs brute force over the source triangles"""
    meta, _, pos, idx = load_collision(folder)
    src, _, _ = select_triangles(meta, pos, idx)
    tris, _, nodes = read_bvh(folder / "sight.bvh")
    js = (folder / "sight.js").read_text(encoding="ascii")
    b64 = js[js.index(", '") + 3:js.rindex("')")]
    assert base64.b64decode(b64) == (folder / "sight.bvh").read_bytes(), "sight.js does not hold the bytes of sight.bvh"
    # structural checks: every triangle once, children inside their parent
    covered = [0] * len(tris)
    for i, n in enumerate(nodes):
        if n[7]:
            for t in range(n[6], n[6] + n[7]):
                covered[t] += 1
                for v in tris[t]:
                    assert all(n[a] - 1e-3 <= v[a] <= n[a + 3] + 1e-3 for a in range(3)), f"node {i}: triangle {t} outside"
        else:
            for c in (i + 1, n[6]):
                assert all(nodes[c][a] >= n[a] - 1e-3 and nodes[c][a + 3] <= n[a + 3] + 1e-3 for a in range(3)), f"node {c} outside parent {i}"
    assert all(c == 1 for c in covered), "a triangle is in no leaf or in more than one"
    assert sorted(map(lambda t: tuple(sorted(t)), tris)) == sorted(map(lambda t: tuple(sorted(t)), src)), "triangles differ from the source"
    rnd = random.Random(seed)
    # sight lines like the viewer's: eye height (60) above a floor point -> chest height (48) above another
    # floor point 100 .. 3000 units away; floor = centre of an upward-facing triangle
    floors = []
    for t in src:
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
        nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay); ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az); nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        nl = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nl and nz / nl > 0.7:
            floors.append(((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3))
    bad, hits, t_bvh, t_brute = 0, 0, 0.0, 0.0
    for _ in range(rays):
        for _try in range(1000):
            f1, f2 = rnd.choice(floors), rnd.choice(floors)
            if 100 <= math.hypot(f2[0] - f1[0], f2[1] - f1[1]) <= 3000:
                break
        o = [f1[0], f1[1], f1[2] + 60]
        d = [f2[0] - f1[0], f2[1] - f1[1], f2[2] + 48 - o[2]]
        ln = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
        a = time.perf_counter(); h1 = first_hit_bvh(tris, nodes, o, d); t_bvh += time.perf_counter() - a
        a = time.perf_counter(); h2 = None
        for t in src:
            s = seg_tri(o, d, t)
            if s is not None and (h2 is None or s < h2):
                h2 = s
        t_brute += time.perf_counter() - a
        hits += h2 is not None
        if (h1 is None) != (h2 is None) or (h1 is not None and abs(h1 - h2) * ln > 1e-3):
            bad += 1
    return {"rays": rays, "hits": hits, "mismatches": bad, "ms_bvh": round(t_bvh / rays * 1000, 3), "ms_brute": round(t_brute / rays * 1000, 1)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("maps", nargs="*", help="map names (default: every folder in geometry/ with collision.bin)")
    ap.add_argument("--check", type=int, nargs="?", const=100, metavar="RAYS", help="compare RAYS random ray casts with brute force (default 100)")
    args = ap.parse_args()
    folders = [GEOMETRY / m for m in args.maps] if args.maps else sorted(p for p in GEOMETRY.iterdir() if (p / "collision.bin").is_file())
    index_path = GEOMETRY / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.is_file() else {}
    index.update({
        "format": MAGIC.decode(), "version": VERSION, "tool": "python/tools/build_sight_bvh.py",
        "groups": {k: v for k, v in SIGHT_GROUPS.items()},
        "flags": {"glass": FLAG_GLASS, "brushmodel": FLAG_BRUSHMODEL, "terrain": FLAG_TERRAIN},
        "build": {"sahBins": SAH_BINS, "leafMax": LEAF_MAX, "leafMin": LEAF_MIN, "costTraverse": COST_TRAVERSE, "minArea": MIN_AREA},
    })
    maps = index.setdefault("maps", {})
    for folder in folders:
        if not (folder / "collision.bin").is_file():
            print(f"{folder.name}: no collision.bin - skipped")
            continue
        t0 = time.perf_counter()
        meta, raw, pos, idx = load_collision(folder)
        tris, flags, st = select_triangles(meta, pos, idx)
        nodes, order = build_bvh(tris)
        info = write_bvh(folder / "sight.bvh", tris, flags, nodes, order)
        info["script"] = write_script(folder, (folder / "sight.bvh").read_bytes())
        info.update({"file": folder.name + "/sight.bvh", "sourceTriangles": st["source"], "droppedDegenerate": st["degenerate"],
                     "droppedDuplicate": st["duplicate"], "groupTriangles": st["groups"],
                     "flagged": {k: sum(1 for f in flags if f & b) for k, b in (("glass", FLAG_GLASS), ("brushmodel", FLAG_BRUSHMODEL), ("terrain", FLAG_TERRAIN))},
                     "source": {"file": folder.name + "/collision.bin", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}})
        prev = maps.get(folder.name) or {}
        if not args.check and prev.get("sha256") == info["sha256"] and "check" in prev:
            info["check"] = prev["check"]      # same bytes as the checked file: the check still applies
        maps[folder.name] = info
        print(f"{folder.name:16} {st['source']:7} -> {info['triangles']:7} tris  {info['vertices']:7} verts  {info['nodes']:7} nodes  depth {info['depth']:3}  "
              f"{info['bytes'] / 1e6:5.2f} MB  {time.perf_counter() - t0:5.1f} s")
        if args.check:
            r = check(folder, args.check)
            info["check"] = r
            print(f"{'':16} check: {r}")
    index["maps"] = dict(sorted(maps.items()))
    index_path.write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
