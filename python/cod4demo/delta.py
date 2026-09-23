"""Delta decoding of CoD4 snapshots: player state, entities, client states.

The snapshot stream is delta coded against earlier snapshots and against the
entity baselines of the gamestate. Every field of every entity of every
snapshot has to be read in order, otherwise the bit stream loses sync. The
code follows the engine (KisakCOD ``msg_mp.cpp``, ``cl_parse_mp.cpp``) and the
CoD4-DM1 reference implementation.

All state values are kept as raw 32-bit patterns (unsigned ints), exactly as
the engine stores them; ``states.py`` turns them into typed, named values.
"""

from __future__ import annotations

from . import _netfields as NF
from .bitmsg import Msg, f2i, f2u, u2f
from .constants import (COD4X_FALLBACK_PROTOCOL, ENTITYNUM_NONE, ENTITYNUM_WORLD,
                        MAX_CLIENTS, MAX_GENTITIES, MAX_HUDELEMENTS, MAX_OBJECTIVES,
                        MAX_PARSE_CLIENTS, MAX_PARSE_ENTITIES, PACKET_BACKUP)

# ---------------------------------------------------------------------------
# Compiled field tables: tuples of (slot, bits, changeHints)
# ---------------------------------------------------------------------------

ENTITY_WORDS = NF.ENTITY_WORDS                                   # 61 words incl. number
ENTITY_TABLES = tuple(tuple((f[4], f[1], f[2]) for f in t) for t in NF.ENTITY_TABLES)
ENTITY_TABLE_LAST = len(ENTITY_TABLES) - 1                        # 17 = event entities


def _compile(table):
    return tuple((i, f[1], f[2]) for i, f in enumerate(table))


PS_TABLE = _compile(NF.PLAYER_STATE_FIELDS)
PS_FIELDS = len(PS_TABLE)
CS_TABLE = _compile(NF.CLIENT_STATE_FIELDS)
CS_FIELDS = len(CS_TABLE)
HUD_TABLE = _compile(NF.HUD_ELEM_FIELDS)
HUD_FIELDS = len(HUD_TABLE)
OBJ_TABLE = _compile(NF.OBJECTIVE_FIELDS)
OBJ_FIELDS = len(OBJ_TABLE)

PS_INDEX = {f[0]: i for i, f in enumerate(NF.PLAYER_STATE_FIELDS)}
CS_INDEX = {f[0]: i for i, f in enumerate(NF.CLIENT_STATE_FIELDS)}
HUD_INDEX = {f[0]: i for i, f in enumerate(NF.HUD_ELEM_FIELDS)}

# slots used by the decoder itself
E_ETYPE = 1
E_EVENT_SEQUENCE = 40      # eventSequence (byte offset 160)
PS_COMMANDTIME = PS_INDEX["commandTime"]
PS_ORIGIN = (PS_INDEX["origin[0]"], PS_INDEX["origin[1]"], PS_INDEX["origin[2]"])
PS_VELOCITY = (PS_INDEX["velocity[0]"], PS_INDEX["velocity[1]"], PS_INDEX["velocity[2]"])
PS_VIEWANGLES = (PS_INDEX["viewangles[0]"], PS_INDEX["viewangles[1]"], PS_INDEX["viewangles[2]"])
PS_BOBCYCLE = PS_INDEX["bobCycle"]
PS_MOVEMENTDIR = PS_INDEX["movementDir"]

_LC_ENTITY_BITS = (61).bit_length()        # MSG_ReadLastChangedField(msg, 61)
_LC_PS_BITS = PS_FIELDS.bit_length()
_LC_CS_BITS = CS_FIELDS.bit_length()

NULL_ENTITY = (0,) * ENTITY_WORDS
NULL_CLIENT = (0,) * CS_FIELDS
NULL_HUD = (0,) * HUD_FIELDS
NULL_OBJECTIVE = (0,) * (OBJ_FIELDS + 1)   # [state, origin x/y/z, icon, entNum, teamNum]


class DecodeError(Exception):
    pass


# ---------------------------------------------------------------------------
# Player state container
# ---------------------------------------------------------------------------

