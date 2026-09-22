/*!
 * dm1.js - parser for Call of Duty 4 demos (.dm_1), no dependencies.
 *
 * Container -> Huffman -> svc opcodes -> config strings, players, server
 * commands -> match analysis. Runs in the browser and in Node.
 *
 *   const demo  = DM1.parseDemo(new Uint8Array(buffer));
 *   const match = DM1.analyze(demo);
 *
 * With deep=true (the default) the snapshots are decoded as well (snapshot.js).
 * That is where the kill feed comes from: who killed whom with what.
 *
 * Format reference: https://github.com/Iswenzz/CoD4-DM1
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* ========================== Huffman ========================== */

/** Symbol frequencies from the CoD4 engine (msg_hData_COD4). */
const FREQ = [
  274054,68777,40460,40266,48059,39006,48630,27692,17712,15439,12386,10758,9420,9979,9346,15256,13184,
  14319,7750,7221,6095,5666,12606,7263,7322,5807,11628,6199,7826,6349,7698,9656,28968,5164,13629,6058,
  4745,4519,5199,4807,5323,3433,3455,3563,6979,5229,5002,4423,14108,13631,11908,11801,10261,7635,7215,
  7218,9353,6161,5689,4649,5026,5866,8002,10534,15381,8874,11798,7199,12814,6103,4982,5972,6779,4929,5333,
  3503,4345,6098,14117,16440,6446,3062,4695,3085,4198,4013,3878,3414,5514,4092,3261,4740,4544,3127,3385,
  7688,11126,6417,5297,4529,6333,4210,7056,4658,6190,3512,2843,3479,9369,5203,4980,5881,7509,4292,6097,
  5492,4648,2996,4988,4163,6534,4001,4342,4488,6039,4827,7112,8654,26712,8688,9677,9368,7209,3399,4473,
  4677,11087,4094,3404,4176,6733,3702,11420,4867,5968,3475,3722,3560,4571,2720,3189,3099,4595,4044,4402,
  3889,4989,3186,3153,5387,8020,3322,3775,2886,4191,2879,3110,2576,3693,2436,4935,3017,3538,5688,3444,
  3410,9170,4708,3425,3273,3684,4564,6957,4817,5224,3285,3143,4227,5630,6053,5851,6507,13692,8270,8260,
  5583,7568,4082,3984,4574,6440,3533,2992,2708,5190,3889,3799,4582,6020,3464,4431,3495,2906,2243,3856,
  3321,8759,3928,2905,3875,4382,3885,5869,6235,10685,4433,4639,4305,4683,2849,3379,4684,5477,4127,3853,
  3515,4913,3601,5237,6617,9019,4857,4112,5180,5998,4925,4986,6365,7930,5948,8085,7732,8643,8901,9653,
  32647
];

const NYT = 256, INTERNAL = 257;

/**
 * Build the static CoD4 Huffman tree.
 *
 * Just like the engine does it: each symbol is inserted through the adaptive
 * FGK algorithm as often as its frequency says, in ascending order of frequency
 * (Init_COD4). The shape of the tree depends on that order, so the procedure is
 * taken over step for step.
 */
function buildTree(){
  const N = 768;
  const L=new Int16Array(N).fill(-1), R=new Int16Array(N).fill(-1), P=new Int16Array(N).fill(-1),
        NX=new Int16Array(N).fill(-1), PV=new Int16Array(N).fill(-1), HD=new Int16Array(N).fill(-1),
        W=new Int32Array(N), SY=new Int16Array(N);
  const pp = new Int16Array(N).fill(-1);
  const free = [];
  let blocPtrs = 0, blocNode = 0, root = -1;
  const loc = new Int16Array(258).fill(-1);

  const newNode = () => blocNode++;
  const getpp = () => { if (free.length) return free.pop(); const i = blocPtrs++; pp[i] = -1; return i; };
  const freepp = i => { pp[i] = -1; free.push(i); };

  function swapNodes(a,b){
    const pa = P[a], pb = P[b];
    if (pa >= 0) { if (L[pa] === a) L[pa] = b; else R[pa] = b; } else root = b;
    if (pb >= 0) { if (L[pb] === b) L[pb] = a; else R[pb] = a; } else root = a;
    P[a] = pb; P[b] = pa;
  }
  function swapList(a,b){
    let t = NX[a]; NX[a] = NX[b]; NX[b] = t;
    t = PV[a]; PV[a] = PV[b]; PV[b] = t;
    if (NX[a] === a) NX[a] = b;
    if (NX[b] === b) NX[b] = a;
    if (NX[a] >= 0) PV[NX[a]] = a;
    if (NX[b] >= 0) PV[NX[b]] = b;
    if (PV[a] >= 0) NX[PV[a]] = a;
    if (PV[b] >= 0) NX[PV[b]] = b;
  }
  function increment(node){
    if (node < 0) return;
    if (NX[node] >= 0 && W[NX[node]] === W[node]) {
      const ln = pp[HD[node]];
      if (ln !== P[node]) swapNodes(ln, node);
      swapList(ln, node);
    }
    if (PV[node] >= 0 && W[PV[node]] === W[node]) pp[HD[node]] = PV[node];
    else { pp[HD[node]] = -1; freepp(HD[node]); }
    W[node]++;
    if (NX[node] >= 0 && W[NX[node]] === W[node]) HD[node] = HD[NX[node]];
    else { HD[node] = getpp(); pp[HD[node]] = node; }
    if (P[node] >= 0) {
      increment(P[node]);
      if (PV[node] === P[node]) {
        swapList(node, P[node]);
        if (pp[HD[node]] === node) pp[HD[node]] = P[node];
      }
    }
  }
  function addRef(ch){
    if (loc[ch] < 0) {
      const tn = newNode(), tn2 = newNode();
      SY[tn2] = INTERNAL; W[tn2] = 1; NX[tn2] = NX[lhead];
      if (NX[lhead] >= 0) {
        PV[NX[lhead]] = tn2;
        if (W[NX[lhead]] === 1) HD[tn2] = HD[NX[lhead]];
        else { HD[tn2] = getpp(); pp[HD[tn2]] = tn2; }
      } else { HD[tn2] = getpp(); pp[HD[tn2]] = tn2; }
      NX[lhead] = tn2; PV[tn2] = lhead;

      SY[tn] = ch; W[tn] = 1; NX[tn] = NX[lhead];
      if (NX[lhead] >= 0) {
        PV[NX[lhead]] = tn;
        if (W[NX[lhead]] === 1) HD[tn] = HD[NX[lhead]];
        else { HD[tn] = getpp(); pp[HD[tn]] = tn2; }   /* as in the original */
      } else { HD[tn] = getpp(); pp[HD[tn]] = tn; }
      NX[lhead] = tn; PV[tn] = lhead;
      L[tn] = R[tn] = -1;

      if (P[lhead] >= 0) { if (L[P[lhead]] === lhead) L[P[lhead]] = tn2; else R[P[lhead]] = tn2; }
      else root = tn2;
      R[tn2] = tn; L[tn2] = lhead;
      P[tn2] = P[lhead]; P[lhead] = tn2; P[tn] = tn2;
      loc[ch] = tn;
      increment(P[tn2]);
    } else increment(loc[ch]);
  }

  const lhead = newNode();
  root = lhead; SY[lhead] = NYT; W[lhead] = 0; loc[NYT] = lhead;

  const done = new Uint8Array(256);
  for (let k = 0; k < 256; k++) {
    let lowest = -1, best = -1;
    for (let i = 0; i < 256; i++) {
      if (done[i]) continue;
      if (best < 0 || FREQ[i] < best) { lowest = i; best = FREQ[i]; }
    }
    if (lowest < 0) break;
    for (let j = 0; j < FREQ[lowest]; j++) addRef(lowest);
    done[lowest] = 1;
  }
  return { L, R, SY, root, nodes: blocNode };
}

