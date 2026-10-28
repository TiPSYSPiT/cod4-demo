/* Minimal MP4 muxer for one H.264 video track (map tab export) and an optional audio track (3D view).
 *
 *   C4.mp4Mux({width, height, fps, avcC: Uint8Array, samples: [{data: Uint8Array, key: bool}], audio}) -> Blob
 *   audio (optional): {codec: 'aac' | 'opus', sampleRate, channels, config: Uint8Array (AAC: the
 *   AudioSpecificConfig; Opus: the OpusHead of the encoder), frame: samples per packet, samples: [{data}]}
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

  /** the audio sample entry: mp4a + esds (ISO/IEC 14496-1 descriptors) or Opus + dOps */
  function audioEntry(a) {
    const head = [zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), u16(0), u16(0), u32(a.sampleRate * 65536)];
    if (a.codec === 'opus') {
      // dOps (Opus in ISO BMFF): the OpusHead's fields big-endian
      const h = a.config, le16 = o => (h && h.length > o + 1 ? h[o] | (h[o + 1] << 8) : 0);
      const preSkip = h && h.length >= 19 ? le16(10) : 312;
      return box('Opus', head, box('dOps', [0, a.channels], u16(preSkip), u32(a.sampleRate), u16(0), [0]));
    }
    const len = n => [0x80, 0x80, 0x80, n];                 // descriptor sizes in 4 bytes
    const dsi = [0x05, ...len(a.config.length), ...a.config];
    const dcd = [0x04, ...len(13 + dsi.length), 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsi];
    const es = [0x03, ...len(3 + dcd.length + 6), ...u16(1), 0, ...dcd, 0x06, ...len(1), 0x02];
    return box('mp4a', head, full('esds', 0, 0, es));
  }

  function mux({ width, height, fps, avcC, samples, audio = null }) {
    const TS = 90000, delta = Math.round(TS / fps), n = samples.length;
    const durTrack = n * delta, durMovie = Math.round(n * 1000 / fps);
    const A = audio && audio.samples && audio.samples.length ? audio : null;
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
    // the audio track: one chunk after the video's, constant packet length
    const aTrak = aOff => box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(durMovie), zeros(8), u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(A.sampleRate), u32(A.samples.length * A.frame), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), enc.encode('soun'), zeros(12), enc.encode('SoundHandler'), [0]),
        box('minf',
          full('smhd', 0, 0, zeros(4)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl',
            full('stsd', 0, 0, u32(1), audioEntry(A)),
            full('stts', 0, 0, u32(1), u32(A.samples.length), u32(A.frame)),
            full('stsc', 0, 0, u32(1), u32(1), u32(A.samples.length), u32(1)),
            full('stsz', 0, 0, u32(0), u32(A.samples.length), A.samples.map(s => u32(s.data.length)).flat()),
            full('stco', 0, 0, u32(1), u32(aOff))))));
    const moov = (stco, aOff = 0) => box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMovie), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(A ? 3 : 2)),
      box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMovie), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX,
          u32(width * 65536), u32(height * 65536)),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(durTrack), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), enc.encode('vide'), zeros(12), enc.encode('VideoHandler'), [0]),
          box('minf',
            full('vmhd', 0, 1, zeros(8)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            stbl(stco)))),
      A ? aTrak(aOff) : []);
    // moov comes before mdat: its size does not depend on the offset value
    const moovSize = moov(0).length;
    const dataSize = samples.reduce((a, s) => a + s.data.length, 0);
    const audioSize = A ? A.samples.reduce((a, s) => a + s.data.length, 0) : 0;
    const offset = ftyp.length + moovSize + 8;
    const mdatHead = new Uint8Array([...u32(dataSize + audioSize + 8), ...enc.encode('mdat')]);
    return new Blob([ftyp, moov(offset, offset + dataSize), mdatHead, ...samples.map(s => s.data), ...(A ? A.samples.map(s => s.data) : [])], { type: 'video/mp4' });
  }

  C4.mp4Mux = mux;
})(window.C4);