class PlayerState:
    """Raw ``playerState_t`` of the recording client (or whoever it follows).

    ``fields``      141 net fields in table order (raw 32-bit values)
    ``stats``       [health, dead_yaw, max_health, ident_client_num, spawn_count]
    ``ammo``        128 ammo counters (index = weapon ammo index)
    ``ammoclip``    128 clip counters (index = weapon clip index)
    ``objectives``  16 x [state, origin0, origin1, origin2, icon, entNum, teamNum]
    ``hud_archival`` / ``hud_current``  31 HUD elements each, 40 raw fields
    ``weaponmodels`` 128 bytes
    ``origin_from_archive``  True if origin/velocity/angles came from the
                             client archive frames (not sent in this snapshot)
    """

    __slots__ = ("fields", "stats", "ammo", "ammoclip", "objectives", "hud_archival",
                 "hud_current", "weaponmodels", "origin_from_archive", "archive_found")

    def __init__(self) -> None:
        self.fields = [0] * PS_FIELDS
        self.stats = [0] * 5
        self.ammo = [0] * 128
        self.ammoclip = [0] * 128
        self.objectives = [NULL_OBJECTIVE] * MAX_OBJECTIVES
        self.hud_archival = [NULL_HUD] * MAX_HUDELEMENTS
        self.hud_current = [NULL_HUD] * MAX_HUDELEMENTS
        self.weaponmodels = bytes(128)
        self.origin_from_archive = False
        self.archive_found = False

    def copy(self) -> "PlayerState":
        """Shallow copy; the sub-lists are replaced (not mutated) on change."""
        ps = PlayerState.__new__(PlayerState)
        ps.fields = self.fields[:]
        ps.stats = self.stats
        ps.ammo = self.ammo
        ps.ammoclip = self.ammoclip
        ps.objectives = self.objectives
        ps.hud_archival = self.hud_archival
        ps.hud_current = self.hud_current
        ps.weaponmodels = self.weaponmodels
        ps.origin_from_archive = False
        ps.archive_found = False
        return ps


# ---------------------------------------------------------------------------
# Snapshot bookkeeping
# ---------------------------------------------------------------------------

class SnapshotInfo:
    """One decoded snapshot (``clientSnapshot_t``)."""

    __slots__ = ("valid", "message_num", "delta_num", "server_time", "snap_flags", "ps",
                 "parse_entities_num", "num_entities", "parse_clients_num", "num_clients",
                 "changed_entities", "removed_entities", "changed_clients")

    def __init__(self) -> None:
        self.valid = False
        self.message_num = 0
        self.delta_num = -1
        self.server_time = 0
        self.snap_flags = 0
        self.ps: PlayerState | None = None
        self.parse_entities_num = 0
        self.num_entities = 0
        self.parse_clients_num = 0
        self.num_clients = 0
        #: entity numbers transmitted (delta coded) in this snapshot
        self.changed_entities: list[int] = []
        #: entity numbers explicitly removed in this snapshot
        self.removed_entities: list[int] = []
        #: client numbers transmitted in this snapshot
        self.changed_clients: list[int] = []


class ArchiveFrame:
    """Client archive record (``MSG_ARCHIVE``): the client's predicted state."""

    __slots__ = ("index", "origin", "velocity", "movement_dir", "bob_cycle",
                 "server_time", "angles")

    def __init__(self, index, origin, velocity, movement_dir, bob_cycle, server_time, angles):
        self.index = index
        self.origin = origin
        self.velocity = velocity
        self.movement_dir = movement_dir
        self.bob_cycle = bob_cycle
        self.server_time = server_time
        self.angles = angles


# ---------------------------------------------------------------------------
# Decoder
# ---------------------------------------------------------------------------