let TREE = null;
function tree(){ if (!TREE) TREE = buildTree(); return TREE; }

/** Decode the Huffman byte stream from `off` (bits LSB-first within each byte). */
function huffDecode(src, off, len, maxOut){
  const { L, R, SY, root } = tree();
  const bits = len * 8;
  const out = new Uint8Array(maxOut);
  let bloc = 0, n = 0;
  while (bloc < bits && n < maxOut) {
    let node = root;
    while (SY[node] === INTERNAL) {
      const bit = (src[off + (bloc >> 3)] >> (bloc & 7)) & 1;
      bloc++;
      node = bit ? R[node] : L[node];
      if (node < 0) return out.subarray(0, n);
    }
    out[n++] = SY[node] & 255;
  }
  return out.subarray(0, n);
}

/* ========================== message reader ========================== */

const SNAP = root.DM1_SNAPSHOT;
if (!SNAP) throw new Error("snapshot.js muss vor dm1.js geladen werden");
const { Msg, SnapshotReader } = SNAP;

/* Short names, to keep the parser code readable */
Msg.prototype.byte = function(){ const v = this.readByte(); return this.ovf ? -1 : v; };
Msg.prototype.int = function(){
  if (this.rc + 4 > this.cur) { this.ovf = true; return -1; }
  const b = this.b, i = this.rc;
  this.rc += 4;
  return (b[i] | (b[i+1] << 8) | (b[i+2] << 16) | (b[i+3] << 24)) | 0;
};
Msg.prototype.str = function(){ return this.readString(); };

/* ========================== Container ========================== */

const MSG = { snapshot: 0, frame: 1, protocol: 2, reliable: 3 };
const SVC = { nop:0, gamestate:1, configstring:2, baseline:3, serverCommand:4,
              download:5, snapshot:6, eof:7, configclient:11 };
const MAX_CONFIGSTRINGS = 2 * 2442;
/* MSG_FRAME arrives at client frame rate (around 125 Hz). For a map one point
   every 40 ms is enough - the same density the other players have. */
const VIEW_STEP_MS = 40;
/** Float from the file to int - NaN and infinity become 0. */
function fi(v){ return (v > -1e9 && v < 1e9) ? Math.trunc(v) : 0; }

/**
 * Walk the demo container and collect everything that comes before the
 * snapshots. `onProgress(fraction)` is called occasionally with 0..1.
 */
/**
 * The actual pass as a generator: yields progress (0..1) along the way so the
 * interface does not freeze for minutes.
 */
function* parseDemoSteps(bytes, deep){
  if (deep === undefined) deep = true;
  if (bytes.length < 17 || bytes[0] !== MSG.protocol)
    throw new Error("Kein CoD4-Demofile: erwartet wird ein MSG_PROTOCOL-Record (Byte 0 = 2).");

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.length;
  const out = {
    protocol: 0, snapshots: 0, frames: 0, gamestates: 0, cleanEof: false, truncated: false,
    commands: [], configstrings: new Map(), players: new Map(), povClient: null,
    firstTime: null, lastTime: null, sizeBytes: size,
    events: [], clientTeams: new Map(), baselines: 0, snapshotErrors: 0,
    viewSamples: [], viewFrames: []
  };
  let p = 0, ft = 0, snaps = null, lastView = -1e9;

  while (p < size) {
    const type = bytes[p++];
    if (type === MSG.protocol) {
      if (p + 16 > size) break;
      out.protocol = dv.getUint32(p, true);
      p += 16;
      if (deep) snaps = new SnapshotReader(out.protocol);
    } else if (type === MSG.frame) {
      if (p + 52 > size) break;
      if (deep) {
        // Frame layout: seq, origin[3], velocity[3], movementDir, bobCycle,
        // commandTime, angles[3] - 52 bytes in total.
        const ct = dv.getInt32(p + 36, true);
        const fx = fi(dv.getFloat32(p + 4, true)), fy = fi(dv.getFloat32(p + 8, true));
        if ((fx || fy) && ct - lastView >= VIEW_STEP_MS) {
          out.viewFrames.push([ct, fx, fy, fi(dv.getFloat32(p + 12, true)),
                               fi(dv.getFloat32(p + 44, true))]);
          lastView = ct;
        }
      }
      ft = dv.getInt32(p + 36, true);                 // commandTime
      if (out.firstTime === null || ft < out.firstTime) out.firstTime = ft;
      if (out.lastTime === null || ft > out.lastTime) out.lastTime = ft;
      p += 52;
      out.frames++;
    } else if (type === MSG.snapshot) {
      if (p + 4 <= size && dv.getInt32(p, true) === -1) { out.cleanEof = true; break; }
      if (p + 12 > size) break;
      const seq = dv.getInt32(p, true), msgSize = dv.getInt32(p + 4, true);
      p += 12;
      const len = msgSize - 4;
      if (len < 0 || p + len > size) { out.truncated = true; break; }
      const start = p;
      p += len;
      out.snapshots++;
      if (len > 0) {
        if (deep) {
          const buf = huffDecode(bytes, start, len, Math.min(len * 6 + 64, 1 << 21));
          readMessage(buf, seq, ft, out, snaps);
        } else {
          // Without snapshot decoding the first opcode byte is enough: if the
          // message holds no commands, the rest can be skipped.
          const head = huffDecode(bytes, start, len, 1);
          const op0 = head.length ? head[0] : SVC.eof;
          if (op0 !== SVC.snapshot && op0 !== SVC.eof) {
            const buf = huffDecode(bytes, start, len, Math.min(len * 6 + 64, 1 << 21));
            readMessage(buf, seq, ft, out, null);
          }
        }
      }
      if ((out.snapshots & 1023) === 0) yield p / size;
    } else if (type === MSG.reliable) {
      break;
    } else break;
  }
  if (out.firstTime === null) out.firstTime = out.lastTime = 0;
  if (snaps) {
    out.events = snaps.events;
    out.clientTeams = snaps.clientTeams;
    out.tracks = snaps.tracks;
    out.missiles = snaps.missiles;
    out.viewSamples = snaps.viewSamples;
    out.baselines = snaps.baselines.size;
    out.snapshotErrors = snaps.errors;
  }
  return out;
}

