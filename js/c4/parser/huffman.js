/* Static Huffman decoding of CoD4 network messages.
 * The code table (256 codes, max. 11 bits, LSB first) is pre-computed from the
 * engine's frequency table msg_hData; see python/cod4demo/huffman.py for the
 * tree builder and its self test. */
C4.define('huffman', function (C4) {
  'use strict';
  let lut = null;
  let lutBits = 0;

  function init() {
    const codes = C4.tables.HUFFMAN_CODES;
    let maxLen = 0;
    for (const [, len] of codes) maxLen = Math.max(maxLen, len);
    const size = 1 << maxLen;
    lut = new Uint16Array(size);          // (symbol << 5) | length
    for (let sym = 0; sym < 256; sym++) {
      const [code, len] = codes[sym];
      const packed = (sym << 5) | len;
      for (let i = code; i < size; i += 1 << len) lut[i] = packed;
    }
    lutBits = maxLen;
  }

  /**
   * Decode `length` bytes of `data` (Uint8Array) starting at `start`.
   * Returns a Uint8Array view of the decoded bytes. Mirrors MSG_ReadBitsCompress:
   * stops when the input bits run out or `maxOut` bytes were produced.
   */
  function decompress(data, start, length, maxOut) {
    if (!lut) init();
    const out = new Uint8Array(Math.min(maxOut, length * 8 + 16));
    const mask = (1 << lutBits) - 1;
    const end = start + length;
    const totalBits = length * 8;
    let acc = 0, have = 0, used = 0, pos = start, n = 0;
    const cap = out.length;
    while (used < totalBits && n < cap) {
      while (have < lutBits && pos < end) {
        acc |= data[pos++] << have;
        have += 8;
      }
      const packed = lut[acc & mask];
      const bits = packed & 31;
      if (used + bits > totalBits) break;   // trailing padding
      acc >>>= bits;
      have -= bits;
      used += bits;
      out[n++] = packed >> 5;
    }
    return out.subarray(0, n);
  }

  C4.huffman = { decompress };
});