class DeltaDecoder:
    """Holds the delta chain across all messages of a demo."""

    def __init__(self, protocol: int) -> None:
        self.protocol = protocol
        self.legacy_origins = protocol <= COD4X_FALLBACK_PROTOCOL
        self.map_center = (0.0, 0.0, 0.0)
        self.baselines: dict[int, list[int]] = {}
        self.parse_entities: list = [None] * MAX_PARSE_ENTITIES   # (num, state)
        self.parse_clients: list = [None] * MAX_PARSE_CLIENTS     # (num, state)
        self.parse_entities_num = 0
        self.parse_clients_num = 0
        self.snapshots = [SnapshotInfo() for _ in range(PACKET_BACKUP)]
        self.snap_message_num = 0
        self.archive: list[ArchiveFrame | None] = [None] * 256
        self.archive_last_index = 0
        self.null_ps = PlayerState()
        self.errors = 0
        self.error_log: list[str] = []

    def reset_for_gamestate(self) -> None:
        """A new gamestate (map change / restart) invalidates the delta chain."""
        self.baselines.clear()
        self.parse_entities_num = 0
        self.parse_clients_num = 0
        self.snapshots = [SnapshotInfo() for _ in range(PACKET_BACKUP)]

    def set_map_center(self, text: str) -> None:
        try:
            parts = [float(x) for x in text.split()[:3]]
            if len(parts) == 3:
                self.map_center = tuple(parts)
        except ValueError:
            pass

    def add_archive(self, frame: ArchiveFrame) -> None:
        self.archive[frame.index & 255] = frame
        self.archive_last_index = frame.index & 255

    # -- single field ---------------------------------------------------------
    def read_field(self, m: Msg, old: int, bits: int, hint: int, time: int) -> int:
        """``MSG_ReadDeltaField``: returns the new raw value."""
        if hint != 2 and not m.read_bit():
            return old

        if bits == 0:                                   # float
            if not m.read_bit():
                return m.read_bit() << 31               # 0.0 or -0.0
            if not m.read_bit():
                b = m.read_bits(5)
                v = ((32 * m.read_byte() + b) ^ (f2i(old) + 4096)) - 4096
                return f2u(float(v))
            return (m.read_int() ^ old) & 0xFFFFFFFF

        if bits > -85:                                  # plain integer (signed if < 0)
            if not m.read_bit():
                return 0
            n = -bits if bits < 0 else bits
            bv = n & 7
            t = m.read_bits(bv) if bv else 0
            while bv < n:
                t |= m.read_byte() << bv
                bv += 8
            mask = 0xFFFFFFFF if n == 32 else (1 << n) - 1
            t = (t ^ (old & mask)) & 0xFFFFFFFF
            if bits < 0 and (t >> (n - 1)) & 1:
                t = (t | ~mask) & 0xFFFFFFFF
            return t

        if bits == -100:                                # angle, zero bit
            return f2u(m.read_angle16()) if m.read_bit() else 0
        if bits == -99:                                 # small float, 12 bit
            if not m.read_bit():
                return 0
            if not m.read_bit():
                b = m.read_bits(4)
                v = ((16 * m.read_byte() + b) ^ (f2i(old) + 2048)) - 2048
                return f2u(float(v))
            return (m.read_int() ^ old) & 0xFFFFFFFF
        if bits == -98:                                 # eFlags
            if m.read_bit():
                return m.read_byte() | (m.read_byte() << 8) | (m.read_byte() << 16)
            return (old ^ (1 << m.read_bits(5))) & 0xFFFFFFFF
        if bits == -97:                                 # time
            if m.read_bit():
                return m.read_int()
            return (time - m.read_bits(8)) & 0xFFFFFFFF
        if bits == -96:                                 # ground entity
            if m.read_bit():
                return ENTITYNUM_WORLD
            if m.read_bit():
                return 0
            v = m.read_bits(2)
            v |= m.read_byte() << 2
            return v
        if bits == -95:
            return 100 * m.read_bits(7)
        if bits == -94 or bits == -93:                  # event / event parm byte
            return m.read_byte()
        if bits == -92 or bits == -91:                  # origin x / y
            if not self.legacy_origins:
                return m.read_int()
            return f2u(self._legacy_origin(m, old, self.map_center[0 if bits == -92 else 1]))
        if bits == -90:                                 # origin z
            if not self.legacy_origins:
                return m.read_int()
            return f2u(self._legacy_origin(m, old, self.map_center[2]))
        if bits == -89:
            if not m.read_bit():
                b = m.read_bits(5)
                v = ((32 * m.read_byte() + b) ^ (f2i(old) + 4096)) - 4096
                return f2u(float(v))
            return (m.read_int() ^ old) & 0xFFFFFFFF
        if bits == -88:                                 # full float, xor
            return (m.read_int() ^ old) & 0xFFFFFFFF
        if bits == -87:                                 # angle
            return f2u(m.read_angle16())
        if bits == -86:                                 # font scale
            return f2u(m.read_bits(5) / 10.0 + 1.399999976158142)
        if bits == -85:                                 # RGBA colour
            if m.read_bit():
                # keep RGB and toggle alpha: 0 -> 255, anything else -> 0
                return (old & 0x00FFFFFF) | ((0 if old >> 24 else 0xFF) << 24)
            v = old
            if not m.read_bit():
                v = m.read_byte() | (m.read_byte() << 8) | (m.read_byte() << 16) | (v & 0xFF000000)
            return (v & 0x00FFFFFF) | (((8 * m.read_bits(5)) & 0xFF) << 24)
        raise DecodeError(f"unknown field encoding {bits}")

    def _legacy_origin(self, m: Msg, old: int, center: float) -> float:
        """Origins of protocols <= 17: 16 bit around the map centre or 7 bit delta."""
        oldv = f2i(old)
        if m.read_bit():
            c = int(center + 0.5)
            return float(c + (((oldv + 0x8000 - c) ^ m.read_bits(16)) - 0x8000))
        return float(m.read_bits(7) - 64) + u2f(old)

    # -- entities ------------------------------------------------------------
    def read_delta_entity(self, m: Msg, time: int, frm, number: int):
        """``MSG_ReadDeltaEntityStruct``: new state list, or None if removed."""
        if m.read_bit():
            return None
        to = list(frm)
        to[0] = number
        if not m.read_bit():
            return to
        lc = m.read_bits(_LC_ENTITY_BITS)
        read = self.read_field
        slot, bits, hint = ENTITY_TABLES[0][0]          # eType is always read
        to[slot] = read(m, frm[slot], bits, hint, time)
        etype = to[E_ETYPE]
        table = ENTITY_TABLES[etype if etype < ENTITY_TABLE_LAST else ENTITY_TABLE_LAST]
        if lc > len(table):
            m.overflowed = True
            return to
        for i in range(1, lc):
            slot, bits, hint = table[i]
            to[slot] = read(m, frm[slot], bits, hint, time)
        return to

    def read_baseline(self, m: Msg) -> int:
        num = m.read_entity_index(10)
        if not 0 <= num < MAX_GENTITIES:
            m.overflowed = True
            return -1
        st = self.read_delta_entity(m, 0, NULL_ENTITY, num)
        if st is not None:
            self.baselines[num] = st
        return num

    # -- client states -------------------------------------------------------
    def read_delta_client(self, m: Msg, time: int, frm, number: int):
        if m.read_bit():
            return None
        to = list(frm)
        if not m.read_bit():
            return to
        lc = m.read_bits(_LC_CS_BITS)
        if lc > CS_FIELDS:
            m.overflowed = True
            return to
        read = self.read_field
        for i in range(lc):
            slot, bits, hint = CS_TABLE[i]
            to[slot] = read(m, frm[slot], bits, hint, time)
        return to

    # -- player state --------------------------------------------------------
    def read_delta_playerstate(self, m: Msg, time: int, frm: PlayerState) -> PlayerState:
        ps = frm.copy()
        to = ps.fields
        old = frm.fields
        read_origin_and_vel = m.read_bit() > 0
        lc = m.read_bits(_LC_PS_BITS)
        if lc > PS_FIELDS:
            m.overflowed = True
            return ps
        read = self.read_field
        for i in range(lc):
            slot, bits, hint = PS_TABLE[i]
            if read_origin_and_vel and hint == 3:
                to[slot] = read(m, 0, bits, hint, time)      # predicted fields: no xor
            else:
                to[slot] = read(m, old[slot], bits, hint, time)

        if not read_origin_and_vel:
            # the server did not send the predicted fields; the client takes
            # them from its own archive (CL_GetPredictedOriginForServerTime)
            ps.origin_from_archive = True
            fr = self._archive_for_time(to[PS_COMMANDTIME])
            if fr is not None:
                ps.archive_found = True
                for k in range(3):
                    to[PS_ORIGIN[k]] = f2u(fr.origin[k])
                    to[PS_VELOCITY[k]] = f2u(fr.velocity[k])
                    to[PS_VIEWANGLES[k]] = f2u(fr.angles[k])
                to[PS_BOBCYCLE] = fr.bob_cycle & 0xFFFFFFFF
                to[PS_MOVEMENTDIR] = fr.movement_dir & 0xFFFFFFFF

        if m.read_bit():                                     # stats
            stats = ps.stats[:]
            sb = m.read_bits(5)
            if sb & 1:
                stats[0] = m.read_short()
            if sb & 2:
                stats[1] = m.read_short()
            if sb & 4:
                stats[2] = m.read_short()
            if sb & 8:
                stats[3] = m.read_bits(6)
            if sb & 16:
                stats[4] = m.read_byte()
            ps.stats = stats

        if m.read_bit():                                     # ammo
            ammo = None
            for j in range(4):
                if m.read_bit():
                    mask = m.read_short() & 0xFFFF
                    if ammo is None:
                        ammo = ps.ammo[:]
                    for i in range(16):
                        if mask & (1 << i):
                            ammo[16 * j + i] = m.read_short()
            if ammo is not None:
                ps.ammo = ammo

        clip = None
        for j in range(8):                                   # ammo in clip
            if m.read_bit():
                mask = m.read_short() & 0xFFFF
                if clip is None:
                    clip = ps.ammoclip[:]
                for i in range(16):
                    if mask & (1 << i):
                        clip[16 * j + i] = m.read_short()
        if clip is not None:
            ps.ammoclip = clip

        if m.read_bit():                                     # objectives
            objs = []
            for j in range(MAX_OBJECTIVES):
                prev = frm.objectives[j]
                cur = list(prev)
                cur[0] = m.read_bits(3)
                if m.read_bit():
                    for i in range(OBJ_FIELDS):
                        slot, bits, hint = OBJ_TABLE[i]
                        cur[slot + 1] = read(m, prev[slot + 1], bits, hint, time)
                objs.append(tuple(cur))
            ps.objectives = objs

        if m.read_bit():                                     # HUD elements
            ps.hud_archival = self._read_hud_elems(m, time, frm.hud_archival)
            ps.hud_current = self._read_hud_elems(m, time, frm.hud_current)

        if m.read_bit():                                     # weapon models
            ps.weaponmodels = bytes(m.read_byte() for _ in range(128))
        return ps

    def _read_hud_elems(self, m: Msg, time: int, frm: list) -> list:
        inuse = m.read_bits(5)
        out = list(frm)
        read = self.read_field
        for i in range(inuse):
            lc = m.read_bits(6)
            if lc >= HUD_FIELDS:
                m.overflowed = True
                return out
            prev = frm[i]
            cur = list(prev)
            for y in range(lc + 1):
                slot, bits, hint = HUD_TABLE[y]
                cur[slot] = read(m, prev[slot], bits, hint, time)
            out[i] = tuple(cur)
        # elements past the transmitted count are cleared
        i = inuse
        while i < MAX_HUDELEMENTS and out[i][4]:            # field 4 = type
            out[i] = NULL_HUD
            i += 1
        return out

    def _archive_for_time(self, time: int) -> ArchiveFrame | None:
        idx = self.archive_last_index
        for _ in range(256):
            fr = self.archive[idx & 255]
            if fr is not None and fr.server_time <= time:
                return fr
            idx -= 1
        return None

    # -- snapshot ------------------------------------------------------------
    def parse_snapshot(self, m: Msg, message_num: int) -> SnapshotInfo | None:
        """``CL_ParseSnapshot``. Returns the snapshot or None if it had to be dropped."""
        snap = SnapshotInfo()
        snap.message_num = message_num
        snap.server_time = m.read_long()
        delta = m.read_byte()
        snap.delta_num = -1 if not delta else message_num - delta
        snap.snap_flags = m.read_byte()

        old = None
        if snap.delta_num >= 0:
            cand = self.snapshots[snap.delta_num & (PACKET_BACKUP - 1)]
            if (not cand.valid or cand.message_num != snap.delta_num
                    or self.parse_entities_num - cand.parse_entities_num > MAX_PARSE_ENTITIES - 128
                    or self.parse_clients_num - cand.parse_clients_num > MAX_PARSE_CLIENTS - 128):
                # delta source no longer available: the engine discards the rest
                self.errors += 1
                self.error_log.append(f"snapshot {message_num}: delta from invalid snapshot {snap.delta_num}")
                m.overflowed = True
                return None
            old = cand
        snap.valid = True

        snap.ps = self.read_delta_playerstate(
            m, snap.server_time, old.ps if old is not None and old.ps is not None else self.null_ps)
        m.last_entity = -1
        self._parse_packet_entities(m, snap.server_time, old, snap)
        m.last_entity = -1
        self._parse_packet_clients(m, snap.server_time, old, snap)
        if m.overflowed:
            self.errors += 1
            self.error_log.append(f"snapshot {message_num}: read past end of message")
            return None

        # invalidate snapshots skipped since the last one
        oldnum = self.snap_message_num + 1
        if snap.message_num - oldnum >= PACKET_BACKUP:
            oldnum = snap.message_num - (PACKET_BACKUP - 1)
        while oldnum < snap.message_num:
            self.snapshots[oldnum & (PACKET_BACKUP - 1)].valid = False
            oldnum += 1
        self.snap_message_num = snap.message_num
        self.snapshots[snap.message_num & (PACKET_BACKUP - 1)] = snap
        return snap

    def _parse_packet_entities(self, m: Msg, time: int, old: SnapshotInfo | None,
                               snap: SnapshotInfo) -> None:
        pe = self.parse_entities
        mask = MAX_PARSE_ENTITIES - 1
        snap.parse_entities_num = self.parse_entities_num
        snap.num_entities = 0
        oldindex = 0
        oldstate = None
        oldnum = 99999
        if old is not None and old.num_entities > 0:
            oldstate = pe[old.parse_entities_num & mask]
            oldnum = oldstate[0]

        def next_old():
            nonlocal oldindex, oldstate, oldnum
            oldindex += 1
            if oldindex < old.num_entities:
                oldstate = pe[(old.parse_entities_num + oldindex) & mask]
                oldnum = oldstate[0]
            else:
                oldnum = 99999

        def keep(entry):
            pe[self.parse_entities_num & mask] = entry
            self.parse_entities_num += 1
            snap.num_entities += 1

        while not m.overflowed:
            newnum = m.read_entity_index(10)
            if newnum == ENTITYNUM_NONE:
                break
            if m.readcount > m.cursize or not 0 <= newnum < MAX_GENTITIES:
                m.overflowed = True
                return
            while oldnum < newnum:                      # unchanged entities
                keep(oldstate)
                next_old()
            if oldnum == newnum:                        # delta from previous
                st = self.read_delta_entity(m, time, oldstate[1], newnum)
                next_old()
            else:                                       # delta from baseline
                st = self.read_delta_entity(m, time, self.baselines.get(newnum, NULL_ENTITY), newnum)
            if st is None:
                snap.removed_entities.append(newnum)
            else:
                keep((newnum, st))
                snap.changed_entities.append(newnum)

        while oldnum != 99999 and not m.overflowed:     # the rest is unchanged
            keep(oldstate)
            next_old()

    def _parse_packet_clients(self, m: Msg, time: int, old: SnapshotInfo | None,
                              snap: SnapshotInfo) -> None:
        pc = self.parse_clients
        mask = MAX_PARSE_CLIENTS - 1
        snap.parse_clients_num = self.parse_clients_num
        snap.num_clients = 0
        oldindex = 0
        oldstate = None
        oldnum = 99999
        if old is not None and old.num_clients > 0:
            oldstate = pc[old.parse_clients_num & mask]
            oldnum = oldstate[0]

        def next_old():
            nonlocal oldindex, oldstate, oldnum
            oldindex += 1
            if oldindex < old.num_clients:
                oldstate = pc[(old.parse_clients_num + oldindex) & mask]
                oldnum = oldstate[0]
            else:
                oldnum = 99999

        def keep(entry):
            pc[self.parse_clients_num & mask] = entry
            self.parse_clients_num += 1
            snap.num_clients += 1

        while not m.overflowed and m.read_bit():
            newnum = m.read_entity_index(6)
            if m.readcount > m.cursize or not 0 <= newnum < MAX_CLIENTS:
                m.overflowed = True
                return
            while oldnum < newnum:
                keep(oldstate)
                next_old()
            if oldnum == newnum:
                st = self.read_delta_client(m, time, oldstate[1], newnum)
                next_old()
            else:
                st = self.read_delta_client(m, time, NULL_CLIENT, newnum)
            if st is not None:
                keep((newnum, st))
                snap.changed_clients.append(newnum)

        while oldnum != 99999 and not m.overflowed:
            keep(oldstate)
            next_old()

    # -- access --------------------------------------------------------------
    def entities_of(self, snap: SnapshotInfo) -> list:
        """[(number, raw_state), ...] of all entities in the snapshot."""
        pe = self.parse_entities
        mask = MAX_PARSE_ENTITIES - 1
        base = snap.parse_entities_num
        return [pe[(base + i) & mask] for i in range(snap.num_entities)]

    def clients_of(self, snap: SnapshotInfo) -> list:
        pc = self.parse_clients
        mask = MAX_PARSE_CLIENTS - 1
        base = snap.parse_clients_num
        return [pc[(base + i) & mask] for i in range(snap.num_clients)]

