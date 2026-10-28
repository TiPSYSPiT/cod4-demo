/* Delta decoding of CoD4 snapshots: player state, entities, client states.
 * Port of python/cod4demo/delta.py (engine: KisakCOD msg_mp.cpp / cl_parse_mp.cpp).
 * All values are kept as raw 32-bit patterns (unsigned numbers). */
C4.define('delta', function (C4) {
  'use strict';
  const T = C4.tables;
  const { u2f, f2u, f2i } = C4.msg;

  const ENTITY_WORDS = T.ENTITY_WORDS;                       // 61 incl. number
  const ENTITY_TABLES = T.ENTITY_TABLES.map(t => t.map(f => [f[4], f[1], f[2]]));
  const ENTITY_TABLE_LAST = ENTITY_TABLES.length - 1;        // 17 = event entities
  const compile = table => table.map((f, i) => [i, f[1], f[2]]);
  const PS_TABLE = compile(T.PLAYER_STATE_FIELDS);
  const CS_TABLE = compile(T.CLIENT_STATE_FIELDS);
  const HUD_TABLE = compile(T.HUD_ELEM_FIELDS);
  const OBJ_TABLE = compile(T.OBJECTIVE_FIELDS);
  const PS_FIELDS = PS_TABLE.length, CS_FIELDS = CS_TABLE.length;
  const HUD_FIELDS = HUD_TABLE.length, OBJ_FIELDS = OBJ_TABLE.length;
  const index = table => Object.fromEntries(table.map((f, i) => [f[0], i]));
  const PS_INDEX = index(T.PLAYER_STATE_FIELDS);
  const CS_INDEX = index(T.CLIENT_STATE_FIELDS);
  const HUD_INDEX = index(T.HUD_ELEM_FIELDS);
  const bitLength = n => 32 - Math.clz32(n);
  const LC_ENTITY_BITS = bitLength(61);
  const LC_PS_BITS = bitLength(PS_FIELDS);
  const LC_CS_BITS = bitLength(CS_FIELDS);

  const PS_COMMANDTIME = PS_INDEX['commandTime'];
  const PS_ORIGIN = [0, 1, 2].map(i => PS_INDEX['origin[' + i + ']']);
  const PS_VELOCITY = [0, 1, 2].map(i => PS_INDEX['velocity[' + i + ']']);
  const PS_VIEWANGLES = [0, 1, 2].map(i => PS_INDEX['viewangles[' + i + ']']);
  const PS_BOBCYCLE = PS_INDEX['bobCycle'];
  const PS_MOVEMENTDIR = PS_INDEX['movementDir'];

  const NULL_ENTITY = new Array(ENTITY_WORDS).fill(0);
  const NULL_CLIENT = new Array(CS_FIELDS).fill(0);
  const NULL_HUD = new Array(HUD_FIELDS).fill(0);
  const NULL_OBJECTIVE = new Array(OBJ_FIELDS + 1).fill(0);  // [state, fields...]

  const ENTITYNUM_NONE = 1023, ENTITYNUM_WORLD = 1022;
  const MAX_PARSE = 2048, PACKET_BACKUP = 32;

  class PlayerState {
    constructor() {
      this.fields = new Array(PS_FIELDS).fill(0);
      this.stats = [0, 0, 0, 0, 0];
      this.ammo = new Array(128).fill(0);
      this.ammoclip = new Array(128).fill(0);
      this.objectives = new Array(16).fill(NULL_OBJECTIVE);
      this.hudArchival = new Array(31).fill(NULL_HUD);
      this.hudCurrent = new Array(31).fill(NULL_HUD);
      this.weaponmodels = null;
      this.originFromArchive = false;
      this.archiveFound = false;
    }
    /** shallow copy; sub-arrays are replaced (never mutated) when they change */
    copy() {
      const ps = Object.create(PlayerState.prototype);
      ps.fields = this.fields.slice();
      ps.stats = this.stats;
      ps.ammo = this.ammo;
      ps.ammoclip = this.ammoclip;
      ps.objectives = this.objectives;
      ps.hudArchival = this.hudArchival;
      ps.hudCurrent = this.hudCurrent;
      ps.weaponmodels = this.weaponmodels;
      ps.originFromArchive = false;
      ps.archiveFound = false;
      return ps;
    }
  }

  function newSnapshot() {
    return {
      valid: false, messageNum: 0, deltaNum: -1, serverTime: 0, snapFlags: 0, ps: null,
      parseEntitiesNum: 0, numEntities: 0, parseClientsNum: 0, numClients: 0,
      changedEntities: [], removedEntities: [], changedClients: []
    };
  }

  class DeltaDecoder {
    constructor(protocol) {
      this.protocol = protocol;
      this.legacyOrigins = protocol <= 17;       // stock CoD4 and CoD4X <= 17
      this.mapCenter = [0, 0, 0];
      this.baselines = new Map();
      this.parseEntities = new Array(MAX_PARSE);
      this.parseClients = new Array(MAX_PARSE);
      this.parseEntitiesNum = 0;
      this.parseClientsNum = 0;
      this.snapshots = Array.from({ length: PACKET_BACKUP }, newSnapshot);
      this.snapMessageNum = 0;
      this.archive = new Array(256).fill(null);
      this.archiveLast = 0;
      this.nullPs = new PlayerState();
      this.errors = 0;
      this.errorLog = [];
    }

    resetForGamestate() {
      this.baselines.clear();
      this.parseEntitiesNum = 0;
      this.parseClientsNum = 0;
      this.snapshots = Array.from({ length: PACKET_BACKUP }, newSnapshot);
    }

    setMapCenter(text) {
      const p = String(text || '').trim().split(/\s+/).slice(0, 3).map(Number);
      if (p.length === 3 && p.every(Number.isFinite)) this.mapCenter = p;
    }

    addArchive(fr) {
      this.archive[fr.index & 255] = fr;
      this.archiveLast = fr.index & 255;
    }

    /* ---- one field (MSG_ReadDeltaField) ---- */
    readField(m, old, bits, hint, time) {
      if (hint !== 2 && !m.readBit()) return old;

      if (bits === 0) {                                   // float
        if (!m.readBit()) return (m.readBit() << 31) >>> 0;
        if (!m.readBit()) {
          const b = m.readBits(5);
          const v = ((32 * m.readByte() + b) ^ (f2i(old) + 4096)) - 4096;
          return f2u(v);
        }
        return (m.readInt() ^ old) >>> 0;
      }
      if (bits > -85) {                                   // integer, signed if < 0
        if (!m.readBit()) return 0;
        const n = bits < 0 ? -bits : bits;
        let bv = n & 7;
        let t = bv ? m.readBits(bv) : 0;
        while (bv < n) { t |= m.readByte() << bv; bv += 8; }
        const mask = n >= 32 ? 0xFFFFFFFF : 2 ** n - 1;
        t = ((t ^ (old & mask)) >>> 0);
        if (bits < 0 && ((t >>> (n - 1)) & 1)) t = (t | ~mask) >>> 0;
        return t;
      }
      switch (bits) {
        case -100:                                        // angle, zero bit
          return m.readBit() ? f2u(m.readAngle16()) : 0;
        case -99: {                                       // small float, 12 bit
          if (!m.readBit()) return 0;
          if (!m.readBit()) {
            const b = m.readBits(4);
            const v = ((16 * m.readByte() + b) ^ (f2i(old) + 2048)) - 2048;
            return f2u(v);
          }
          return (m.readInt() ^ old) >>> 0;
        }
        case -98:                                         // eFlags
          if (m.readBit()) return (m.readByte() | (m.readByte() << 8) | (m.readByte() << 16)) >>> 0;
          return (old ^ (1 << m.readBits(5))) >>> 0;
        case -97:                                         // time
          if (m.readBit()) return m.readInt();
          return (time - m.readBits(8)) >>> 0;
        case -96: {                                       // ground entity
          if (m.readBit()) return ENTITYNUM_WORLD;
          if (m.readBit()) return 0;
          const v = m.readBits(2);
          return (v | (m.readByte() << 2)) >>> 0;
        }
        case -95: return 100 * m.readBits(7);
        case -94: case -93: return m.readByte();
        case -92: case -91:                               // origin x / y
          if (!this.legacyOrigins) return m.readInt();
          return f2u(this.legacyOrigin(m, old, this.mapCenter[bits === -92 ? 0 : 1]));
        case -90:                                         // origin z
          if (!this.legacyOrigins) return m.readInt();
          return f2u(this.legacyOrigin(m, old, this.mapCenter[2]));
        case -89: {
          if (!m.readBit()) {
            const b = m.readBits(5);
            const v = ((32 * m.readByte() + b) ^ (f2i(old) + 4096)) - 4096;
            return f2u(v);
          }
          return (m.readInt() ^ old) >>> 0;
        }
        case -88: return (m.readInt() ^ old) >>> 0;      // full float, xor
        case -87: return f2u(m.readAngle16());
        case -86: return f2u(m.readBits(5) / 10 + 1.399999976158142);
        case -85: {                                       // RGBA colour
          if (m.readBit()) return ((old & 0x00FFFFFF) | ((old >>> 24) ? 0 : 0xFF000000)) >>> 0;
          let v = old;
          if (!m.readBit()) v = (m.readByte() | (m.readByte() << 8) | (m.readByte() << 16) | (v & 0xFF000000)) >>> 0;
          return ((v & 0x00FFFFFF) | (((8 * m.readBits(5)) & 0xFF) << 24)) >>> 0;
        }
        default:
          throw new Error('unknown field encoding ' + bits);
      }
    }

    /** positions of protocols <= 17: 16 bit around the map centre or 7-bit delta */
    legacyOrigin(m, old, center) {
      const oldv = f2i(old);
      if (m.readBit()) {
        const c = Math.trunc(center + 0.5);
        return c + (((oldv + 0x8000 - c) ^ m.readBits(16)) - 0x8000);
      }
      return (m.readBits(7) - 64) + u2f(old);
    }

    /* ---- entities ---- */
    readDeltaEntity(m, time, from, number) {
      if (m.readBit()) return null;                       // removed
      const to = from.slice();
      to[0] = number;
      if (!m.readBit()) return to;
      const lc = m.readBits(LC_ENTITY_BITS);
      const first = ENTITY_TABLES[0][0];                  // eType is always read
      to[first[0]] = this.readField(m, from[first[0]], first[1], first[2], time);
      const etype = to[1];
      const table = ENTITY_TABLES[etype < ENTITY_TABLE_LAST ? etype : ENTITY_TABLE_LAST];
      if (lc > table.length) { m.overflowed = true; return to; }
      for (let i = 1; i < lc; i++) {
        const f = table[i];
        to[f[0]] = this.readField(m, from[f[0]], f[1], f[2], time);
      }
      return to;
    }

    readBaseline(m) {
      const num = m.readEntityIndex(10);
      if (num < 0 || num >= 1024) { m.overflowed = true; return; }
      const st = this.readDeltaEntity(m, 0, NULL_ENTITY, num);
      if (st) this.baselines.set(num, st);
    }

    /* ---- client states ---- */
    readDeltaClient(m, time, from) {
      if (m.readBit()) return null;
      const to = from.slice();
      if (!m.readBit()) return to;
      const lc = m.readBits(LC_CS_BITS);
      if (lc > CS_FIELDS) { m.overflowed = true; return to; }
      for (let i = 0; i < lc; i++) {
        const f = CS_TABLE[i];
        to[f[0]] = this.readField(m, from[f[0]], f[1], f[2], time);
      }
      return to;
    }

    /* ---- player state ---- */
    readDeltaPlayerState(m, time, from) {
      const ps = from.copy();
      const to = ps.fields, old = from.fields;
      const readOriginAndVel = m.readBit() > 0;
      const lc = m.readBits(LC_PS_BITS);
      if (lc > PS_FIELDS) { m.overflowed = true; return ps; }
      for (let i = 0; i < lc; i++) {
        const f = PS_TABLE[i];
        // predicted fields are sent without xor when origin/velocity are sent
        to[f[0]] = this.readField(m, readOriginAndVel && f[2] === 3 ? 0 : old[f[0]], f[1], f[2], time);
      }
      if (!readOriginAndVel) {
        // not sent: the client takes them from its archive (CL_GetPredictedOriginForServerTime)
        ps.originFromArchive = true;
        const fr = this.archiveForTime(to[PS_COMMANDTIME] | 0);
        if (fr) {
          ps.archiveFound = true;
          for (let k = 0; k < 3; k++) {
            to[PS_ORIGIN[k]] = f2u(fr.origin[k]);
            to[PS_VELOCITY[k]] = f2u(fr.velocity[k]);
            to[PS_VIEWANGLES[k]] = f2u(fr.angles[k]);
          }
          to[PS_BOBCYCLE] = fr.bobCycle >>> 0;
          to[PS_MOVEMENTDIR] = fr.movementDir >>> 0;
        }
      }
      if (m.readBit()) {                                  // stats
        const s = ps.stats.slice();
        const sb = m.readBits(5);
        if (sb & 1) s[0] = m.readShort();
        if (sb & 2) s[1] = m.readShort();
        if (sb & 4) s[2] = m.readShort();
        if (sb & 8) s[3] = m.readBits(6);
        if (sb & 16) s[4] = m.readByte();
        ps.stats = s;
      }
      if (m.readBit()) {                                  // ammo
        let ammo = null;
        for (let j = 0; j < 4; j++) {
          if (m.readBit()) {
            const mask = m.readShort() & 0xFFFF;
            if (!ammo) ammo = ps.ammo.slice();
            for (let i = 0; i < 16; i++) if (mask & (1 << i)) ammo[16 * j + i] = m.readShort();
          }
        }
        if (ammo) ps.ammo = ammo;
      }
      let clip = null;                                    // ammo in clip
      for (let j = 0; j < 8; j++) {
        if (m.readBit()) {
          const mask = m.readShort() & 0xFFFF;
          if (!clip) clip = ps.ammoclip.slice();
          for (let i = 0; i < 16; i++) if (mask & (1 << i)) clip[16 * j + i] = m.readShort();
        }
      }
      if (clip) ps.ammoclip = clip;
      if (m.readBit()) {                                  // objectives
        const objs = [];
        for (let j = 0; j < 16; j++) {
          const prev = from.objectives[j];
          const cur = prev.slice();
          cur[0] = m.readBits(3);
          if (m.readBit()) {
            for (let i = 0; i < OBJ_FIELDS; i++) {
              const f = OBJ_TABLE[i];
              cur[f[0] + 1] = this.readField(m, prev[f[0] + 1], f[1], f[2], time);
            }
          }
          objs.push(cur);
        }
        ps.objectives = objs;
      }
      if (m.readBit()) {                                  // HUD elements
        ps.hudArchival = this.readHudElems(m, time, from.hudArchival);
        ps.hudCurrent = this.readHudElems(m, time, from.hudCurrent);
      }
      if (m.readBit()) {                                  // weapon models
        const wm = new Uint8Array(128);
        for (let i = 0; i < 128; i++) wm[i] = m.readByte();
        ps.weaponmodels = wm;
      }
      return ps;
    }

    readHudElems(m, time, from) {
      const inuse = m.readBits(5);
      const out = from.slice();
      for (let i = 0; i < inuse; i++) {
        const lc = m.readBits(6);
        if (lc >= HUD_FIELDS) { m.overflowed = true; return out; }
        const prev = from[i];
        const cur = prev.slice();
        for (let y = 0; y <= lc; y++) {
          const f = HUD_TABLE[y];
          cur[f[0]] = this.readField(m, prev[f[0]], f[1], f[2], time);
        }
        out[i] = cur;
      }
      const TYPE = HUD_INDEX['type'];
      for (let i = inuse; i < 31 && out[i][TYPE]; i++) out[i] = NULL_HUD;
      return out;
    }

    archiveForTime(time) {
      let idx = this.archiveLast;
      for (let k = 0; k < 256; k++) {
        const fr = this.archive[idx & 255];
        if (fr && fr.serverTime <= time) return fr;
        idx--;
      }
      return null;
    }

    /* ---- snapshot (CL_ParseSnapshot) ---- */
    parseSnapshot(m, messageNum) {
      const snap = newSnapshot();
      snap.messageNum = messageNum;
      snap.serverTime = m.readLong();
      const delta = m.readByte();
      snap.deltaNum = delta ? messageNum - delta : -1;
      snap.snapFlags = m.readByte();
      let old = null;
      if (snap.deltaNum >= 0) {
        const cand = this.snapshots[snap.deltaNum & (PACKET_BACKUP - 1)];
        if (!cand.valid || cand.messageNum !== snap.deltaNum ||
            this.parseEntitiesNum - cand.parseEntitiesNum > MAX_PARSE - 128 ||
            this.parseClientsNum - cand.parseClientsNum > MAX_PARSE - 128) {
          this.errors++;
          this.errorLog.push('snapshot ' + messageNum + ': delta from unavailable snapshot ' + snap.deltaNum);
          m.overflowed = true;
          return null;
        }
        old = cand;
      }
      snap.valid = true;
      snap.ps = this.readDeltaPlayerState(m, snap.serverTime, old && old.ps ? old.ps : this.nullPs);
      m.lastEntity = -1;
      this.parsePacketEntities(m, snap.serverTime, old, snap);
      m.lastEntity = -1;
      this.parsePacketClients(m, snap.serverTime, old, snap);
      if (m.overflowed) {
        this.errors++;
        this.errorLog.push('snapshot ' + messageNum + ': read past end of message');
        return null;
      }
      let oldNum = this.snapMessageNum + 1;
      if (snap.messageNum - oldNum >= PACKET_BACKUP) oldNum = snap.messageNum - (PACKET_BACKUP - 1);
      for (; oldNum < snap.messageNum; oldNum++) this.snapshots[oldNum & (PACKET_BACKUP - 1)].valid = false;
      this.snapMessageNum = snap.messageNum;
      this.snapshots[snap.messageNum & (PACKET_BACKUP - 1)] = snap;
      return snap;
    }

    parsePacketEntities(m, time, old, snap) {
      const pe = this.parseEntities, mask = MAX_PARSE - 1;
      snap.parseEntitiesNum = this.parseEntitiesNum;
      snap.numEntities = 0;
      let oldIndex = 0, oldState = null, oldNum = 99999;
      if (old && old.numEntities > 0) { oldState = pe[old.parseEntitiesNum & mask]; oldNum = oldState[0]; }
      const nextOld = () => {
        oldIndex++;
        if (oldIndex < old.numEntities) { oldState = pe[(old.parseEntitiesNum + oldIndex) & mask]; oldNum = oldState[0]; }
        else oldNum = 99999;
      };
      const keep = st => { pe[this.parseEntitiesNum++ & mask] = st; snap.numEntities++; };
      while (!m.overflowed) {
        const newNum = m.readEntityIndex(10);
        if (newNum === ENTITYNUM_NONE) break;
        if (m.readcount > m.cursize || newNum < 0 || newNum >= 1024) { m.overflowed = true; return; }
        while (oldNum < newNum) { keep(oldState); nextOld(); }
        let st;
        if (oldNum === newNum) { st = this.readDeltaEntity(m, time, oldState, newNum); nextOld(); }
        else st = this.readDeltaEntity(m, time, this.baselines.get(newNum) || NULL_ENTITY, newNum);
        if (st === null) snap.removedEntities.push(newNum);
        else { keep(st); snap.changedEntities.push(newNum); }
      }
      while (oldNum !== 99999 && !m.overflowed) { keep(oldState); nextOld(); }
    }

    parsePacketClients(m, time, old, snap) {
      const pc = this.parseClients, mask = MAX_PARSE - 1;
      snap.parseClientsNum = this.parseClientsNum;
      snap.numClients = 0;
      let oldIndex = 0, oldState = null, oldNum = 99999;
      if (old && old.numClients > 0) { oldState = pc[old.parseClientsNum & mask]; oldNum = oldState.num; }
      const nextOld = () => {
        oldIndex++;
        if (oldIndex < old.numClients) { oldState = pc[(old.parseClientsNum + oldIndex) & mask]; oldNum = oldState.num; }
        else oldNum = 99999;
      };
      const keep = e => { pc[this.parseClientsNum++ & mask] = e; snap.numClients++; };
      while (!m.overflowed && m.readBit()) {
        const newNum = m.readEntityIndex(6);
        if (m.readcount > m.cursize || newNum < 0 || newNum >= 64) { m.overflowed = true; return; }
        while (oldNum < newNum) { keep(oldState); nextOld(); }
        let st;
        if (oldNum === newNum) { st = this.readDeltaClient(m, time, oldState.state); nextOld(); }
        else st = this.readDeltaClient(m, time, NULL_CLIENT);
        if (st !== null) { keep({ num: newNum, state: st }); snap.changedClients.push(newNum); }
      }
      while (oldNum !== 99999 && !m.overflowed) { keep(oldState); nextOld(); }
    }

    /** all entities of a snapshot: array of raw states (state[0] = number) */
    entitiesOf(snap) {
      const out = new Array(snap.numEntities);
      for (let i = 0; i < snap.numEntities; i++) out[i] = this.parseEntities[(snap.parseEntitiesNum + i) & (MAX_PARSE - 1)];
      return out;
    }

    /** all client states of a snapshot: array of {num, state} */
    clientsOf(snap) {
      const out = new Array(snap.numClients);
      for (let i = 0; i < snap.numClients; i++) out[i] = this.parseClients[(snap.parseClientsNum + i) & (MAX_PARSE - 1)];
      return out;
    }
  }

  C4.delta = {
    DeltaDecoder, PlayerState, PS_INDEX, CS_INDEX, HUD_INDEX, ENTITY_WORDS,
    NULL_ENTITY, ENTITYNUM_NONE, ENTITYNUM_WORLD
  };
});
