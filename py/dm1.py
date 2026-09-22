#!/usr/bin/env python3
"""Parser for Call of Duty 4 demos (.dm_1).

Reads the demo container, decompresses the snapshot payloads (static CoD4
Huffman) and evaluates the gamestate config strings, the player list and the
server commands. Out of that comes the match analysis: teams, player stats,
round breakdown, chat.

Standard library only. Usable as a module:

    from dm1 import parse_demo, analyze
    match = analyze(parse_demo(Path("demo0025.dm_1").read_bytes()))

With ``deep=True`` (the default) the delta entities are decoded as well -
that is where the kill feed (killer, victim, weapon) and the team assignment
come from. Without it only the server's scoreboard commands remain.


Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
see LICENSE. No warranty of any kind.
Format reference: https://github.com/Iswenzz/CoD4-DM1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from snapshot import EntityEvent, Msg, SnapshotReader

__all__ = ["parse_demo", "analyze", "DemoData", "Match", "HuffmanTree", "strip_colors"]

# ---------------------------------------------------------------------------
# Huffman
# ---------------------------------------------------------------------------

#: Symbol frequencies from the CoD4 engine (msg_hData_COD4).
FREQ = (
    274054, 68777, 40460, 40266, 48059, 39006, 48630, 27692, 17712, 15439, 12386, 10758,
    9420, 9979, 9346, 15256, 13184, 14319, 7750, 7221, 6095, 5666, 12606, 7263, 7322, 5807,
    11628, 6199, 7826, 6349, 7698, 9656, 28968, 5164, 13629, 6058, 4745, 4519, 5199, 4807,
    5323, 3433, 3455, 3563, 6979, 5229, 5002, 4423, 14108, 13631, 11908, 11801, 10261, 7635,
    7215, 7218, 9353, 6161, 5689, 4649, 5026, 5866, 8002, 10534, 15381, 8874, 11798, 7199,
    12814, 6103, 4982, 5972, 6779, 4929, 5333, 3503, 4345, 6098, 14117, 16440, 6446, 3062,
    4695, 3085, 4198, 4013, 3878, 3414, 5514, 4092, 3261, 4740, 4544, 3127, 3385, 7688,
    11126, 6417, 5297, 4529, 6333, 4210, 7056, 4658, 6190, 3512, 2843, 3479, 9369, 5203,
    4980, 5881, 7509, 4292, 6097, 5492, 4648, 2996, 4988, 4163, 6534, 4001, 4342, 4488,
    6039, 4827, 7112, 8654, 26712, 8688, 9677, 9368, 7209, 3399, 4473, 4677, 11087, 4094,
    3404, 4176, 6733, 3702, 11420, 4867, 5968, 3475, 3722, 3560, 4571, 2720, 3189, 3099,
    4595, 4044, 4402, 3889, 4989, 3186, 3153, 5387, 8020, 3322, 3775, 2886, 4191, 2879,
    3110, 2576, 3693, 2436, 4935, 3017, 3538, 5688, 3444, 3410, 9170, 4708, 3425, 3273,
    3684, 4564, 6957, 4817, 5224, 3285, 3143, 4227, 5630, 6053, 5851, 6507, 13692, 8270,
    8260, 5583, 7568, 4082, 3984, 4574, 6440, 3533, 2992, 2708, 5190, 3889, 3799, 4582,
    6020, 3464, 4431, 3495, 2906, 2243, 3856, 3321, 8759, 3928, 2905, 3875, 4382, 3885,
    5869, 6235, 10685, 4433, 4639, 4305, 4683, 2849, 3379, 4684, 5477, 4127, 3853, 3515,
    4913, 3601, 5237, 6617, 9019, 4857, 4112, 5180, 5998, 4925, 4986, 6365, 7930, 5948,
    8085, 7732, 8643, 8901, 9653, 32647,
)

NYT = 256
INTERNAL = 257

#: SHA-256 of the canonical tree structure, cross-checked against a second
#: independent implementation.
TREE_FINGERPRINT = "920d1ece3fe19e0706211b237023ff746ae00991a9bc2317016fbfa5f8becfaa"


class HuffmanTree:
    """The static CoD4 Huffman tree.

    The tree is built - as in the engine - through the adaptive FGK algorithm:
    each symbol is inserted as often as its frequency says, in ascending order
    of frequency (``Init_COD4``). The result is a fixed tree; its shape depends
    on the insertion order, so the algorithm is taken over step for step.
    """

    __slots__ = ("left", "right", "sym", "root", "nodes", "_lut", "_lut_bits")

    def __init__(self) -> None:
        n = 768
        self.left = [-1] * n
        self.right = [-1] * n
        self.sym = [0] * n
        self.root = 0
        self.nodes = 0
        self._lut: list[int] = []
        self._lut_bits = 0

    # -- Aufbau ------------------------------------------------------------
    @classmethod
    def build(cls, freq: Iterable[int] = FREQ) -> "HuffmanTree":
        freq = list(freq)
        if len(freq) != 256:
            raise ValueError("Frequenztabelle braucht 256 Eintraege")

        n = 768
        left = [-1] * n
        right = [-1] * n
        parent = [-1] * n
        nxt = [-1] * n
        prv = [-1] * n
        head = [-1] * n
        weight = [0] * n
        sym = [0] * n
        pp = [-1] * n
        freelist: list[int] = []
        loc = [-1] * 258
        bloc_node = 0
        bloc_ptrs = 0
        root = 0

        def get_pp() -> int:
            nonlocal bloc_ptrs
            if freelist:
                return freelist.pop()
            i = bloc_ptrs
            bloc_ptrs += 1
            pp[i] = -1
            return i

        def swap_nodes(a: int, b: int) -> None:
            nonlocal root
            pa, pb = parent[a], parent[b]
            if pa >= 0:
                if left[pa] == a:
                    left[pa] = b
                else:
                    right[pa] = b
            else:
                root = b
            if pb >= 0:
                if left[pb] == b:
                    left[pb] = a
                else:
                    right[pb] = a
            else:
                root = a
            parent[a], parent[b] = pb, pa

        def swap_list(a: int, b: int) -> None:
            nxt[a], nxt[b] = nxt[b], nxt[a]
            prv[a], prv[b] = prv[b], prv[a]
            if nxt[a] == a:
                nxt[a] = b
            if nxt[b] == b:
                nxt[b] = a
            if nxt[a] >= 0:
                prv[nxt[a]] = a
            if nxt[b] >= 0:
                prv[nxt[b]] = b
            if prv[a] >= 0:
                nxt[prv[a]] = a
            if prv[b] >= 0:
                nxt[prv[b]] = b

        def increment(node: int) -> None:
            # iterative instead of recursive: the chain runs up to the root
            pending: list[int] = []
            while node >= 0:
                if nxt[node] >= 0 and weight[nxt[node]] == weight[node]:
                    lnode = pp[head[node]]
                    if lnode != parent[node]:
                        swap_nodes(lnode, node)
                    swap_list(lnode, node)
                if prv[node] >= 0 and weight[prv[node]] == weight[node]:
                    pp[head[node]] = prv[node]
                else:
                    pp[head[node]] = -1
                    freelist.append(head[node])
                weight[node] += 1
                if nxt[node] >= 0 and weight[nxt[node]] == weight[node]:
                    head[node] = head[nxt[node]]
                else:
                    head[node] = get_pp()
                    pp[head[node]] = node
                pending.append(node)
                node = parent[node]
            # post-processing in reverse order - matches the code after the
            # recursive increment call in the original.
            for nd in reversed(pending):
                p = parent[nd]
                if p >= 0 and prv[nd] == p:
                    swap_list(nd, p)
                    if pp[head[nd]] == nd:
                        pp[head[nd]] = p

        def add_ref(ch: int) -> None:
            nonlocal bloc_node, root
            if loc[ch] < 0:
                tn = bloc_node
                tn2 = bloc_node + 1
                bloc_node += 2

                sym[tn2] = INTERNAL
                weight[tn2] = 1
                nxt[tn2] = nxt[lhead]
                if nxt[lhead] >= 0:
                    prv[nxt[lhead]] = tn2
                    if weight[nxt[lhead]] == 1:
                        head[tn2] = head[nxt[lhead]]
                    else:
                        head[tn2] = get_pp()
                        pp[head[tn2]] = tn2
                else:
                    head[tn2] = get_pp()
                    pp[head[tn2]] = tn2
                nxt[lhead] = tn2
                prv[tn2] = lhead

                sym[tn] = ch
                weight[tn] = 1
                nxt[tn] = nxt[lhead]
                if nxt[lhead] >= 0:
                    prv[nxt[lhead]] = tn
                    if weight[nxt[lhead]] == 1:
                        head[tn] = head[nxt[lhead]]
                    else:
                        head[tn] = get_pp()
                        pp[head[tn]] = tn2      # as in the original
                else:
                    head[tn] = get_pp()
                    pp[head[tn]] = tn
                nxt[lhead] = tn
                prv[tn] = lhead
                left[tn] = right[tn] = -1

                if parent[lhead] >= 0:
                    if left[parent[lhead]] == lhead:
                        left[parent[lhead]] = tn2
                    else:
                        right[parent[lhead]] = tn2
                else:
                    root = tn2
                right[tn2] = tn
                left[tn2] = lhead
                parent[tn2] = parent[lhead]
                parent[lhead] = tn2
                parent[tn] = tn2
                loc[ch] = tn
                increment(parent[tn2])
            else:
                increment(loc[ch])

        lhead = bloc_node
        bloc_node += 1
        root = lhead
        sym[lhead] = NYT
        loc[NYT] = lhead

        # Init_COD4: insert symbols in ascending order of frequency
        for _ in range(256):
            lowest, best = -1, -1
            for i in range(256):
                if freq[i] >= 0 and (best < 0 or freq[i] < best):
                    lowest, best = i, freq[i]
            if lowest < 0:
                break
            for _ in range(best):
                add_ref(lowest)
            freq[lowest] = -1

        tree = cls()
        tree.left = left
        tree.right = right
        tree.sym = sym
        tree.root = root
        tree.nodes = bloc_node
        tree._build_lut()
        return tree

    # -- Dekodierung -------------------------------------------------------
    def _build_lut(self) -> None:
        """Collect the codes and build a jump table (one lookup per symbol)."""
        codes: dict[int, tuple[int, int]] = {}
        stack = [(self.root, 0, 0)]
        maxlen = 0
        while stack:
            node, code, bits = stack.pop()
            if self.sym[node] != INTERNAL:
                codes[self.sym[node] & 0xFF] = (code, bits)
                maxlen = max(maxlen, bits)
                continue
            # bit 0 -> left, bit 1 -> right; the first bit read is the
            # least significant one in the later lookup index.
            stack.append((self.left[node], code, bits + 1))
            stack.append((self.right[node], code | (1 << bits), bits + 1))
        if maxlen > 20:
            raise ValueError(f"unexpectedly long codes ({maxlen} bits)")
        self._lut_bits = maxlen
        size = 1 << maxlen
        lut = [0] * size
        for symbol, (code, bits) in codes.items():
            step = 1 << bits
            packed = (symbol << 5) | bits
            for idx in range(code, size, step):
                lut[idx] = packed
        self._lut = lut

    def fingerprint(self) -> str:
        canon = ",".join(
            f"{self.left[i]}:{self.right[i]}:{self.sym[i]}" for i in range(self.nodes)
        )
        return hashlib.sha256(canon.encode()).hexdigest()

    def decode(self, data: bytes, off: int, nbytes: int, max_out: int) -> bytes:
        """Huffman-Bytestrom ab ``off`` dekodieren (Bits LSB-first je Byte)."""
        if nbytes <= 0 or max_out <= 0:
            return b""
        lut = self._lut
        mask = (1 << self._lut_bits) - 1
        need = self._lut_bits
        end = off + nbytes
        out = bytearray()
        bitpos = 0
        total_bits = nbytes * 8
        acc = 0
        have = 0
        pos = off
        while bitpos < total_bits and len(out) < max_out:
            while have < need and pos < end:
                acc |= data[pos] << have
                have += 8
                pos += 1
            packed = lut[acc & mask]
            bits = packed & 31
            if bits == 0 or bitpos + bits > total_bits:
                break
            acc >>= bits
            have -= bits
            bitpos += bits
            out.append(packed >> 5)
        return bytes(out)


_TREE: HuffmanTree | None = None


def tree() -> HuffmanTree:
    global _TREE
    if _TREE is None:
        _TREE = HuffmanTree.build()
    return _TREE


# ---------------------------------------------------------------------------
# Container / Messages
# ---------------------------------------------------------------------------

MSG_SNAPSHOT, MSG_FRAME, MSG_PROTOCOL, MSG_RELIABLE = 0, 1, 2, 3

SVC_NOP = 0
SVC_GAMESTATE = 1
SVC_CONFIGSTRING = 2
SVC_BASELINE = 3
SVC_SERVERCOMMAND = 4
SVC_SNAPSHOT = 6
SVC_EOF = 7
SVC_CONFIGCLIENT = 11

#: MSG_FRAME arrives at client frame rate (around 125 Hz). For a map one point
#: every 40 ms is enough - the same density the other players have.
VIEW_STEP_MS = 40
#: Layout of a MSG_FRAME record: seq, origin[3], velocity[3], movementDir,
#: bobCycle, commandTime, angles[3] - 52 bytes in total.
_FRAME = struct.Struct("<i3f3f2ii3f")


def _fi(v: float) -> int:
    """Float from the file to int - NaN and infinity become 0.

    A plain int() would raise on NaN and abort the run; the JS version
    returns 0 at the same spot.
    """
    return int(v) if -1e9 < v < 1e9 else 0

MAX_CONFIGSTRINGS = 2 * 2442


class _Reader(Msg):
    """Read head over a message - byte and bit reads, the way CoD4 mixes them."""

    def byte(self) -> int:
        v = self.read_byte()
        return -1 if self.ovf else v

    def int32(self) -> int:
        if self.rc + 4 > self.cur:
            self.ovf = True
            return -1
        v = struct.unpack_from("<i", self.b, self.rc)[0]
        self.rc += 4
        return v

    def string(self) -> str:
        return self.read_string()


@dataclass
class ServerCommand:
    seq: int          # server message sequence of the record
    time: int         # commandTime of the last frame before it (ms)
    cseq: int         # reliable sequence of the command
    text: str


@dataclass
class DemoData:
    protocol: int = 0
    snapshots: int = 0
    frames: int = 0
    gamestates: int = 0
    clean_eof: bool = False
    truncated: bool = False
    size_bytes: int = 0
    first_time: int = 0
    last_time: int = 0
    pov_client: int | None = None
    commands: list[ServerCommand] = field(default_factory=list)
    configstrings: dict[int, str] = field(default_factory=dict)
    players: dict[int, str] = field(default_factory=dict)
    #: only with deep=True: event entities from the snapshots (kill feed)
    events: list = field(default_factory=list)
    #: clientIndex -> {teamId: first serverTime}
    client_teams: dict = field(default_factory=dict)
    #: only with deep=True: clientIndex -> [(serverTime, x, y, z, yaw)] for the map
    tracks: dict = field(default_factory=dict)
    #: only with deep=True: (weaponId, launchTime) -> flight path of a thrown grenade
    missiles: dict = field(default_factory=dict)
    #: [(serverTime, clientIndex, x, y, z, yaw, weaponId)] from the player state
    view_samples: list = field(default_factory=list)
    #: [(commandTime, x, y, z, yaw)] from the MSG_FRAME records: the view of the
    #: recording player at client frame rate, thinned down to VIEW_STEP_MS
    view_frames: list = field(default_factory=list)
    baselines: int = 0
    snapshot_errors: int = 0
    first_server_time: int = 0
    last_server_time: int = 0


def parse_demo(data: bytes, progress=None, deep: bool = True) -> DemoData:
    """Walk the demo container and evaluate it.

    ``deep=True`` additionally decodes the snapshots (delta entities) - that
    costs time but yields the kill feed and the real team assignments.
    """
    out = DemoData(size_bytes=len(data))
    if len(data) < 17 or data[0] != MSG_PROTOCOL:
        raise ValueError("not a CoD4 demo file: a MSG_PROTOCOL record is expected (byte 0 = 2)")

    huff = tree()
    snaps: SnapshotReader | None = None
    size = len(data)
    p = 0
    frame_time = 0
    last_view = -10**9
    first = last = None
    unpack_i = struct.Struct("<i").unpack_from

    while p < size:
        rtype = data[p]
        p += 1
        if rtype == MSG_PROTOCOL:
            if p + 16 > size:
                break
            out.protocol = struct.unpack_from("<I", data, p)[0]
            p += 16
            if deep:
                snaps = SnapshotReader(out.protocol)
        elif rtype == MSG_FRAME:
            if p + 52 > size:
                break
            if deep:
                fr = _FRAME.unpack_from(data, p)
                x, y = _fi(fr[1]), _fi(fr[2])
                if (x or y) and fr[9] - last_view >= VIEW_STEP_MS:
                    out.view_frames.append((fr[9], x, y, _fi(fr[3]), _fi(fr[11])))
                    last_view = fr[9]
            frame_time = unpack_i(data, p + 36)[0]
            if first is None or frame_time < first:
                first = frame_time
            if last is None or frame_time > last:
                last = frame_time
            p += 52
            out.frames += 1
        elif rtype == MSG_SNAPSHOT:
            if p + 4 <= size and unpack_i(data, p)[0] == -1:
                out.clean_eof = True
                break
            if p + 12 > size:
                break
            seq = unpack_i(data, p)[0]
            msg_size = unpack_i(data, p + 4)[0]
            p += 12
            length = msg_size - 4
            if length < 0 or p + length > size:
                out.truncated = True
                break
            start = p
            p += length
            out.snapshots += 1
            if length:
                if deep:
                    buf = huff.decode(data, start, length, min(length * 6 + 64, 1 << 21))
                    _read_message(buf, seq, frame_time, out, snaps)
                else:
                    head = huff.decode(data, start, length, 1)
                    op = head[0] if head else SVC_EOF
                    if op not in (SVC_SNAPSHOT, SVC_EOF):
                        buf = huff.decode(data, start, length, min(length * 6 + 64, 1 << 21))
                        _read_message(buf, seq, frame_time, out, None)
            if progress and out.snapshots % 2000 == 0:
                progress(p / size)
        elif rtype == MSG_RELIABLE:
            break
        else:
            break

    out.first_time = first or 0
    out.last_time = last or 0
    if snaps is not None:
        out.events = snaps.events
        out.client_teams = snaps.client_teams
        out.tracks = snaps.tracks
        out.missiles = snaps.missiles
        out.view_samples = snaps.view_samples
        out.baselines = len(snaps.baselines)
        out.snapshot_errors = snaps.errors
    return out


def _read_message(buf: bytes, seq: int, ftime: int, out: DemoData,
                  snaps: SnapshotReader | None = None) -> None:
    r = _Reader(buf)
    while r.rc < len(buf):
        cmd = r.byte()
        if cmd in (SVC_EOF, -1):
            break
        if cmd == SVC_SERVERCOMMAND:
            cseq = r.int32()
            text = r.string()
            out.commands.append(ServerCommand(seq, ftime, cseq, text))
            if r.ovf:
                break
        elif cmd == SVC_GAMESTATE:
            out.gamestates += 1
            _read_gamestate(r, buf, out, snaps)
            if snaps is None:
                break                               # without the baseline parser the message ends here
        elif cmd == SVC_CONFIGCLIENT:
            r.int32()
            cn = r.byte()
            name = r.string()
            r.string()
            if 0 <= cn < 64 and name:
                out.players[cn] = name
            if r.ovf:
                break
        elif cmd == SVC_SNAPSHOT:
            if snaps is None:
                break
            snaps.parse_snapshot(r, seq)
            if r.ovf:
                break
        elif cmd == SVC_NOP:
            continue
        else:
            break


def _read_gamestate(r: _Reader, buf: bytes, out: DemoData,
                    snaps: SnapshotReader | None = None) -> None:
    r.last_ref = -1                                 # ClearLastReferencedEntity
    r.int32()                                       # serverCommandSequence
    while True:
        c = r.byte()
        if c in (SVC_EOF, -1):
            break
        if c == SVC_CONFIGSTRING:
            count = r.int32()
            if count < 0 or count > 2 * MAX_CONFIGSTRINGS:
                break
            for _ in range(count):
                idx = r.int32()
                s = r.string()
                if 0 <= idx < 2 * MAX_CONFIGSTRINGS and s:
                    out.configstrings[idx] = s
                    if idx == 12 and snaps is not None:
                        # Kartenmitte: aeltere Protokolle kodieren Origins dagegen
                        try:
                            snaps.map_center = [float(x) for x in s.split()[:3]]
                        except ValueError:
                            pass
                if r.ovf:
                    break
            if r.ovf:
                break
        elif c == SVC_CONFIGCLIENT:
            cn = r.byte()
            name = r.string()
            r.string()
            if 0 <= cn < 64 and name:
                out.players[cn] = name
        elif c == SVC_BASELINE and snaps is not None:
            snaps.read_baseline(r)
            if r.ovf:
                break
        else:
            break                                   # ohne Baseline-Parser: Rest per Scan
    if snaps is not None and not r.ovf:
        r.int32()                                   # serverConfigSequence
        pov = r.int32()                             # clientNum of the recording player
        r.int32()                                   # checksumFeed
        if 0 <= pov < 64:
            out.pov_client = pov
    _scan_clients(buf, out)


_CLIENT_BLOCK = re.compile(
    rb"\x0b([\x00-\x3f])([\x20-\x7e]{1,40})\x00([\x20-\x7e]{0,24})\x00", re.S
)


def _scan_clients(buf: bytes, out: DemoData) -> None:
    """svc_configclient blocks sit behind the baselines - search the buffer.

    Right after the last block come svc_EOF, configSeq, clientNum (the
    recording player) and checksumFeed.
    """
    for m in _CLIENT_BLOCK.finditer(buf):
        cn = m.group(1)[0]
        out.players[cn] = m.group(2).decode("latin-1")
        tail = m.end()
        if tail < len(buf) and buf[tail] == SVC_EOF and tail + 13 <= len(buf):
            out.pov_client = struct.unpack_from("<i", buf, tail + 5)[0]


# ---------------------------------------------------------------------------
# Auswertung
# ---------------------------------------------------------------------------

_COLOR = re.compile(r"\^[0-9:;<=>?]")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")

#: Obituary event type (eType - 17) from the snapshots.
OBITUARY_EVENT = 66
#: Config string holding the server's weapon list (the index is 1-based).
CS_WEAPON_LIST = 2258
#: Config string with the compass image and its four world coordinates:
#: "compass_map_<map>" <x1> <y1> <x2> <y2> - that is what lets positions be
#: projected onto the minimap.
CS_COMPASS = 823
#: Gravity in units per second squared. Measured from the demos themselves:
#: across 838 trajectory segments the median is 778, with 64 per cent inside
#: 800 +/- 5 per cent - the downward bias comes from bounces that interrupt
#: free fall.
GRAVITY = 800.0
#: How far an incomplete flight path is extrapolated at most.
MAX_FLIGHT_S = 4.0
#: groundEntityNum of the world entity: the grenade is at rest.
GROUND_WORLD = 1022

#: Weapon name from config string 2258 -> grenade type for the map view.
GRENADE_TYPES = {
    "frag_grenade": "frag", "frag_grenade_short": "frag",
    "smoke_grenade": "smoke", "flash_grenade": "flash",
}
#: From this value on, eventParm holds 128 + means-of-death instead of the weapon.
#: The server's weapon list has a good 40 entries, so there is no collision.
MOD_OFFSET = 128
#: CoD4's means-of-death enum. Proven by the demos themselves: 136 (headshot) and
#: 140 (suicide, matching attacker == victim exactly) were the way in,
#: 135 falls exclusively in warmup and knife phases, and 139 always comes from
#: the world entity - both fit MOD_MELEE and MOD_FALLING at position 7 and 11.
MEANS_OF_DEATH = (
    "unknown", "pistol_bullet", "rifle_bullet", "grenade", "grenade_splash",
    "projectile", "projectile_splash", "melee", "headshot", "crush",
    "telefrag", "falling", "suicide", "trigger_hurt", "explosive",
)
KILL_HEADSHOT = MOD_OFFSET + MEANS_OF_DEATH.index("headshot")
#: Deaths with no attacker (falls, trigger_hurt) are booked on the world entity.
ENTITYNUM_WORLD = 1022


def weapon_name(weapon_id: int, weapons: list[str]) -> str:
    """Translate a weapon id into a name (list from config string 2258)."""
    if weapon_id >= MOD_OFFSET:
        mod = weapon_id - MOD_OFFSET
        if mod < len(MEANS_OF_DEATH):
            return MEANS_OF_DEATH[mod]
    elif 0 < weapon_id <= len(weapons):
        return weapons[weapon_id - 1]
    return f"weapon #{weapon_id}"


def pretty_weapon(name: str) -> str:
    """ak47_mp -> AK-47, frag_grenade_mp -> Frag Grenade."""
    n = name.removesuffix("_mp")
    special = {
        "ak47": "AK-47", "ak74u": "AK-74u", "m16": "M16", "m4": "M4", "m14": "M14",
        "g3": "G3", "g36c": "G36C", "mp5": "MP5", "mp44": "MP44", "usp": "USP",
        "uzi": "Mini-Uzi", "p90": "P90", "m1014": "M1014", "m40a3": "M40A3",
        "remington700": "Remington 700", "winchester1200": "Winchester 1200",
        "colt45": "Colt 1911", "beretta": "Beretta", "deserteagle": "Desert Eagle",
        "deserteaglegold": "Desert Eagle (gold)", "defaultweapon": "-",
        "frag_grenade": "Frag Grenade", "frag_grenade_short": "Frag Grenade (cooked)",
        "smoke_grenade": "Smoke Grenade", "flash_grenade": "Flashbang",
        "destructible_car": "Destructible Car", "briefcase_bomb": "Bomb",
        "briefcase_bomb_defuse": "Bomb (defuse)", "headshot": "Headshot",
        "suicide": "Suicide / world", "melee": "Knife", "falling": "Fall damage",
        "trigger_hurt": "Map hazard", "crush": "Crushed", "telefrag": "Telefrag",
        "explosive": "Explosive", "grenade": "Grenade", "grenade_splash": "Grenade (splash)",
        "projectile": "Projectile", "projectile_splash": "Projectile (splash)",
        "pistol_bullet": "Pistol", "rifle_bullet": "Rifle", "unknown": "Unknown",
    }
    base = n
    suffix = ""
    for tag, label in (("_silencer", " (silenced)"), ("_reflex", " (reflex)"),
                       ("_acog", " (ACOG)"), ("_gold", " (gold)"), ("_scout", " (scout)")):
        if base.endswith(tag):
            base, suffix = base[:-len(tag)], label
            break
    return special.get(base, base.replace("_", " ").title()) + suffix


#: MP_EXPLOSIVES_<X>_BY<player> -> lesbare Bezeichnung.
BOMB_ACTION = {
    "PLANTED": "Bomb planted", "DEFUSED": "Bomb defused",
    "RECOVERED": "Bomb picked up", "DROPPED": "Bomb dropped",
}


def strip_colors(s: str) -> str:
    """Strip CoD4 colour codes and control characters (Promod prefixes 0x15, say)."""
    return _CTRL.sub("", _COLOR.sub("", s or ""))


def parse_infostring(s: str) -> dict[str, str]:
    parts = (s or "").split("\\")
    return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}


@dataclass
class Player:
    client: int
    name: str
    team: str
    kills: int = 0
    deaths: int = 0
    assists: int = 0
    score: int = 0
    ping: int = 0
    has_stats: bool = False
    #: Second at which the player joined or left (otherwise None)
    joined_s: float | None = None
    left_s: float | None = None


@dataclass
class Round:
    n: int
    half: int
    start_s: float
    dur_s: float
    winner: str = "?"
    reason: str = ""
    score: str = ""
    exact: bool = False
    bomb: str = ""
    #: Timeline of the round: when which side loses a player, plus the bomb
    #: messages. Without killer/victim - that sits in the delta entities.
    timeline: list[dict] = field(default_factory=list)
    kills: dict[int, int] = field(default_factory=dict)
    deaths: dict[int, int] = field(default_factory=dict)


@dataclass
class Team:
    name: str
    wins: int = 0
    halves: list[int] = field(default_factory=list)


@dataclass
class Match:
    info: dict
    teams: list[Team]
    players: list[Player]
    rounds: list[Round]
    chat: list[dict]
    events: list[dict]
    #: the complete kill feed (empty when parsed without snapshot decoding)
    kills: list[dict] = field(default_factory=list)
    knife_s: float | None = None
    #: Map view: compass image, world bounds and movement tracks per client
    map: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """JSON form - the same schema as the web version (source/js/dm1.js)."""
        return {
            "info": self.info,
            "teams": [vars(t) for t in self.teams],
            "players": [
                {"client": p.client, "name": p.name, "team": p.team, "kills": p.kills,
                 "deaths": p.deaths, "assists": p.assists, "score": p.score,
                 "ping": p.ping, "hasStats": p.has_stats,
                 "joinedS": p.joined_s, "leftS": p.left_s}
                for p in self.players
            ],
            "rounds": [
                {"n": r.n, "half": r.half, "startS": r.start_s, "durS": r.dur_s,
                 "winner": r.winner, "reason": r.reason, "score": r.score,
                 "exact": r.exact, "bomb": r.bomb, "timeline": r.timeline,
                 "kills": {str(k): v for k, v in r.kills.items()},
                 "deaths": {str(k): v for k, v in r.deaths.items()}}
                for r in self.rounds
            ],
            "chat": self.chat,
            "events": self.events,
            "kills": self.kills,
            "knifeS": self.knife_s,
            "map": self.map,
        }


_RE_SCORES = re.compile(r"^b (\d+) (-?\d+) (-?\d+) (-?\d+) (.*)$")
_RE_G = re.compile(r"^G (-?\d+)")
_RE_H = re.compile(r"^H (-?\d+)")
_RE_TIMER = re.compile(r"^d 11 (\d+)")
_RE_HUDHEAD = re.compile(r"^d (380|381) (.+)$")
_RE_HUDLINE = re.compile(r"^d (385|387|388) (.+)$")
_RE_ALIVE = re.compile(r'self_alive "(\d+)" opposing_alive "(\d+)"')
_RE_MSG = re.compile(r'^f "(.+)"$')
_RE_CHAT = re.compile(r'^([hi]) "(.+)"$')
#: The config string index of the halftime sound depends on map and mod,
#: so the value is matched instead of a fixed index.
_RE_HALFTIME = re.compile(r"^d \d+ .*halftime", re.I)
#: The server reports joins and leaves in plain text.
_RE_JOINED = re.compile(r'^f "MP_CONNECTED(.+)"$')
_RE_LEFT = re.compile(r'^e "(.+?) EXE_LEFTGAME"$')
#: The event list shows exactly these messages - everything else (hit feedback,
#: grenade selection, round status such as "Time Elapsed") stays out.
_RE_EV_JOINED_TEAM = re.compile(r"[ ]Joined[ ](?:Attack|Defence)$", re.I)
_RE_EV_TIMEOUT = re.compile(r"^Timeout called by[ ]", re.I)
_EV_HUD_KEEP = ("All Players are Ready!", "Attack eliminated", "Defence eliminated")
_RE_BOMB_MSG = re.compile(r"^MP_EXPLOSIVES_([A-Z]+)_BY(.*)$")


def analyze(d: DemoData) -> Match:
    """Condense the server commands into a match analysis."""
    cmds = d.commands
    t0 = next((c.time for c in cmds if c.time > 0), 0)

    def rel(t: int) -> float:
        """Seconds since the start of the demo, truncated to one decimal.

        Truncated rather than rounded so that an m:ss display never jumps a
        second too early.
        """
        return int((t - t0) / 100.0) / 10.0

    # --- Teams ---
    # What counts is the side assignment from the client states: it knows about
    # spectators too and works without clan tags. Team 1/2 are the playing sides
    # (they swap at halftime, so the first assignment is what counts), 0/3 are
    # free and spectator. Without snapshot data it falls back to clan tags.
    names = dict(sorted(d.players.items()))
    # Times of the side swaps - whoever joins after one gets their first
    # assignment on the swapped side and has to be counted back.
    # The marker arrives twice, so only the first one per swap counts.
    swaps: list[int] = []
    for c in cmds:
        if _RE_HALFTIME.match(c.text) and (not swaps or c.time - swaps[-1] > 2000):
            swaps.append(c.time)
    side_of: dict[int, int] = {}
    for cl, teams in (d.client_teams or {}).items():
        if cl not in names:
            continue
        playing = sorted((tm, t) for t, tm in teams.items() if t in (1, 2))
        if playing:
            tm, sd = playing[0]
            if sum(1 for w in swaps if w < tm) % 2:
                sd = 3 - sd
            side_of[cl] = sd
    side_groups: dict[int, list[int]] = {}
    for cl, sd in sorted(side_of.items()):
        side_groups.setdefault(sd, []).append(cl)

    def tag_of(cl: int) -> str:
        m = re.match(r"^(\S+)\s+\S", strip_colors(names[cl]).strip())
        return m.group(1) if m else "?"

    def team_name(clients: list[int], fallback: str) -> str:
        """Team name from the common prefix of the members' names."""
        parts = [strip_colors(names[c]).strip() for c in clients]
        if not parts:
            return fallback
        pref = parts[0]
        for q in parts[1:]:
            while pref and not q.startswith(pref):
                pref = pref[:-1]
        pref = pref.strip(" -_|[]")
        return pref if len(pref) >= 2 else fallback

    pov = d.pov_client if d.pov_client in names else (next(iter(names), 0))
    tagged = False
    roster: dict[str, list[int]] = {}
    if (len(side_groups) == 2 and all(len(v) >= 2 for v in side_groups.values())
            and pov in side_of):
        # sides from the snapshots - spectators stay out
        a, b = sorted(side_groups)
        roster = {team_name(side_groups[a], "Team A"): side_groups[a],
                  team_name(side_groups[b], "Team B"): side_groups[b]}
        if len(roster) == 2:
            tagged = True
    if not tagged:
        # fallback: group by clan tag
        groups: dict[str, list[int]] = {}
        for cl in names:
            groups.setdefault(tag_of(cl), []).append(cl)
        if len(groups) == 2 and all(len(v) >= 2 for v in groups.values()):
            roster = groups
            tagged = True
    if tagged:
        # The POV is in one of the two groups; the fallback is only there so that
        # an unexpected split does not abort the run.
        my_team = next((t for t, cls in roster.items() if pov in cls), next(iter(roster)))
        other = next(t for t in roster if t != my_team)
    else:
        my_team = "Team " + strip_colors(names.get(pov, str(pov)))
        other = "Opponents"
        roster = {my_team: list(names), other: []}
    order = [my_team, other]

    # --- kill feed from the snapshot obituaries ---
    weapons = d.configstrings.get(CS_WEAPON_LIST, "").split()
    kills: list[dict] = []
    for e in d.events:
        if e.event != OBITUARY_EVENT:
            continue
        w = weapon_name(e.event_parm, weapons)
        kills.append({
            "tS": int((e.server_time - t0) / 100.0) / 10.0,
            "killer": e.attacker, "victim": e.other,
            "weaponId": e.event_parm, "weapon": w, "weaponLabel": pretty_weapon(w),
            "headshot": e.event_parm == KILL_HEADSHOT,
            # No attacker: either the player himself or the world entity (a fall,
            # a map hazard). In both cases nobody gets the kill.
            "suicide": e.attacker == e.other or e.attacker >= ENTITYNUM_WORLD,
        })
    kills.sort(key=lambda k: k["tS"])
    # Temp entities can be re-transmitted across several snapshots. The same
    # pairing within the same second is always the same kill - in S&D a victim
    # cannot die twice within one round.
    # Compare backwards exactly to the edge of the time window - a fixed count
    # would be too tight: the demos hold up to seven kills in two seconds.
    deduped: list[dict] = []
    for k in kills:
        dup = False
        for i in range(len(deduped) - 1, -1, -1):
            p = deduped[i]
            if k["tS"] - p["tS"] > 2.0:
                break
            if p["killer"] == k["killer"] and p["victim"] == k["victim"]:
                dup = True
                break
        if dup:
            continue
        deduped.append(k)
    duplicates = len(kills) - len(deduped)
    kills = deduped

    # --- Timeline ---
    scoreboards: list[dict] = []
    chat: list[dict] = []
    events: list[dict] = []
    raw_rounds: list[dict] = []
    hud: dict[str, str] = {}
    score_a = score_b = 0
    half = 1
    cur: dict | None = None
    alive_s = alive_o = 5
    knife_t: int | None = None
    joined: dict[int, int] = {}
    left: dict[int, int] = {}
    by_name = {strip_colors(v).strip(): k for k, v in names.items()}

    def client_by_name(raw: str) -> int | None:
        return by_name.get(strip_colors(raw).strip())

    for c in cmds:
        x, tm = c.text, c.time
        m = _RE_SCORES.match(x)
        if m:
            n = int(m.group(1))
            tok = m.group(5).split()
            if len(tok) != n * 7:
                continue
            st = {}
            for i in range(n):
                g = [int(v) for v in tok[i * 7:i * 7 + 7]]
                st[g[0]] = {"score": g[1], "ping": g[2], "deaths": g[3],
                            "kills": g[5], "assists": g[6]}
            scoreboards.append({"t": tm, "a": int(m.group(2)), "b": int(m.group(3)),
                                "lim": int(m.group(4)), "st": st})
            continue
        m = _RE_G.match(x)
        if m:
            v = int(m.group(1))
            if v != score_a:
                events.append({"t": tm, "k": "scoreA", "from": score_a, "to": v})
                score_a = v
            continue
        m = _RE_H.match(x)
        if m:
            v = int(m.group(1))
            if v != score_b:
                events.append({"t": tm, "k": "scoreB", "from": score_b, "to": v})
                score_b = v
            continue
        m = _RE_TIMER.match(x)
        if m:
            # Config string 11 carries the round timer AND the bomb timer - the
            # second hit within a running round is the bomb.
            if int(m.group(1)) > 0:
                if cur is None:
                    cur = {"start": tm, "half": half}
            elif cur is not None:
                cur["end"] = tm
                raw_rounds.append(cur)
                cur = None
            continue
        m = _RE_HUDHEAD.match(x)
        if m:
            if m.group(2).strip():
                hud[m.group(1)] = m.group(2).strip()
            continue
        m = _RE_HUDLINE.match(x)
        if m:
            s = m.group(2).rstrip()
            if s:
                events.append({"t": tm, "k": "hud", "v": s})
            if "Knife Round" in s:
                knife_t = tm
            continue
        m = _RE_ALIVE.search(x)
        if m:
            s, o = int(m.group(1)), int(m.group(2))
            if s != alive_s or o != alive_o:
                events.append({"t": tm, "k": "alive", "s": s, "o": o})
            alive_s, alive_o = s, o
            continue
        # Joins and leaves carry control characters in the text (CoD4 localisation
        # markers), so the match runs against the cleaned version.
        xc = _CTRL.sub("", x) if ("MP_CONNECTED" in x or "EXE_LEFTGAME" in x) else x
        m = _RE_JOINED.match(xc)
        if m:
            cl = client_by_name(m.group(1))
            if cl is not None and cl not in joined:
                joined[cl] = tm
            events.append({"t": tm, "k": "join", "v": m.group(1)})
            continue
        m = _RE_LEFT.match(xc)
        if m:
            cl = client_by_name(m.group(1))
            if cl is not None:
                left[cl] = tm
            events.append({"t": tm, "k": "left", "v": m.group(1)})
            continue
        m = _RE_MSG.match(x)
        if m:
            events.append({"t": tm, "k": "msg", "v": m.group(1)})
            continue
        m = _RE_CHAT.match(x)
        if m:
            chat.append({"tS": rel(tm),
                         "scope": "team" if m.group(1) == "i" else "all",
                         "text": m.group(2)})
            continue
        if _RE_HALFTIME.match(x):
            if half == 1:
                events.append({"t": tm, "k": "half"})
            half = 2

    # --- Runden: Siegerseite, Alive-Stand, Bombe ---
    for r in raw_rounds:
        for e in events:
            if e["t"] < r["end"] - 1500 or e["t"] > r["end"] + 5000:
                continue
            if e["k"] == "scoreA" and e["to"] == e["from"] + 1:
                r["side"] = "A"
            elif e["k"] == "scoreB" and e["to"] == e["from"] + 1:
                r["side"] = "B"
        s, o = 5, 5
        for e in events:
            if e["k"] != "alive" or e["t"] < r["start"]:
                continue
            if e["t"] > r["end"] + 300:
                break
            s, o = e["s"], e["o"]
        r["as"], r["ao"] = s, o
        bomb_events = [e for e in events
                       if e["k"] == "msg" and "EXPLOSIVES" in e["v"]
                       and r["start"] - 3000 <= e["t"] <= r["end"] + 2000]
        r["bomb"] = [e["v"] for e in bomb_events]

        # Timeline of the round: the real kill feed where available, otherwise the
        # alive counters (which only say which side lost someone).
        tl: list[dict] = []
        r["kills"] = [k for k in kills if r["start"] <= t0 + k["tS"] * 1000 <= r["end"] + 300]
        prev_s = prev_o = 5
        for e in [] if r["kills"] else events:
            if e["k"] != "alive":
                continue
            if e["t"] < r["start"]:
                prev_s, prev_o = e["s"], e["o"]
                continue
            if e["t"] > r["end"] + 300:
                break
            if prev_s - e["s"] > 0:
                tl.append({"tS": rel(e["t"]), "kind": "down", "team": my_team, "side": "self",
                           "n": prev_s - e["s"], "aliveSelf": e["s"], "aliveOther": e["o"]})
            if prev_o - e["o"] > 0:
                tl.append({"tS": rel(e["t"]), "kind": "down", "team": other, "side": "other",
                           "n": prev_o - e["o"], "aliveSelf": e["s"], "aliveOther": e["o"]})
            prev_s, prev_o = e["s"], e["o"]
        for k in r["kills"]:
            tl.append({"tS": k["tS"], "kind": "kill", **k})
        for e in bomb_events:
            m = _RE_BOMB_MSG.match(strip_colors(e["v"]))
            # Picking up and dropping the bomb stay out - only planting and
            # defusing decide the round.
            if not m or m.group(1) not in ("PLANTED", "DEFUSED"):
                continue
            tl.append({"tS": rel(e["t"]), "kind": "bomb",
                       "action": BOMB_ACTION[m.group(1)],
                       "player": m.group(2).strip()})
        tl.sort(key=lambda x: x["tS"])
        for entry in tl:
            if entry["kind"] in ("down", "kill"):
                entry["first"] = True
                break
        r["timeline"] = tl

    # Side -> team is tracked along and corrects itself: as soon as a round is
    # decided beyond doubt (one side completely dead), the winner is known
    # without needing the side assignment - and the assignment is reset from
    # it. After halftime the sides swap, which this notices by itself,
    # without relying on a config string.
    side_map: dict[str, str] = {}
    for r in raw_rounds:
        decisive = None
        if r["ao"] == 0 and r["as"] > 0:
            decisive = my_team
        elif r["as"] == 0 and r["ao"] > 0:
            decisive = other
        side = r.get("side")
        if decisive and side:
            side_map[side] = decisive
            side_map["B" if side == "A" else "A"] = other if decisive == my_team else my_team
        r["decided"] = decisive
        r["winner_team"] = decisive or (side_map.get(side) if side else None) or "?"

    wins = {my_team: 0, other: 0}
    halves: dict[int, dict[str, int]] = {}
    rounds: list[Round] = []
    for i, r in enumerate(raw_rounds, 1):
        winner = r["winner_team"]
        bomb = "; ".join(r["bomb"])
        if "DEFUSED" in bomb:
            reason = "Bomb defused"
        elif "PLANTED" in bomb:
            reason = "Bomb exploded"
        elif r["ao"] == 0 and r["as"] > 0:
            reason = f"{other} eliminated"
        elif r["as"] == 0 and r["ao"] > 0:
            reason = f"{my_team} eliminated"
        else:
            reason = "Time expired"
        if winner in wins:
            wins[winner] += 1
        halves.setdefault(r["half"], {})
        halves[r["half"]][winner] = halves[r["half"]].get(winner, 0) + 1
        rounds.append(Round(
            n=i, half=r["half"], start_s=rel(r["start"]),
            dur_s=int((r["end"] - r["start"]) / 100.0) / 10.0,
            winner=winner, reason=reason,
            score=":".join(str(wins[t]) for t in order),
            bomb=strip_colors(bomb), timeline=r["timeline"],
        ))

    # --- kills/deaths per round ---
    # Exact with the kill feed; without it only the scoreboard deltas remain,
    # and rounds without a scoreboard of their own stay approximate.
    if kills:
        for rd, raw in zip(rounds, raw_rounds):
            rd.exact = True
            for k in raw["kills"]:
                if not k["suicide"]:
                    rd.kills[k["killer"]] = rd.kills.get(k["killer"], 0) + 1
                rd.deaths[k["victim"]] = rd.deaths.get(k["victim"], 0) + 1
    prev: dict[int, dict[str, int]] = {}
    for i, rd in enumerate(rounds):
        if kills:
            break
        nxt = raw_rounds[i + 1]["start"] if i + 1 < len(raw_rounds) else float("inf")
        best = None
        for s in scoreboards:
            if raw_rounds[i]["end"] - 1000 <= s["t"] < nxt:
                best = s
        if best is None:
            continue
        rd.exact = True
        for cl, st in best["st"].items():
            p = prev.get(cl, {"kills": 0, "deaths": 0})
            rd.kills[cl] = st["kills"] - p["kills"]
            rd.deaths[cl] = st["deaths"] - p["deaths"]
            prev[cl] = {"kills": st["kills"], "deaths": st["deaths"]}

    # --- players ---
    final = scoreboards[-1] if scoreboards else None
    # The last scoreboard can be older than the last round - the server does not
    # necessarily send another one after the match ends. With a kill feed, kills
    # and deaths are therefore counted from it, by the same rule the scoreboard
    # uses: only within the rounds, and team kills do not count as a kill for
    # the shooter. On every demo checked the two agree exactly.
    team_of = {cl: t for t, cls in roster.items() for cl in cls}
    feed_kills: dict[int, int] = {}
    feed_deaths: dict[int, int] = {}
    for r in raw_rounds if kills else []:
        for k in r["kills"]:
            feed_deaths[k["victim"]] = feed_deaths.get(k["victim"], 0) + 1
            if not k["suicide"] and team_of.get(k["killer"]) != team_of.get(k["victim"]):
                feed_kills[k["killer"]] = feed_kills.get(k["killer"], 0) + 1
    last_round_end = (raw_rounds[-1]["end"] if raw_rounds else 0)
    stale = bool(final and raw_rounds and final["t"] < last_round_end)
    # Whoever left the server before the end is missing from the last
    # scoreboard - for them the last one they still appear in counts.
    last_st: dict[int, dict] = {}
    for sb_entry in scoreboards:
        last_st.update(sb_entry["st"])

    players: list[Player] = []
    for t in order:
        for cl in roster.get(t, []):
            st = last_st.get(cl)
            players.append(Player(
                client=cl, name=names.get(cl, f"client {cl}"), team=t,
                kills=feed_kills.get(cl, 0) if kills else (st["kills"] if st else 0),
                deaths=feed_deaths.get(cl, 0) if kills else (st["deaths"] if st else 0),
                assists=st["assists"] if st else 0, score=st["score"] if st else 0,
                ping=st["ping"] if st else 0, has_stats=st is not None,
                joined_s=rel(joined[cl]) if cl in joined else None,
                left_s=rel(left[cl]) if cl in left else None,
            ))
    players.sort(key=lambda p: (order.index(p.team), -p.kills))

    si = parse_infostring(d.configstrings.get(0, ""))
    duration = ((d.last_time - d.first_time) / 1000.0) if d.last_time > d.first_time \
        else (rel(cmds[-1].time) if cmds else 0.0)
    info = {
        "server": strip_colors(si.get("sv_hostname", "")),
        "map": si.get("mapname", ""),
        "gametype": si.get("g_gametype", ""),
        "mod": si.get("fs_game", ""),
        "ruleset": strip_colors(hud.get("381", "")),
        "hud": strip_colors(hud.get("380", "")),
        "mapStart": si.get("g_mapStartTime", ""),
        "version": si.get("version", ""),
        "factions": [d.configstrings.get(152, ""), d.configstrings.get(153, "")],
        "protocol": d.protocol,
        "scorelimit": scoreboards[0]["lim"] if scoreboards else 0,
        "povClient": pov,
        "povName": names.get(pov, ""),
        "durationS": round(duration),
        "snapshots": d.snapshots,
        "frames": d.frames,
        "commands": len(cmds),
        "configstrings": len(d.configstrings),
        "cleanEof": d.clean_eof,
        "sizeBytes": d.size_bytes,
        "taggedTeams": tagged,
        "killFeed": bool(kills),
        "statsSource": "killfeed" if kills else "scoreboard",
        "scoreboardStale": stale,
        "obituaries": len(kills),
        "duplicateObituaries": duplicates,
    }
    teams = [Team(name=t, wins=wins.get(t, 0),
                  halves=[halves.get(h, {}).get(t, 0) for h in sorted(halves)])
             for t in order]
    def player_name(cl: int) -> str:
        return strip_colors(names.get(cl, f"client {cl}"))

    # The event list is a fixed allow list - anything that cannot be matched
    # here does not show up.
    out_events: list[dict] = []
    for e in events:
        k = e["k"]
        v = strip_colors(e.get("v", ""))
        if k == "half":
            text = "Halftime"
        elif k == "join":
            text = f"{v} connected"
        elif k == "left":
            text = f"{v} left the server"
        elif k == "hud":
            if v not in _EV_HUD_KEEP:
                continue
            text = v
        elif k == "msg":
            m = _RE_BOMB_MSG.match(v)
            if m and m.group(1) in ("PLANTED", "DEFUSED"):
                text = f"{BOMB_ACTION[m.group(1)]}: {m.group(2).strip()}"
            elif _RE_EV_JOINED_TEAM.search(v) or _RE_EV_TIMEOUT.match(v):
                text = v
            else:
                continue
        else:
            continue
        out_events.append({"tS": rel(e["t"]), "kind": k, "text": text})
    for kill in kills:
        if kill["suicide"]:
            continue
        out_events.append({
            "tS": kill["tS"], "kind": "kill",
            "text": f"{player_name(kill['killer'])} kills {player_name(kill['victim'])}"})
    out_events.sort(key=lambda e: e["tS"])

    return Match(info=info, teams=teams, players=players, rounds=rounds,
                 chat=chat, events=out_events, kills=kills,
                 knife_s=None if knife_t is None else rel(knife_t),
                 map=_build_map(d, t0))


