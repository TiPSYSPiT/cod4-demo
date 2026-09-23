"""Named, typed views of the raw decoder states.

The decoder keeps every field as a raw 32-bit pattern. This module converts
them according to the field tables: floats, signed/unsigned ints, RGBA
colours - and knows which table applies to which entity type.
"""

from __future__ import annotations

from . import _netfields as NF
from .bitmsg import s32, u2f
from .constants import (EF_FLAGS, ET_EVENTS, PERK_NAMES, PMF_FLAGS, STAT_NAMES)
from .delta import (ENTITY_TABLE_LAST, HUD_INDEX, NULL_ENTITY, PS_INDEX, CS_INDEX,
                    PlayerState)

FLOAT_DIGITS = 4


def convert(raw: int, kind: str):
    if kind == "f":
        v = u2f(raw)
        if v != v or v in (float("inf"), float("-inf")):
            return None
        return round(v, FLOAT_DIGITS)
    if kind == "i":
        return s32(raw)
    if kind == "c":
        return [raw & 0xFF, (raw >> 8) & 0xFF, (raw >> 16) & 0xFF, (raw >> 24) & 0xFF]
    return raw & 0xFFFFFFFF


# ---------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------

def entity_table(etype: int):
    return NF.ENTITY_TABLES[etype if etype < ENTITY_TABLE_LAST else ENTITY_TABLE_LAST]


#: slots common to every entity table
E = {
    "eType": 1, "eFlags": 2, "pos.trType": 3, "pos.trTime": 4, "pos.trDuration": 5,
    "pos.trBase": (6, 7, 8), "pos.trDelta": (9, 10, 11),
    "apos.trType": 12, "apos.trTime": 13, "apos.trBase": (15, 16, 17),
    "apos.trDelta": (18, 19, 20), "u": (21, 22, 23, 24, 25, 26, 27),
    "time2": 28, "otherEntityNum": 29, "attackerEntityNum": 30, "groundEntityNum": 31,
    "loopSound": 32, "surfType": 33, "index": 34, "clientNum": 35, "iHeadIcon": 36,
    "iHeadIconTeam": 37, "solid": 38, "eventParm": 39, "eventSequence": 40,
    "events": (41, 42, 43, 44), "eventParms": (45, 46, 47, 48), "weapon": 49,
    "weaponModel": 50, "legsAnim": 51, "torsoAnim": 52, "un1": 53, "un2": 54,
    "fTorsoPitch": 55, "fWaistPitch": 56, "partBits": (57, 58, 59, 60),
}


def entity_dict(state, include_zero: bool = False) -> dict:
    """All transmitted fields of an entity with the names of its eType's table."""
    etype = state[1]
    out = {"number": state[0]}
    for name, _bits, _hint, kind, slot in entity_table(etype):
        raw = state[slot]
        if raw or include_zero:
            out[name] = convert(raw, kind)
    return out


def entity_delta_dict(old, new) -> dict:
    """Fields of ``new`` that differ from ``old`` (named per new eType)."""
    out = {}
    for name, _bits, _hint, kind, slot in entity_table(new[1]):
        if old is None or old[slot] != new[slot]:
            out[name] = convert(new[slot], kind)
    return out


def fvec(state, slots) -> tuple:
    return tuple(round(u2f(state[s]), FLOAT_DIGITS) for s in slots)


def ffloat(state, slot) -> float:
    return round(u2f(state[slot]), FLOAT_DIGITS)


def flag_names(value: int, table: dict[int, str]) -> list[str]:
    out = []
    rest = value
    for bit, name in table.items():
        if value & bit == bit:
            out.append(name)
            rest &= ~bit
    b = 0
    while rest:
        if rest & 1:
            out.append(f"bit{b}")
        rest >>= 1
        b += 1
    return out


def stance_from_eflags(eflags: int) -> str:
    if eflags & 0x8:
        return "prone"
    if eflags & 0x4:
        return "crouch"
    return "stand"