function readMessage(buf, seq, time, out, snaps){
  const r = new Msg(buf);
  for (;;) {
    if (r.rc >= buf.length) break;
    const cmd = r.byte();
    if (cmd === SVC.eof || cmd < 0) break;
    if (cmd === SVC.serverCommand) {
      const cseq = r.int(), text = r.str();
      out.commands.push({ seq, time, cseq, text });
      if (r.ovf) break;
    } else if (cmd === SVC.gamestate) {
      out.gamestates++;
      readGamestate(r, buf, out, snaps);
      if (!snaps) break;                              // without the baseline parser the message ends here
    } else if (cmd === SVC.configclient) {
      r.int();
      const cn = r.byte(), nm = r.str();
      r.str();
      if (cn >= 0 && cn < 64 && nm) out.players.set(cn, nm);
      if (r.ovf) break;
    } else if (cmd === SVC.snapshot) {
      if (!snaps) break;
      snaps.parseSnapshot(r, seq);
      if (r.ovf) break;
    } else if (cmd === SVC.nop) {
      continue;
    } else break;
  }
}

function readGamestate(r, buf, out, snaps){
  r.lastRef = -1;                                     // ClearLastReferencedEntity
  r.int();                                            // serverCommandSequence
  for (;;) {
    const c = r.byte();
    if (c === SVC.eof || c < 0) break;
    if (c === SVC.configstring) {
      const n = r.int();
      if (n < 0 || n > 2 * MAX_CONFIGSTRINGS) break;
      for (let i = 0; i < n; i++) {
        const idx = r.int(), s = r.str();
        if (idx >= 0 && idx < 2 * MAX_CONFIGSTRINGS && s) {
          out.configstrings.set(idx, s);
          if (idx === 12 && snaps) {
            // Map centre: older protocols encode origins against it
            const v = s.split(/\s+/).slice(0, 3).map(Number);
            if (v.length === 3 && v.every(Number.isFinite)) snaps.mapCenter = v;
          }
        }
        if (r.ovf) break;
      }
      if (r.ovf) break;
    } else if (c === SVC.configclient) {
      const cn = r.byte(), nm = r.str();
      r.str();
      if (cn >= 0 && cn < 64 && nm) out.players.set(cn, nm);
    } else if (c === SVC.baseline && snaps) {
      snaps.readBaseline(r);
      if (r.ovf) break;
    } else break;                                     // without the baseline parser: scan the rest
  }
  if (snaps && !r.ovf) {
    r.int();                                          // serverConfigSequence
    const pov = r.int();                              // clientNum of the recording player
    r.int();                                          // checksumFeed
    if (pov >= 0 && pov < 64) out.povClient = pov;
  }
  scanClients(buf, out);
}

/**
 * svc_configclient blocks sit behind the baselines - search the decoded buffer
 * for them. Right after the last block come svc_EOF, configSeq, clientNum (the
 * recording player) and checksumFeed.
 */
function scanClients(buf, out){
  const printable = c => c >= 0x20 && c <= 0x7e;
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== SVC.configclient) continue;
    const cn = buf[i + 1];
    if (cn > 0x3f) continue;
    let j = i + 2;
    const n0 = j;
    while (j < buf.length && printable(buf[j])) j++;
    if (j === n0 || j >= buf.length || buf[j] !== 0 || j - n0 > 40) continue;
    const name = latin1(buf, n0, j);
    j++;
    const t0 = j;
    while (j < buf.length && printable(buf[j])) j++;
    if (j >= buf.length || buf[j] !== 0 || j - t0 > 24) continue;
    j++;
    out.players.set(cn, name);
    if (buf[j] === SVC.eof && j + 13 <= buf.length) {
      out.povClient = buf[j+5] | buf[j+6] << 8 | buf[j+7] << 16 | buf[j+8] << 24;
    }
    i = j - 1;
  }
}

function latin1(buf, a, b){
  let s = "";
  for (let i = a; i < b; i++) s += String.fromCharCode(buf[i]);
  return s;
}

/* ========================== analysis ========================== */