def _view_track(d: DemoData) -> list[tuple]:
    """Track of the player being followed.

    Prefers the MSG_FRAME records: they carry the position of the recording
    player at client frame rate. The player state only delivers that same
    position as an occasional server correction - across a match it changes
    there only about a hundred times, so the track would be a series of jumps.
    Which frame belongs to whom is told by the ClientNum of the player state
    sample before it (after your own death that is the spectated team mate).
    """
    samples = d.view_samples or []
    if not d.view_frames or not samples:
        return [(t, c, x, y, z, yaw, w) for t, c, x, y, z, yaw, w in samples]
    out: list[tuple] = []
    i = 0
    for t, x, y, z, yaw in d.view_frames:
        while i + 1 < len(samples) and samples[i + 1][0] <= t:
            i += 1
        s = samples[i]
        out.append((t, s[1], x, y, z, yaw, s[6]))
    return out


def _build_map(d: DemoData, t0: int) -> dict:
    """Assemble the map view: projection and movement tracks per client.

    The tracks come from two sources - the delta entities of the other players
    and the player state of the player being followed. Both can deliver the
    same instant, so they are sorted by time and duplicate timestamps per
    client are merged.
    """
    raw = d.configstrings.get(CS_COMPASS, "")
    parts = raw.replace('"', " ").split()
    bounds: list[float] = []
    if len(parts) >= 5:
        try:
            bounds = [float(x) for x in parts[1:5]]
        except ValueError:
            bounds = []
    # The view of the recording player comes from the frames, not from the
    # player state - there it is only an occasional correction.
    merged: dict[int, list] = {c: list(v) for c, v in (d.tracks or {}).items()}
    for t, client, x, y, z, yaw, weapon in _view_track(d):
        merged.setdefault(client, []).append((t, x, y, z, yaw, weapon))
    tracks: dict[str, list[list[int]]] = {}
    for client, pts in sorted(merged.items()):
        if not (0 <= client < 64):
            continue
        out: list[list[int]] = []
        last_t = None
        # Sort stably and by time only: with equal timestamps that keeps the
        # insertion order - the same as in the JS version.
        for t, x, y, z, yaw, weapon in sorted(pts, key=lambda q: q[0]):
            ts = int((t - t0) / 10.0)              # Hundertstelsekunden seit Start
            if ts == last_t:
                continue
            out.append([ts, x, y, z, yaw, weapon])
            last_t = ts
        if len(out) > 1:
            tracks[str(client)] = out
    # Pass the weapon names along once, so the display can resolve the ids in
    # the tracks without knowing the config strings.
    weapons = [pretty_weapon(w.removesuffix("_mp"))
               for w in d.configstrings.get(CS_WEAPON_LIST, "").split()]
    return {"compass": parts[0] if parts else "", "bounds": bounds,
            "center": d.configstrings.get(12, ""), "tracks": tracks,
            "weapons": weapons, "grenades": _build_grenades(d, t0)}


