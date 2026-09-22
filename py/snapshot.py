#!/usr/bin/env python3
"""Snapshot decoding for CoD4 demos: delta entities, player state, client state.

This is what makes the kill feed readable: obituaries sit in the snapshots as
event entities (field table ``EventEntityStateFields`` with
``attackerEntityNum``, ``otherEntityNum``, ``weapon`` and ``eventParm``).

The bit stream is strictly sequential and delta coded: every field of every
entity of every snapshot has to be read, or everything after it shifts. The
code therefore follows the reference implementation line for line
(https://github.com/Iswenzz/CoD4-DM1, Demo.cpp / Msg.cpp).

Values are kept as raw 32-bit patterns - exactly like the original, which
reinterprets between float and uint32.

Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
see LICENSE. No warranty of any kind.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import netfields as NF

__all__ = ["Msg", "SnapshotReader", "EntityEvent"]

_f2u = struct.Struct("<f").pack
_u2f = struct.Struct("<I").unpack
_u_pack = struct.Struct("<I").pack
_f_unpack = struct.Struct("<f").unpack


def u2f(u: int) -> float:
    return _f_unpack(_u_pack(u & 0xFFFFFFFF))[0]


def f2u(f: float) -> int:
    try:
        return struct.unpack("<I", _f2u(f))[0]
    except (OverflowError, ValueError):
        return 0


def f2i(u: int) -> int:
    """C-Semantik: (signed int)(*(float*)&u) - Richtung null abgeschnitten."""
    f = u2f(u)
    if f != f or f in (float("inf"), float("-inf")) or abs(f) >= 2**31:
        return 0
    return int(f)


def bitcount(x: int) -> int:
    """GetMinBitCount: 32 - clz(x) == x.bit_length()."""
    return x.bit_length()


# ---------------------------------------------------------------------------
# Field slots
# ---------------------------------------------------------------------------

def _build_slots(tables) -> tuple[dict[str, int], list[str]]:
    idx: dict[str, int] = {}
    names: list[str] = []
    for t in tables:
        for name, _bits, _hint in t:
            if name not in idx:
                idx[name] = len(names)
                names.append(name)
    return idx, names


ENT_IDX, ENT_NAMES = _build_slots(list(NF.LIST) + [NF.ENTITY_STATE_FIELDS])
ENT_SIZE = len(ENT_NAMES)
#: eType -> Tabelle als (slot, bits, changeHints)
ENT_TABLES = [tuple((ENT_IDX[n], b, h) for n, b, h in t) for t in NF.LIST]
ENT_MAX_TYPE = len(ENT_TABLES) - 1

PS_IDX, PS_NAMES = _build_slots([NF.PLAYER_STATE_FIELDS])
PS_TABLE = tuple((PS_IDX[n], b, h) for n, b, h in NF.PLAYER_STATE_FIELDS)
PS_SIZE = len(PS_NAMES)
PS_LC_BITS = bitcount(len(NF.PLAYER_STATE_FIELDS))

CS_IDX, CS_NAMES = _build_slots([NF.CLIENT_STATE_FIELDS])
CS_TABLE = tuple((CS_IDX[n], b, h) for n, b, h in NF.CLIENT_STATE_FIELDS)
CS_SIZE = len(CS_NAMES)

HUD_IDX, HUD_NAMES = _build_slots([NF.HUD_ELEM_FIELDS])
HUD_TABLE = tuple((HUD_IDX[n], b, h) for n, b, h in NF.HUD_ELEM_FIELDS)
HUD_SIZE = len(HUD_NAMES)

OBJ_IDX, OBJ_NAMES = _build_slots([NF.OBJECTIVE_FIELDS])
OBJ_TABLE = tuple((OBJ_IDX[n], b, h) for n, b, h in NF.OBJECTIVE_FIELDS)
OBJ_SIZE = len(OBJ_NAMES)

ENT_LC_BITS = bitcount(0x3D)   # the game reads entities with 0x3D instead of 0x3B
GENTITYNUM_BITS = 10
MAX_PARSE_ENTITIES = 2048
MAX_PARSE_CLIENTS = 2048
#: Entity numbers below this belong to a fixed client slot.
MAX_CLIENTS = 64
PACKET_BACKUP = 32
PACKET_MASK = PACKET_BACKUP - 1
#: Ab diesem Protokoll schickt CoD4X Ortskoordinaten als rohe Floats.
COD4X_FALLBACK_PROTOCOL = 17

E_ETYPE = ENT_IDX["eType"]
E_OTHER = ENT_IDX["otherEntityNum"]
E_ATTACKER = ENT_IDX["attackerEntityNum"]
E_WEAPON = ENT_IDX["weapon"]
E_EVENTPARM = ENT_IDX["eventParm"]
E_CLIENTNUM = ENT_IDX["ClientNum"]
E_SURFTYPE = ENT_IDX["surfType"]
#: Position and facing of an entity (players carry them in lerp.pos/apos).
E_POS = (ENT_IDX["lerp.pos.trBase[0]"], ENT_IDX["lerp.pos.trBase[1]"],
         ENT_IDX["lerp.pos.trBase[2]"])
E_YAW = ENT_IDX["lerp.apos.trBase[1]"]
#: eType of a living player; corpses and objects have other values.
ET_PLAYER = 1
#: Thrown grenades are missiles. launchTime identifies each throw uniquely -
#: entity numbers get reused during a match, the throw time does not.
ET_MISSILE = 4
E_LAUNCHTIME = ENT_IDX["lerp.u.missile.launchTime"]
#: Trajectory parameters: position and velocity apply from trTime on, the client
#: extrapolates the flight path from them. groundEntityNum 1022 means it rests
#: on the ground.
E_VEL = (ENT_IDX["lerp.pos.trDelta[0]"], ENT_IDX["lerp.pos.trDelta[1]"],
         ENT_IDX["lerp.pos.trDelta[2]"])
E_TRTIME = ENT_IDX["lerp.pos.trTime"]
E_GROUND = ENT_IDX["groundEntityNum"]
#: The same values in the player state of the player being followed.
PS_POS = (PS_IDX["origin[0]"], PS_IDX["origin[1]"], PS_IDX["origin[2]"])
PS_YAW = PS_IDX["viewangles[1]"]
PS_CLIENTNUM = PS_IDX["ClientNum"]
PS_WEAPON = PS_IDX["weapon"]
C_TEAM = CS_IDX["team"]


# ---------------------------------------------------------------------------
# Bit reader with CoD4 semantics
# ---------------------------------------------------------------------------

class Msg:
    """Read head over a decompressed message.

    CoD4 mixes byte-aligned reads (``ReadCount``) with bit reads (``bit``): a
    bit read fetches the next byte through ``ReadCount`` when it crosses a byte
    boundary, a byte read leaves the bit cursor untouched. This quirk has to be
    reproduced exactly.
    """

    __slots__ = ("b", "cur", "rc", "bit", "ovf", "last_ref")

    def __init__(self, buf: bytes, read_count: int = 0) -> None:
        self.b = buf
        self.cur = len(buf)
        self.rc = read_count
        self.bit = 8 * read_count
        self.ovf = False
        self.last_ref = 0

    def read_bit(self) -> int:
        oldbit7 = self.bit & 7
        if not oldbit7:
            if self.rc >= self.cur:
                self.ovf = True
                return 0
            self.bit = 8 * self.rc
            self.rc += 1
        v = (self.b[self.bit >> 3] >> oldbit7) & 1
        self.bit += 1
        return v

    def read_bits(self, n: int) -> int:
        if n <= 0:
            return 0
        ret = 0
        i = 0
        b = self.b
        while i < n:
            if not (self.bit & 7):
                if self.rc >= self.cur:
                    self.ovf = True
                    return ret
                self.bit = 8 * self.rc
                self.rc += 1
            pos = self.bit & 7
            take = min(8 - pos, n - i)
            chunk = (b[self.bit >> 3] >> pos) & ((1 << take) - 1)
            ret |= chunk << i
            self.bit += take
            i += take
        return ret

    def read_byte(self) -> int:
        if self.rc + 1 > self.cur:
            self.ovf = True
            return 0
        v = self.b[self.rc]
        self.rc += 1
        return v

    def read_short(self) -> int:
        if self.rc + 2 > self.cur:
            self.ovf = True
            return 0
        v = int.from_bytes(self.b[self.rc:self.rc + 2], "little", signed=True)
        self.rc += 2
        return v

    def read_int(self) -> int:
        if self.rc + 4 > self.cur:
            self.ovf = True
            return 0
        v = int.from_bytes(self.b[self.rc:self.rc + 4], "little", signed=False)
        self.rc += 4
        return v

    def read_string(self) -> str:
        end = self.b.find(b"\0", self.rc)
        if end < 0:
            self.ovf = True
            end = self.cur
        s = self.b[self.rc:end].decode("latin-1")
        self.rc = min(end + 1, self.cur)
        return s

    def read_angle16(self) -> float:
        return self.read_short() * (360.0 / 65536)

    def read_eflags(self, old: int) -> int:
        if self.read_bit() == 1:
            v = 0
            for i in (0, 8, 16):
                v |= self.read_byte() << i
            return v
        return (old ^ (1 << self.read_bits(5))) & 0xFFFFFFFF

    def discard(self) -> None:
        self.cur = self.rc
        self.ovf = True


# ---------------------------------------------------------------------------
# Delta-Dekodierung
# ---------------------------------------------------------------------------

@dataclass
class EntityEvent:
    """Event entity from a snapshot (eType >= 17)."""
    server_time: int
    msg_seq: int
    number: int
    event: int
    event_parm: int
    other: int
    attacker: int
    weapon: int
    client: int
    surf_type: int


@dataclass
class _Snap:
    valid: bool = False
    message_num: int = 0
    delta_num: int = -1
    server_time: int = 0
    snap_flags: int = 0
    ps: list = field(default_factory=list)
    parse_entities_num: int = 0
    num_entities: int = 0
    parse_clients_num: int = 0
    num_clients: int = 0


class SnapshotReader:
    """Holds the state across all snapshots (the delta chain)."""

    def __init__(self, protocol: int) -> None:
        self.protocol = protocol
        #: Map centre from config string 12 - only needed for protocol <= 17
        self.map_center = [0.0, 0.0, 0.0]
        self.baselines: dict[int, list[int]] = {}
        self.snapshots: list[_Snap] = [_Snap() for _ in range(PACKET_BACKUP)]
        self.parse_entities: list[tuple[int, list[int]]] = [(0, [])] * MAX_PARSE_ENTITIES
        self.parse_clients: list[tuple[int, list[int]]] = [(0, [])] * MAX_PARSE_CLIENTS
        self.parse_entities_num = 0
        self.parse_clients_num = 0
        self.snap_message_num = 0
        self.null_entity = [0] * ENT_SIZE
        self.null_client = [0] * CS_SIZE
        self.null_ps = [0] * PS_SIZE
        self.events: list[EntityEvent] = []
        self.client_teams: dict[int, dict[int, int]] = {}   # clientIndex -> {team: erstes serverTime}
        #: clientIndex -> [(serverTime, x, y, z, yaw, weaponId)] - movement tracks for
        #: the map view. Rounded to whole units; a map does not need more. The weapon
        #: is the one currently held, not the loadout.
        self.tracks: dict[int, list[tuple[int, int, int, int, int, int]]] = {}
        #: (weaponId, launchTime) -> [(serverTime, x, y, z, vx, vy, vz, trTime, ground)]
        #: Flight paths of the throws, with the trajectory parameters of the last state.
        self.missiles: dict[tuple[int, int], list[tuple]] = {}
        #: [(serverTime, clientIndex, x, y, z, yaw, weaponId)] - the player being
        #: followed, from the player state. Deliberately kept apart from tracks:
        #: for your own player the client predicts the movement and the server only
        #: corrects it now and then, so the track would be a series of jumps. The
        #: MSG_FRAME records carry it cleanly; ClientNum here says whose it is.
        self.view_samples: list[tuple[int, int, int, int, int, int, int]] = []
        self.server_time = 0
        self.errors = 0

    # -- Felder ----------------------------------------------------------
    def read_delta_field(self, m: Msg, frm: list[int], to: list[int], f, no_xor: bool, time: int) -> None:
        slot, bits, hint = f
        fv = 0 if (no_xor and hint == 3) else frm[slot]

        if hint != 2 and not m.read_bit():
            to[slot] = fv
            return

        if bits == 0:
            if not m.read_bit():
                to[slot] = m.read_bit() << 31
                return
            if not m.read_bit():
                b = m.read_bits(5)
                v = ((32 * m.read_byte() + b) ^ (f2i(fv) + 4096)) - 4096
                to[slot] = f2u(float(v))
                return
            to[slot] = (m.read_int() ^ fv) & 0xFFFFFFFF
            return

        if bits == -100:
            to[slot] = f2u(m.read_angle16()) if m.read_bit() else f2u(0.0)
            return
        if bits == -99:
            if m.read_bit():
                if not m.read_bit():
                    b = m.read_bits(4)
                    v = ((16 * m.read_byte() + b) ^ (f2i(fv) + 2048)) - 2048
                    to[slot] = f2u(float(v))
                    return
                to[slot] = (m.read_int() ^ fv) & 0xFFFFFFFF
                return
            to[slot] = 0
            return
        if bits == -98:
            to[slot] = m.read_eflags(fv)
            return
        if bits == -97:
            to[slot] = m.read_int() if m.read_bit() else (time - m.read_bits(8)) & 0xFFFFFFFF
            return
        if bits == -96:
            to[slot] = self.read_delta_ground_entity(m)
            return
        if bits == -95:
            to[slot] = 100 * m.read_bits(7)
            return
        if bits in (-94, -93):
            to[slot] = m.read_byte()
            return
        if bits in (-92, -91):
            to[slot] = f2u(self.read_origin_float(m, bits, fv))
            return
        if bits == -90:
            to[slot] = f2u(self.read_origin_z_float(m, fv))
            return
        if bits == -89:
            if not m.read_bit():
                b = m.read_bits(5)
                v = ((32 * m.read_byte() + b) ^ (f2i(fv) + 4096)) - 4096
                to[slot] = f2u(float(v))
                return
            to[slot] = (m.read_int() ^ fv) & 0xFFFFFFFF
            return
        if bits == -88:
            to[slot] = (m.read_int() ^ fv) & 0xFFFFFFFF
            return
        if bits == -87:
            to[slot] = f2u(m.read_angle16())
            return
        if bits == -86:
            to[slot] = f2u(m.read_bits(5) / 10.0 + 1.399999976158142)
            return
        if bits == -85:
            if m.read_bit():
                to[slot] = (fv & 0x00FFFFFF) | (0x00 if (fv >> 24) == 0 else 0xFF) << 24
                return
            v = fv
            if not m.read_bit():
                v = (v & 0xFF000000) | m.read_byte() | (m.read_byte() << 8) | (m.read_byte() << 16)
            to[slot] = (v & 0x00FFFFFF) | ((8 * m.read_bits(5)) & 0xFF) << 24
            return

        # ganzzahlige Felder
        if not m.read_bit():
            to[slot] = 0
            return
        nbits = -bits if bits < 0 else bits
        bv = nbits & 7
        t = m.read_bits(bv) if bv else 0
        while bv < nbits:
            t |= m.read_byte() << bv
            bv += 8
        mask = 0xFFFFFFFF if nbits == 32 else (1 << nbits) - 1
        t = (t ^ (fv & mask)) & 0xFFFFFFFF
        if bits < 0 and (t >> (nbits - 1)) & 1:
            t = (t | ~mask) & 0xFFFFFFFF
        to[slot] = t

    def read_delta_ground_entity(self, m: Msg) -> int:
        if m.read_bit() == 1:
            return 1022
        if m.read_bit() == 1:
            return 0
        value = m.read_bits(2)
        j = 2
        while j < 10:
            value |= m.read_byte() << j
            j += 8
        return value

    def read_origin_float(self, m: Msg, bits: int, fv: int) -> float:
        """Ortskoordinate lesen.

        CoD4X (protocol > 17) sends raw 32-bit floats. Older protocols encode
        against the map centre (config string 12) - that path is taken from the
        reference but untested, for lack of such a demo.
        """
        if self.protocol > COD4X_FALLBACK_PROTOCOL:
            return u2f(m.read_int())
        axis = 0 if bits == -92 else 1
        return self._origin_legacy(m, fv, self.map_center[axis])

    def read_origin_z_float(self, m: Msg, fv: int) -> float:
        if self.protocol > COD4X_FALLBACK_PROTOCOL:
            return u2f(m.read_int())
        return self._origin_legacy(m, fv, self.map_center[2])

    def _origin_legacy(self, m: Msg, fv: int, center_component: float) -> float:
        old = f2i(fv)
        if m.read_bit():
            coord = int(center_component + 0.5)
            return float(((old - coord + 0x8000) ^ m.read_bits(16)) + coord - 0x8000)
        return float(m.read_bits(7) - 64 + old)

    # -- Strukturen ------------------------------------------------------
    def read_delta_fields(self, m: Msg, frm: list[int], to: list[int], table, time: int,
                          is_entity: bool) -> None:
        if not m.read_bit():
            return                                      # to is already a copy of frm
        if is_entity:
            lc = m.read_bits(ENT_LC_BITS)
        else:
            lc = m.read_bits(bitcount(len(table)))
        if lc > len(table):
            m.ovf = True
            return
        if lc <= 0:
            return
        self.read_delta_field(m, frm, to, table[0], False, time)
        if is_entity:
            etype = to[E_ETYPE]
            table = ENT_TABLES[etype if etype < ENT_MAX_TYPE else ENT_MAX_TYPE]
        for i in range(1, lc):
            self.read_delta_field(m, frm, to, table[i], False, time)

    def read_delta_struct(self, m: Msg, frm: list[int], table, time: int,
                          is_entity: bool) -> list[int] | None:
        if m.read_bit() == 1:
            return None                                 # geloescht
        to = frm[:]
        self.read_delta_fields(m, frm, to, table, time, is_entity)
        return to

    def read_entity_index(self, m: Msg, index_bits: int) -> int:
        if m.read_bit():
            m.last_ref += 1
        elif index_bits != 10 or m.read_bit():
            m.last_ref = m.read_bits(index_bits)
        else:
            m.last_ref += m.read_bits(4)
        return m.last_ref

    # -- baselines from the gamestate -----------------------------------
    def read_baseline(self, m: Msg) -> int:
        num = self.read_entity_index(m, GENTITYNUM_BITS)
        if num >= 1024:
            m.ovf = True
            return -1
        st = self.read_delta_struct(m, self.null_entity, ENT_TABLES[0], 0, True)
        if st is not None:
            self.baselines[num] = st
        return num

    # -- Snapshot --------------------------------------------------------
    def parse_snapshot(self, m: Msg, msg_seq: int) -> None:
        snap = _Snap()
        snap.message_num = msg_seq
        snap.server_time = m.read_int() & 0xFFFFFFFF
        delta_num = m.read_byte()
        snap.delta_num = -1 if not delta_num else msg_seq - delta_num
        snap.snap_flags = m.read_byte()
        self.server_time = snap.server_time

        old = None
        if snap.delta_num > 0:
            cand = self.snapshots[snap.delta_num & PACKET_MASK]
            if cand.valid and cand.message_num == snap.delta_num \
                    and self.parse_entities_num - cand.parse_entities_num <= 1920 \
                    and self.parse_clients_num - cand.parse_clients_num <= 1920:
                old = cand
            else:
                m.discard()
                self.errors += 1
                return
        snap.valid = True

        snap.ps = self.read_delta_player_state(m, snap.server_time,
                                               old.ps if old and old.ps else self.null_ps)
        m.last_ref = -1                              # ClearLastReferencedEntity
        self.parse_packet_entities(m, snap.server_time, old, snap, msg_seq)
        m.last_ref = -1                              # ClearLastReferencedEntity
        self.parse_packet_clients(m, snap.server_time, old, snap)

        if m.ovf:
            return

        old_message_num = self.snap_message_num + 1
        if snap.message_num - old_message_num >= PACKET_BACKUP:
            old_message_num = snap.message_num - (PACKET_BACKUP - 1)
        while old_message_num < snap.message_num:
            self.snapshots[old_message_num & PACKET_MASK].valid = False
            old_message_num += 1
        self.snap_message_num = snap.message_num
        self.snapshots[self.snap_message_num & PACKET_MASK] = snap

    def parse_packet_entities(self, m: Msg, time: int, old: _Snap | None, to: _Snap,
                              msg_seq: int) -> None:
        to.parse_entities_num = self.parse_entities_num
        to.num_entities = 0
        oldindex = 0
        oldstate = None
        oldnum = 99999
        if old is not None and old.num_entities > 0:
            oldstate = self.parse_entities[old.parse_entities_num & (MAX_PARSE_ENTITIES - 1)]
            oldnum = oldstate[0]

        while not m.ovf:
            newnum = self.read_entity_index(m, GENTITYNUM_BITS)
            if newnum == 1023:
                break
            if m.rc > m.cur or newnum >= 1024:
                m.ovf = True
                return

            while oldnum < newnum and not m.ovf and oldstate is not None:
                self.parse_entities[self.parse_entities_num & (MAX_PARSE_ENTITIES - 1)] = oldstate
                self.parse_entities_num += 1
                to.num_entities += 1
                oldindex += 1
                if old is not None and oldindex < old.num_entities:
                    oldstate = self.parse_entities[(oldindex + old.parse_entities_num)
                                                   & (MAX_PARSE_ENTITIES - 1)]
                    oldnum = oldstate[0]
                else:
                    oldnum = 99999

            if oldnum == newnum:
                self.delta_entity(m, time, to, newnum, oldstate[1], msg_seq)
                oldindex += 1
                if old is not None and oldindex < old.num_entities:
                    oldstate = self.parse_entities[(oldindex + old.parse_entities_num)
                                                   & (MAX_PARSE_ENTITIES - 1)]
                    oldnum = oldstate[0]
                else:
                    oldnum = 99999
            else:
                base = self.baselines.get(newnum, self.null_entity)
                self.delta_entity(m, time, to, newnum, base, msg_seq)

        while oldnum != 99999 and not m.ovf and oldstate is not None:
            self.parse_entities[self.parse_entities_num & (MAX_PARSE_ENTITIES - 1)] = oldstate
            self.parse_entities_num += 1
            to.num_entities += 1
            oldindex += 1
            if old is not None and oldindex < old.num_entities:
                oldstate = self.parse_entities[(oldindex + old.parse_entities_num)
                                               & (MAX_PARSE_ENTITIES - 1)]
                oldnum = oldstate[0]
            else:
                oldnum = 99999

    def delta_entity(self, m: Msg, time: int, to: _Snap, num: int, old: list[int],
                     msg_seq: int) -> None:
        st = self.read_delta_struct(m, old, ENT_TABLES[0], time, True)
        if st is None:
            return
        self.parse_entities[self.parse_entities_num & (MAX_PARSE_ENTITIES - 1)] = (num, st)
        self.parse_entities_num += 1
        to.num_entities += 1
        etype = st[E_ETYPE]
        if etype >= ENT_MAX_TYPE:
            self.events.append(EntityEvent(
                server_time=time, msg_seq=msg_seq, number=num, event=etype - ENT_MAX_TYPE,
                event_parm=st[E_EVENTPARM], other=st[E_OTHER], attacker=st[E_ATTACKER],
                weapon=st[E_WEAPON], client=st[E_CLIENTNUM], surf_type=st[E_SURFTYPE]))
        elif etype == ET_MISSILE and st[E_LAUNCHTIME]:
            # Without launchTime one throw could not be told from the next; such
            # entries are rare and are therefore left out.
            self.missiles.setdefault((st[E_WEAPON], st[E_LAUNCHTIME]), []).append((
                time, f2i(st[E_POS[0]]), f2i(st[E_POS[1]]), f2i(st[E_POS[2]]),
                f2i(st[E_VEL[0]]), f2i(st[E_VEL[1]]), f2i(st[E_VEL[2]]),
                st[E_TRTIME], st[E_GROUND]))
        elif etype == ET_PLAYER and num < MAX_CLIENTS:
            # Entity numbers below MAX_CLIENTS belong to that client slot.
            # f2i instead of int(u2f(...)): C semantics, so that NaN and infinity
            # become 0 rather than an exception - just like the |0 on the JS side.
            self.tracks.setdefault(num, []).append((
                time, f2i(st[E_POS[0]]), f2i(st[E_POS[1]]),
                f2i(st[E_POS[2]]), f2i(st[E_YAW]), st[E_WEAPON]))

    def parse_packet_clients(self, m: Msg, time: int, old: _Snap | None, to: _Snap) -> None:
        to.parse_clients_num = self.parse_clients_num
        to.num_clients = 0
        oldindex = 0
        oldstate = None
        oldnum = 99999
        if old is not None and old.num_clients > 0:
            oldstate = self.parse_clients[old.parse_clients_num & (MAX_PARSE_CLIENTS - 1)]
            oldnum = oldstate[0]

        while not m.ovf and m.read_bit():
            newnum = self.read_entity_index(m, 6)
            if m.rc > m.cur or newnum >= 64:
                m.ovf = True
                return

            while oldnum < newnum:
                self.delta_client(m, time, to, oldnum, oldstate, True)
                oldindex += 1
                if old is not None and oldindex < old.num_clients:
                    oldstate = self.parse_clients[(oldindex + old.parse_clients_num)
                                                  & (MAX_PARSE_CLIENTS - 1)]
                    oldnum = oldstate[0]
                else:
                    oldnum = 99999

            if oldnum == newnum:
                self.delta_client(m, time, to, newnum, oldstate, False)
                oldindex += 1
                if old is not None and oldindex < old.num_clients:
                    oldstate = self.parse_clients[(oldindex + old.parse_clients_num)
                                                  & (MAX_PARSE_CLIENTS - 1)]
                    oldnum = oldstate[0]
                else:
                    oldnum = 99999
            else:
                self.delta_client(m, time, to, newnum, (newnum, self.null_client), False)

        while oldnum != 99999 and not m.ovf and oldstate is not None:
            self.delta_client(m, time, to, oldnum, oldstate, True)
            oldindex += 1
            if old is not None and oldindex < old.num_clients:
                oldstate = self.parse_clients[(oldindex + old.parse_clients_num)
                                              & (MAX_PARSE_CLIENTS - 1)]
                oldnum = oldstate[0]
            else:
                oldnum = 99999

    def delta_client(self, m: Msg, time: int, to: _Snap, num: int,
                     old: tuple[int, list[int]] | None, unchanged: bool) -> None:
        if unchanged:
            state = old[1] if old else self.null_client
        else:
            base = old[1] if old else self.null_client
            state = self.read_delta_struct(m, base, CS_TABLE, time, False)
            if state is None:
                return
            team = state[C_TEAM]
            self.client_teams.setdefault(num, {}).setdefault(team, time)
        self.parse_clients[self.parse_clients_num & (MAX_PARSE_CLIENTS - 1)] = (num, state)
        self.parse_clients_num += 1
        to.num_clients += 1

    # -- PlayerState -----------------------------------------------------
    def read_delta_player_state(self, m: Msg, time: int, frm: list[int]) -> list[int]:
        to = frm[:]
        read_origin_and_vel = m.read_bit() > 0
        lc = m.read_bits(PS_LC_BITS)
        if lc > len(PS_TABLE):
            m.ovf = True
            return to
        for i in range(lc):
            f = PS_TABLE[i]
            no_xor = read_origin_and_vel and f[2] == 3
            self.read_delta_field(m, frm, to, f, no_xor, time)

        if m.read_bit():                                # stats
            statsbits = m.read_bits(5)
            if statsbits & 1:
                m.read_short()
            if statsbits & 2:
                m.read_short()
            if statsbits & 4:
                m.read_short()
            if statsbits & 8:
                m.read_bits(6)
            if statsbits & 16:
                m.read_byte()

        if m.read_bit():                                # ammo
            for _ in range(4):
                if m.read_bit():
                    bits = m.read_short() & 0xFFFF
                    for i in range(16):
                        if bits & (1 << i):
                            m.read_short()

        for _ in range(8):                              # ammo in clip
            if m.read_bit():
                bits = m.read_short() & 0xFFFF
                for i in range(16):
                    if bits & (1 << i):
                        m.read_short()

        if m.read_bit():                                # objectives
            for _ in range(16):
                m.read_bits(3)
                self.read_delta_objective(m, time)

        if m.read_bit():                                # hud elems
            self.read_delta_hud_elems(m, time)
            self.read_delta_hud_elems(m, time)

        if m.read_bit():                                # weapon models
            for _ in range(128):
                m.read_byte()

        # The player being followed does not appear as an entity - his position is
        # only here. ClientNum says whose it is (after your own death that is the
        # team mate currently being spectated).
        x, y = f2i(to[PS_POS[0]]), f2i(to[PS_POS[1]])
        if x or y:
            self.view_samples.append((time, to[PS_CLIENTNUM], x, y,
                                      f2i(to[PS_POS[2]]), f2i(to[PS_YAW]), to[PS_WEAPON]))
        return to

    def read_delta_objective(self, m: Msg, time: int) -> None:
        if m.read_bit():
            dummy_from = [0] * OBJ_SIZE
            dummy_to = [0] * OBJ_SIZE
            for f in OBJ_TABLE:
                self.read_delta_field(m, dummy_from, dummy_to, f, False, time)

    def read_delta_hud_elems(self, m: Msg, time: int) -> None:
        inuse = m.read_bits(5)
        for _ in range(inuse):
            lc = m.read_bits(6)
            if lc >= len(HUD_TABLE):
                m.ovf = True
                return
            dummy_from = [0] * HUD_SIZE
            dummy_to = [0] * HUD_SIZE
            for y in range(lc + 1):
                self.read_delta_field(m, dummy_from, dummy_to, HUD_TABLE[y], False, time)
