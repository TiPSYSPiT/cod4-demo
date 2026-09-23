"""Low-level demo reader: container records, server messages and snapshots.

``DemoParser`` walks a ``.dm_1`` file and yields one event object per item
found in it, in file order:

    ProtocolInfo    REC_PROTOCOL record (CoD4X demos only)
    ArchiveFrame    REC_ARCHIVE record (client-predicted position / view)
    Gamestate       svc_gamestate: config strings, baselines, client names
    ConfigClient    svc_configclient outside the gamestate (name / clan tag)
    ServerCommand   svc_serverCommand (reliable command string)
    Snapshot        svc_snapshot, fully delta-decoded
    ReliableMessage REC_RELIABLE record (CoD4X, raw)
    Download        svc_download (raw)
    ParseIssue      anything that could not be decoded
    DemoEnd         end of file / end marker

Nothing is interpreted here beyond what the engine itself does while reading;
``extract.py`` builds the high-level tables on top of these events.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

from . import huffman
from .bitmsg import Msg, s32
from .constants import (CS_MAPCENTER, MAX_CLIENTS, PROTOCOL_STOCK, REC_ARCHIVE, REC_MESSAGE,
                        REC_PROTOCOL, REC_RELIABLE, SVC_BASELINE, SVC_CONFIGCLIENT,
                        SVC_CONFIGSTRING, SVC_DOWNLOAD, SVC_EOF, SVC_GAMESTATE, SVC_NAMES,
                        SVC_NOP, SVC_SERVERCOMMAND, SVC_SNAPSHOT)
from .delta import ArchiveFrame as _Arch
from .delta import DeltaDecoder, SnapshotInfo

_ARCHIVE = struct.Struct("<i3f3fiii3f")          # 52 bytes incl. index
_MAX_MSGLEN = 0x20000


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@dataclass
class ProtocolInfo:
    offset: int
    protocol: int
    legacy_end: int
    reserved: int


@dataclass
class ArchiveFrame:
    """Client archive: predicted origin/velocity/view of the recording client."""
    offset: int
    index: int
    origin: tuple[float, float, float]
    velocity: tuple[float, float, float]
    movement_dir: int
    bob_cycle: int
    server_time: int
    angles: tuple[float, float, float]


@dataclass
class Gamestate:
    offset: int
    message_seq: int
    server_command_seq: int
    configstrings: dict[int, str]
    baselines: dict[int, list[int]]
    clients: dict[int, tuple[str, str]]          # client -> (name, clan tag)
    server_config_seq: int | None
    client_num: int                             # the recording client (POV)
    checksum_feed: int


@dataclass
class ConfigClient:
    offset: int
    message_seq: int
    server_time: int
    sequence: int
    client: int
    name: str
    clantag: str


@dataclass
class ServerCommand:
    offset: int
    message_seq: int
    server_time: int
    seq: int
    text: str


@dataclass
class Snapshot:
    """A decoded snapshot. ``entities`` / ``clients`` give the complete state."""
    offset: int
    info: SnapshotInfo
    _decoder: DeltaDecoder = field(repr=False)
    _entities: list | None = field(default=None, repr=False)
    _clients: list | None = field(default=None, repr=False)

    @property
    def message_seq(self) -> int:
        return self.info.message_num

    @property
    def server_time(self) -> int:
        return self.info.server_time

    @property
    def delta_num(self) -> int:
        return self.info.delta_num

    @property
    def snap_flags(self) -> int:
        return self.info.snap_flags

    @property
    def ps(self):
        return self.info.ps

    @property
    def entities(self) -> list:
        """[(entity number, raw 61-word state), ...] - valid until the next snapshot."""
        if self._entities is None:
            self._entities = self._decoder.entities_of(self.info)
        return self._entities

    @property
    def clients(self) -> list:
        """[(client number, raw client state), ...]"""
        if self._clients is None:
            self._clients = self._decoder.clients_of(self.info)
        return self._clients


@dataclass
class ReliableMessage:
    offset: int
    command: int
    data: bytes


@dataclass
class Download:
    offset: int
    message_seq: int
    data: bytes


@dataclass
class ParseIssue:
    offset: int
    message_seq: int | None
    text: str


@dataclass
class DemoEnd:
    offset: int
    clean: bool            # True if the end marker (seq == -1) was found
    truncated: bool        # True if the last record was cut off


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class DemoParser:
    """Iterate over all events of a demo.

    ``decode_snapshots=False`` skips the (expensive) snapshot decoding; the
    gamestate, config strings and server commands are still read.
    """

    def __init__(self, source, decode_snapshots: bool = True) -> None:
        if isinstance(source, (bytes, bytearray, memoryview)):
            self.data = bytes(source)
            self.path = None
        else:
            self.path = Path(source)
            self.data = self.path.read_bytes()
        self.decode_snapshots = decode_snapshots
        self.protocol = PROTOCOL_STOCK
        self.decoder: DeltaDecoder | None = None
        self.server_time = 0
        self.stats = {"records": 0, "messages": 0, "archives": 0, "reliable": 0,
                      "snapshots": 0, "snapshots_dropped": 0, "server_commands": 0,
                      "gamestates": 0, "configclients": 0, "bytes_decompressed": 0,
                      "issues": 0}
        self.clean_end = False
        self.truncated = False
        self.server_config_seq: int | None = None

    # -- public ------------------------------------------------------------
    def __iter__(self) -> Iterator:
        return self.events()

    def events(self) -> Iterator:
        data = self.data
        size = len(data)
        p = 0
        self.decoder = DeltaDecoder(self.protocol)
        first = True
        while p < size:
            rec = data[p]
            start = p
            p += 1
            self.stats["records"] += 1
            if rec == REC_PROTOCOL:
                if p + 16 > size:
                    self.truncated = True
                    break
                proto, legacy_end, reserved = struct.unpack_from("<Iiq", data, p)
                p += 16
                self.protocol = proto
                if first:
                    self.decoder = DeltaDecoder(proto)
                yield ProtocolInfo(start, proto, legacy_end, reserved)
            elif rec == REC_ARCHIVE:
                if p + 52 > size:
                    self.truncated = True
                    break
                v = _ARCHIVE.unpack_from(data, p)
                p += 52
                self.stats["archives"] += 1
                fr = ArchiveFrame(start, v[0], v[1:4], v[4:7], v[7], v[8], v[9], v[10:13])
                self.decoder.add_archive(_Arch(v[0], v[1:4], v[4:7], v[7], v[8], v[9], v[10:13]))
                yield fr
            elif rec == REC_MESSAGE:
                if p + 8 > size:
                    self.truncated = True
                    break
                seq, length = struct.unpack_from("<ii", data, p)
                p += 8
                if length == -1 or seq == -1:
                    self.clean_end = True
                    break
                if length < 4 or p + length > size:
                    self.truncated = True
                    yield ParseIssue(start, seq, f"message record length {length} exceeds file")
                    break
                body_start = p
                p += length
                self.stats["messages"] += 1
                yield from self._read_message(start, seq, data, body_start, length)
            elif rec == REC_RELIABLE:
                if p + 4 > size:
                    self.truncated = True
                    break
                length = struct.unpack_from("<i", data, p)[0]
                p += 4
                if length < 0 or p + length > size:
                    self.truncated = True
                    break
                body = data[p:p + length]
                p += length
                self.stats["reliable"] += 1
                cmd = s32(int.from_bytes(body[:4], "little")) if len(body) >= 4 else -1
                yield ReliableMessage(start, cmd, body)
            else:
                self.stats["issues"] += 1
                yield ParseIssue(start, None, f"unknown record type {rec} - stopping")
                self.truncated = True
                break
            first = False
        yield DemoEnd(p, self.clean_end, self.truncated)

    # -- messages ----------------------------------------------------------
    def _read_message(self, offset: int, seq: int, data: bytes, start: int, length: int):
        # 4 bytes reliable acknowledge, then the Huffman coded payload
        buf = huffman.decompress(data, start + 4, length - 4, _MAX_MSGLEN)
        self.stats["bytes_decompressed"] += len(buf)
        m = Msg(buf)
        pending_cmds: list[ServerCommand] = []
        pending_other: list = []
        snapshot_event = None
        while True:
            if m.readcount >= m.cursize:
                break
            op = m.read_byte()
            if op == SVC_EOF:
                break
            if op == SVC_NOP:
                continue
            if op == SVC_SERVERCOMMAND:
                cseq = m.read_long()
                text = m.read_string()
                self.stats["server_commands"] += 1
                pending_cmds.append(ServerCommand(offset, seq, 0, cseq, text))
            elif op == SVC_GAMESTATE:
                gs = self._read_gamestate(m, offset, seq)
                self.stats["gamestates"] += 1
                pending_other.append(gs)
            elif op == SVC_CONFIGCLIENT:
                cfg_seq = m.read_long()
                cn = m.read_byte()
                name = m.read_string()
                tag = m.read_string()
                self.stats["configclients"] += 1
                if cn < MAX_CLIENTS:
                    pending_other.append(ConfigClient(offset, seq, 0, cfg_seq, cn, name, tag))
            elif op == SVC_SNAPSHOT:
                if not self.decode_snapshots:
                    break
                info = self.decoder.parse_snapshot(m, seq)
                if info is None:
                    self.stats["snapshots_dropped"] += 1
                    self.stats["issues"] += 1
                    pending_other.append(ParseIssue(offset, seq, self.decoder.error_log[-1]
                                                    if self.decoder.error_log else "snapshot dropped"))
                    break
                self.stats["snapshots"] += 1
                self.server_time = info.server_time
                snapshot_event = Snapshot(offset, info, self.decoder)
            elif op == SVC_DOWNLOAD:
                pending_other.append(Download(offset, seq, m.data[m.readcount:]))
                break
            else:
                self.stats["issues"] += 1
                name = SVC_NAMES.get(op, str(op))
                pending_other.append(ParseIssue(offset, seq, f"unexpected svc op {name} at byte {m.readcount - 1}"))
                break
            if m.overflowed:
                self.stats["issues"] += 1
                pending_other.append(ParseIssue(offset, seq, "message overflow"))
                break

        # commands and config updates of a message are applied before its snapshot:
        # give them the time of that snapshot (or the last known time)
        t = snapshot_event.server_time if snapshot_event is not None else self.server_time
        for ev in pending_other:
            if isinstance(ev, ConfigClient):
                ev.server_time = t
        for gs in (e for e in pending_other if isinstance(e, Gamestate)):
            yield gs
        for c in pending_cmds:
            c.server_time = t
            yield c
        for ev in pending_other:
            if not isinstance(ev, Gamestate):
                yield ev
        if snapshot_event is not None:
            yield snapshot_event

    def _read_gamestate(self, m: Msg, offset: int, seq: int) -> Gamestate:
        dec = self.decoder
        dec.reset_for_gamestate()
        m.last_entity = -1
        cmd_seq = m.read_long()
        configstrings: dict[int, str] = {}
        clients: dict[int, tuple[str, str]] = {}
        cod4x = self.protocol != PROTOCOL_STOCK
        while not m.overflowed:
            op = m.read_byte()
            if op == SVC_EOF:
                break
            if op == SVC_CONFIGSTRING:
                if cod4x:
                    count = m.read_long()
                    for _ in range(max(count, 0)):
                        idx = m.read_long()
                        configstrings[idx] = m.read_string()
                        if m.overflowed:
                            break
                else:
                    count = m.read_short()
                    idx = -1
                    for _ in range(max(count, 0)):
                        idx = idx + 1 if m.read_bit() else m.read_bits(12)
                        configstrings[idx] = m.read_string()
                        if m.overflowed:
                            break
                if CS_MAPCENTER in configstrings:
                    dec.set_map_center(configstrings[CS_MAPCENTER])
            elif op == SVC_BASELINE:
                dec.read_baseline(m)
            elif op == SVC_CONFIGCLIENT and cod4x:
                cn = m.read_byte()
                name = m.read_string()
                tag = m.read_string()
                if cn < MAX_CLIENTS:
                    clients[cn] = (name, tag)
            else:
                m.overflowed = True
                break
        server_cfg_seq = None
        if cod4x:
            server_cfg_seq = m.read_long()
            self.server_config_seq = server_cfg_seq
        client_num = m.read_long()
        checksum = m.read_long()
        # A live CoD4X server appends one more long ("dbchecksumFeed"); the
        # gamestate that the client writes into the demo does not carry it
        # (verified on protocol 17, 19 and 21 demos: svc_EOF follows directly).
        return Gamestate(offset, seq, cmd_seq, configstrings, dict(dec.baselines), clients,
                         server_cfg_seq, client_num, checksum)
