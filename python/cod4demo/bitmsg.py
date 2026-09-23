"""Read head over a decompressed CoD4 message (``msg_t`` semantics).

CoD4 mixes two cursors in one buffer:

* byte reads (``read_byte``, ``read_short``, ``read_int``, ``read_string``)
  advance ``readcount`` and ignore the bit cursor;
* bit reads (``read_bit``, ``read_bits``) keep a separate bit position. When
  the bit position reaches a byte boundary, the next byte is taken at
  ``readcount`` (which is then advanced), so bit fields and bytes interleave.

This quirk (``MSG_ReadBit`` in the engine) must be reproduced exactly or the
delta-coded snapshot stream goes out of step immediately.
"""

from __future__ import annotations

import struct

_F32 = struct.Struct("<f")
_U32 = struct.Struct("<I")


def u2f(u: int) -> float:
    """Reinterpret a 32-bit pattern as IEEE float."""
    return _F32.unpack(_U32.pack(u & 0xFFFFFFFF))[0]


def f2u(f: float) -> int:
    """Reinterpret a float as its 32-bit pattern (float32 rounding)."""
    try:
        return _U32.unpack(_F32.pack(f))[0]
    except (OverflowError, ValueError):
        return 0x7FC00000 if f != f else (0x7F800000 if f > 0 else 0xFF800000)


def f2i(u: int) -> int:
    """``(int)*(float*)&u`` with C truncation; NaN/inf/out of range give 0."""
    f = u2f(u)
    if f != f or not (-2147483648.0 < f < 2147483648.0):
        return 0
    return int(f)


def s32(u: int) -> int:
    """Unsigned 32-bit pattern -> signed int."""
    u &= 0xFFFFFFFF
    return u - 0x100000000 if u & 0x80000000 else u


class Msg:
    __slots__ = ("data", "cursize", "readcount", "bit", "overflowed", "last_entity")

    def __init__(self, data: bytes, readcount: int = 0) -> None:
        self.data = data
        self.cursize = len(data)
        self.readcount = readcount
        self.bit = readcount * 8
        self.overflowed = False
        self.last_entity = -1          # MSG_ClearLastReferencedEntity

    # -- bits ---------------------------------------------------------------
    def read_bit(self) -> int:
        bit = self.bit
        if not bit & 7:
            if self.readcount >= self.cursize:
                self.overflowed = True
                return 0
            bit = self.readcount * 8
            self.readcount += 1
        self.bit = bit + 1
        return (self.data[bit >> 3] >> (bit & 7)) & 1

    def read_bits(self, n: int) -> int:
        value = 0
        got = 0
        data = self.data
        bit = self.bit
        while got < n:
            if not bit & 7:
                if self.readcount >= self.cursize:
                    self.overflowed = True
                    self.bit = bit
                    return value
                bit = self.readcount * 8
                self.readcount += 1
            pos = bit & 7
            take = 8 - pos
            if take > n - got:
                take = n - got
            value |= ((data[bit >> 3] >> pos) & ((1 << take) - 1)) << got
            bit += take
            got += take
        self.bit = bit
        return value

    # -- bytes --------------------------------------------------------------
    def read_byte(self) -> int:
        rc = self.readcount
        if rc >= self.cursize:
            self.overflowed = True
            return 0
        self.readcount = rc + 1
        return self.data[rc]

    def read_short(self) -> int:
        """Signed 16-bit little endian."""
        rc = self.readcount
        if rc + 2 > self.cursize:
            self.overflowed = True
            self.readcount = self.cursize
            return 0
        self.readcount = rc + 2
        v = self.data[rc] | (self.data[rc + 1] << 8)
        return v - 0x10000 if v & 0x8000 else v

    def read_int(self) -> int:
        """Unsigned 32-bit little endian (use ``s32`` for the signed value)."""
        rc = self.readcount
        if rc + 4 > self.cursize:
            self.overflowed = True
            self.readcount = self.cursize
            return 0
        self.readcount = rc + 4
        return int.from_bytes(self.data[rc:rc + 4], "little")

    def read_long(self) -> int:
        """Signed 32-bit little endian."""
        return s32(self.read_int())

    def read_string_bytes(self) -> bytes:
        end = self.data.find(b"\0", self.readcount, self.cursize)
        if end < 0:
            self.overflowed = True
            end = self.cursize
            s = self.data[self.readcount:end]
            self.readcount = end
            return s
        s = self.data[self.readcount:end]
        self.readcount = end + 1
        return s

    def read_string(self) -> str:
        # CoD4 strings are 8-bit; latin-1 maps every byte 1:1 and is lossless
        return self.read_string_bytes().decode("latin-1")

    def read_data(self, n: int) -> bytes:
        rc = self.readcount
        if rc + n > self.cursize:
            self.overflowed = True
            n = self.cursize - rc
        self.readcount = rc + n
        return self.data[rc:rc + n]

    # -- helpers ------------------------------------------------------------
    def read_angle16(self) -> float:
        return self.read_short() * (360.0 / 65536)

    def read_entity_index(self, index_bits: int) -> int:
        """``MSG_ReadEntityIndex``: +1, absolute, or (10-bit only) +4-bit delta."""
        if self.read_bit():
            self.last_entity += 1
        elif index_bits != 10 or self.read_bit():
            self.last_entity = self.read_bits(index_bits)
        else:
            self.last_entity += self.read_bits(4)
        return self.last_entity

    @property
    def remaining(self) -> int:
        return self.cursize - self.readcount
