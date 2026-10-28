/* Demo container reader: records, server messages, gamestate, snapshots.
 * Port of python/cod4demo/parser.py. DOM-free; results are delivered to a
 * visitor object with optional callbacks:
 *
 *   onProtocol({offset, protocol})
 *   onArchive({index, origin, velocity, movementDir, bobCycle, serverTime, angles})
 *   onGamestate({configstrings: Map, baselines: Map, clients: Map, clientNum, ...})
 *   onConfigClient({client, name, clantag, serverTime})
 *   onServerCommand({seq, text, serverTime, messageSeq})
 *   onSnapshot(snap, decoder)
 *   onIssue({offset, messageSeq, text})
 *
 * Damaged data in the middle of a file (an invalid record) does not end the reading: the reader
 * searches the next position where valid records follow again (resync, same rules as parser.py),
 * reports the skipped bytes and goes on. Only a record cut off at the end counts as truncated.
 */
C4.define('demo', function (C4) {
  'use strict';
  const { Msg } = C4.msg;
  const { DeltaDecoder } = C4.delta;

  const REC_MESSAGE = 0, REC_ARCHIVE = 1, REC_PROTOCOL = 2, REC_RELIABLE = 3;
  const SVC_NOP = 0, SVC_GAMESTATE = 1, SVC_CONFIGSTRING = 2, SVC_BASELINE = 3,
    SVC_SERVERCOMMAND = 4, SVC_DOWNLOAD = 5, SVC_SNAPSHOT = 6, SVC_EOF = 7, SVC_CONFIGCLIENT = 11;
  const SVC_NAMES = ['nop', 'gamestate', 'configstring', 'baseline', 'serverCommand', 'download',
    'snapshot', 'EOF', 'steamcommands', 'statscommands', 'configdata', 'configclient', 'acdata'];
  const PROTOCOL_STOCK = 1;
  const MAX_MSGLEN = 0x20000;
  // resync: message records of a valid chain, largest sequence step inside it
  const RESYNC_MESSAGES = 3, RESYNC_MAX_SEQ_STEP = 64;

  class DemoError extends Error {}

  /**
   * Parse a whole demo.
   * @param {Uint8Array} bytes
   * @param {object} visitor callbacks (see top of file)
   * @param {function} [onProgress] receives a fraction 0..1
   * @returns {object} summary: protocol, cleanEnd, truncated, stats, errors
   */
  function parseDemo(bytes, visitor, onProgress) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const size = bytes.length;
    if (size < 13) throw new DemoError('The file is too small to be a CoD4 demo.');
    if (bytes[0] !== REC_PROTOCOL && bytes[0] !== REC_MESSAGE) {
      throw new DemoError('This is not a CoD4 demo (.dm_1): unknown first record type ' + bytes[0] + '.');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stats = { records: 0, messages: 0, archives: 0, reliable: 0, snapshots: 0,
      snapshotsDropped: 0, snapshotsDroppedAfterDamage: 0, serverCommands: 0, serverCommandsRepeated: 0,
      gamestates: 0, configClients: 0, issues: 0, damagedParts: 0, bytesSkipped: 0 };
    const st = { protocol: PROTOCOL_STOCK, serverTime: 0, serverConfigSeq: null, commandSeq: null };
    let decoder = new DeltaDecoder(PROTOCOL_STOCK);
    let cleanEnd = false, truncated = false;
    const damaged = [];             // {offset, bytesSkipped} of damaged parts in the middle of the file
    // snapshots dropped since the last decoded one: a damage often starts inside the message before
    // the broken record - those drops are caused by the damage, too
    let droppedSinceDecoded = 0;
    let p = 0, first = true, nextProgress = 0;

    const issue = (offset, messageSeq, text) => {
      stats.issues++;
      if (visitor.onIssue) visitor.onIssue({ offset, messageSeq, text });
    };

    while (p < size) {
      const rec = bytes[p];
      const start = p;
      p++;
      stats.records++;
      let bad = null;               // why the record at start is invalid
      if (rec === REC_PROTOCOL) {
        if (p + 16 > size) { truncated = true; break; }
        const proto = dv.getUint32(p, true);
        p += 16;
        st.protocol = proto;
        if (first) decoder = new DeltaDecoder(proto);
        if (visitor.onProtocol) visitor.onProtocol({ offset: start, protocol: proto });
      } else if (rec === REC_ARCHIVE) {
        if (p + 52 > size) { truncated = true; break; }
        const f = i => dv.getFloat32(p + i, true);
        const fr = {
          index: dv.getInt32(p, true),
          origin: [f(4), f(8), f(12)],
          velocity: [f(16), f(20), f(24)],
          movementDir: dv.getInt32(p + 28, true),
          bobCycle: dv.getInt32(p + 32, true),
          serverTime: dv.getInt32(p + 36, true),
          angles: [f(40), f(44), f(48)]
        };
        p += 52;
        stats.archives++;
        decoder.addArchive(fr);
        if (visitor.onArchive) visitor.onArchive(fr);
      } else if (rec === REC_MESSAGE) {
        if (p + 8 > size) { truncated = true; break; }
        const seq = dv.getInt32(p, true), length = dv.getInt32(p + 4, true);
        p += 8;
        if (seq === -1 || length === -1) { cleanEnd = true; break; }
        if (length < 4 || length > MAX_MSGLEN) bad = 'message record with invalid length ' + length;
        else if (p + length > size) bad = 'message record length ' + length + ' exceeds the file';
        else {
          const bodyStart = p;
          p += length;
          stats.messages++;
          readMessage(start, seq, bodyStart, length);
        }
      } else if (rec === REC_RELIABLE) {
        if (p + 4 > size) { truncated = true; break; }
        const length = dv.getInt32(p, true);
        p += 4;
        if (length < 0 || p + length > size) bad = 'reliable message record with invalid length ' + length;
        else {
          p += length;
          stats.reliable++;
          issue(start, null, 'CoD4X reliable message record (' + length + ' bytes) kept undecoded.');
        }
      } else {
        bad = 'unknown record type ' + rec;
      }
      if (bad !== null) {
        const resume = resync(start + 1);
        if (resume < 0) {
          // nothing valid follows: the file ends with a cut off / broken record
          truncated = true;
          issue(start, null, 'The demo is truncated at byte ' + start + ': ' + bad + ', no valid record follows.');
          break;
        }
        damaged.push({ offset: start, bytesSkipped: resume - start });
        stats.snapshotsDroppedAfterDamage += droppedSinceDecoded;
        droppedSinceDecoded = 0;
        stats.damagedParts++;
        stats.bytesSkipped += resume - start;
        issue(start, null, 'Damaged data at byte ' + start + ' (' + bad + '): ' + (resume - start) + ' bytes skipped, reading resumed at byte ' + resume + '.');
        p = resume;
      }
      first = false;
      if (onProgress && p >= nextProgress) {
        onProgress(p / size);
        nextProgress = p + (size >> 6);
      }
    }
    if (onProgress) onProgress(1);
    return { protocol: st.protocol, cleanEnd, truncated, damaged, stats, errors: decoder.errorLog.slice() };

    /* First offset >= from where valid records follow again: a message record starting a chain of
     * RESYNC_MESSAGES message records (archive / reliable records in between) with plausible
     * lengths and rising sequence numbers, or followed by the end of the file / the end marker.
     * -1 if there is none. The sequence number is not compared with the message before the damage:
     * it starts again at a map change. */
    function resync(from) {
      for (let q = bytes.indexOf(REC_MESSAGE, from); q >= 0 && q <= size - 9; q = bytes.indexOf(REC_MESSAGE, q + 1)) {
        if (chainOk(q)) return q;
      }
      return -1;
    }
    function chainOk(q) {
      let messages = 0, prevSeq = null;
      while (messages < RESYNC_MESSAGES) {
        if (q === size) return messages > 0;
        const rec = bytes[q];
        if (rec === REC_MESSAGE) {
          if (q + 9 > size) return false;
          const seq = dv.getInt32(q + 1, true), length = dv.getInt32(q + 5, true);
          if (seq === -1 || length === -1) return messages > 0;
          if (seq < 0 || length < 4 || length > MAX_MSGLEN || q + 9 + length > size) return false;
          if (prevSeq !== null && !(seq - prevSeq > 0 && seq - prevSeq <= RESYNC_MAX_SEQ_STEP)) return false;
          prevSeq = seq;
          messages++;
          q += 9 + length;
        } else if (rec === REC_ARCHIVE && messages) {
          if (q + 53 > size) return false;
          q += 53;
        } else if (rec === REC_RELIABLE && messages) {
          if (q + 5 > size) return false;
          const length = dv.getInt32(q + 1, true);
          if (length < 0 || q + 5 + length > size) return false;
          q += 5 + length;
        } else return false;
      }
      return true;
    }

    /* ---- one server message ---- */
    function readMessage(offset, seq, start, length) {
      const buf = C4.huffman.decompress(bytes, start + 4, length - 4, MAX_MSGLEN);
      const m = new Msg(buf);
      const cmds = [], others = [];
      let snapshot = null;
      for (;;) {
        if (m.readcount >= m.cursize) break;
        const op = m.readByte();
        if (op === SVC_EOF) break;
        if (op === SVC_NOP) continue;
        if (op === SVC_SERVERCOMMAND) {
          const cseq = m.readLong();
          const text = m.readString();
          // Reliable commands are sent again (same sequence number) in the following messages until
          // the client has acknowledged them. Like the client (CL_ParseCommandString: only
          // seq > serverCommandSequence is executed) every command counts once.
          if (st.commandSeq != null && cseq <= st.commandSeq) { stats.serverCommandsRepeated++; continue; }
          st.commandSeq = cseq;
          stats.serverCommands++;
          cmds.push({ seq: cseq, text, serverTime: 0, messageSeq: seq, offset });
        } else if (op === SVC_GAMESTATE) {
          others.push({ kind: 'gamestate', value: readGamestate(m, offset, seq) });
          stats.gamestates++;
        } else if (op === SVC_CONFIGCLIENT) {
          const cfgSeq = m.readLong();
          const cn = m.readByte();
          const name = m.readString();
          const clantag = m.readString();
          stats.configClients++;
          if (cn < 64) others.push({ kind: 'configclient', value: { sequence: cfgSeq, client: cn, name, clantag, serverTime: 0 } });
        } else if (op === SVC_SNAPSHOT) {
          const snap = decoder.parseSnapshot(m, seq);
          if (!snap) {
            stats.snapshotsDropped++;
            if (damaged.length) stats.snapshotsDroppedAfterDamage++;
            else droppedSinceDecoded++;
            issue(offset, seq, decoder.errorLog[decoder.errorLog.length - 1] || 'snapshot dropped');
            break;
          }
          stats.snapshots++;
          droppedSinceDecoded = 0;
          st.serverTime = snap.serverTime;
          snapshot = snap;
        } else if (op === SVC_DOWNLOAD) {
          issue(offset, seq, 'svc_download in a demo message (not decoded)');
          break;
        } else {
          issue(offset, seq, 'Unexpected message operation ' + (SVC_NAMES[op] || op) + ' at byte ' + (m.readcount - 1));
          break;
        }
        if (m.overflowed) { issue(offset, seq, 'Message overflow while reading'); break; }
      }
      // commands of a message are applied before its snapshot: they get its time
      const t = snapshot ? snapshot.serverTime : st.serverTime;
      // a gamestate gets the time of the last snapshot before it (null for the first one): a demo can
      // contain several (map change / map restart), each with its own configstrings
      for (const o of others) if (o.kind === 'gamestate' && visitor.onGamestate) { o.value.serverTime = st.serverTime != null ? st.serverTime : null; visitor.onGamestate(o.value); }
      for (const c of cmds) { c.serverTime = t; if (visitor.onServerCommand) visitor.onServerCommand(c); }
      for (const o of others) {
        if (o.kind === 'configclient') { o.value.serverTime = t; if (visitor.onConfigClient) visitor.onConfigClient(o.value); }
      }
      if (snapshot && visitor.onSnapshot) visitor.onSnapshot(snapshot, decoder);
    }

    function readGamestate(m, offset, seq) {
      decoder.resetForGamestate();
      m.lastEntity = -1;
      const cmdSeq = m.readLong();
      // the gamestate sets the client's command sequence (commands up to it are already executed)
      st.commandSeq = cmdSeq;
      const configstrings = new Map();
      const clients = new Map();
      const cod4x = st.protocol !== PROTOCOL_STOCK;
      while (!m.overflowed) {
        const op = m.readByte();
        if (op === SVC_EOF) break;
        if (op === SVC_CONFIGSTRING) {
          if (cod4x) {
            const count = m.readLong();
            for (let i = 0; i < count && !m.overflowed; i++) {
              const idx = m.readLong();
              configstrings.set(idx, m.readString());
            }
          } else {
            const count = m.readShort();
            let idx = -1;
            for (let i = 0; i < count && !m.overflowed; i++) {
              idx = m.readBit() ? idx + 1 : m.readBits(12);
              configstrings.set(idx, m.readString());
            }
          }
          if (configstrings.has(12)) decoder.setMapCenter(configstrings.get(12));
        } else if (op === SVC_BASELINE) {
          decoder.readBaseline(m);
        } else if (op === SVC_CONFIGCLIENT && cod4x) {
          const cn = m.readByte();
          const name = m.readString();
          const clantag = m.readString();
          if (cn < 64) clients.set(cn, { name, clantag });
        } else {
          m.overflowed = true;
          break;
        }
      }
      const serverConfigSeq = cod4x ? m.readLong() : null;
      const clientNum = m.readLong();
      const checksumFeed = m.readLong();
      // A live CoD4X server appends one more long; demos do not (verified).
      return { offset, messageSeq: seq, serverCommandSeq: cmdSeq, configstrings,
        baselines: new Map(decoder.baselines), clients, serverConfigSeq, clientNum, checksumFeed };
    }
  }

  C4.demo = { parseDemo, DemoError, PROTOCOL_STOCK };
});