/** Strip CoD4 colour codes and control characters (Promod prefixes 0x15, say). */
function strip(s){
  return String(s == null ? "" : s).replace(/\^[0-9:;<=>?]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
}

function parseInfoString(s){
  const o = {}, parts = String(s || "").split("\\");
  for (let i = 1; i + 1 < parts.length + 1; i += 2) if (parts[i] !== undefined) o[parts[i]] = parts[i + 1] || "";
  return o;
}

/** Obituary event type (eType - 17) from the snapshots. */
const OBITUARY_EVENT = 66;
/** Config string holding the server's weapon list (the index is 1-based). */
const CS_WEAPON_LIST = 2258;
/* Config string with the compass image and its four world coordinates:
   "compass_map_<map>" <x1> <y1> <x2> <y2> - that is what lets positions be
   projected onto the minimap. */
const CS_COMPASS = 823;
/* Gravity in units per second squared. Measured from the demos themselves:
   across 838 trajectory segments the median is 778, with 64 per cent inside
   800 +/- 5 per cent - the downward bias comes from bounces that interrupt
   free fall. */
const GRAVITY = 800.0;
/** How far an incomplete flight path is extrapolated at most. */
const MAX_FLIGHT_S = 4.0;
/** groundEntityNum of the world entity: the grenade is at rest. */
const GROUND_WORLD = 1022;

/** Weapon name from config string 2258 -> grenade type for the map view. */
const GRENADE_TYPES = {
  frag_grenade: "frag", frag_grenade_short: "frag",
  smoke_grenade: "smoke", flash_grenade: "flash"
};
/* From MOD_OFFSET on, eventParm holds 128 + means-of-death instead of the
   weapon. The server's weapon list has a good 40 entries, so there is no
   collision. */
const MOD_OFFSET = 128;
const MEANS_OF_DEATH = [
  "unknown", "pistol_bullet", "rifle_bullet", "grenade", "grenade_splash",
  "projectile", "projectile_splash", "melee", "headshot", "crush",
  "telefrag", "falling", "suicide", "trigger_hurt", "explosive"
];
const KILL_HEADSHOT = MOD_OFFSET + MEANS_OF_DEATH.indexOf("headshot");
/** Deaths with no attacker (falls, map hazards) are booked on the world entity. */
const ENTITYNUM_WORLD = 1022;

const WEAPON_LABELS = {
  ak47: "AK-47", ak74u: "AK-74u", m16: "M16", m4: "M4", m14: "M14", g3: "G3",
  g36c: "G36C", mp5: "MP5", mp44: "MP44", usp: "USP", uzi: "Mini-Uzi", p90: "P90",
  m1014: "M1014", m40a3: "M40A3", remington700: "Remington 700",
  winchester1200: "Winchester 1200", colt45: "Colt 1911", beretta: "Beretta",
  deserteagle: "Desert Eagle", deserteaglegold: "Desert Eagle (gold)",
  defaultweapon: "-", frag_grenade: "Frag Grenade",
  frag_grenade_short: "Frag Grenade (cooked)", smoke_grenade: "Smoke Grenade",
  flash_grenade: "Flashbang", destructible_car: "Destructible Car",
  briefcase_bomb: "Bomb", briefcase_bomb_defuse: "Bomb (defuse)",
  headshot: "Headshot", suicide: "Suicide / world", melee: "Knife",
  falling: "Fall damage", trigger_hurt: "Map hazard", crush: "Crushed",
  telefrag: "Telefrag", explosive: "Explosive", grenade: "Grenade",
  grenade_splash: "Grenade (splash)", projectile: "Projectile",
  projectile_splash: "Projectile (splash)", pistol_bullet: "Pistol",
  rifle_bullet: "Rifle", unknown: "Unknown"
};

/** Translate a weapon id into a name (list from config string 2258). */
function weaponName(id, weapons){
  if (id >= MOD_OFFSET) {
    const mod = id - MOD_OFFSET;
    if (mod < MEANS_OF_DEATH.length) return MEANS_OF_DEATH[mod];
  } else if (id > 0 && id <= weapons.length) {
    return weapons[id - 1];
  }
  return "weapon #" + id;
}

/** ak47_mp -> AK-47, frag_grenade_mp -> Frag Grenade. */
function prettyWeapon(name){
  let n = name.replace(/_mp$/, ""), suffix = "";
  for (const [tag, label] of [["_silencer", " (silenced)"], ["_reflex", " (reflex)"],
                              ["_acog", " (ACOG)"], ["_gold", " (gold)"], ["_scout", " (scout)"]]) {
    if (n.endsWith(tag)) { n = n.slice(0, -tag.length); suffix = label; break; }
  }
  const base = WEAPON_LABELS[n] || n.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return base + suffix;
}

/** MP_EXPLOSIVES_<X>_BY<player> -> readable label. */
const BOMB_ACTION = {
  PLANTED: "Bomb planted", DEFUSED: "Bomb defused",
  RECOVERED: "Bomb picked up", DROPPED: "Bomb dropped"
};

const RE = {
  scores:  /^b (\d+) (-?\d+) (-?\d+) (-?\d+) (.*)$/,
  g:       /^G (-?\d+)/,
  h:       /^H (-?\d+)/,
  timer:   /^d 11 (\d+)/,
  hudHead: /^d (380|381) (.+)$/,
  hudLine: /^d (385|387|388) (.+)$/,
  alive:   /self_alive "(\d+)" opposing_alive "(\d+)"/,
  msg:     /^f "(.+)"$/,
  chat:    /^([hi]) "(.+)"$/,
  // The config string index of the halftime sound depends on map and mod, so
  // the value is matched instead of a fixed index.
  halftime: /^d \d+ .*halftime/i,
  // The server reports joins and leaves in plain text.
  joined: /^f "MP_CONNECTED(.+)"$/,
  left: /^e "(.+?) EXE_LEFTGAME"$/,
  // Messages that add nothing to the event list: hit feedback and grenade
  // selection concern only the recording player; picking up and dropping the
  // bomb concern only the round itself (where they stay in the timeline).
  // The event list shows exactly the messages from buildEvents - everything
  // else (hit feedback, grenade selection, round status such as "Time
  // Elapsed") stays out.
  evJoinedTeam: /[ ]Joined[ ](?:Attack|Defence)$/i,
  evTimeout: /^Timeout called by[ ]/i,
  bombMsg: /^MP_EXPLOSIVES_([A-Z]+)_BY(.*)$/
};

const EV_HUD_KEEP = ["All Players are Ready!", "Attack eliminated", "Defence eliminated"];

/**
 * Event list for the display: a fixed allow list plus the kills from the feed.
 * Anything that cannot be matched here does not show up.
 */
function buildEvents(events, kills, names, rel){
  const out = [];
  const pname = cl => strip(names.get(cl) || ("client " + cl));
  for (const e of events) {
    const v = strip(e.v);
    let text;
    if (e.k === "half") text = "Halftime";
    else if (e.k === "join") text = v + " connected";
    else if (e.k === "left") text = v + " left the server";
    else if (e.k === "hud") {
      if (!EV_HUD_KEEP.includes(v)) continue;
      text = v;
    } else if (e.k === "msg") {
      const m = v.match(RE.bombMsg);
      if (m && (m[1] === "PLANTED" || m[1] === "DEFUSED")) text = BOMB_ACTION[m[1]] + ": " + m[2].trim();
      else if (RE.evJoinedTeam.test(v) || RE.evTimeout.test(v)) text = v;
      else continue;
    } else continue;
    out.push({ tS: rel(e.t), kind: e.k, text });
  }
  for (const k of kills) {
    if (k.suicide) continue;
    out.push({ tS: k.tS, kind: "kill", text: pname(k.killer) + " kills " + pname(k.victim) });
  }
  out.sort((a, b) => a.tS - b.tS);
  return out;
}

/** Condense the server commands into a match analysis. */
function analyze(d){
  const cmds = d.commands;
  let t0 = 0;
  for (const c of cmds) if (c.time > 0) { t0 = c.time; break; }
  // Seconds since the start of the demo, truncated to one decimal (not
  // rounded) so that an m:ss display never jumps a second too early.
  const rel = t => Math.trunc((t - t0) / 100) / 10;   // like Python's int(): towards zero

  // --- teams ---
  // What counts is the side assignment from the client states: it knows about
  // spectators too and works without clan tags. Team 1/2 are the playing sides
  // (they swap at halftime, so the first assignment is what counts), 0/3 are
  // free and spectator. Without snapshot data it falls back to clan tags.
  const names = new Map([...d.players.entries()].sort((a, b) => a[0] - b[0]));
  // The halftime marker arrives twice, so only the first one per swap counts.
  const swaps = [];
  for (const c of cmds)
    if (RE.halftime.test(c.text) && (!swaps.length || c.time - swaps[swaps.length - 1] > 2000))
      swaps.push(c.time);
  const sideOf = new Map();
  for (const [cl, teams] of (d.clientTeams || new Map())) {
    if (!names.has(cl)) continue;
    const playing = [...teams.entries()].filter(([t]) => t === 1 || t === 2)
      .map(([t, tm]) => [tm, t]).sort((a, b) => a[0] - b[0]);
    if (!playing.length) continue;
    let [tm, sd] = playing[0];
    if (swaps.filter(w => w < tm).length % 2) sd = 3 - sd;
    sideOf.set(cl, sd);
  }
  const sideGroups = new Map();
  for (const [cl, sd] of [...sideOf.entries()].sort((a, b) => a[0] - b[0])) {
    if (!sideGroups.has(sd)) sideGroups.set(sd, []);
    sideGroups.get(sd).push(cl);
  }
  const tagOf = cl => {
    const m = strip(names.get(cl)).trim().match(/^(\S+)\s+\S/);
    return m ? m[1] : "?";
  };
  /** Team name from the common prefix of the members' names. */
  const teamName = (clients, fallback) => {
    const parts = clients.map(c => strip(names.get(c)).trim());
    if (!parts.length) return fallback;
    let pref = parts[0];
    for (const q of parts.slice(1)) while (pref && !q.startsWith(pref)) pref = pref.slice(0, -1);
    pref = pref.replace(/^[ \-_|[\]]+|[ \-_|[\]]+$/g, "");
    return pref.length >= 2 ? pref : fallback;
  };

  const pov = (d.povClient !== null && names.has(d.povClient)) ? d.povClient
            : (names.keys().next().value ?? 0);
  let tagged = false, roster = new Map();
  if (sideGroups.size === 2 && [...sideGroups.values()].every(v => v.length >= 2)
      && sideOf.has(pov)) {
    const [a, b] = [...sideGroups.keys()].sort();
    roster = new Map([[teamName(sideGroups.get(a), "Team A"), sideGroups.get(a)],
                      [teamName(sideGroups.get(b), "Team B"), sideGroups.get(b)]]);
    if (roster.size === 2) tagged = true;
  }
  if (!tagged) {
    const groups = new Map();
    for (const cl of names.keys()) {
      const t = tagOf(cl);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(cl);
    }
    if (groups.size === 2 && [...groups.values()].every(v => v.length >= 2)) {
      roster = groups;
      tagged = true;
    }
  }
  let myTeam, other, rosterOf;
  if (tagged) {
    myTeam = [...roster.keys()].find(t => roster.get(t).includes(pov)) || [...roster.keys()][0];
    other = [...roster.keys()].find(t => t !== myTeam);
    rosterOf = t => roster.get(t) || [];
  } else {
    myTeam = "Team " + strip(names.get(pov) || pov);
    other = "Opponents";
    rosterOf = t => (t === myTeam ? [...names.keys()] : []);
  }
  const order = [myTeam, other];

  // --- kill feed from the snapshot obituaries ---
  const weapons = (d.configstrings.get(CS_WEAPON_LIST) || "").split(/\s+/).filter(Boolean);
  let kills = (d.events || []).filter(e => e.event === OBITUARY_EVENT).map(e => {
    const w = weaponName(e.eventParm, weapons);
    return { tS: rel(e.serverTime), killer: e.attacker, victim: e.other,
             weaponId: e.eventParm, weapon: w, weaponLabel: prettyWeapon(w),
             headshot: e.eventParm === KILL_HEADSHOT,
             // No attacker: either the player himself or the world entity.
             suicide: e.attacker === e.other || e.attacker >= ENTITYNUM_WORLD };
  });
  kills.sort((a, b) => a.tS - b.tS);
  // Temp entities can be re-transmitted across several snapshots. The same
  // pairing within the same second is always the same kill - in S&D a victim
  // cannot die twice within one round.
  // Compare backwards exactly to the edge of the time window - a fixed count
  // would be too tight: the demos hold up to seven kills in two seconds.
  const deduped = [];
  for (const k of kills) {
    let dup = false;
    for (let i = deduped.length - 1; i >= 0; i--) {
      const p = deduped[i];
      if (k.tS - p.tS > 2) break;
      if (p.killer === k.killer && p.victim === k.victim) { dup = true; break; }
    }
    if (dup) continue;
    deduped.push(k);
  }
  const duplicates = kills.length - deduped.length;
  kills = deduped;

  // --- timeline ---
  const sb = [], chat = [], events = [], rounds = [], hud = {};
  let sA = 0, sB = 0, half = 1, cur = null, aliveS = 5, aliveO = 5, knifeT = null;
  const joined = new Map(), left = new Map();
  const byName = new Map();
  for (const [cl, nm] of names) byName.set(strip(nm).trim(), cl);
  for (const c of cmds) {
    const x = c.text, tm = c.time;
    // Joins and leaves carry control characters in the text (CoD4 localisation
    // markers), so the match runs against the cleaned version.
    const xc = (x.indexOf("MP_CONNECTED") >= 0 || x.indexOf("EXE_LEFTGAME") >= 0)
      ? x.replace(/[\x00-\x1f\x7f]/g, "") : x;
    let m;
    if ((m = x.match(RE.scores))) {
      const n = +m[1], tk = m[5].trim().split(/\s+/).filter(Boolean);
      if (tk.length !== n * 7) continue;
      const st = new Map();
      for (let i = 0; i < n; i++) {
        const g = tk.slice(i * 7, i * 7 + 7).map(Number);
        st.set(g[0], { score: g[1], ping: g[2], deaths: g[3], kills: g[5], assists: g[6] });
      }
      sb.push({ t: tm, a: +m[2], b: +m[3], lim: +m[4], st });
    } else if ((m = x.match(RE.g))) {
      if (+m[1] !== sA) { events.push({ t: tm, k: "scoreA", from: sA, to: +m[1] }); sA = +m[1]; }
    } else if ((m = x.match(RE.h))) {
      if (+m[1] !== sB) { events.push({ t: tm, k: "scoreB", from: sB, to: +m[1] }); sB = +m[1]; }
    } else if ((m = x.match(RE.timer))) {
      // Config string 11 carries the round timer AND the bomb timer - the
      // second hit within a running round is the bomb.
      if (+m[1] > 0) { if (!cur) cur = { start: tm, half }; }
      else if (cur) { cur.end = tm; rounds.push(cur); cur = null; }
    } else if ((m = x.match(RE.hudHead))) {
      if (m[2].trim()) hud[m[1]] = m[2].trim();
    } else if ((m = x.match(RE.hudLine))) {
      const s = m[2].replace(/\s+$/, "");
      if (s) events.push({ t: tm, k: "hud", v: s });
      if (/Knife Round/.test(s)) knifeT = tm;
    } else if ((m = x.match(RE.alive))) {
      if (+m[1] !== aliveS || +m[2] !== aliveO) events.push({ t: tm, k: "alive", s: +m[1], o: +m[2] });
      aliveS = +m[1]; aliveO = +m[2];
    } else if ((m = xc.match(RE.joined))) {
      const cl = byName.get(strip(m[1]).trim());
      if (cl !== undefined && !joined.has(cl)) joined.set(cl, tm);
      events.push({ t: tm, k: "join", v: m[1] });
    } else if ((m = xc.match(RE.left))) {
      const cl = byName.get(strip(m[1]).trim());
      if (cl !== undefined) left.set(cl, tm);
      events.push({ t: tm, k: "left", v: m[1] });
    } else if ((m = x.match(RE.msg))) {
      events.push({ t: tm, k: "msg", v: m[1] });
    } else if ((m = x.match(RE.chat))) {
      chat.push({ tS: rel(tm), scope: m[1] === "i" ? "team" : "all", text: m[2] });
    } else if (RE.halftime.test(x)) {
      if (half === 1) events.push({ t: tm, k: "half" });
      half = 2;
    }
  }

  // --- rounds: winning side, alive count, bomb ---
  for (const r of rounds) {
    for (const e of events) {
      if (e.t < r.end - 1500 || e.t > r.end + 5000) continue;
      if (e.k === "scoreA" && e.to === e.from + 1) r.side = "A";
      if (e.k === "scoreB" && e.to === e.from + 1) r.side = "B";
    }
    let s = 5, o = 5;
    for (const e of events) {
      if (e.k !== "alive" || e.t < r.start) continue;
      if (e.t > r.end + 300) break;
      s = e.s; o = e.o;
    }
    r.as = s; r.ao = o;
    r.bombEvents = events.filter(e => e.k === "msg" && /EXPLOSIVES/.test(e.v)
      && e.t >= r.start - 3000 && e.t <= r.end + 2000);
    r.bomb = r.bombEvents.map(e => e.v);
    r.kills = kills.filter(k => t0 + k.tS * 1000 >= r.start && t0 + k.tS * 1000 <= r.end + 300);

    // Timeline of the round: when a team loses a player (from the alive
    // counters) plus the bomb messages. Who killed whom is not in here -
    // obituaries live in the delta entities.
    const tl = [];
    // Key order as in the Python version, so JSON exports stay diffable
    for (const k of r.kills) tl.push(Object.assign({ tS: k.tS, kind: "kill" }, k));
    let prevS = 5, prevO = 5;
    for (const e of (r.kills.length ? [] : events)) {
      if (e.k !== "alive") continue;
      if (e.t < r.start) { prevS = e.s; prevO = e.o; continue; }
      if (e.t > r.end + 300) break;
      const lostSelf = prevS - e.s, lostOther = prevO - e.o;
      if (lostSelf > 0) tl.push({ tS: rel(e.t), kind: "down", team: myTeam, side: "self",
                                  n: lostSelf, aliveSelf: e.s, aliveOther: e.o });
      if (lostOther > 0) tl.push({ tS: rel(e.t), kind: "down", team: other, side: "other",
                                   n: lostOther, aliveSelf: e.s, aliveOther: e.o });
      prevS = e.s; prevO = e.o;
    }
    for (const e of r.bombEvents) {
      const m = strip(e.v).match(RE.bombMsg);
      // Picking up and dropping the bomb stay out - only planting and
      // defusing decide the round.
      if (!m || (m[1] !== "PLANTED" && m[1] !== "DEFUSED")) continue;
      tl.push({ tS: rel(e.t), kind: "bomb", action: BOMB_ACTION[m[1]], player: m[2].trim() });
    }
    tl.sort((a, b) => a.tS - b.tS);
    const firstDown = tl.find(x => x.kind === "down" || x.kind === "kill");
    if (firstDown) firstDown.first = true;
    r.timeline = tl;
  }

  // Side -> team is tracked along and corrects itself: as soon as a round is
  // decided beyond doubt (one side completely dead), the winner is known
  // without needing the side assignment - and the assignment is reset from it.
  // After halftime the sides swap, which this notices by itself, without
  // relying on a config string.
  const sideMap = {};
  for (const r of rounds) {
    let decisive = null;
    if (r.ao === 0 && r.as > 0) decisive = myTeam;
    else if (r.as === 0 && r.ao > 0) decisive = other;
    if (decisive && r.side) {
      sideMap[r.side] = decisive;
      sideMap[r.side === "A" ? "B" : "A"] = decisive === myTeam ? other : myTeam;
    }
    r.winnerTeam = decisive || (r.side ? sideMap[r.side] : null) || "?";
  }

  const wins = {}; wins[myTeam] = 0; wins[other] = 0;
  const halves = {};
  const outRounds = rounds.map((r, i) => {
    const winner = r.winnerTeam;
    const bomb = r.bomb.join("; ");
    let reason;
    if (/DEFUSED/.test(bomb)) reason = "Bomb defused";
    else if (/PLANTED/.test(bomb)) reason = "Bomb exploded";
    else if (r.ao === 0 && r.as > 0) reason = other + " eliminated";
    else if (r.as === 0 && r.ao > 0) reason = myTeam + " eliminated";
    else reason = "Time expired";
    if (winner in wins) wins[winner]++;
    if (!halves[r.half]) halves[r.half] = {};
    halves[r.half][winner] = (halves[r.half][winner] || 0) + 1;
    return {
      n: i + 1, half: r.half, startS: rel(r.start),
      durS: Math.trunc((r.end - r.start) / 100) / 10,
      winner, reason, score: order.map(t => wins[t]).join(":"),
      exact: false, bomb: strip(bomb), timeline: r.timeline, kills: {}, deaths: {}
    };
  });

  // --- kills/deaths per round ---
  // Exact with the kill feed; without it only the scoreboard deltas remain,
  // and rounds without a scoreboard of their own stay approximate.
  if (kills.length) {
    outRounds.forEach((rd, i) => {
      rd.exact = true;
      for (const k of rounds[i].kills) {
        if (!k.suicide) rd.kills[k.killer] = (rd.kills[k.killer] || 0) + 1;
        rd.deaths[k.victim] = (rd.deaths[k.victim] || 0) + 1;
      }
    });
  }
  const prev = new Map();
  if (!kills.length) outRounds.forEach((rd, i) => {
    const nxt = i < rounds.length - 1 ? rounds[i + 1].start : Infinity;
    let best = null;
    for (const s of sb) if (s.t >= rounds[i].end - 1000 && s.t < nxt) best = s;
    if (!best) return;
    rd.exact = true;
    for (const [cl, st] of best.st) {
      const p = prev.get(cl) || { kills: 0, deaths: 0 };
      rd.kills[cl] = st.kills - p.kills;
      rd.deaths[cl] = st.deaths - p.deaths;
      prev.set(cl, { kills: st.kills, deaths: st.deaths });
    }
  });

  // --- players ---
  const fin = sb.length ? sb[sb.length - 1] : null;
  // The last scoreboard can be older than the last round - the server does not
  // necessarily send another one after the match ends. With a kill feed, kills
  // and deaths are therefore counted from it, by the same rule the scoreboard
  // uses: only within the rounds, and team kills do not count for the shooter.
  const teamOf = new Map();
  for (const t of order) for (const cl of rosterOf(t)) teamOf.set(cl, t);
  const feedKills = new Map(), feedDeaths = new Map();
  if (kills.length) {
    for (const r of rounds) for (const k of r.kills) {
      feedDeaths.set(k.victim, (feedDeaths.get(k.victim) || 0) + 1);
      if (!k.suicide && teamOf.get(k.killer) !== teamOf.get(k.victim))
        feedKills.set(k.killer, (feedKills.get(k.killer) || 0) + 1);
    }
  }
  const lastRoundEnd = rounds.length ? rounds[rounds.length - 1].end : 0;
  const stale = !!(fin && rounds.length && fin.t < lastRoundEnd);
  // Whoever left the server before the end is missing from the last
  // scoreboard - for them the last one they still appear in counts.
  const lastSt = new Map();
  for (const s2 of sb) for (const [cl, st] of s2.st) lastSt.set(cl, st);

  const players = [];
  for (const t of order) for (const cl of rosterOf(t)) {
    const st = lastSt.get(cl);
    players.push({
      client: cl, name: names.get(cl) || ("client " + cl), team: t,
      kills: kills.length ? (feedKills.get(cl) || 0) : (st ? st.kills : 0),
      deaths: kills.length ? (feedDeaths.get(cl) || 0) : (st ? st.deaths : 0),
      assists: st ? st.assists : 0, score: st ? st.score : 0,
      ping: st ? st.ping : 0, hasStats: !!st,
      joinedS: joined.has(cl) ? rel(joined.get(cl)) : null,
      leftS: left.has(cl) ? rel(left.get(cl)) : null
    });
  }
  players.sort((a, b) => order.indexOf(a.team) - order.indexOf(b.team) || b.kills - a.kills);

  const si = parseInfoString(d.configstrings.get(0));
  const duration = d.lastTime > d.firstTime ? (d.lastTime - d.firstTime) / 1000
                 : (cmds.length ? rel(cmds[cmds.length - 1].time) : 0);
  return {
    info: {
      server: strip(si.sv_hostname), map: si.mapname || "", gametype: si.g_gametype || "",
      mod: si.fs_game || "", ruleset: strip(hud["381"]), hud: strip(hud["380"]),
      mapStart: si.g_mapStartTime || "", version: si.version || "",
      factions: [d.configstrings.get(152) || "", d.configstrings.get(153) || ""],
      protocol: d.protocol, scorelimit: sb.length ? sb[0].lim : 0,
      povClient: pov, povName: names.get(pov) || "",
      durationS: Math.round(duration),
      snapshots: d.snapshots, frames: d.frames, commands: cmds.length,
      configstrings: d.configstrings.size, cleanEof: d.cleanEof, sizeBytes: d.sizeBytes,
      taggedTeams: tagged,
      killFeed: kills.length > 0,
      statsSource: kills.length ? "killfeed" : "scoreboard",
      scoreboardStale: stale,
      obituaries: kills.length,
      duplicateObituaries: duplicates
    },
    teams: order.map(t => ({
      name: t, wins: wins[t] || 0,
      halves: Object.keys(halves).sort().map(h => halves[h][t] || 0)
    })),
    players,
    rounds: outRounds,
    chat,
    kills,
    events: buildEvents(events, kills, names, rel),
    knifeS: knifeT === null ? null : rel(knifeT),
    map: buildMap(d, t0)
  };
}

/** Map view: projection and movement tracks per client.
 *
 * The tracks come from two sources - the delta entities of the other players
 * and the player state of the player being followed. Both can deliver the same
 * instant, so they are sorted by time and duplicate timestamps per client are
 * merged. */
/** Track of the player being followed.
 *
 * Prefers the MSG_FRAME records: they carry the position of the recording
 * player at client frame rate. The player state only delivers that same
 * position as an occasional server correction - across a match it changes
 * there only about a hundred times, so the track would be a series of jumps.
 * Which frame belongs to whom is told by the ClientNum of the player state
 * sample before it (after your own death that is the spectated team mate). */
function viewTrack(d){
  const samples = d.viewSamples || [];
  if (!d.viewFrames || !d.viewFrames.length || !samples.length) return samples;
  const out = [];
  let i = 0;
  for (const [t, x, y, z, yaw] of d.viewFrames) {
    while (i + 1 < samples.length && samples[i + 1][0] <= t) i++;
    out.push([t, samples[i][1], x, y, z, yaw, samples[i][6]]);
  }
  return out;
}

function buildMap(d, t0){
  const raw = d.configstrings.get(CS_COMPASS) || "";
  const parts = raw.replace(/"/g, " ").split(/\s+/).filter(Boolean);
  let bounds = [];
  if (parts.length >= 5) {
    const b = parts.slice(1, 5).map(Number);
    if (b.every(v => Number.isFinite(v))) bounds = b;
  }
  // The view of the recording player comes from the frames, not from the player
  // state - there it is only an occasional correction.
  const merged = new Map();
  for (const [c, v] of (d.tracks || new Map())) merged.set(c, v.slice());
  for (const [t, client, x, y, z, yaw, weapon] of viewTrack(d)) {
    let tr = merged.get(client);
    if (!tr) { tr = []; merged.set(client, tr); }
    tr.push([t, x, y, z, yaw, weapon]);
  }
  const tracks = {};
  for (const client of [...merged.keys()].sort((a, b) => a - b)) {
    if (!(client >= 0 && client < 64)) continue;
    const pts = merged.get(client).slice().sort((a, b) => a[0] - b[0]);
    const out = [];
    let lastT = null;
    for (const [t, x, y, z, yaw, weapon] of pts) {
      const ts = Math.trunc((t - t0) / 10);        // hundredths of a second since the start
      if (ts === lastT) continue;
      out.push([ts, x, y, z, yaw, weapon]);
      lastT = ts;
    }
    if (out.length > 1) tracks[String(client)] = out;
  }
  // Pass the weapon names along once, so the display can resolve the ids in
  // the tracks without knowing the config strings.
  const weapons = (d.configstrings.get(CS_WEAPON_LIST) || "").split(/\s+/).filter(Boolean)
    .map(w => prettyWeapon(w.replace(/_mp$/, "")));
  return { compass: parts[0] || "", bounds,
           center: d.configstrings.get(12) || "", tracks, weapons,
           grenades: buildGrenades(d, t0) };
}

/** Flight paths of the thrown grenades.
 *
 * What the demo holds is the flight up to ignition - the smoke cloud itself is
 * not transmitted, the client renders it from the event. */
/** Where and when the grenade lands.
 *
 * If the last transmitted state is already on the ground, that is the impact.
 * Otherwise the trajectory is extrapolated ballistically until it falls back to
 * throwing height. That is a prediction, not a measurement: it ignores walls.
 * Accuracy checked against frags over 393 throws - 172 units median, 386 units
 * at the 90th percentile, against 1967 units if one takes the throwing point. */
function impactOf(ordered, path){
  const last = ordered[ordered.length - 1], tail = path[path.length - 1];
  const at = [tail[1], tail[2], tail[3]];
  if (last.length < 9 || last[8] === GROUND_WORLD)
    return { impact: at, impactS: tail[0], predicted: false };
  const vx = last[4], vy = last[5], vz = last[6];
  if (!vx && !vy && !vz) return { impact: at, impactS: tail[0], predicted: false };
  const zRef = path[0][3];
  let x = last[1], y = last[2], z = last[3], t = 0;
  while (t < MAX_FLIGHT_S) {
    t += 0.02;
    x = last[1] + vx * t;
    y = last[2] + vy * t;
    z = last[3] + vz * t - 0.5 * GRAVITY * t * t;
    if (vz - GRAVITY * t < 0 && z <= zRef) break;
  }
  return { impact: [Math.trunc(x), Math.trunc(y), Math.trunc(z)],
           impactS: tail[0] + Math.trunc(t * 100), predicted: true };
}

function buildGrenades(d, t0){
  const weapons = (d.configstrings.get(CS_WEAPON_LIST) || "").split(/\s+/).filter(Boolean);
  const out = [];
  for (const [key, pts] of (d.missiles || new Map())) {
    const weaponId = Number(key.split(":")[0]);
    const full = (weaponId > 0 && weaponId <= weapons.length) ? weapons[weaponId - 1] : "";
    const base = full.replace(/_mp$/, "");
    const path = [];
    let lastT = null;
    const ordered = pts.slice().sort((a, b) => a[0] - b[0]);
    for (const rec of ordered) {
      const ts = Math.trunc((rec[0] - t0) / 10);
      if (ts === lastT) continue;
      path.push([ts, rec[1], rec[2], rec[3]]);
      lastT = ts;
    }
    if (!path.length) continue;
    const hit = impactOf(ordered, path);
    out.push({ kind: GRENADE_TYPES[base] || "other", weapon: prettyWeapon(base), path,
               impact: hit.impact, impactS: hit.impactS, predicted: hit.predicted });
  }
  out.sort((a, b) => a.path[0][0] - b.path[0][0]);
  return out;
}

/** Run through synchronously (Node, tests). */
function parseDemo(bytes, onProgress, deep){
  const gen = parseDemoSteps(bytes, deep);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (onProgress) onProgress(r.value);
  }
}

/** With breathing room for the browser - hands control back regularly. */
async function parseDemoAsync(bytes, onProgress){
  const gen = parseDemoSteps(bytes, true);
  let last = performance.now();
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (performance.now() - last > 60) {
      if (onProgress) onProgress(r.value);
      await new Promise(res => setTimeout(res, 0));
      last = performance.now();
    }
  }
}

const API = { parseDemo, parseDemoAsync, analyze, strip };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1 = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
