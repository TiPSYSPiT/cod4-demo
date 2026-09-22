/*!
 * snapshot.js - snapshot decoding for CoD4 demos: delta entities, player state,
 * client state. This is where the kill feed comes from (obituaries are event
 * entities inside the snapshots) along with the real team assignments.
 *
 * The bit stream is strictly sequential and delta coded: every field of every
 * entity of every snapshot has to be read, or everything after it shifts. The
 * code therefore follows the reference implementation line for line
 * (https://github.com/Iswenzz/CoD4-DM1, Demo.cpp / Msg.cpp) and is checked
 * against the Python version in source/py/snapshot.py.
 *
 * Values are kept as raw 32-bit patterns - exactly like the original, which
 * reinterprets between float and uint32.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const NF = root.DM1_NETFIELDS;
if (!NF) throw new Error("netfields.js muss vor snapshot.js geladen werden");

/* ---- float <-> uint32 ---- */
const _buf = new ArrayBuffer(4);
const _f32 = new Float32Array(_buf);
const _u32 = new Uint32Array(_buf);
const u2f = u => { _u32[0] = u >>> 0; return _f32[0]; };
const f2u = f => { _f32[0] = f; return _u32[0]; };
/** C semantics: (signed int)(*(float*)&u), truncated towards zero. */
function f2i(u){
  const f = u2f(u);
  if (!isFinite(f) || Math.abs(f) >= 2147483648) return 0;
  return Math.trunc(f);
}
/** GetMinBitCount: 32 - clz(x) */
const bitcount = x => (x <= 0 ? 0 : 32 - Math.clz32(x));

/* ---- field slots ---- */
function buildSlots(tables){
  const idx = new Map();
  for (const t of tables) for (const [name] of t) if (!idx.has(name)) idx.set(name, idx.size);
  return idx;
}
const ENT_IDX = buildSlots([...NF.LIST, NF.ENTITY_STATE_FIELDS]);
const ENT_SIZE = ENT_IDX.size;
const ENT_TABLES = NF.LIST.map(t => t.map(([n, b, h]) => [ENT_IDX.get(n), b, h]));
const ENT_MAX_TYPE = ENT_TABLES.length - 1;

const PS_IDX = buildSlots([NF.PLAYER_STATE_FIELDS]);
const PS_TABLE = NF.PLAYER_STATE_FIELDS.map(([n, b, h]) => [PS_IDX.get(n), b, h]);
const PS_SIZE = PS_IDX.size;
const PS_LC_BITS = bitcount(NF.PLAYER_STATE_FIELDS.length);

const CS_IDX = buildSlots([NF.CLIENT_STATE_FIELDS]);
const CS_TABLE = NF.CLIENT_STATE_FIELDS.map(([n, b, h]) => [CS_IDX.get(n), b, h]);
const CS_SIZE = CS_IDX.size;

const HUD_IDX = buildSlots([NF.HUD_ELEM_FIELDS]);
const HUD_TABLE = NF.HUD_ELEM_FIELDS.map(([n, b, h]) => [HUD_IDX.get(n), b, h]);
const HUD_SIZE = HUD_IDX.size;

const OBJ_IDX = buildSlots([NF.OBJECTIVE_FIELDS]);
const OBJ_TABLE = NF.OBJECTIVE_FIELDS.map(([n, b, h]) => [OBJ_IDX.get(n), b, h]);
const OBJ_SIZE = OBJ_IDX.size;

const ENT_LC_BITS = bitcount(0x3D);   // the game reads entities with 0x3D instead of 0x3B
const GENTITYNUM_BITS = 10;
const MAX_PARSE_ENTITIES = 2048;
const MAX_PARSE_CLIENTS = 2048;
const PACKET_BACKUP = 32;
const PACKET_MASK = PACKET_BACKUP - 1;
/** From this protocol on, CoD4X sends world coordinates as raw floats. */
const COD4X_FALLBACK_PROTOCOL = 17;