def _impact(ordered: list, path: list[list[int]], t0: int) -> tuple[list[int], int, bool]:
    """Where and when the grenade lands.

    If the last transmitted state is already on the ground, that is the impact.
    Otherwise the trajectory is extrapolated ballistically until it falls back
    to throwing height. That is a prediction, not a measurement: it ignores
    walls. Accuracy checked against frags over 393 throws - 172 units median,
    386 units at the 90th percentile, against 1967 units for the throwing point.
    """
    last = ordered[-1]
    tail = path[-1]
    if len(last) < 9 or last[8] == GROUND_WORLD:
        return [tail[1], tail[2], tail[3]], tail[0], False
    vx, vy, vz = last[4], last[5], last[6]
    if not (vx or vy or vz):
        return [tail[1], tail[2], tail[3]], tail[0], False
    z_ref = path[0][3]
    x = float(last[1])
    y = float(last[2])
    z = float(last[3])
    t = 0.0
    while t < MAX_FLIGHT_S:
        t += 0.02
        x = last[1] + vx * t
        y = last[2] + vy * t
        z = last[3] + vz * t - 0.5 * GRAVITY * t * t
        if vz - GRAVITY * t < 0 and z <= z_ref:
            break
    return [int(x), int(y), int(z)], tail[0] + int(t * 100), True


