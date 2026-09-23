/* One pass over the demo: collects the raw facts the analysis needs.
 * Times are absolute server times here; build.js converts them to "ms since
 * the first snapshot". */
C4.define('collect', function (C4) {
  'use strict';
  const { u2f } = C4.msg;
  const { PS_INDEX, CS_INDEX } = C4.delta;
  const K = C4.constants;
  const { decode, BigConfigString } = C4.servercmd;

  // entityState word offsets (see python/cod4demo/states.py)
  const E_TYPE = 1, E_EFLAGS = 2, E_POS_TRTYPE = 3, E_POS_TRTIME = 4, E_POS = 6, E_VEL = 9,
    E_APOS = 15, E_U0 = 21, E_OTHER = 29, E_ATTACKER = 30, E_CLIENTNUM = 35, E_EVENTPARM = 39,
    E_EVENTSEQ = 40, E_EVENTS = 41, E_EVENTPARMS = 45, E_WEAPON = 49;
  const EXPLOSIONS = new Set([K.EV.GRENADE_EXPLODE, K.EV.FLASHBANG_EXPLODE, K.EV.CUSTOM_EXPLODE,
    K.EV.CUSTOM_EXPLODE_NOMARKS, K.EV.ROCKET_EXPLODE, K.EV.ROCKET_EXPLODE_NOMARKS]);
  const PSI = {
    client: PS_INDEX['ClientNum'], pmType: PS_INDEX['pm_type'], eFlags: PS_INDEX['eFlags'],
    weapon: PS_INDEX['weapon'], ox: PS_INDEX['origin[0]'], oy: PS_INDEX['origin[1]'],
    oz: PS_INDEX['origin[2]'], pitch: PS_INDEX['viewangles[0]'], yaw: PS_INDEX['viewangles[1]']
  };
  const CSI_TEAM = CS_INDEX['team'];
  const R = v => Math.round(v * 10) / 10;

  /* position flags */
  const PF = { TRANSMITTED: 1, CROUCH: 2, PRONE: 4, FIRING: 8, DEAD: 16, FROM_PS: 32 };

  class PosTrack {
    constructor() { this.t = []; this.x = []; this.y = []; this.z = []; this.yaw = []; this.pitch = []; this.flags = []; this.weapon = []; }
    push(t, x, y, z, yaw, pitch, flags, weapon) {
      this.t.push(t); this.x.push(x); this.y.push(y); this.z.push(z);
      this.yaw.push(yaw); this.pitch.push(pitch); this.flags.push(flags); this.weapon.push(weapon);
    }
  }

  function createCollector() {
    const c = {
      protocol: 1,
      gamestate: null,
      cs: new Map(),                // current config strings
      csInitial: null,
      csChanges: [],                // {t, index, old, value}
      commands: [],                 // {t, seq, text, d}
      names: new Map(),             // client -> {name, clantag}
      nameHistory: [],              // {t, client, name, clantag, source}
      teamTimeline: [],             // {t, client, team}
      slotEvents: [],               // {t, client, kind: 'connected'|'disconnected'}
      kills: [],
      tracks: new Map(),            // client -> PosTrack
      grenades: new Map(),          // key -> grenade
      grenadeOrder: [],
      detonations: [],              // unmatched detonations
      scoreboards: [],              // {t, axis, allies, limit, entries}
      issues: [],
      firstTime: null, lastTime: null,
      snapshots: 0,
      povTimeline: [],              // {t, client} changes of the followed client
      firstArchive: null
    };
    const bigCs = new BigConfigString();
    let prevEntities = new Map();
    const ringSeq = new Map();
    const missileKey = new Map();
    const lastClientState = new Map();
    const lastWeapon = new Map();   // client -> [t, weapon]
    const lastPos = new Map();      // client -> [t, x, y, z]
    let lastPsClient = -1;

    const track = cl => { let t = c.tracks.get(cl); if (!t) c.tracks.set(cl, t = new PosTrack()); return t; };

    function setName(client, name, clantag, t, source) {
      const prev = c.names.get(client);
      if (prev && prev.name === name && (clantag == null || prev.clantag === clantag)) return;
      c.names.set(client, { name, clantag: clantag != null ? clantag : (prev ? prev.clantag : '') });
      c.nameHistory.push({ t, client, name, clantag, source });
    }

    function csUpdate(t, index, value) {
      if (index == null) return;
      const old = c.cs.has(index) ? c.cs.get(index) : null;
      c.cs.set(index, value);
      c.csChanges.push({ t, index, old, value });
    }

    const visitor = {
      onProtocol(p) { c.protocol = p.protocol; },
      onArchive(fr) { if (c.firstArchive === null) c.firstArchive = fr.serverTime; },
      onGamestate(gs) {
        if (!c.gamestate) c.gamestate = gs;
        for (const [k, v] of gs.configstrings) c.cs.set(k, v);
        if (!c.csInitial) c.csInitial = new Map(gs.configstrings);
        for (const [cl, v] of gs.clients) setName(cl, v.name, v.clantag, null, 'gamestate');
        prevEntities = new Map();
        ringSeq.clear();
        missileKey.clear();
      },
      onConfigClient(cc) { setName(cc.client, cc.name, cc.clantag, cc.serverTime, 'configclient'); },
      onServerCommand(cmd) {
        const d = decode(cmd.text);
        c.commands.push({ t: cmd.serverTime, seq: cmd.seq, text: cmd.text, d });
        if (d.verb === 'd') csUpdate(cmd.serverTime, d.index, d.value);
        else if (d.verb === 'x' || d.verb === 'y' || d.verb === 'z') {
          const done = bigCs.feed(d);
          if (done) csUpdate(cmd.serverTime, done[0], done[1]);
        } else if (d.verb === 'b') {
          c.scoreboards.push({ t: cmd.serverTime, axis: d.scoreAxis, allies: d.scoreAllies, limit: d.scorelimit, entries: d.entries });
        }
      },
      onIssue(i) { c.issues.push(i); },
      onSnapshot(snap, decoder) {
        const t = snap.serverTime;
        if (c.firstTime === null) c.firstTime = t;
        c.lastTime = t;
        c.snapshots++;
        // commands of the gamestate message carry time 0: move them to the first snapshot
        doClients(snap, decoder, t);
        doPlayerState(snap, t);
        doEntities(snap, decoder, t);
      }
    };

    function doClients(snap, decoder, t) {
      const present = new Set();
      for (const { num, state } of decoder.clientsOf(snap)) {
        present.add(num);
        const prev = lastClientState.get(num);
        if (prev === state) continue;
        const team = state[CSI_TEAM];
        if (!prev) {
          c.slotEvents.push({ t, client: num, kind: 'connected' });
          c.teamTimeline.push({ t, client: num, team });
        } else if (prev[CSI_TEAM] !== team) {
          c.teamTimeline.push({ t, client: num, team });
        }
        lastClientState.set(num, state);
        // stock servers: the name is only in the client state (16 bytes)
        if (c.protocol === 1) {
          const bytes = [];
          for (const i of [0, 4, 8, 12]) {
            const w = state[CS_INDEX['netname[' + i + ']']];
            for (let b = 0; b < 4; b++) bytes.push((w >>> (8 * b)) & 255);
          }
          let s = '';
          for (const ch of bytes) { if (!ch) break; s += String.fromCharCode(ch); }
          if (s) setName(num, s, null, t, 'client_state');
        }
      }
      for (const num of Array.from(lastClientState.keys())) {
        if (!present.has(num)) {
          lastClientState.delete(num);
          c.slotEvents.push({ t, client: num, kind: 'disconnected' });
          c.teamTimeline.push({ t, client: num, team: -1 });
        }
      }
    }

    function doPlayerState(snap, t) {
      const f = snap.ps.fields;
      const client = f[PSI.client];
      if (client !== lastPsClient) { c.povTimeline.push({ t, client }); lastPsClient = client; }
      const pm = f[PSI.pmType];
      if (client >= 64 || pm === 4 || pm === 5) return;       // spectator / intermission
      if (snap.ps.originFromArchive && !snap.ps.archiveFound) return;
      const x = u2f(f[PSI.ox]), y = u2f(f[PSI.oy]), z = u2f(f[PSI.oz]);
      if (!x && !y) return;
      const ef = f[PSI.eFlags];
      let flags = PF.TRANSMITTED | PF.FROM_PS;
      if (ef & K.EF.CROUCH) flags |= PF.CROUCH;
      if (ef & K.EF.PRONE) flags |= PF.PRONE;
      if (ef & K.EF.FIRING) flags |= PF.FIRING;
      if ((ef & K.EF.DEAD) || pm === 7 || pm === 8) flags |= PF.DEAD;
      const w = f[PSI.weapon];
      track(client).push(t, R(x), R(y), R(z), R(u2f(f[PSI.yaw])), R(u2f(f[PSI.pitch])), flags, w);
      lastWeapon.set(client, [t, w]);
      lastPos.set(client, [t, x, y, z]);
    }

    function doEntities(snap, decoder, t) {
      const changed = new Set(snap.changedEntities);
      const cur = new Map();
      for (const st of decoder.entitiesOf(snap)) {
        const num = st[0];
        cur.set(num, st);
        const etype = st[E_TYPE];
        const prev = prevEntities.get(num);
        if (etype >= K.ET.EVENTS) {
          // temporary event entity: played once when it appears (or is reused)
          if (!prev || prev[E_TYPE] !== etype || !sameState(prev, st)) onEventEntity(t, num, st, etype - K.ET.EVENTS);
          continue;
        }
        // event ring of normal entities (CG_CheckEvents arithmetic)
        const evseq = st[E_EVENTSEQ];
        if (!prev || prev[E_TYPE] >= K.ET.EVENTS) {
          let init = 0;
          if (etype === K.ET.PLAYER) init = evseq;
          else if ((etype === K.ET.GENERAL || etype === K.ET.MISSILE) && (st[E_EFLAGS] & 0x10000) && t - (st[E_U0] | 0) > 200) init = evseq;
          ringSeq.set(num, init);
        }
        if (evseq) {
          let p = ringSeq.get(num) || 0;
          if (p > evseq + 64) p -= 256;
          if (evseq - p > 4) p = evseq - 4;
          for (let i = p; i < evseq; i++) {
            const ev = st[E_EVENTS + (i & 3)];
            if (EXPLOSIONS.has(ev)) onDetonation(t, num, st, ev);
          }
          ringSeq.set(num, evseq);
        } else ringSeq.set(num, 0);

        if (etype === K.ET.PLAYER && num < 64) {
          const ef = st[E_EFLAGS];
          let flags = changed.has(num) ? PF.TRANSMITTED : 0;
          if (ef & K.EF.CROUCH) flags |= PF.CROUCH;
          if (ef & K.EF.PRONE) flags |= PF.PRONE;
          if (ef & K.EF.FIRING) flags |= PF.FIRING;
          if (ef & K.EF.DEAD) flags |= PF.DEAD;
          const x = u2f(st[E_POS]), y = u2f(st[E_POS + 1]), z = u2f(st[E_POS + 2]);
          const w = st[E_WEAPON];
          track(num).push(t, R(x), R(y), R(z), R(u2f(st[E_APOS + 1])), R(u2f(st[E_APOS])), flags, w);
          lastWeapon.set(num, [t, w]);
          lastPos.set(num, [t, x, y, z]);
        } else if (etype === K.ET.MISSILE) {
          onMissile(t, num, st, changed.has(num));
        }
      }
      for (const num of prevEntities.keys()) if (!cur.has(num)) missileKey.delete(num);
      prevEntities = cur;
    }

    function sameState(a, b) {
      for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    function onEventEntity(t, num, st, ev) {
      if (ev === K.EV.OBITUARY) {
        const victim = st[E_OTHER], attacker = st[E_ATTACKER], parm = st[E_EVENTPARM];
        const aw = lastWeapon.get(attacker);
        const vp = lastPos.get(victim), ap = lastPos.get(attacker);
        c.kills.push({
          t, attacker, victim, parm,
          attackerWeapon: aw && t - aw[0] <= 1000 ? aw[1] : null,
          victimPos: vp && t - vp[0] <= 1000 ? [R(vp[1]), R(vp[2]), R(vp[3])] : null,
          attackerPos: ap && t - ap[0] <= 1000 ? [R(ap[1]), R(ap[2]), R(ap[3])] : null
        });
      } else if (EXPLOSIONS.has(ev)) {
        onDetonation(t, num, st, ev);
      }
    }

    function onMissile(t, num, st, transmitted) {
      const launch = st[E_U0] | 0;
      const weapon = st[E_WEAPON];
      const key = num + ':' + launch + ':' + weapon;
      let g = c.grenades.get(key);
      const seg = [st[E_POS_TRTIME] | 0, st[E_POS_TRTYPE],
        R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2])),
        R(u2f(st[E_VEL])), R(u2f(st[E_VEL + 1])), R(u2f(st[E_VEL + 2]))];
      if (!g) {
        g = { entity: num, weapon, launch, first: t, last: t, segments: [seg], detonation: null };
        c.grenades.set(key, g);
        c.grenadeOrder.push(key);
      } else {
        g.last = t;
        const l = g.segments[g.segments.length - 1];
        if (transmitted && (l[0] !== seg[0] || l[2] !== seg[2] || l[3] !== seg[3] || l[4] !== seg[4] || l[1] !== seg[1])) g.segments.push(seg);
      }
      missileKey.set(num, key);
    }

    function onDetonation(t, num, st, ev) {
      const pos = [R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2]))];
      const det = { t, x: pos[0], y: pos[1], z: pos[2], event: ev, weapon: st[E_WEAPON] };
      let g = null;
      const key = missileKey.get(num);
      if (key) g = c.grenades.get(key);
      if (!g || g.detonation) {
        // The explosion is a separate temp entity: it appears one snapshot after
        // the grenade entity vanished (measured: always 50 ms, same weapon).
        // Take the grenade of the same weapon that vanished last, nearest first.
        g = null;
        let best = Infinity;
        for (let i = c.grenadeOrder.length - 1; i >= 0; i--) {
          const cand = c.grenades.get(c.grenadeOrder[i]);
          if (t - cand.last > 5000 && cand.first < t - 30000) break;
          if (cand.detonation || cand.weapon !== det.weapon || t < cand.last || t - cand.last > 250) continue;
          const s = cand.segments[cand.segments.length - 1];
          const d = Math.hypot(s[2] - det.x, s[3] - det.y);
          if (d < best) { best = d; g = cand; }
        }
      }
      if (g) g.detonation = det;
      else c.detonations.push(det);
    }

    return { collector: c, visitor, PF };
  }

  C4.collect = { createCollector, PF };
});
