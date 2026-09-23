#!/usr/bin/env python3
"""Generate ``cod4demo/_netfields.py`` from the CoD4 net field tables.

    py tools/gen_netfields.py <CoD4-DM1>/src/Crypt/NetFields.cpp \
        [--kisak <KisakCOD>/src/qcommon/sv_msg_write_mp.cpp]

The primary source is ``NetFields.cpp`` of Iswenzz/CoD4-DM1 (complete set of
tables). If the KisakCOD file is given, every table present in both is
compared entry by entry (order, bit count, change hint) and the script aborts
on any difference.

Each entity field additionally gets a *slot*: its 32-bit word offset inside
``entityState_t``. Different entity types name the same union word
differently (``lerp.u.missile.launchTime`` vs ``lerp.u.anonymous.buffer[0]``),
and delta decoding works on memory offsets, so state is stored per slot.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TABLE = re.compile(r"netField_t NetFields::(\w+)\[\w+\]\s*=\s*\{(.*?)\n\t\};", re.S)
KISAK_TABLE = re.compile(r"NetField (\w+)\[\d+\]\s*=\s*\{(.*?)\n\};", re.S)
ENTRY = re.compile(r"\{\s*\w+\(([^)]*)\)\s*,\s*(-?\d+)\s*,\s*(\d+)u?\s*\}")
LIST = re.compile(r"netFieldList_t NetFields::List\[\w+\]\s*=\s*\{(.*?)\n\t\};", re.S)
LIST_ENTRY = re.compile(r"NETFE\((\w+)\)")

# entityState_t layout (byte offsets), see DemoData.hpp / the engine
_ENT_OFFSETS = {
    "number": 0, "eType": 4, "lerp.eFlags": 8,
    "lerp.pos.trType": 12, "lerp.pos.trTime": 16, "lerp.pos.trDuration": 20,
    "lerp.pos.trBase[0]": 24, "lerp.pos.trBase[1]": 28, "lerp.pos.trBase[2]": 32,
    "lerp.pos.trDelta[0]": 36, "lerp.pos.trDelta[1]": 40, "lerp.pos.trDelta[2]": 44,
    "lerp.apos.trType": 48, "lerp.apos.trTime": 52, "lerp.apos.trDuration": 56,
    "lerp.apos.trBase[0]": 60, "lerp.apos.trBase[1]": 64, "lerp.apos.trBase[2]": 68,
    "lerp.apos.trDelta[0]": 72, "lerp.apos.trDelta[1]": 76, "lerp.apos.trDelta[2]": 80,
    # lerp.u union: 84 .. 111 (7 words)
    "time2": 112, "otherEntityNum": 116, "attackerEntityNum": 120,
    "groundEntityNum": 124, "loopSound": 128, "surfType": 132, "index": 136,
    "ClientNum": 140, "iHeadIcon": 144, "iHeadIconTeam": 148, "solid": 152,
    "eventParm": 156, "eventSequence": 160,
    "events[0]": 164, "events[1]": 168, "events[2]": 172, "events[3]": 176,
    "eventParms[0]": 180, "eventParms[1]": 184, "eventParms[2]": 188, "eventParms[3]": 192,
    "weapon": 196, "weaponModel": 200, "legsAnim": 204, "torsoAnim": 208,
    "un1": 212, "un1.helicopterStage": 212, "un2": 216,
    "fTorsoPitch": 220, "fWaistPitch": 224,
    "partBits[0]": 228, "partBits[1]": 232, "partBits[2]": 236, "partBits[3]": 240,
}
_UNION_BASE = 84
_UNION_MEMBERS = {
    "player.leanf": 0, "player.movementDir": 4,
    "loopFx.cullDist": 0, "loopFx.period": 4,
    "missile.launchTime": 0,
    "soundBlend.lerp": 0,
    "vehicle.bodyPitch": 0, "vehicle.bodyRoll": 4, "vehicle.steerYaw": 8,
    "vehicle.materialTime": 12, "vehicle.gunPitch": 16, "vehicle.gunYaw": 20,
    "vehicle.team": 24,
}
ENTITY_WORDS = 244 // 4

#: 32-bit fields that are bit masks, shown unsigned
_BITMASKS = re.compile(r"^(weapons|weaponold|weaponrechamber|partBits|perks|"
                       r"lerp\.u\.anonymous|iCompassPlayerInfo|clientMask|r\.clientMask|"
                       r"s\.partBits|netname)")

_FLOAT_CODES = {0, -100, -99, -92, -91, -90, -89, -88, -87, -86}


def entity_slot(name: str) -> int:
    if name == "clientNum":             # KisakCOD spelling
        name = "ClientNum"
    if name in _ENT_OFFSETS:
        return _ENT_OFFSETS[name] // 4
    m = re.fullmatch(r"lerp\.u\.anonymous\.(?:buffer|data)\[(\d)\]", name)
    if m:
        return (_UNION_BASE + 4 * int(m.group(1))) // 4
    m = re.fullmatch(r"lerp\.u\.(\w+\.\w+)", name)
    if m and m.group(1) in _UNION_MEMBERS:
        return (_UNION_BASE + _UNION_MEMBERS[m.group(1)]) // 4
    raise SystemExit(f"no entityState_t offset known for field {name!r}")


def kind(name: str, bits: int) -> str:
    """Value type: f = float, i = signed int, u = unsigned int, c = RGBA colour."""
    if bits in _FLOAT_CODES:
        return "f"
    if bits == -85:
        return "c"
    if bits in (-98, -96, -94, -93):
        return "u"
    if bits in (-97, -95):
        return "i"
    if bits < 0:
        return "i"
    if bits == 32:
        return "u" if _BITMASKS.match(name) else "i"
    return "u"


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).upper()


def read_tables(src: str, pattern: re.Pattern) -> dict[str, list[tuple[str, int, int]]]:
    tables = {}
    for name, body in pattern.findall(src):
        fields = [(f.strip(), int(b), int(h)) for f, b, h in ENTRY.findall(body)]
        if fields:
            tables[name] = fields
    return tables


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("netfields_cpp", type=Path)
    ap.add_argument("--kisak", type=Path, help="KisakCOD qcommon/sv_msg_write_mp.cpp for cross-checking")
    ap.add_argument("-o", "--out", type=Path,
                    default=Path(__file__).resolve().parents[1] / "cod4demo" / "_netfields.py")
    args = ap.parse_args()

    src = args.netfields_cpp.read_text(encoding="utf-8-sig", errors="replace")
    tables = read_tables(src, TABLE)
    m = LIST.search(src)
    if not m:
        raise SystemExit("NetFields::List not found")
    order = LIST_ENTRY.findall(m.group(1))

    if args.kisak:
        ksrc = args.kisak.read_text(encoding="utf-8", errors="replace")
        ktables = read_tables(ksrc, KISAK_TABLE)
        checked = 0
        for kname, kfields in ktables.items():
            dname = kname[0].upper() + kname[1:]
            dname = dname.replace("Missile", "Missle")
            if dname not in tables:
                continue
            dfields = tables[dname]
            if len(dfields) != len(kfields):
                raise SystemExit(f"{dname}: {len(dfields)} vs {len(kfields)} fields")
            for i, (a, b) in enumerate(zip(dfields, kfields)):
                if a[1:] != b[1:] or entity_slot_safe(a[0]) != entity_slot_safe(b[0]):
                    raise SystemExit(f"{dname}[{i}]: {a} vs {b}")
            checked += 1
        print(f"cross-checked {checked} tables against KisakCOD: identical")

    entity_tables = [n for n in tables if n in order]
    lines = [
        '"""CoD4 net field tables - GENERATED by tools/gen_netfields.py, do not edit.',
        "",
        "Source: NetFields.cpp of https://github.com/Iswenzz/CoD4-DM1 (GPL-3.0),",
        "cross-checked against KisakCOD qcommon/sv_msg_write_mp.cpp.",
        "",
        "Every entry is (name, bits, changeHints, kind[, slot]):",
        "  bits   > 0: unsigned integer of that width, < 0 and > -85: signed integer,",
        "         0: float, -85 .. -100: special encodings (see delta.py)",
        "  kind   f float, i signed int, u unsigned int, c RGBA colour",
        "  slot   (entity tables only) 32-bit word offset in entityState_t",
        '"""',
        "",
        f"ENTITY_WORDS = {ENTITY_WORDS}",
        "",
    ]
    for name, fields in tables.items():
        is_ent = name in entity_tables
        lines.append(f"{snake(name)} = (")
        for f, b, h in fields:
            if is_ent:
                lines.append(f'    ("{f}", {b}, {h}, "{kind(f, b)}", {entity_slot(f)}),')
            else:
                lines.append(f'    ("{f}", {b}, {h}, "{kind(f, b)}"),')
        lines.append(")")
        lines.append("")
    lines.append("#: eType -> field table; eType values above the last index use the last one")
    lines.append("ENTITY_TABLES = (")
    for name in order:
        lines.append(f"    {snake(name)},")
    lines.append(")")
    lines.append("ENTITY_TABLE_NAMES = (")
    for name in order:
        lines.append(f'    "{name}",')
    lines.append(")")
    lines.append("")
    args.out.write_text("\n".join(lines), encoding="ascii", newline="\n")
    print(f"{args.out}: {len(tables)} tables, {sum(len(v) for v in tables.values())} fields")
    return 0


def entity_slot_safe(name: str):
    try:
        return entity_slot(name)
    except SystemExit:
        return name


if __name__ == "__main__":
    sys.exit(main())
