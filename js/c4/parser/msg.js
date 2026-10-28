/* Read head over a decompressed CoD4 message (msg_t semantics).
 *
 * Byte reads advance `readcount` and ignore the bit cursor; bit reads keep
 * their own position and, when they reach a byte boundary, take the next byte
 * at `readcount` (which then advances). This is MSG_ReadBit of the engine and
 * must be reproduced exactly or the delta stream loses sync. */
C4.define('msg', function (C4) {
  'use strict';
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const i32 = new Int32Array(f32.buffer);

  /** Reinterpret a 32-bit pattern as float. */
  function u2f(u) { u32[0] = u; return f32[0]; }
  /** Float -> 32-bit pattern (float32 rounding). */
  function f2u(f) { f32[0] = f; return u32[0]; }
  /** (int)*(float*)&u with C truncation; NaN / infinity / out of range -> 0. */
  function f2i(u) {
    u32[0] = u;
    const f = f32[0];
    if (!(f > -2147483648 && f < 2147483648)) return 0;
    return f < 0 ? Math.ceil(f) : Math.floor(f);
  }
  function s32(u) { return u | 0; }

  class Msg {
    constructor(data) {
      this.data = data;
      this.cursize = data.length;
      this.readcount = 0;
      this.bit = 0;
      this.overflowed = false;
      this.lastEntity = -1;
    }

    readBit() {
      let bit = this.bit;
      if ((bit & 7) === 0) {
        if (this.readcount >= this.cursize) { this.overflowed = true; return 0; }
        bit = this.readcount * 8;
        this.readcount++;
      }
      this.bit = bit + 1;
      return (this.data[bit >> 3] >> (bit & 7)) & 1;
    }

    readBits(n) {
      let value = 0, got = 0, bit = this.bit;
      const data = this.data;
      while (got < n) {
        if ((bit & 7) === 0) {
          if (this.readcount >= this.cursize) { this.overflowed = true; this.bit = bit; return value >>> 0; }
          bit = this.readcount * 8;
          this.readcount++;
        }
        const pos = bit & 7;
        let take = 8 - pos;
        if (take > n - got) take = n - got;
        value |= ((data[bit >> 3] >> pos) & ((1 << take) - 1)) << got;
        bit += take;
        got += take;
      }
      this.bit = bit;
      return value >>> 0;
    }

    readByte() {
      const rc = this.readcount;
      if (rc >= this.cursize) { this.overflowed = true; return 0; }
      this.readcount = rc + 1;
      return this.data[rc];
    }

    /** signed 16 bit */
    readShort() {
      const rc = this.readcount;
      if (rc + 2 > this.cursize) { this.overflowed = true; this.readcount = this.cursize; return 0; }
      this.readcount = rc + 2;
      const v = this.data[rc] | (this.data[rc + 1] << 8);
      return v & 0x8000 ? v - 0x10000 : v;
    }

    /** unsigned 32 bit */
    readInt() {
      const rc = this.readcount, d = this.data;
      if (rc + 4 > this.cursize) { this.overflowed = true; this.readcount = this.cursize; return 0; }
      this.readcount = rc + 4;
      return (d[rc] | (d[rc + 1] << 8) | (d[rc + 2] << 16) | (d[rc + 3] << 24)) >>> 0;
    }

    /** signed 32 bit */
    readLong() { return this.readInt() | 0; }

    /** NUL-terminated 8-bit string (latin-1, lossless). */
    readString() {
      const d = this.data;
      let i = this.readcount;
      const end = this.cursize;
      let s = '';
      const start = i;
      while (i < end && d[i] !== 0) i++;
      if (i - start < 64) {
        for (let k = start; k < i; k++) s += String.fromCharCode(d[k]);
      } else {
        const chunk = 8192;
        for (let k = start; k < i; k += chunk) {
          s += String.fromCharCode.apply(null, d.subarray(k, Math.min(i, k + chunk)));
        }
      }
      if (i >= end) { this.overflowed = true; this.readcount = end; }
      else this.readcount = i + 1;
      return s;
    }

    readAngle16() { return this.readShort() * (360 / 65536); }

    /** MSG_ReadEntityIndex: +1, absolute, or (10-bit only) +4-bit delta. */
    readEntityIndex(indexBits) {
      if (this.readBit()) this.lastEntity++;
      else if (indexBits !== 10 || this.readBit()) this.lastEntity = this.readBits(indexBits);
      else this.lastEntity += this.readBits(4);
      return this.lastEntity;
    }

    get remaining() { return this.cursize - this.readcount; }
  }

  C4.msg = { Msg, u2f, f2u, f2i, s32 };
});