def _build_grenades(d: DemoData, t0: int) -> list[dict]:
    """Flight paths of the thrown grenades.

    What the demo holds is the flight up to ignition - the smoke cloud itself
    is not transmitted, the client renders it from the event.
    """
    weapons = d.configstrings.get(CS_WEAPON_LIST, "").split()
    out: list[dict] = []
    for (weapon_id, _launch), pts in (d.missiles or {}).items():
        name = weapons[weapon_id - 1] if 0 < weapon_id <= len(weapons) else ""
        kind = GRENADE_TYPES.get(name.removesuffix("_mp"), "other")
        path: list[list[int]] = []
        last_t = None
        ordered = sorted(pts, key=lambda q: q[0])
        for rec in ordered:
            t, x, y, z = rec[0], rec[1], rec[2], rec[3]
            ts = int((t - t0) / 10.0)
            if ts == last_t:
                continue
            path.append([ts, x, y, z])
            last_t = ts
        if not path:
            continue
        impact, impact_ts, predicted = _impact(ordered, path, t0)
        out.append({"kind": kind, "weapon": pretty_weapon(name.removesuffix("_mp")),
                    "path": path, "impact": impact, "impactS": impact_ts,
                    "predicted": predicted})
    out.sort(key=lambda g: g["path"][0][0])
    return out


