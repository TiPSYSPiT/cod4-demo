/* Minimal MP4 muxer for one H.264 video track (map tab export).
 *
 *   C4.mp4Mux({width, height, fps, avcC: Uint8Array, samples: [{data: Uint8Array, key: bool}]}) -> Blob
 *
 * avcC = the AVCDecoderConfigurationRecord of the encoder (VideoEncoder with avc.format 'avc':
 * metadata.decoderConfig.description), samples = the encoded chunks in decode order (length-prefixed
 * NAL units). Writes ftyp, moov (before the data, "fast start") and mdat with one chunk; constant
 * frame rate (track timescale 90 kHz). ISO/IEC 14496-12 / -15. DOM-free except the Blob. */
(function (C4) {
  'use strict';

  const enc = new TextEncoder();
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = v => [(v >>> 8) & 255, v & 255];
  const zeros = n => new Array(n).fill(0);
  /** box: 32-bit size + type + payload (arrays of bytes / Uint8Arrays / boxes) */
  function box(type, ...parts) {
    const chunks = parts.flat(Infinity).map(p => (p instanceof Uint8Array ? p : Uint8Array.from(Array.isArray(p) ? p : [p])));
    let size = 8; for (const c of chunks) size += c.length;
    const out = new Uint8Array(size);
    out.set(u32(size), 0); out.set(enc.encode(type), 4);
    let o = 8; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  const full = (type, version, flags, ...parts) => box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
  const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

  function mux({ width, height, fps, avcC, samples }) {
    const TS = 90000, delta = Math.round(TS / fps), n = samples.length;
    const durTrack = n * delta, durMovie = Math.round(n * 1000 / fps);
    const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isomiso2avc1mp41'));
    const stbl = stco => box('stbl',
      full('stsd', 0, 0, u32(1),
        box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
          zeros(32), u16(0x0018), u16(0xffff), box('avcC', avcC))),
      full('stts', 0, 0, u32(1), u32(n), u32(delta)),
      full('stss', 0, 0, u32(samples.filter(s => s.key).length), samples.map((s, i) => (s.key ? u32(i + 1) : [])).flat()),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), samples.map(s => u32(s.data.length)).flat()),
      full('stco', 0, 0, u32(1), u32(stco)));
    const moov = stco => box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMovie), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2)),
      box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMovie), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX,
          u32(width * 65536), u32(height * 65536)),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(durTrack), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), enc.encode('vide'), zeros(12), enc.encode('VideoHandler'), [0]),
          box('minf',
            full('vmhd', 0, 1, zeros(8)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            stbl(stco)))));
    // moov comes before mdat: its size does not depend on the offset value
    const moovSize = moov(0).length;
    const dataSize = samples.reduce((a, s) => a + s.data.length, 0);
    const offset = ftyp.length + moovSize + 8;
    const mdatHead = new Uint8Array([...u32(dataSize + 8), ...enc.encode('mdat')]);
    return new Blob([ftyp, moov(offset), mdatHead, ...samples.map(s => s.data)], { type: 'video/mp4' });
  }

  C4.mp4Mux = mux;
})(window.C4);