const E_ETYPE = ENT_IDX.get("eType");
const E_OTHER = ENT_IDX.get("otherEntityNum");
const E_ATTACKER = ENT_IDX.get("attackerEntityNum");
const E_WEAPON = ENT_IDX.get("weapon");
const E_EVENTPARM = ENT_IDX.get("eventParm");
const E_CLIENTNUM = ENT_IDX.get("ClientNum");
/** Position and facing of an entity (players carry them in lerp.pos/apos). */
const E_POS = [ENT_IDX.get("lerp.pos.trBase[0]"), ENT_IDX.get("lerp.pos.trBase[1]"),
               ENT_IDX.get("lerp.pos.trBase[2]")];
const E_YAW = ENT_IDX.get("lerp.apos.trBase[1]");
/** eType of a living player; corpses and objects have other values. */
const ET_PLAYER = 1;
/* Thrown grenades are missiles. launchTime identifies each throw uniquely -
   entity numbers get reused during a match, the throw time does not. */
const ET_MISSILE = 4;
const E_LAUNCHTIME = ENT_IDX.get("lerp.u.missile.launchTime");
/* Trajectory parameters: position and velocity apply from trTime on, the
   client extrapolates the flight path from them. groundEntityNum 1022 means
   the grenade is resting on the ground. */
const E_VEL = [ENT_IDX.get("lerp.pos.trDelta[0]"), ENT_IDX.get("lerp.pos.trDelta[1]"),
               ENT_IDX.get("lerp.pos.trDelta[2]")];
const E_TRTIME = ENT_IDX.get("lerp.pos.trTime");
const E_GROUND = ENT_IDX.get("groundEntityNum");
/** Entity numbers below this belong to a fixed client slot. */
const MAX_CLIENTS = 64;
/** The same values in the player state of the player being followed. */
const PS_POS = [PS_IDX.get("origin[0]"), PS_IDX.get("origin[1]"), PS_IDX.get("origin[2]")];
const PS_YAW = PS_IDX.get("viewangles[1]");
const PS_CLIENTNUM = PS_IDX.get("ClientNum");
const PS_WEAPON = PS_IDX.get("weapon");
const C_TEAM = CS_IDX.get("team");

/* ---- bit reader with CoD4 semantics ---- */

/**
 * CoD4 mixes byte-aligned reads (readCount) with bit reads (bit): a bit read
 * fetches the next byte through readCount when it crosses a byte boundary, a
 * byte read leaves the bit cursor untouched. This quirk has to be reproduced
 * exactly, otherwise the stream goes out of step.
 */