# ---------------------------------------------------------------------------
# Textreport
# ---------------------------------------------------------------------------

def format_report(m: Match) -> str:
    i = m.info
    L: list[str] = []
    add = L.append
    add("================= COD4 DEMO ANALYSIS =================")
    for label, value in (
        ("Server", i["server"]), ("Map", i["map"]),
        ("Mode", f"{i['gametype']} (Search & Destroy)" if i["gametype"] == "sd" else i["gametype"]),
        ("Mod", i["mod"]), ("HUD", i["hud"]), ("Ruleset", i["ruleset"]),
        ("Factions", f"{i['factions'][0]} / {i['factions'][1]}  (score limit {i['scorelimit']})"),
        ("Map start", i["mapStart"]), ("Server build", i["version"]),
        ("Demo POV", f"client {i['povClient']} = {strip_colors(i['povName'])}"),
        ("Length", f"{i['durationS'] / 60:.1f} min, {len(m.rounds)} rounds"
                 + (" (+ knife round)" if m.knife_s is not None else "")),
    ):
        add(f"{label:<14} {value}")

    add("")
    add("================= FINAL SCORE =================")
    order = sorted(m.teams, key=lambda t: -t.wins)
    add(f"  {order[0].name} {order[0].wins}  :  {order[1].wins} {order[1].name}"
        if len(order) > 1 else f"  {order[0].name} {order[0].wins}")
    for n, _ in enumerate(order[0].halves):
        add(f"  Half {n + 1}:  " + "  :  ".join(f"{t.name} {t.halves[n]}" for t in order))

    add("")
    add("================= PLAYERS =================")
    add(f"{'Team':<6} {'cl':<4} {'Player':<18} {'Score':>6} {'K':>5} {'A':>4} {'D':>5} {'K/D':>6}")
    for t in order:
        team_players = [p for p in m.players if p.team == t.name]
        for p in team_players:
            kd = p.kills / p.deaths if p.deaths else float(p.kills)
            add(f"{t.name:<6} {p.client:<4} {strip_colors(p.name):<18} {p.score:>6} {p.kills:>5} "
                f"{p.assists:>4} {p.deaths:>5} {kd:>6.2f}")
        k = sum(p.kills for p in team_players)
        dd = sum(p.deaths for p in team_players)
        a = sum(p.assists for p in team_players)
        sc = sum(p.score for p in team_players)
        kd = k / dd if dd else float(k)
        add(f"{t.name:<6} {'':<4} {'  TEAM TOTAL':<18} {sc:>6} {k:>5} {a:>4} {dd:>5} {kd:>6.2f}")

    add("")
    add("================= ROUNDS =================")
    add(f"{'#':<3} {'Start':<6} {'Len':<6} {'Winner':<6} {'Score':<7} {'Reason':<22} Bomb")
    for r in m.rounds:
        bomb = r.bomb.replace("MP_EXPLOSIVES_", "").replace("_BY", " <- ")
        add(f"{r.n:<3} {_mmss(r.start_s):<6} {int(r.dur_s + 0.5):>5}s {r.winner:<6} "
            f"{r.score:<7} {r.reason:<22} {bomb}")
    if m.knife_s is not None:
        add(f"(knife round before round 1 at {_mmss(m.knife_s)} - outcome under EVENTS)")

    add("")
    add("================= KILLS PER ROUND =================")
    gaps = [r.n for r in m.rounds if not r.exact]
    if gaps:
        add("(rounds without a scoreboard of their own are marked ?; their kills are")
        add(" counted in the next column (*). The totals on the right are correct.)")
    # Columns after a gap carry that gap's kills and are marked with *.
    labels = []
    for idx, r in enumerate(m.rounds):
        if not r.exact:
            labels.append("?")
        elif idx and not m.rounds[idx - 1].exact:
            labels.append(f"{r.n}*")
        else:
            labels.append(str(r.n))
    add(f"{'Player':<18}" + "".join(f"{lbl:>3}" for lbl in labels) + "   K   D")
    for p in m.players:
        cells = []
        k = dd = 0
        for r in m.rounds:
            if not r.exact:
                cells.append(f"{'?':>3}")
                continue
            v = r.kills.get(p.client, 0)
            k += v
            dd += r.deaths.get(p.client, 0)
            cells.append(f"{(str(v) if v else '.'):>3}")
        add(f"{strip_colors(p.name):<18}" + "".join(cells) + f" {k:>3} {dd:>3}")

    if m.kills:
        add("")
        add("================= KILL FEED =================")
        names = {p.client: strip_colors(p.name) for p in m.players}
        for r in m.rounds:
            feed = [e for e in r.timeline if e.get("kind") == "kill"]
            add(f"-- Round {r.n}  ({r.winner} win, {r.reason}) " + "-" * 28)
            for e in r.timeline:
                t = _mmss(max(0.0, e["tS"] - r.start_s))
                if e.get("kind") == "kill":
                    if e["suicide"]:
                        how = "" if e["weapon"] == "suicide" else f"  {e['weaponLabel']}"
                        add(f"   {t:<6} {names.get(e['victim'], e['victim']):<18} died{how}")
                    else:
                        tag = "  [headshot]" if e["headshot"] else ""
                        add(f"   {t:<6} {names.get(e['killer'], e['killer']):<18} -> "
                            f"{names.get(e['victim'], e['victim']):<18} {e['weaponLabel']}{tag}")
                elif e.get("kind") == "bomb":
                    add(f"   {t:<6} {e['action']} - {strip_colors(e.get('player', ''))}")
            if not feed:
                add("   (no kills)")

    add("")
    add("================= CHAT =================")
    for c in m.chat:
        add(f"{_mmss(c['tS']):<6} {'[team]' if c['scope'] == 'team' else '':<7} {strip_colors(c['text'])}")

    add("")
    add("================= EVENTS =================")
    for e in m.events:
        if e["kind"] == "half":
            add(f"{_mmss(e['tS']):<6} --- HALFTIME ---")
        else:
            prefix = "[HUD] " if e["kind"] == "hud" else ""
            add(f"{_mmss(e['tS']):<6} {prefix}{e['text']}")
    return "\n".join(L) + "\n"