def perk_names(mask: int) -> list[str]:
    return [PERK_NAMES[i] if i < len(PERK_NAMES) else f"perk{i}"
            for i in range(32) if mask & (1 << i)]


# ---------------------------------------------------------------------------
# Player state
# ---------------------------------------------------------------------------

PS_KINDS = tuple(f[3] for f in NF.PLAYER_STATE_FIELDS)
PS_NAMES = tuple(f[0] for f in NF.PLAYER_STATE_FIELDS)


def ps_value(ps: PlayerState, name: str):
    i = PS_INDEX[name]
    return convert(ps.fields[i], PS_KINDS[i])


def ps_dict(ps: PlayerState, full: bool = False) -> dict:
    """The player state as a dict. ``full`` adds ammo, HUD and objectives."""
    out = {name: convert(raw, kind) for name, raw, kind in zip(PS_NAMES, ps.fields, PS_KINDS)}
    out["stats"] = dict(zip(STAT_NAMES, ps.stats))
    out["origin_from_archive"] = ps.origin_from_archive
    if full:
        out["ammo"] = {i: v for i, v in enumerate(ps.ammo) if v}
        out["ammoclip"] = {i: v for i, v in enumerate(ps.ammoclip) if v}
        out["objectives"] = [objective_dict(o) for o in ps.objectives]
        out["hud_archival"] = [hud_dict(h) for h in ps.hud_archival if h[HUD_TYPE]]
        out["hud_current"] = [hud_dict(h) for h in ps.hud_current if h[HUD_TYPE]]
        out["weaponmodels"] = {i: v for i, v in enumerate(ps.weaponmodels) if v}
    return out


# ---------------------------------------------------------------------------
# HUD elements / objectives / clients
# ---------------------------------------------------------------------------

HUD_NAMES = tuple(f[0] for f in NF.HUD_ELEM_FIELDS)
HUD_KINDS = tuple(f[3] for f in NF.HUD_ELEM_FIELDS)
HUD_TYPE = HUD_INDEX["type"]


def hud_dict(values, include_zero: bool = False) -> dict:
    out = {}
    for name, raw, kind in zip(HUD_NAMES, values, HUD_KINDS):
        if raw or include_zero:
            out[name] = convert(raw, kind)
    return out


OBJ_NAMES = ("state",) + tuple(f[0] for f in NF.OBJECTIVE_FIELDS)
OBJ_KINDS = ("u",) + tuple(f[3] for f in NF.OBJECTIVE_FIELDS)


def objective_dict(values) -> dict:
    return {name: convert(raw, kind) for name, raw, kind in zip(OBJ_NAMES, values, OBJ_KINDS)}


CS_NAMES = tuple(f[0] for f in NF.CLIENT_STATE_FIELDS)
CS_KINDS = tuple(f[3] for f in NF.CLIENT_STATE_FIELDS)
_NETNAME = tuple(CS_INDEX[f"netname[{i}]"] for i in (0, 4, 8, 12))


def client_netname(state) -> str:
    """clientState.netname: only the first 16 bytes are networked (4 words)."""
    raw = b"".join((state[i] & 0xFFFFFFFF).to_bytes(4, "little") for i in _NETNAME)
    return raw.split(b"\0", 1)[0].decode("latin-1")


def client_dict(state) -> dict:
    out = {}
    for name, raw, kind in zip(CS_NAMES, state, CS_KINDS):
        if name.startswith("netname["):
            continue
        out[name] = convert(raw, kind)
    out["netname"] = client_netname(state)
    return out


def is_event_entity(state) -> bool:
    return state[1] >= ET_EVENTS


__all__ = ["convert", "entity_dict", "entity_delta_dict", "ps_dict", "ps_value", "hud_dict",
           "objective_dict", "client_dict", "client_netname", "flag_names", "stance_from_eflags",
           "perk_names", "E", "EF_FLAGS", "PMF_FLAGS", "NULL_ENTITY"]