function Msg(buf){
  this.b = buf;
  this.cur = buf.length;
  this.rc = 0;
  this.bit = 0;
  this.ovf = false;
  this.lastRef = 0;
}
Msg.prototype.readBit = function(){
  const oldbit7 = this.bit & 7;
  if (!oldbit7) {
    if (this.rc >= this.cur) { this.ovf = true; return 0; }
    this.bit = 8 * this.rc;
    this.rc++;
  }
  const v = (this.b[this.bit >> 3] >> oldbit7) & 1;
  this.bit++;
  return v;
};
Msg.prototype.readBits = function(n){
  if (n <= 0) return 0;
  let ret = 0, i = 0;
  while (i < n) {
    if (!(this.bit & 7)) {
      if (this.rc >= this.cur) { this.ovf = true; return ret; }
      this.bit = 8 * this.rc;
      this.rc++;
    }
    const pos = this.bit & 7;
    const take = Math.min(8 - pos, n - i);
    const chunk = (this.b[this.bit >> 3] >> pos) & ((1 << take) - 1);
    ret |= chunk << i;
    this.bit += take;
    i += take;
  }
  return ret >>> 0;
};
Msg.prototype.readByte = function(){
  if (this.rc + 1 > this.cur) { this.ovf = true; return 0; }
  return this.b[this.rc++];
};
Msg.prototype.readShort = function(){
  if (this.rc + 2 > this.cur) { this.ovf = true; return 0; }
  const v = (this.b[this.rc] | (this.b[this.rc + 1] << 8)) << 16 >> 16;
  this.rc += 2;
  return v;
};
Msg.prototype.readInt = function(){
  if (this.rc + 4 > this.cur) { this.ovf = true; return 0; }
  const b = this.b, i = this.rc;
  this.rc += 4;
  return (b[i] | (b[i+1] << 8) | (b[i+2] << 16) | (b[i+3] << 24)) >>> 0;
};
Msg.prototype.readString = function(){
  let s = "";
  for (;;) {
    if (this.rc >= this.cur) { this.ovf = true; break; }
    const c = this.b[this.rc++];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};
Msg.prototype.readAngle16 = function(){ return this.readShort() * (360 / 65536); };
Msg.prototype.readEFlags = function(old){
  if (this.readBit() === 1) {
    let v = 0;
    for (const i of [0, 8, 16]) v |= this.readByte() << i;
    return v >>> 0;
  }
  return (old ^ (1 << this.readBits(5))) >>> 0;
};
Msg.prototype.discard = function(){ this.cur = this.rc; this.ovf = true; };

/* ---- snapshot reader ---- */

function SnapshotReader(protocol){
  this.protocol = protocol;
  /** Map centre from configstring 12 - only needed for protocol <= 17. */
  this.mapCenter = [0, 0, 0];
  this.baselines = new Map();
  this.snapshots = new Array(PACKET_BACKUP);
  for (let i = 0; i < PACKET_BACKUP; i++) this.snapshots[i] = { valid: false };
  this.parseEntities = new Array(MAX_PARSE_ENTITIES).fill(null);
  this.parseClients = new Array(MAX_PARSE_CLIENTS).fill(null);
  this.parseEntitiesNum = 0;
  this.parseClientsNum = 0;
  this.snapMessageNum = 0;
  this.nullEntity = new Array(ENT_SIZE).fill(0);
  this.nullClient = new Array(CS_SIZE).fill(0);
  this.nullPs = new Array(PS_SIZE).fill(0);
  this.events = [];
  this.clientTeams = new Map();
  // clientIndex -> [[serverTime, x, y, z, yaw, weaponId]] - movement tracks for
  // the map view. Rounded to whole units; a map does not need more. The weapon
  // is the one currently held, not the loadout.
  this.tracks = new Map();
  // "weaponId:launchTime" -> [[serverTime, x, y, z, vx, vy, vz, trTime, ground]]
  // Flight paths of the throws, with the trajectory parameters of the last state.
  this.missiles = new Map();
  // [[serverTime, clientIndex, x, y, z, yaw, weaponId]] - the player being
  // followed, from the player state. Deliberately kept apart from tracks: for
  // your own player the client predicts the movement and the server only
  // corrects it now and then, so the track would be a series of jumps. The
  // MSG_FRAME records carry it cleanly; ClientNum here says whose it is.
  this.viewSamples = [];
  this.errors = 0;
}

SnapshotReader.prototype.readDeltaField = function(m, frm, to, f, noXor, time){
  const slot = f[0], bits = f[1], hint = f[2];
  const fv = (noXor && hint === 3) ? 0 : frm[slot];

  if (hint !== 2 && !m.readBit()) { to[slot] = fv; return; }

  if (bits === 0) {
    if (!m.readBit()) { to[slot] = m.readBit() << 31; return; }
    if (!m.readBit()) {
      const b = m.readBits(5);
      const v = ((32 * m.readByte() + b) ^ (f2i(fv) + 4096)) - 4096;
      to[slot] = f2u(v);
      return;
    }
    to[slot] = (m.readInt() ^ fv) >>> 0;
    return;
  }
  switch (bits) {
    case -100: to[slot] = m.readBit() ? f2u(m.readAngle16()) : f2u(0); return;
    case -99: {
      if (m.readBit()) {
        if (!m.readBit()) {
          const b = m.readBits(4);
          const v = ((16 * m.readByte() + b) ^ (f2i(fv) + 2048)) - 2048;
          to[slot] = f2u(v);
          return;
        }
        to[slot] = (m.readInt() ^ fv) >>> 0;
        return;
      }
      to[slot] = 0;
      return;
    }
    case -98: to[slot] = m.readEFlags(fv); return;
    case -97: to[slot] = m.readBit() ? m.readInt() : ((time - m.readBits(8)) >>> 0); return;
    case -96: to[slot] = this.readDeltaGroundEntity(m); return;
    case -95: to[slot] = 100 * m.readBits(7); return;
    case -94: case -93: to[slot] = m.readByte(); return;
    case -92: case -91:
      to[slot] = f2u(this.readOriginFloat(m, bits, fv));
      return;
    case -90:
      to[slot] = f2u(this.readOriginFloat(m, -90, fv));
      return;
    case -89: {
      if (!m.readBit()) {
        const b = m.readBits(5);
        const v = ((32 * m.readByte() + b) ^ (f2i(fv) + 4096)) - 4096;
        to[slot] = f2u(v);
        return;
      }
      to[slot] = (m.readInt() ^ fv) >>> 0;
      return;
    }
    case -88: to[slot] = (m.readInt() ^ fv) >>> 0; return;
    case -87: to[slot] = f2u(m.readAngle16()); return;
    case -86: to[slot] = f2u(m.readBits(5) / 10 + 1.399999976158142); return;
    case -85: {
      if (m.readBit()) {
        to[slot] = ((fv & 0x00FFFFFF) | (((fv >>> 24) === 0 ? 0x00 : 0xFF) << 24)) >>> 0;
        return;
      }
      let v = fv;
      if (!m.readBit()) {
        v = ((v & 0xFF000000) | m.readByte() | (m.readByte() << 8) | (m.readByte() << 16)) >>> 0;
      }
      to[slot] = ((v & 0x00FFFFFF) | (((8 * m.readBits(5)) & 0xFF) << 24)) >>> 0;
      return;
    }
  }
  // integer fields
  if (!m.readBit()) { to[slot] = 0; return; }
  const nbits = bits < 0 ? -bits : bits;
  let bv = nbits & 7;
  let t = bv ? m.readBits(bv) : 0;
  for (; bv < nbits; bv += 8) t = (t | (m.readByte() << bv)) >>> 0;
  const mask = nbits === 32 ? 0xFFFFFFFF : ((1 << nbits) - 1) >>> 0;
  t = ((t ^ (fv & mask)) >>> 0);
  if (bits < 0 && ((t >>> (nbits - 1)) & 1)) t = (t | ~mask) >>> 0;
  to[slot] = t;
};

/**
 * Read a world coordinate. CoD4X (protocol > 17) sends raw 32-bit floats; older
 * protocols encode against the map centre (configstring 12) - that path is
 * taken from the reference but untested, for lack of such a demo.
 */
SnapshotReader.prototype.readOriginFloat = function(m, bits, fv){
  if (this.protocol > COD4X_FALLBACK_PROTOCOL) return u2f(m.readInt());
  const center = this.mapCenter[bits === -92 ? 0 : (bits === -90 ? 2 : 1)];
  const old = f2i(fv);
  if (m.readBit()) {
    const coord = Math.trunc(center + 0.5);
    return (((old - coord + 0x8000) ^ m.readBits(16)) >>> 0) + coord - 0x8000;
  }
  return m.readBits(7) - 64 + old;
};

SnapshotReader.prototype.readDeltaGroundEntity = function(m){
  if (m.readBit() === 1) return 1022;
  if (m.readBit() === 1) return 0;
  let value = m.readBits(2);
  for (let j = 2; j < 10; j += 8) value |= m.readByte() << j;
  return value;
};

SnapshotReader.prototype.readDeltaFields = function(m, frm, to, table, time, isEntity){
  if (!m.readBit()) return;                     // to is already a copy of frm
  const lc = isEntity ? m.readBits(ENT_LC_BITS) : m.readBits(bitcount(table.length));
  if (lc > table.length) { m.ovf = true; return; }
  if (lc <= 0) return;
  this.readDeltaField(m, frm, to, table[0], false, time);
  if (isEntity) {
    const et = to[E_ETYPE];
    table = ENT_TABLES[et < ENT_MAX_TYPE ? et : ENT_MAX_TYPE];
  }
  for (let i = 1; i < lc; i++) this.readDeltaField(m, frm, to, table[i], false, time);
};

SnapshotReader.prototype.readDeltaStruct = function(m, frm, table, time, isEntity){
  if (m.readBit() === 1) return null;           // deleted
  const to = frm.slice();
  this.readDeltaFields(m, frm, to, table, time, isEntity);
  return to;
};

SnapshotReader.prototype.readEntityIndex = function(m, indexBits){
  if (m.readBit()) m.lastRef++;
  else if (indexBits !== 10 || m.readBit()) m.lastRef = m.readBits(indexBits);
  else m.lastRef += m.readBits(4);
  return m.lastRef;
};

SnapshotReader.prototype.readBaseline = function(m){
  const num = this.readEntityIndex(m, GENTITYNUM_BITS);
  if (num >= 1024) { m.ovf = true; return -1; }
  const st = this.readDeltaStruct(m, this.nullEntity, ENT_TABLES[0], 0, true);
  if (st) this.baselines.set(num, st);
  return num;
};

SnapshotReader.prototype.parseSnapshot = function(m, msgSeq){
  const snap = { valid: false, messageNum: msgSeq, deltaNum: -1, serverTime: 0,
                 ps: null, parseEntitiesNum: 0, numEntities: 0,
                 parseClientsNum: 0, numClients: 0 };
  snap.serverTime = m.readInt();
  const deltaNum = m.readByte();
  snap.deltaNum = deltaNum ? msgSeq - deltaNum : -1;
  m.readByte();                                  // snapFlags

  let old = null;
  if (snap.deltaNum > 0) {
    const cand = this.snapshots[snap.deltaNum & PACKET_MASK];
    if (cand && cand.valid && cand.messageNum === snap.deltaNum
        && this.parseEntitiesNum - cand.parseEntitiesNum <= 1920
        && this.parseClientsNum - cand.parseClientsNum <= 1920) {
      old = cand;
    } else {
      m.discard();
      this.errors++;
      return;
    }
  }
  snap.valid = true;
  snap.ps = this.readDeltaPlayerState(m, snap.serverTime, (old && old.ps) || this.nullPs);
  m.lastRef = -1;                                // ClearLastReferencedEntity
  this.parsePacketEntities(m, snap.serverTime, old, snap, msgSeq);
  m.lastRef = -1;                                // ClearLastReferencedEntity
  this.parsePacketClients(m, snap.serverTime, old, snap);
  if (m.ovf) return;

  let oldMessageNum = this.snapMessageNum + 1;
  if (snap.messageNum - oldMessageNum >= PACKET_BACKUP)
    oldMessageNum = snap.messageNum - (PACKET_BACKUP - 1);
  while (oldMessageNum < snap.messageNum) {
    this.snapshots[oldMessageNum & PACKET_MASK].valid = false;
    oldMessageNum++;
  }
  this.snapMessageNum = snap.messageNum;
  this.snapshots[this.snapMessageNum & PACKET_MASK] = snap;
};

SnapshotReader.prototype.parsePacketEntities = function(m, time, old, to, msgSeq){
  to.parseEntitiesNum = this.parseEntitiesNum;
  to.numEntities = 0;
  let oldindex = 0, oldstate = null, oldnum = 99999;
  if (old && old.numEntities > 0) {
    oldstate = this.parseEntities[old.parseEntitiesNum & (MAX_PARSE_ENTITIES - 1)];
    oldnum = oldstate[0];
  }
  while (!m.ovf) {
    const newnum = this.readEntityIndex(m, GENTITYNUM_BITS);
    if (newnum === 1023) break;
    if (m.rc > m.cur || newnum >= 1024) { m.ovf = true; return; }

    while (oldnum < newnum && !m.ovf && oldstate) {
      this.parseEntities[this.parseEntitiesNum++ & (MAX_PARSE_ENTITIES - 1)] = oldstate;
      to.numEntities++;
      oldindex++;
      if (old && oldindex < old.numEntities) {
        oldstate = this.parseEntities[(oldindex + old.parseEntitiesNum) & (MAX_PARSE_ENTITIES - 1)];
        oldnum = oldstate[0];
      } else oldnum = 99999;
    }
    if (oldnum === newnum) {
      this.deltaEntity(m, time, to, newnum, oldstate[1], msgSeq);
      oldindex++;
      if (old && oldindex < old.numEntities) {
        oldstate = this.parseEntities[(oldindex + old.parseEntitiesNum) & (MAX_PARSE_ENTITIES - 1)];
        oldnum = oldstate[0];
      } else oldnum = 99999;
    } else {
      const base = this.baselines.get(newnum) || this.nullEntity;
      this.deltaEntity(m, time, to, newnum, base, msgSeq);
    }
  }
  while (oldnum !== 99999 && !m.ovf && oldstate) {
    this.parseEntities[this.parseEntitiesNum++ & (MAX_PARSE_ENTITIES - 1)] = oldstate;
    to.numEntities++;
    oldindex++;
    if (old && oldindex < old.numEntities) {
      oldstate = this.parseEntities[(oldindex + old.parseEntitiesNum) & (MAX_PARSE_ENTITIES - 1)];
      oldnum = oldstate[0];
    } else oldnum = 99999;
  }
};

SnapshotReader.prototype.deltaEntity = function(m, time, to, num, old, msgSeq){
  const st = this.readDeltaStruct(m, old, ENT_TABLES[0], time, true);
  if (!st) return;
  this.parseEntities[this.parseEntitiesNum++ & (MAX_PARSE_ENTITIES - 1)] = [num, st];
  to.numEntities++;
  const etype = st[E_ETYPE];
  if (etype >= ENT_MAX_TYPE) {
    this.events.push({
      serverTime: time, msgSeq, number: num, event: etype - ENT_MAX_TYPE,
      eventParm: st[E_EVENTPARM], other: st[E_OTHER], attacker: st[E_ATTACKER],
      weapon: st[E_WEAPON], client: st[E_CLIENTNUM]
    });
  } else if (etype === ET_MISSILE && st[E_LAUNCHTIME]) {
    // Without launchTime one throw could not be told from the next; such
    // entries are rare and are therefore left out.
    const key = st[E_WEAPON] + ":" + st[E_LAUNCHTIME];
    let ms = this.missiles.get(key);
    if (!ms) { ms = []; this.missiles.set(key, ms); }
    ms.push([time, u2f(st[E_POS[0]]) | 0, u2f(st[E_POS[1]]) | 0, u2f(st[E_POS[2]]) | 0,
             u2f(st[E_VEL[0]]) | 0, u2f(st[E_VEL[1]]) | 0, u2f(st[E_VEL[2]]) | 0,
             st[E_TRTIME], st[E_GROUND]]);
  } else if (etype === ET_PLAYER && num < MAX_CLIENTS) {
    // Entity numbers below MAX_CLIENTS belong to that client slot.
    let tr = this.tracks.get(num);
    if (!tr) { tr = []; this.tracks.set(num, tr); }
    tr.push([time, u2f(st[E_POS[0]]) | 0, u2f(st[E_POS[1]]) | 0,
             u2f(st[E_POS[2]]) | 0, u2f(st[E_YAW]) | 0, st[E_WEAPON]]);
  }
};

SnapshotReader.prototype.parsePacketClients = function(m, time, old, to){
  to.parseClientsNum = this.parseClientsNum;
  to.numClients = 0;
  let oldindex = 0, oldstate = null, oldnum = 99999;
  if (old && old.numClients > 0) {
    oldstate = this.parseClients[old.parseClientsNum & (MAX_PARSE_CLIENTS - 1)];
    oldnum = oldstate[0];
  }
  while (!m.ovf && m.readBit()) {
    const newnum = this.readEntityIndex(m, 6);
    if (m.rc > m.cur || newnum >= 64) { m.ovf = true; return; }
    while (oldnum < newnum) {
      this.deltaClient(m, time, to, oldnum, oldstate, true);
      oldindex++;
      if (old && oldindex < old.numClients) {
        oldstate = this.parseClients[(oldindex + old.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
        oldnum = oldstate[0];
      } else oldnum = 99999;
    }
    if (oldnum === newnum) {
      this.deltaClient(m, time, to, newnum, oldstate, false);
      oldindex++;
      if (old && oldindex < old.numClients) {
        oldstate = this.parseClients[(oldindex + old.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
        oldnum = oldstate[0];
      } else oldnum = 99999;
    } else {
      this.deltaClient(m, time, to, newnum, [newnum, this.nullClient], false);
    }
  }
  while (oldnum !== 99999 && !m.ovf && oldstate) {
    this.deltaClient(m, time, to, oldnum, oldstate, true);
    oldindex++;
    if (old && oldindex < old.numClients) {
      oldstate = this.parseClients[(oldindex + old.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
      oldnum = oldstate[0];
    } else oldnum = 99999;
  }
};

SnapshotReader.prototype.deltaClient = function(m, time, to, num, old, unchanged){
  let state;
  if (unchanged) {
    state = old ? old[1] : this.nullClient;
  } else {
    const base = old ? old[1] : this.nullClient;
    state = this.readDeltaStruct(m, base, CS_TABLE, time, false);
    if (!state) return;
    let teams = this.clientTeams.get(num);
    if (!teams) { teams = new Map(); this.clientTeams.set(num, teams); }
    const team = state[C_TEAM];
    if (!teams.has(team)) teams.set(team, time);
  }
  this.parseClients[this.parseClientsNum++ & (MAX_PARSE_CLIENTS - 1)] = [num, state];
  to.numClients++;
};

SnapshotReader.prototype.readDeltaPlayerState = function(m, time, frm){
  const to = frm.slice();
  const readOriginAndVel = m.readBit() > 0;
  const lc = m.readBits(PS_LC_BITS);
  if (lc > PS_TABLE.length) { m.ovf = true; return to; }
  for (let i = 0; i < lc; i++) {
    const f = PS_TABLE[i];
    this.readDeltaField(m, frm, to, f, readOriginAndVel && f[2] === 3, time);
  }
  if (m.readBit()) {                              // stats
    const sb = m.readBits(5);
    if (sb & 1) m.readShort();
    if (sb & 2) m.readShort();
    if (sb & 4) m.readShort();
    if (sb & 8) m.readBits(6);
    if (sb & 16) m.readByte();
  }
  if (m.readBit()) {                              // ammo
    for (let j = 0; j < 4; j++) {
      if (m.readBit()) {
        const bits = m.readShort() & 0xFFFF;
        for (let i = 0; i < 16; i++) if (bits & (1 << i)) m.readShort();
      }
    }
  }
  for (let j = 0; j < 8; j++) {                   // ammo in clip
    if (m.readBit()) {
      const bits = m.readShort() & 0xFFFF;
      for (let i = 0; i < 16; i++) if (bits & (1 << i)) m.readShort();
    }
  }
  if (m.readBit()) {                              // objectives
    for (let i = 0; i < 16; i++) {
      m.readBits(3);
      this.readDeltaObjective(m, time);
    }
  }
  if (m.readBit()) {                              // hud elems
    this.readDeltaHudElems(m, time);
    this.readDeltaHudElems(m, time);
  }
  if (m.readBit()) {                              // weapon models
    for (let i = 0; i < 128; i++) m.readByte();
  }
  // The player being followed does not appear as an entity - his position is
  // only here. ClientNum says whose it is (after your own death that is the
  // team mate currently being spectated).
  const px = u2f(to[PS_POS[0]]) | 0, py = u2f(to[PS_POS[1]]) | 0;
  if (px || py) {
    this.viewSamples.push([time, to[PS_CLIENTNUM], px, py,
                           u2f(to[PS_POS[2]]) | 0, u2f(to[PS_YAW]) | 0, to[PS_WEAPON]]);
  }
  return to;
};

SnapshotReader.prototype.readDeltaObjective = function(m, time){
  if (!m.readBit()) return;
  const frm = new Array(OBJ_SIZE).fill(0), to = new Array(OBJ_SIZE).fill(0);
  for (const f of OBJ_TABLE) this.readDeltaField(m, frm, to, f, false, time);
};

SnapshotReader.prototype.readDeltaHudElems = function(m, time){
  const inuse = m.readBits(5);
  for (let i = 0; i < inuse; i++) {
    const lc = m.readBits(6);
    if (lc >= HUD_TABLE.length) { m.ovf = true; return; }
    const frm = new Array(HUD_SIZE).fill(0), to = new Array(HUD_SIZE).fill(0);
    for (let y = 0; y <= lc; y++) this.readDeltaField(m, frm, to, HUD_TABLE[y], false, time);
  }
};

root.DM1_SNAPSHOT = { Msg, SnapshotReader, u2f, f2u, ENT_IDX, ENT_MAX_TYPE, GENTITYNUM_BITS };

})(typeof globalThis !== "undefined" ? globalThis : this);