def _mmss(seconds: float) -> str:
    """Elapsed time as m:ss - truncated, not rounded, like a clock."""
    s = max(0, int(seconds))
    return f"{s // 60}:{s % 60:02d}"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _write_raw(d: DemoData, outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    with (outdir / "commands.tsv").open("w", encoding="utf-8", newline="\n") as f:
        f.write("msgseq\ttime_ms\tcmdseq\tcommand\n")
        for c in d.commands:
            f.write(f"{c.seq}\t{c.time}\t{c.cseq}\t{c.text}\n")
    with (outdir / "configstrings.tsv").open("w", encoding="utf-8", newline="\n") as f:
        for k in sorted(d.configstrings):
            f.write(f"{k}\t{d.configstrings[k]}\n")
    with (outdir / "players.tsv").open("w", encoding="utf-8", newline="\n") as f:
        f.write("client\tname\n")
        for k in sorted(d.players):
            f.write(f"{k}\t{d.players[k]}\n")


def selftest() -> int:
    t = HuffmanTree.build()
    ok = True
    print(f"symbols: {len(FREQ)}, sum: {sum(FREQ)}")
    if len(FREQ) != 256 or sum(FREQ) != 2154227:
        print("  ERROR: frequency table differs"); ok = False
    print(f"nodes: {t.nodes} (expected 513), longest code: {t._lut_bits} bits")
    if t.nodes != 513:
        print("  ERROR: unexpected node count"); ok = False
    fp = t.fingerprint()
    print(f"Fingerprint: {fp}")
    if TREE_FINGERPRINT.startswith("__"):
        print("  (no reference fingerprint stored)")
    elif fp != TREE_FINGERPRINT:
        print(f"  ERROR: expected {TREE_FINGERPRINT}"); ok = False
    else:
        print("  matches the reference implementation")
    print("OK" if ok else "FAILED")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Read and analyse Call of Duty 4 demos (.dm_1).")
    ap.add_argument("demo", nargs="?", type=Path, help="path to the .dm_1 file")
    ap.add_argument("--json", type=Path, metavar="FILE", help="write the analysis as JSON")
    ap.add_argument("--report", type=Path, metavar="FILE", help="write the text report to a file")
    ap.add_argument("--raw", type=Path, metavar="DIR",
                    help="dump server commands, config strings and players as TSV")
    ap.add_argument("--tracks", action="store_true",
                    help="include the movement tracks in the JSON (large: ~100k points)")
    ap.add_argument("-q", "--quiet", action="store_true", help="no output on stdout")
    ap.add_argument("--selftest", action="store_true",
                    help="verify the Huffman tree and exit")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.demo:
        ap.error("missing path to a demo (or use --selftest)")
    if not args.demo.is_file():
        print(f"file not found: {args.demo}", file=sys.stderr)
        return 2

    t_start = time.perf_counter()
    data = args.demo.read_bytes()
    try:
        demo = parse_demo(data)
    except ValueError as exc:
        print(f"could not read this demo: {exc}", file=sys.stderr)
        return 1
    match = analyze(demo)
    ms = (time.perf_counter() - t_start) * 1000

    print(f"{args.demo.name}: protocol {demo.protocol}, {demo.snapshots} snapshots, "
          f"{demo.frames} frames, {len(demo.commands)} server commands, "
          f"{len(demo.configstrings)} config strings, "
          f"{'clean EOF' if demo.clean_eof else 'no EOF marker'} "
          f"[{ms:.0f} ms]", file=sys.stderr)

    report = format_report(match)
    if not args.quiet:
        sys.stdout.write(report)
    if args.report:
        args.report.write_text(report, encoding="utf-8", newline="\n")
    if args.json:
        payload = match.to_dict()
        if not args.tracks:
            # The movement tracks run to a good hundred thousand points and would
            # blow up any JSON output - they are only included on request.
            payload["map"] = dict(payload["map"], tracks={})
        args.json.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                             encoding="utf-8", newline="\n")
    if args.raw:
        _write_raw(demo, args.raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
