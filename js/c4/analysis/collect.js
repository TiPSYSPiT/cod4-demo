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
    E_EVENTSEQ = 40, E_EVENTS = 41, E_EVENTPARMS = 45, E_WEAPON = 49, E_SURFTYPE = 33, E_UN1 = 53,
    E_INDEX = 34,                       // model index (config string MODELS + index)
    E_SOLID = 38;
  // cod4-demo3d: an entity whose solid is SOLID_BMODEL (0xFFFFFF) is a brush model - its index is the
  // map's inline brush model, not a config string model (CG_ScriptMover: R_GetBrushModel(index)); named
  // '*index' like the map's entity string, never looked up among the XModels
  const SOLID_BMODEL = 0xFFFFFF;
  // the bomb (Search & Destroy, docs/ANALYSIS.md 3.11): the script model of the bomb lying on the
  // ground / planted, and the compass objectives of the player state
  const BOMB_MODEL_RE = /^prop_suitcase_bomb/;
  const BOMB_OBJ_ICON = 'compass_waypoint_bomb';
  const SITE_OBJ_RE = /^compass_waypoint_(?:defend|defuse)_([ab])$/;
  const SURF_FLESH = 7;
  const IMPACT_VICTIM_DIST = 80;    // bullet impact -> nearest player within this distance = victim (≈)
  const EXPLOSIONS = new Set([K.EV.GRENADE_EXPLODE, K.EV.FLASHBANG_EXPLODE, K.EV.CUSTOM_EXPLODE,
    K.EV.CUSTOM_EXPLODE_NOMARKS, K.EV.ROCKET_EXPLODE, K.EV.ROCKET_EXPLODE_NOMARKS]);
  // own-kill metrics (ownKills.js): a shot of a player, and every event of a player that makes a sound
  const SHOT_EVENTS = new Set([26, 27, 38]);                // fire_weapon, fire_weapon_lastshot, fire_weapon_mg42
  const SOUND_EVENTS = new Set([9, 15, 16, 17, 18, 19, 20, 21, 23, 26, 27, 28, 30, 31, 32, 33, 35, 36, 37, 38,
    72, 73, 74, 75, 76]);                                    // item pickup, reload, weapon raise / put away, shots,
  const isSoundEvent = ev => SOUND_EVENTS.has(ev) || (ev >= 77 && ev < 135);   // melee, grenade, footsteps, jump; landing (+ pain)
  // cod4-demo3d (the 3D view's sounds, CG_EntityEvent): the player events that play a sound - foliage,
  // sound alias, reload / raise / put away / pull back, shots, rechamber, melee, footsteps, jump, landings
  const SND_PLAYER_EVENTS = new Set([1, 3, 4, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 30, 35, 36, 38]);
  const isSndPlayerEvent = ev => SND_PLAYER_EVENTS.has(ev) || (ev >= 72 && ev < 135);
  const EV_SOUND_ALIAS = 3, EV_SOUND_ALIAS_AS_MASTER = 4, E_LOOPSOUND = 32;
  const PSI = {
    client: PS_INDEX['ClientNum'], pmType: PS_INDEX['pm_type'], eFlags: PS_INDEX['eFlags'], commandTime: PS_INDEX['commandTime'],
    weapon: PS_INDEX['weapon'], ox: PS_INDEX['origin[0]'], oy: PS_INDEX['origin[1]'],
    oz: PS_INDEX['origin[2]'], pitch: PS_INDEX['viewangles[0]'], yaw: PS_INDEX['viewangles[1]'],
    damageEvent: PS_INDEX['damageEvent'], damageYaw: PS_INDEX['damageYaw'], damageCount: PS_INDEX['damageCount'],
    eventSeq: PS_INDEX['eventSequence'], events: [0, 1, 2, 3].map(i => PS_INDEX['events[' + i + ']']),
    eventParms: [0, 1, 2, 3].map(i => PS_INDEX['eventParms[' + i + ']']), perks: PS_INDEX['perks'],
    viewHeight: PS_INDEX['viewHeightCurrent'], aimSpread: PS_INDEX['aimSpreadScale'], weaponPos: PS_INDEX['fWeaponPosFrac'],
    spreadOverride: PS_INDEX['spreadOverride'], spreadOverrideState: PS_INDEX['spreadOverrideState'],
    legsAnim: PS_INDEX['legsAnim'], torsoAnim: PS_INDEX['torsoAnim'],
    moveDir: PS_INDEX['movementDir'], lean: PS_INDEX['leanf'], torsoPitch: PS_INDEX['fTorsoPitch'], waistPitch: PS_INDEX['fWaistPitch']
  };
  // cod4-demo3d: the player's animations (indices into the game's "multiplayer" anim tree, bit 0x200
  // toggles on a restart of the same animation), entity state fields legsAnim / torsoAnim
  const E_LEGS = 51, E_TORSO = 52;
  // ... and what the game's angle controllers use (bg_animation_mp.cpp BG_PlayerAngles): the movement
  // direction relative to the view (degrees, signed 8 bit), the lean (-1 .. 1) and the prone
  // body / waist pitch; player entities only (the lerp union of a player)
  const E_LEAN = 21, E_MOVEDIR = 22, E_TORSOPITCH = 55, E_WAISTPITCH = 56;
  const CSI_TEAM = CS_INDEX['team'];
  // cod4-demo3d: the character of a player = body model + attached models (head, gear), indices into the model config strings
  const CSI_MODEL = CS_INDEX['modelindex'];
  const CSI_ATTACH = [0, 1, 2, 3, 4, 5].map(i => CS_INDEX['attachModelIndex[' + i + ']']);
  const R = v => Math.round(v * 10) / 10;

  /* position flags */
  const PF = { TRANSMITTED: 1, CROUCH: 2, PRONE: 4, FIRING: 8, DEAD: 16, FROM_PS: 32 };

  class PosTrack {
    constructor() {
      this.t = []; this.x = []; this.y = []; this.z = []; this.yaw = []; this.pitch = []; this.flags = []; this.weapon = [];
      this.legs = []; this.torso = []; this.moveDir = []; this.lean = []; this.torsoPitch = []; this.waistPitch = [];
    }
    push(t, x, y, z, yaw, pitch, flags, weapon, legs, torso, moveDir, lean, torsoPitch, waistPitch) {
      this.t.push(t); this.x.push(x); this.y.push(y); this.z.push(z);
      this.yaw.push(yaw); this.pitch.push(pitch); this.flags.push(flags); this.weapon.push(weapon);
      this.legs.push(legs | 0); this.torso.push(torso | 0);
      this.moveDir.push(moveDir | 0); this.lean.push(lean || 0); this.torsoPitch.push(torsoPitch || 0); this.waistPitch.push(waistPitch || 0);
    }
  }

  function createCollector() {
    const c = {
      protocol: 1,
      gamestate: null,
      cs: new Map(),                // current config strings
      csInitial: null,
      gamestates: [],               // {t (null = start), configstrings} - one per map load
      csChanges: [],                // {t, index, old, value}
      commands: [],                 // {t, seq, text, d}
      names: new Map(),             // client -> {name, clantag}
      nameHistory: [],              // {t, client, name, clantag, source}
      teamTimeline: [],             // {t, client, team}
      modelTimeline: [],            // {t, client, model, attach: [model indices]} (cod4-demo3d)
      corpses: [],                  // {client, t0, t1, x, y, z, yaw, legs, torso} player corpse entities (cod4-demo3d)
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
      // player state of the followed client whenever health / damage counter / client / pm type /
      // weapon changes: {t, client, health (stats[0]), damageEvent, damageYaw, damageCount, pmType, weapon}
      povStates: [],
      // cod4-demo3d: the recorder's player state commandTime per snapshot [t, commandTime] - the seed of
      // the bullet spread the client guesses for other players' shots (CG_BulletEndpos)
      psCommandTimes: [],
      // cod4-demo3d: what the recorder's client fires its own shots with (DrawBulletImpacts for the
      // player state's client): [t, client, aimSpreadScale, fWeaponPosFrac, viewHeightCurrent, leanf,
      // perks, spreadOverride, spreadOverrideState] per snapshot
      psAim: [],
      hitsTaken: [],                // EV_BULLET_HIT_CLIENT_*: {t, victim, attacker, weapon}
      // cod4-demo3d (the 3D view's effects): every bullet impact the POV received (EV_BULLET_HIT temp
      // entities): [t, x, y, z, normal (DirToByte), surface type, weapon, impact flags (un1), shooter], and
      // every scripted effect (EV_PLAY_FX): [t, x, y, z, pitch, yaw, roll, effect id (CS_EFFECT_NAMES + id)]
      impacts: [], playFx: [], scriptEnts: [],
      // the sounds (sound.js): player events [t, client, event, eventParm, weapon, quiet (specialty_quieter, POV
      // only)]; the other entities' sound events (sound alias, grenade bounce) [t, entity, event, eventParm,
      // weapon, x, y, z, surfType]; looping entity sounds {num, index (CS_SOUNDALIASES + index), t0, t1, x, y, z}
      sndEvents: [], sndEntEvents: [], loopSounds: [],
      // EV_BULLET_HIT on flesh shot by the POV: {t, weapon, headshot, lethal, victim (nearest player) | null, dist}
      povImpacts: [],
      // lethal flesh impacts of every shooter: {t, shooter, weapon, head} - the weapon of headshot kills
      lethalImpacts: [],
      // per client: times of his shots by source - fire events (entity / player state ring), bullet
      // impacts he caused, clip decrements of the player state (followed client only) - and of his
      // sound events (footsteps, jumps, landings, shots, reload ...); only while he is in the snapshots
      shots: new Map(), impactShots: new Map(), ammoShots: new Map(), sounds: new Map(),
      // exact view height of the followed client (player state viewHeightCurrent): client -> {t: [], vh: []}
      psEye: new Map(),
      // the bomb as the POV sees it: change points {t, obj, site, ent} (doBomb)
      bombObs: [],
      firstArchive: null
    };
    let prevClip = null, prevClipClient = -1;
    let bombEntNow = null;          // bomb model of the current snapshot (doEntities -> doBomb)
    const addTime = (map, cl, t) => { let a = map.get(cl); if (!a) map.set(cl, a = []); if (a[a.length - 1] !== t) a.push(t); };
    const playerEvent = (cl, ev, t, parm, weapon, quiet) => {
      if (cl == null || cl >= 64) return;
      if (SHOT_EVENTS.has(ev)) addTime(c.shots, cl, t);
      if (isSoundEvent(ev)) addTime(c.sounds, cl, t);
      if (isSndPlayerEvent(ev)) c.sndEvents.push([t, cl, ev, parm | 0, weapon | 0, quiet ? 1 : 0]);
    };
    const loopRec = new Map();           // entity number -> current loop sound record (cod4-demo3d)
    let prevPsSeq = null, prevPsEvClient = -1;
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
        // every gamestate with its time (null = start of the recording): a map change loads new
        // configstrings, e.g. another weapon list (weapon indices are assigned per map load)
        c.gamestates.push({ t: gs.serverTime || null, configstrings: new Map(gs.configstrings) });
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
        doBomb(snap, t);
      }
    };

    /** what the POV sees of the bomb in this snapshot - one entry per change (c.bombObs):
     *  obj  = compass objective of the bomb (attacking side only): [carrier client or -1, x, y, z]
     *  site = objective at the planted bomb (both sides): [site letter, x, y, z]
     *  ent  = the bomb model lying on the ground / planted (both sides, while sent): [x, y, z] */
    let lastBombKey = null;
    function doBomb(snap, t) {
      let obj = null, site = null;
      for (const o of snap.ps.objectives) {
        if (o[0] !== 1) continue;                               // active objectives only
        const icon = c.cs.get(K.CS.SERVER_MATERIALS + o[4]);
        if (!icon) continue;
        const pos = [R(u2f(o[1])), R(u2f(o[2])), R(u2f(o[3]))];
        if (icon === BOMB_OBJ_ICON) obj = [o[5] < 64 ? o[5] : -1, ...pos];
        else { const m = SITE_OBJ_RE.exec(icon); if (m) site = [m[1].toUpperCase(), ...pos]; }
      }
      const ent = bombEntNow;
      const key = JSON.stringify([obj, site, ent]);
      if (key === lastBombKey) return;
      lastBombKey = key;
      c.bombObs.push({ t, obj, site, ent });
    }

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
        if (!prev || prev[CSI_MODEL] !== state[CSI_MODEL] || CSI_ATTACH.some(k => prev[k] !== state[k])) {
          c.modelTimeline.push({ t, client: num, model: state[CSI_MODEL], attach: CSI_ATTACH.map(k => state[k]) });
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
      c.psCommandTimes.push(t, f[PSI.commandTime] | 0);
      c.psAim.push(t, f[PSI.client], u2f(f[PSI.aimSpread]), u2f(f[PSI.weaponPos]), u2f(f[PSI.viewHeight]), u2f(f[PSI.lean]),
        f[PSI.perks] >>> 0, f[PSI.spreadOverride] | 0, f[PSI.spreadOverrideState] | 0);
      const client = f[PSI.client];
      if (client !== lastPsClient) { c.povTimeline.push({ t, client }); lastPsClient = client; }
      const pm = f[PSI.pmType];
      // health and damage feedback of the followed client (change points only)
      const health = snap.ps.stats[0] << 16 >> 16, dEv = f[PSI.damageEvent], w0 = f[PSI.weapon];
      const lp = c.povStates.length ? c.povStates[c.povStates.length - 1] : null;
      if (!lp || lp.client !== client || lp.health !== health || lp.damageEvent !== dEv || lp.pmType !== pm || lp.weapon !== w0) {
        c.povStates.push({ t, client, health, damageEvent: dEv, damageYaw: f[PSI.damageYaw], damageCount: f[PSI.damageCount], pmType: pm, weapon: w0 });
      }
      // event ring of the player state (4 slots, CG_CheckPlayerstateEvents): shots / sounds of the
      // followed client - he is not in the entity list of his own snapshot
      const seq = f[PSI.eventSeq];
      if (prevPsSeq != null && prevPsEvClient === client && client < 64) {
        let n = (seq - prevPsSeq) & 0xff;
        if (n > 0 && n < 128) {
          n = Math.min(n, 4);
          for (let k = n; k > 0; k--) {
            const slot = (seq - k) & 3;
            playerEvent(client, f[PSI.events[slot]], t, f[PSI.eventParms[slot]], f[PSI.weapon], (f[PSI.perks] & 0x100) !== 0);
          }
        }
      }
      prevPsSeq = seq; prevPsEvClient = client;
      // shots from the clip: any clip slot of the followed client going down (a reload raises it)
      const clip = snap.ps.ammoclip;
      if (prevClip && prevClipClient === client && client < 64 && clip !== prevClip) {
        for (let i = 0; i < clip.length; i++) if (clip[i] < prevClip[i]) { addTime(c.ammoShots, client, t); break; }
      }
      prevClip = clip; prevClipClient = client;
      if (client < 64 && pm !== 4 && pm !== 5) {
        let e = c.psEye.get(client);
        if (!e) c.psEye.set(client, e = { t: [], vh: [] });
        e.t.push(t); e.vh.push(R(u2f(f[PSI.viewHeight])));
      }
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
      // the player state keeps the prone body / waist pitch after standing up; the entity state of
      // the game carries them only while prone, in -180 .. 180 (BG_PlayerStateToEntityState)
      const pronePitch = v => (ef & K.EF.PRONE) ? R(((v % 360) + 540) % 360 - 180) : 0;
      track(client).push(t, R(x), R(y), R(z), R(u2f(f[PSI.yaw])), R(u2f(f[PSI.pitch])), flags, w, f[PSI.legsAnim], f[PSI.torsoAnim],
        f[PSI.moveDir] | 0, u2f(f[PSI.lean]), pronePitch(u2f(f[PSI.torsoPitch])), pronePitch(u2f(f[PSI.waistPitch])));
      lastWeapon.set(client, [t, w]);
      lastPos.set(client, [t, x, y, z]);
    }

    const corpseRec = new Map();         // corpse entity number -> current record (cod4-demo3d)
    // cod4-demo3d: the map's script entities (script models / brush models, turrets, helicopters, planes,
    // vehicles): one record per appearance with every change of model, trajectory, angles, flags and solid
    const SCRIPT_TYPES = new Set([0, 6, 11, 12, 13, 14, 15, 16]);
    const scriptRec = new Map();
    const scriptState = (t, st) => [t, st[E_TYPE], st[E_SOLID] === SOLID_BMODEL ? '*' + st[E_INDEX] : c.cs.get(K.CS.MODELS + st[E_INDEX]) || null, st[E_POS_TRTYPE], st[E_POS_TRTIME], st[5],
      R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2])), R(u2f(st[E_VEL])), R(u2f(st[E_VEL + 1])), R(u2f(st[E_VEL + 2])),
      st[12], st[13], st[14], R(u2f(st[E_APOS])), R(u2f(st[E_APOS + 1])), R(u2f(st[E_APOS + 2])), R(u2f(st[18])), R(u2f(st[19])), R(u2f(st[20])),
      st[E_EFLAGS], st[E_SOLID]];
    function onScriptEntity(t, num, st, prev) {
      let rec = scriptRec.get(num);
      const s2 = scriptState(t, st);
      if (!rec || !prev || prev[E_TYPE] !== st[E_TYPE]) {
        rec = { num, t0: t, t1: t, states: [s2] };
        scriptRec.set(num, rec);
        c.scriptEnts.push(rec);
        return;
      }
      rec.t1 = t;
      const last = rec.states[rec.states.length - 1];
      for (let i = 1; i < s2.length; i++) if (last[i] !== s2[i]) { rec.states.push(s2); return; }
    }
    function doEntities(snap, decoder, t) {
      const changed = new Set(snap.changedEntities);
      const cur = new Map();
      bombEntNow = null;
      for (const st of decoder.entitiesOf(snap)) {
        const num = st[0];
        cur.set(num, st);
        const etype = st[E_TYPE];
        const prev = prevEntities.get(num);
        if (etype !== K.ET.PLAYER && etype < K.ET.EVENTS && st[E_SOLID] !== SOLID_BMODEL && BOMB_MODEL_RE.test(c.cs.get(K.CS.MODELS + st[E_INDEX]) || '')) {
          bombEntNow = [R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2]))];
        }
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
            const ev = st[E_EVENTS + (i & 3)], parm = st[E_EVENTPARMS + (i & 3)];
            if (EXPLOSIONS.has(ev)) onDetonation(t, num, st, ev, parm);
            else if (etype === K.ET.PLAYER && num < 64) playerEvent(num, ev, t, parm, st[E_WEAPON], false);
            else if (ev === EV_SOUND_ALIAS || ev === EV_SOUND_ALIAS_AS_MASTER || ev === K.EV.GRENADE_BOUNCE) sndEntEvent(t, num, st, ev, parm);
          }
          ringSeq.set(num, evseq);
        } else ringSeq.set(num, 0);

        if (etype !== K.ET.PLAYER) loopSound(t, num, st);
        if (etype === K.ET.PLAYER && num < 64) {
          const ef = st[E_EFLAGS];
          let flags = changed.has(num) ? PF.TRANSMITTED : 0;
          if (ef & K.EF.CROUCH) flags |= PF.CROUCH;
          if (ef & K.EF.PRONE) flags |= PF.PRONE;
          if (ef & K.EF.FIRING) flags |= PF.FIRING;
          if (ef & K.EF.DEAD) flags |= PF.DEAD;
          const x = u2f(st[E_POS]), y = u2f(st[E_POS + 1]), z = u2f(st[E_POS + 2]);
          const w = st[E_WEAPON];
          track(num).push(t, R(x), R(y), R(z), R(u2f(st[E_APOS + 1])), R(u2f(st[E_APOS])), flags, w, st[E_LEGS], st[E_TORSO],
            st[E_MOVEDIR] | 0, u2f(st[E_LEAN]), R(u2f(st[E_TORSOPITCH])), R(u2f(st[E_WAISTPITCH])));
          lastWeapon.set(num, [t, w]);
          lastPos.set(num, [t, x, y, z]);
        } else if (etype === K.ET.PLAYER_CORPSE) {
          // a dead player's body with the death animation the server chose; one record per appearance
          let rec = corpseRec.get(num);
          if (!rec || !prev || prev[E_TYPE] !== etype || rec.client !== st[E_CLIENTNUM]) {
            rec = { client: st[E_CLIENTNUM], t0: t, t1: t, x: R(u2f(st[E_POS])), y: R(u2f(st[E_POS + 1])), z: R(u2f(st[E_POS + 2])),
              yaw: R(u2f(st[E_APOS + 1])), legs: st[E_LEGS], torso: st[E_TORSO] };
            corpseRec.set(num, rec);
            c.corpses.push(rec);
          }
          rec.t1 = t;
        } else if (etype === K.ET.MISSILE) {
          onMissile(t, num, st, changed.has(num));
        } else if (SCRIPT_TYPES.has(etype) && st[E_INDEX]) {
          onScriptEntity(t, num, st, prev);
        }
      }
      for (const num of prevEntities.keys()) if (!cur.has(num)) missileKey.delete(num);
      prevEntities = cur;
    }

    /** a sound event of an entity other than a player (CG_EntityEvent: EV_SOUND_ALIAS at the entity's
     *  position, EV_GRENADE_BOUNCE: the weapon's bounce sound of the surface) */
    function sndEntEvent(t, num, st, ev, parm) {
      c.sndEntEvents.push([t, num, ev, parm | 0, st[E_WEAPON] | 0, R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2])), st[E_SURFTYPE] | 0]);
    }

    /** an entity's loop sound (entityState loopSound: CS_SOUNDALIASES + index; the burning cars) - one
     *  record per entity and alias while the entity is sent */
    function loopSound(t, num, st) {
      const idx = st[E_LOOPSOUND] | 0;
      let rec = loopRec.get(num);
      if (rec && (rec.index !== idx || t - rec.t1 > 1000)) { loopRec.delete(num); rec = null; }
      if (!idx) return;
      if (!rec) {
        rec = { num, index: idx, t0: t, t1: t, x: R(u2f(st[E_POS])), y: R(u2f(st[E_POS + 1])), z: R(u2f(st[E_POS + 2])) };
        loopRec.set(num, rec);
        c.loopSounds.push(rec);
      }
      rec.t1 = t;
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
        onDetonation(t, num, st, ev, st[E_EVENTPARM]);
      } else if (ev === EV_SOUND_ALIAS || ev === EV_SOUND_ALIAS_AS_MASTER || ev === K.EV.GRENADE_BOUNCE) {
        sndEntEvent(t, num, st, ev, st[E_EVENTPARM]);
      } else if (ev === K.EV.PLAY_FX) {
        c.playFx.push([t, R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2])),
          R(u2f(st[E_APOS])), R(u2f(st[E_APOS + 1])), R(u2f(st[E_APOS + 2])), st[E_EVENTPARM]]);
      } else if (ev === K.EV.BULLET_HIT_CLIENT_SMALL || ev === K.EV.BULLET_HIT_CLIENT_LARGE) {
        // a bullet hit the recording client (or the player it follows): attacker = otherEntityNum
        c.hitsTaken.push({ t, victim: st[E_CLIENTNUM], attacker: st[E_OTHER], weapon: st[E_WEAPON] });
      }
      if (ev === K.EV.BULLET_HIT) {
        c.impacts.push([t, R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2])), st[E_EVENTPARM],
          st[E_SURFTYPE], st[E_WEAPON], st[E_UN1], st[E_OTHER]]);
      }
      if (ev === K.EV.BULLET_HIT && st[E_SURFTYPE] === SURF_FLESH && st[E_OTHER] < 64) {
        // every bullet impact on a player proves a shot of the shooter (otherEntityNum)
        addTime(c.impactShots, st[E_OTHER], t);
        // a lethal impact names the weapon of the kill exactly (un1 bit 0 = head, bit 1 = lethal) - the
        // obituary of a headshot names no weapon (build.js). Not sent to the victim.
        if (st[E_UN1] & 2) c.lethalImpacts.push({ t, shooter: st[E_OTHER], weapon: st[E_WEAPON], head: !!(st[E_UN1] & 1) });
      }
      if (ev === K.EV.BULLET_HIT && st[E_SURFTYPE] === SURF_FLESH && c.gamestate && st[E_OTHER] === c.gamestate.clientNum) {
        // a bullet of the POV hit a player (MP damage code, sent to everyone but the victim):
        // otherEntityNum = shooter, un1 bit 0 = head, bit 1 = the hit killed (docs/ANALYSIS.md 3.9).
        // The victim is not transmitted: the nearest other player to the impact (position <= 200 ms old)
        const x = u2f(st[E_POS]), y = u2f(st[E_POS + 1]), z = u2f(st[E_POS + 2]);
        let victim = null, best = IMPACT_VICTIM_DIST;
        for (const [cl, p] of lastPos) {
          if (cl === st[E_OTHER] || t - p[0] > 200) continue;
          const d = Math.hypot(p[1] - x, p[2] - y, p[3] - z);
          if (d < best) { best = d; victim = cl; }
        }
        const flags = st[E_UN1];
        c.povImpacts.push({ t, weapon: st[E_WEAPON], headshot: !!(flags & 1), lethal: !!(flags & 2), victim, dist: victim == null ? null : R(best) });
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

    function onDetonation(t, num, st, ev, parm) {
      const pos = [R(u2f(st[E_POS])), R(u2f(st[E_POS + 1])), R(u2f(st[E_POS + 2]))];
      // cod4-demo3d: the surface hit and its normal (eventParm: DirToByte) choose the explosion's effect;
      // a smoke grenade's cloud starts at customExplode.startTime (lerp union word 0, server time)
      const det = { t, x: pos[0], y: pos[1], z: pos[2], event: ev, weapon: st[E_WEAPON], surf: st[E_SURFTYPE], dir: parm | 0,
        start: ev === K.EV.CUSTOM_EXPLODE || ev === K.EV.CUSTOM_EXPLODE_NOMARKS ? st[E_U0] | 0 : null };
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
