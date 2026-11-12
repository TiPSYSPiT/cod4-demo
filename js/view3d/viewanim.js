/* The first-person weapon's motion at a demo time (viewmodel.js draws it): which of the weapon's view
 * animations play and how far, aiming down the sights, the knife, the gun's kick, bob and sway, and
 * the crosshair's spread.
 *
 * Everything is a function of the demo time - nothing is carried from frame to frame - so pausing,
 * seeking and the playback speed need nothing special: the animations run in demo time (faster at
 * 2x / 4x, every shot restarts the fire animation as in the game), and the state after a jump in the
 * timeline is the one the demo gives there. The demo times are continuous (the samples interpolated),
 * so the motion runs at the display's frame rate.
 *
 * Two sources (README "First-person weapon"):
 *   the recorder - the player whose player state the demo holds (the POV): the game's own view model
 *     state per snapshot: weapAnim (the animation the client plays, weapAnimNumber_t), weaponstate,
 *     the offhand weapon, fWeaponPosFrac (ADS), aimSpreadScale, the view height, the bob cycle, the
 *     velocity and the ground entity (collect.js psWeapon / psAim);
 *   the other players - their weapon events (shots, reloads, rechamber, raise / put away, melee swipe;
 *     collect.js weapEvents), the knife kills, the legs animation (ADS: a walk movetype as the game's
 *     BG_IsAds; sprint), the stance and the positions (speed, jumps). */

// weapAnimNumber_t (bg_public.h), matched against the demos: fire_weapon -> 2 / 5 (ADS), reload -> 13,
// reload_from_empty -> 14, reload_start / end -> 15 / 16, put away -> 10 / 19 (quick), raise -> 11 /
// 20 (quick), first raise -> 12, melee -> 8, rechamber -> 4 / 7, sprint -> 23 .. 25, offhand hold -> 26
export const WEAP_ANIMS = ['idle', 'idle', 'fire', 'lastShot', 'rechamber', 'adsFire', 'adsLastShot', 'adsRechamber',
  'melee', 'meleeCharge', 'drop', 'raise', 'firstRaise', 'reload', 'reloadEmpty', 'reloadStart', 'reloadEnd',
  'altDrop', 'altRaise', 'quickDrop', 'quickRaise', 'emptyDrop', 'emptyRaise', 'sprintIn', 'sprintLoop', 'sprintOut',
  'holdFire', 'detonate'];
const LOOPED = new Set(['idle', 'emptyIdle', 'sprintLoop', 'holdFire']);
// the animations played stretched to the weapon file's time (GetWeaponAnimRate, g_animRateOffsets: the animation's
// length / the time); the others - idle, fire, last shot, rechamber, ADS - at their own pace
export const STRETCH = { holdFire: 'holdFireTime', melee: 'meleeTime', meleeCharge: 'meleeChargeTime', reload: 'reloadTime', reloadEmpty: 'reloadEmptyTime',
  reloadStart: 'reloadStartTime', reloadEnd: 'reloadEndTime', raise: 'raiseTime', firstRaise: 'firstRaiseTime', drop: 'dropTime',
  altRaise: 'altRaiseTime', altDrop: 'altDropTime', quickRaise: 'quickRaiseTime', quickDrop: 'quickDropTime', emptyRaise: 'emptyRaiseTime',
  emptyDrop: 'emptyDropTime', sprintIn: 'sprintInTime', sprintLoop: 'sprintLoopTime', sprintOut: 'sprintOutTime' };
export const PERK_RELOAD = 0.5, PERK_RATE = 0.75;     // perk_weapReloadMultiplier (sleight of hand), perk_weapRateMultiplier (double tap)
const ADS_VARIANT = { fire: 'adsFire', lastShot: 'adsLastShot', rechamber: 'adsRechamber' };
const ADS_ANIMS = new Set(['adsFire', 'adsLastShot', 'adsRechamber']);
const FIRE_ANIMS = new Set(['fire', 'lastShot', 'adsFire', 'adsLastShot']);
// the animations that end at a held pose (the gun lowered until the next raise)
const HOLD_END = new Set(['drop', 'quickDrop', 'altDrop', 'emptyDrop']);
// demo events (EVENT_NAMES index) of the other players -> animation
const EVENT_ANIMS = { 15: 'reload', 16: 'reloadEmpty', 17: 'reloadStart', 18: 'reloadEnd', 21: 'raise', 22: 'firstRaise',
  23: 'drop', 26: 'fire', 27: 'lastShot', 28: 'rechamber', 30: 'melee', 31: 'melee' };
const SHOT_EVENTS = new Set([26, 27]);
const MELEE_EVENTS = new Set([30, 31]);
const BLEND = 0.12, FIRE_BLEND = 0.04;        // s: cross-fade between animations (a shot restarts at once)
const ENTITYNUM_NONE = 1023;
const OFFHAND_STATES = [15, 20];               // WEAPON_OFFHAND_INIT .. WEAPON_OFFHAND_END
const RUN_SPEED = 190;                         // units / s: full movement offsets and bob
const SIM_MS = 2500;                           // the gun's follow simulation: the last 2.5 s (gunFollow)
// bg_bobAmplitudeSprinting / Standing / Ducked / Prone: [horizontal, vertical]
const BOB_AMP = { sprint: [0.02, 0.014], stand: [0.007, 0.007], ducked: [0.0075, 0.0075], prone: [0.03, 0.03] };
const NO_GROUND = 1023;                        // groundEntityNum in the air
// cg_viewZSmoothingMin / Max / Time (the defaults; Promod's client.gsc forces the same), bg_stepSize
const STEP_MIN = 1, STEP_MAX = 16, STEP_MS = 100, STEP_SIZE = 18;
const RETICLE_OFF = new Set([1, 2, 3, 4, 7, 12, 13, 14]);   // AllowedToDrawCrosshair: raising, dropping, reloading, melee
const AIM_SPEED_MIN = 11;                      // bg_aimSpreadMoveSpeedThreshold
const JUMP_SPREAD_ADD = 64;                    // jump_spreadAdd

const lower = (a, t) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m + 1; else hi = m; } return lo - 1; };
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
// a deterministic random number in [0, 1) per shot (the gun kick: the same after every seek)
const hash01 = n => { let x = (n | 0) ^ 0x9e3779b9; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

export class ViewAnimator {
  /** M: the match; anims: the player AnimationLibrary (legs clip names and movetypes: ADS, sprint) */
  constructor(M, anims) {
    this.M = M; this.anims = anims;
    this.events = new Map();             // client -> {t: Int32Array, ev, weapon[]}
    this.dist = new Map();               // client -> cumulative ground distance per position sample
    this.legsInfo = new Map();           // legs anim index -> {ads, sprint}
    this.adsRuns = new WeakMap();        // weapon params -> client -> the other player's aiming runs (adsRunsOf)
    this.idleRec = new WeakMap();        // weapon params -> client -> the recorder's idle time integral (idleTime)
    if (anims) anims.load().then(ok => { this.animsReady = ok; });
    this.buildRecorder();
  }

  /* ---------- per demo ---------- */
  /** the recorder's rows: the start of each weapAnim run (the toggle bit marks a restart) */
  buildRecorder() {
    const W = this.M.d.psWeapon;
    this.rec = null;
    if (!W || !W.t.length) return;
    const n = W.t.length, start = new Float64Array(n), first = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const same = i > 0 && W.client[i] === W.client[i - 1] && W.anim[i] === W.anim[i - 1] && W.weapon[i] === W.weapon[i - 1] && W.t[i] - W.t[i - 1] < 500;
      if (same) { start[i] = start[i - 1]; first[i] = first[i - 1]; }
      // a new run started between the snapshots: the middle (the game changed it within that time)
      else { start[i] = i > 0 && W.t[i] - W.t[i - 1] < 500 ? (W.t[i - 1] + W.t[i]) / 2 : W.t[i]; first[i] = i; }
    }
    this.rec = { W, start, first };
  }

  /** a client's weapon events, plus a melee swing for every knife kill without one (the swing starts
   *  meleeDelay before the hit) -> {t, ev, w} sorted */
  eventsOf(cl, meleeDelay = 0.13) {
    let E = this.events.get(cl);
    if (E) return E;
    const list = [];
    for (const r of this.M.d.weapEvents || []) if (r[1] === cl && (EVENT_ANIMS[r[2]] || r[2] === 23)) list.push([r[0], r[2], r[4]]);
    const swings = list.filter(e => MELEE_EVENTS.has(e[1])).map(e => e[0]);
    for (const k of this.M.d.kills || []) {
      if (k.attacker !== cl || !(k.knife || k.mod === 7 || k.mod === 'MOD_MELEE')) continue;
      if (swings.some(s => s > k.t - 1000 && s <= k.t + 100)) continue;
      list.push([Math.round(k.t - meleeDelay * 1000), 30, k.weaponName || null, 'kill']);
    }
    list.sort((a, b) => a[0] - b[0]);
    E = { t: Int32Array.from(list, e => e[0]), ev: list.map(e => e[1]), w: list.map(e => e[2]), synthetic: list.map(e => !!e[3]) };
    this.events.set(cl, E);
    return E;
  }

  /** the legs animation's movetypes: a walk = aiming down the sights (BG_IsAds), the sprint */
  legs(index) {
    const k = index & 0x1ff;
    let v = this.legsInfo.get(k);
    if (v) return v;
    const lib = this.anims;
    if (!lib || !this.animsReady || !lib.meta) return { ads: false, sprint: false };
    const name = lib.treeName(k), c = name && lib.meta.clips[lib.name(name)];
    const WALKS = ['walk', 'walkbk', 'walkcr', 'walkcrbk', 'walkprone', 'walkpronebk'];
    v = { ads: !!(c && c.game && (c.game.movetypes || []).some(m => WALKS.includes(m))), sprint: !!(name && /sprint/.test(name)) };
    this.legsInfo.set(k, v);
    return v;
  }

  /** cumulative ground distance of a client's samples (the bob phase of the other players) */
  distOf(cl) {
    let D = this.dist.get(cl);
    if (D) return D;
    const P = this.M.d.positions[cl];
    D = new Float64Array(P ? P.t.length : 0);
    for (let i = 1; i < D.length; i++) {
      const d = Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]);
      D[i] = D[i - 1] + (d < 64 && P.t[i] - P.t[i - 1] < 300 ? d : 0);
    }
    this.dist.set(cl, D);
    return D;
  }

  /* ---------- per frame ---------- */
  /** the recorder's row at t when it is client cl's (and recent) -> index or -1 */
  recorderRow(cl, t) {
    const R = this.rec;
    if (!R) return -1;
    const i = lower(R.W.t, t);
    return i >= 0 && R.W.client[i] === cl && t - R.W.t[i] < 250 ? i : -1;
  }

  /** the state of client cl's first-person weapon at t.
   *  s: the client's sample (M.sampleAt); entryOf(name) -> the view model entry (viewmodel.js) or null;
   *  clipInfo(name) -> {duration, loop} or null.
   *  -> {weapon, entry, layers [{clip, time, weight}], knife, offset {pos [f, l, u], rot [p, y, r] deg},
   *      ads (0..1, the sights' fraction), spread (deg, the crosshair), recorder (bool), sources} */
  state(cl, t, s, entryOf, clipInfo) {
    const M = this.M;
    const ri = this.recorderRow(cl, t);
    const W = ri >= 0 ? this.rec.W : null;
    // the weapon: the recorder's (the offhand one while he throws), else the sample's
    let wIdx = W ? W.weapon[ri] : s.weapon;
    let animIdx = W ? W.anim[ri] & 0x1ff : -1;
    if (W && W.state[ri] >= OFFHAND_STATES[0] && W.state[ri] <= OFFHAND_STATES[1] && W.offhand[ri] && animIdx !== 19 && animIdx !== 20) wIdx = W.offhand[ri];
    const weapon = M.weaponName(wIdx, t);
    const entry = weapon ? entryOf(weapon) : null;
    const out = { weapon, entry, layers: [], knife: false, ads: 0, spread: 0, recorder: !!W,
      offset: { pos: [0, 0, 0], rot: [0, 0, 0] }, sources: W ? 'player state' : 'events' };
    if (!entry) return out;
    const A = entry.anims || {}, P = entry.params || {};
    // the rate of an animation (StartWeaponAnim: the recorder's reload and rechamber faster with the perks) and its
    // duration at that rate (s)
    const A3 = M.d.psAim, perks = W && A3 && ri < A3.t.length ? A3.perks[ri] : 0, ws = W ? W.state[ri] : -1;
    const perkRate = ws >= 7 && ws <= 11 && (perks & 4) ? 1 / PERK_RELOAD : ws === 6 && (perks & 8) ? 1 / PERK_RATE : 1;
    const rate = key => { const c = A[key] && clipInfo(A[key]), tm = STRETCH[key] && P[STRETCH[key]]; return (c && tm > 0 && c.duration > 0 ? c.duration / tm : 1) * perkRate; };
    const dur = key => { const c = A[key] && clipInfo(A[key]); return c ? c.duration / rate(key) : null; };
    const has = key => !!(A[key] && clipInfo(A[key]));
    const idleKey = has('idle') ? 'idle' : null;

    // ---- the action: [key, time (s) into it, previous key, its time, blend] ----
    let key = null, time = 0, prevKey = null, prevTime = 0, sinceStart = 0;
    if (W) {
      key = WEAP_ANIMS[animIdx] || 'idle';
      const start = this.rec.start[ri];
      time = sinceStart = (t - start) / 1000;
      const f = this.rec.first[ri];
      if (f > 0 && W.client[f - 1] === cl && W.weapon[f - 1] === W.weapon[ri]) {
        prevKey = WEAP_ANIMS[W.anim[f - 1] & 0x1ff] || 'idle';
        prevTime = (t - this.rec.start[f - 1]) / 1000;
      }
    } else {
      const E = this.eventsOf(cl, P.meleeDelay);
      let k = lower(E.t, t);
      // events of another weapon (the one put away) do not drive this one
      while (k >= 0 && E.w[k] && E.w[k] !== weapon && E.ev[k] !== 23) k--;
      if (k >= 0 && t - E.t[k] < 6000) {
        key = this.eventKey(E, k, weapon);
        time = sinceStart = (t - E.t[k]) / 1000;
        // the shotgun reload: the shells go in (the reload animation, looped) until reload_end
        if (key === 'reloadStart' && dur('reloadStart') != null && time > dur('reloadStart') && has('reload')) {
          const d0 = dur('reloadStart'), d1 = Math.max(0.1, dur('reload'));
          prevKey = 'reloadStart'; prevTime = time;
          time = (time - d0) % d1; key = 'reload'; sinceStart = time;
        } else if (k > 0 && E.t[k] - E.t[k - 1] < 3000 && (!E.w[k - 1] || E.w[k - 1] === weapon)) {
          prevKey = this.eventKey(E, k - 1, weapon);
          prevTime = (t - E.t[k - 1]) / 1000;
        }
      }
    }
    // ---- aiming down the sights ----
    let ads = 0;
    if (W) {
      const A2 = M.d.psAim;
      if (A2 && ri < A2.t.length) {
        ads = A2.ads[ri];
        if (ri + 1 < A2.t.length && A2.client[ri + 1] === cl && A2.t[ri + 1] > A2.t[ri]) ads += (A2.ads[ri + 1] - ads) * clamp01((t - A2.t[ri]) / (A2.t[ri + 1] - A2.t[ri]));
      }
    } else ads = this.adsOther(cl, t, P);
    // the ADS variant of a shot / rechamber; no sights during the other actions (the game leaves ADS)
    if (key && ADS_VARIANT[key] && ads > 0.5 && has(ADS_VARIANT[key])) key = ADS_VARIANT[key];
    if (prevKey && ADS_VARIANT[prevKey] && ads > 0.5 && has(ADS_VARIANT[prevKey])) prevKey = ADS_VARIANT[prevKey];
    const actionOn = key && key !== 'idle' && !LOOPED.has(key) && (dur(key) == null || time <= dur(key) || HOLD_END.has(key));
    // (the recorder's fraction is the player state's: it falls by itself, the zoom going out at the game's pace)
    if (!W && actionOn && !FIRE_ANIMS.has(key) && !ADS_ANIMS.has(key) && key !== 'rechamber') ads = 0;
    out.ads = ads;
    // ---- the sprint (the other players: the legs animation) ----
    if (!W && !actionOn) {
      const sp = this.sprintOther(cl, t);
      if (sp) { key = sp.key; time = sp.time; prevKey = sp.prev; prevTime = sp.prevTime; sinceStart = sp.time; }
    }
    // ---- the layers: the hip set (cross-faded) under the ADS set ----
    const hip = [];
    const push = (list, k, tm, w) => {
      if (w <= 0.001) return;
      const name = A[k];
      const c = name && clipInfo(name);
      if (!c) { if (k !== 'idle' && idleKey) push(list, 'idle', t / 1000, w); return; }
      let x = tm * rate(k);
      if (c.loop || LOOPED.has(k)) x = c.duration > 0 ? x % c.duration : 0; else x = Math.min(Math.max(0, x), c.duration);
      list.push({ clip: name, time: x, weight: w, key: k });
    };
    const blendTime = FIRE_ANIMS.has(key) ? FIRE_BLEND : BLEND;
    if (key && key !== 'idle') {
      const d = dur(key);
      const ended = d != null && !LOOPED.has(key) && time > d && !HOLD_END.has(key);
      if (ended) {
        // back to the idle after the action's end
        const w = clamp01((time - d) / BLEND);
        push(hip, key, d, 1 - w); push(hip, idleKey || key, t / 1000, w);
      } else {
        const w = clamp01(sinceStart / blendTime);
        if (prevKey && w < 1) push(hip, prevKey, prevTime, 1 - w);
        else if (!prevKey && w < 1 && idleKey) push(hip, 'idle', t / 1000, 1 - w);
        push(hip, key, time, prevKey || idleKey ? w : 1);
      }
    } else {
      // (an action cut short: the idle fades in over it, as after any other change of animation)
      const w = prevKey && prevKey !== 'idle' ? clamp01(sinceStart / BLEND) : 1;
      if (w < 1) push(hip, prevKey, prevTime, 1 - w);
      push(hip, 'idle', t / 1000, w);
    }
    // ADS: the weapon's adsUp animation moves only tag_ads (the parent of the hands' torso: back, and
    // aside so that the sights sit on the view axis); it plays at the sights' fraction (0 = hip, its
    // end = aimed) over the other animations, which keep moving the rest (an ADS shot: adsFire)
    for (const l of hip) out.layers.push(l);
    if (has('adsUp')) {
      const ov = [];
      push(ov, 'adsUp', (dur('adsUp') || 0) * clamp01(ads), 1);
      for (const l of ov) out.layers.push(Object.assign(l, { override: true }));
    }
    // the knife: during a melee (on the hands' tag_knife_attach)
    out.knife = !!(key && /^melee/.test(key) && dur(key) != null && time <= dur(key) + 0.05);
    out.action = key;

    // ---- the motion: stance offsets, movement, bob, landing, idle sway, turn sway, kick ----
    this.motion(out, cl, t, s, W, ri, P, ads);
    out.spread = this.spread(cl, t, s, W, ri, P, ads);
    out.spreadScale = this.lastScale;                // aimSpreadScale / 255 (the reticle's alpha)
    // the crosshair: not while raising, putting away, reloading, meleeing (AllowedToDrawCrosshair: weapon
    // states 1 - 4, 7, 12 - 14), while flashed (CG_Flashbanged: the recorder's); the sights' direction
    // (CG_TransitionToAds: the in / out fractions). The sprint states 22 - 24 are the viewer's choice (viewmodel.js)
    const isSprint = st => st >= 22 && st <= 24, isOff = st => RETICLE_OFF.has(st);
    out.sprinting = W ? this.heldState(W, ri, cl, isSprint) : !!this.sprintOther(cl, t);
    out.flashed = !!W && this.flashedAt(cl, t);
    // the grenade's cook timer (CG_DrawReticleCenter: the centre pulses by grenadeTimeLeft)
    out.grenadeLeft = W && A3 && A3.grenadeLeft && ri < A3.t.length ? A3.grenadeLeft[ri] : 0;
    if (W) out.reticleOff = this.heldState(W, ri, cl, isOff);
    else out.reticleOff = !!(key && /^(raise|firstRaise|quickRaise|altRaise|emptyRaise|drop|quickDrop|altDrop|emptyDrop|reload|reloadEmpty|reloadStart|reloadEnd|melee|meleeCharge)$/.test(key)
      && (dur(key) == null || time <= dur(key) || HOLD_END.has(key)));
    const before = W ? this.adsRecorder(cl, t - 50) : this.adsOther(cl, t - 50, P);
    out.adsIn = ads >= (before == null ? ads : before);
    out.weapFlags = W ? W.weapFlags[ri] : null;
    return out;
  }

  /** the animation of the other player's event k (put away: quick when the same weapon comes back,
   *  raise: quick after a quick put away) */
  eventKey(E, k, weapon) {
    const ev = E.ev[k];
    let key = EVENT_ANIMS[ev] || 'idle';
    if (ev === 23) {
      // a put away followed by a raise of the same weapon within 3 s: the offhand throw (quick drop)
      for (let j = k + 1; j < E.t.length && E.t[j] - E.t[k] < 3000; j++) if (E.ev[j] === 21 || E.ev[j] === 22) { if (E.w[j] === E.w[k]) key = 'quickDrop'; break; }
    } else if (ev === 21) {
      for (let j = k - 1; j >= 0 && E.t[k] - E.t[j] < 3000; j--) if (E.ev[j] === 23) { if (E.w[j] === E.w[k]) key = 'quickRaise'; break; }
    }
    return key;
  }

  /** the recorder's ADS fraction at tm (psAim, interpolated) or null */
  adsRecorder(cl, tm) {
    const r = this.recorderRow(cl, tm), A2 = this.M.d.psAim;
    if (r < 0 || !A2 || r >= A2.t.length) return null;
    let a = A2.ads[r];
    if (r + 1 < A2.t.length && A2.client[r + 1] === cl && A2.t[r + 1] > A2.t[r]) a += (A2.ads[r + 1] - a) * clamp01((tm - A2.t[r]) / (A2.t[r + 1] - A2.t[r]));
    return a;
  }

  /** the other player's ADS fraction: the legs animation's walk (BG_IsAds) since its last change, at the weapon's
   *  transition times - each ramp starts where the previous one had got to (aiming in again before the sights were
   *  down: no jump to 0 / 1) */
  adsOther(cl, t, P) {
    const R = this.adsRunsOf(cl, P);
    if (!R) return 0;
    const k = lower(R.c, t);
    return k < 0 ? 0 : R.value(k, t);
  }

  /** client cl's aiming runs (built once per weapon params): the change times c (between the two samples), the state
   *  after each (on), the fraction there (v) and the integral of the fraction up to there (area, ms) -> {c, on, v,
   *  area, value(k, t), integral(t)} or null */
  adsRunsOf(cl, P) {
    const Ps = this.M.d.positions[cl];
    if (!Ps || !Ps.legs || !Ps.t.length || !this.animsReady) return null;
    let byCl = this.adsRuns.get(P);
    if (!byCl) this.adsRuns.set(P, byCl = new Map());
    let R = byCl.get(cl);
    if (R) return R;
    const rin = 1 / ((P.adsTransInTime || 0.25) * 1000), rout = 1 / ((P.adsTransOutTime || 0.25) * 1000);
    const c = [Ps.t[0]], on = [this.legs(Ps.legs[0]).ads], v = [0], area = [0];
    // (the fraction d ms after a change from v0 towards up / down, and its integral over those d ms)
    const step = (v0, up, d) => {
      const r = up ? rin : rout, goal = up ? 1 : 0, reach = Math.abs(goal - v0) / r;
      if (d <= reach) { const v1 = v0 + (up ? r : -r) * d; return [v1, d * (v0 + v1) / 2]; }
      return [goal, reach * (v0 + goal) / 2 + (d - reach) * goal];
    };
    for (let i = 1; i < Ps.t.length; i++) {
      const o = this.legs(Ps.legs[i]).ads, k = on.length - 1;
      if (o === on[k]) continue;
      const tc = (Ps.t[i - 1] + Ps.t[i]) / 2, [v1, ar] = step(v[k], on[k], tc - c[k]);
      c.push(tc); on.push(o); v.push(v1); area.push(area[k] + ar);
    }
    R = { c: Float64Array.from(c), on, v: Float64Array.from(v), area: Float64Array.from(area),
      value: (k, t) => step(R.v[k], R.on[k], t - R.c[k])[0],
      integral: t => { const k = lower(R.c, t); return k < 0 ? 0 : R.area[k] + step(R.v[k], R.on[k], t - R.c[k])[1]; } };
    byCl.set(cl, R);
    return R;
  }

  /** the recorder's weapon state at row ri matches, for longer than this one snapshot: a switch key tapped with nothing
   *  to switch to shows WEAPON_DROPPING for 50 ms - a blink of the crosshair (a real raise, drop, reload or melee takes
   *  many snapshots) */
  heldState(W, ri, cl, test) {
    if (!test(W.state[ri])) return false;
    return (ri > 0 && W.client[ri - 1] === cl && test(W.state[ri - 1])) || (ri + 1 < W.t.length && W.client[ri + 1] === cl && test(W.state[ri + 1]));
  }

  /** CG_Flashbanged at t: a flashbang's shell shock of client cl still running (shock files by name: the concussion
   *  grenade's is "blurred" and keeps the crosshair) */
  flashedAt(cl, t) {
    for (const h of this.M.d.shocks || []) if (h.client === cl && t >= h.start && t < h.start + h.duration && /flash/i.test(h.name)) return true;
    return false;
  }

  /** the idle sway's time at t (ms; BG_CalculateWeaponPosition_IdleAngles advances it by frame time x idle speed): the
   *  hip speed since the map's start plus what the ADS speed (and, for the recorder, holdBreathScale) added or took -
   *  integrated from the start, so continuous between frames and the same for the same t (seeks, any speed) */
  idleTime(cl, t, W, P) {
    const hs = P.hipIdleSpeed || 1, as = P.adsIdleSpeed || 1;
    if (!W) {
      const R = this.adsRunsOf(cl, P);
      return t * hs + (R ? (as - hs) * R.integral(t) : 0);
    }
    // the recorder: his rows (psAim: the ADS fraction and the breath per snapshot), a trapezoid between two rows of his
    // less than 250 ms apart (else the last one's rate for up to 250 ms)
    const A2 = this.M.d.psAim;
    if (!A2) return t * hs;
    let byCl = this.idleRec.get(P);
    if (!byCl) this.idleRec.set(P, byCl = new Map());
    let I = byCl.get(cl);
    if (!I) {
      const rt = [], g = [], cum = [];
      for (let r = 0; r < A2.t.length; r++) {
        if (A2.client[r] !== cl) continue;
        const x = (A2.breath ? A2.breath[r] : 1) * (hs + (as - hs) * A2.ads[r]) - hs, n = rt.length;
        if (n) { const d = A2.t[r] - rt[n - 1]; cum.push(cum[n - 1] + (d < 250 ? d * (g[n - 1] + x) / 2 : 250 * g[n - 1])); }
        else cum.push(0);
        rt.push(A2.t[r]); g.push(x);
      }
      byCl.set(cl, I = { rt: Float64Array.from(rt), g: Float64Array.from(g), cum: Float64Array.from(cum) });
    }
    const k = lower(I.rt, t);
    if (k < 0) return t * hs;
    const d = t - I.rt[k];
    let e = I.cum[k];
    if (k + 1 < I.rt.length && I.rt[k + 1] - I.rt[k] < 250) {
      const g1 = I.g[k] + (I.g[k + 1] - I.g[k]) * d / (I.rt[k + 1] - I.rt[k]);
      e += d * (I.g[k] + g1) / 2;
    } else e += Math.min(d, 250) * I.g[k];
    return t * hs + e;
  }

  /** the other player's sprint from the legs animation -> {key, time, prev, prevTime} or null */
  sprintOther(cl, t) {
    const Ps = this.M.d.positions[cl];
    if (!Ps || !Ps.legs || !this.animsReady) return null;
    const i = lower(Ps.t, t);
    if (i < 0) return null;
    const on = this.legs(Ps.legs[i]).sprint;
    let j = i;
    while (j > 0 && i - j < 200 && this.legs(Ps.legs[j - 1]).sprint === on) j--;
    const since = (t - (j > 0 ? (Ps.t[j - 1] + Ps.t[j]) / 2 : Ps.t[j])) / 1000;
    if (on) return since < 0.3 ? { key: 'sprintIn', time: since, prev: null } : { key: 'sprintLoop', time: since - 0.3, prev: 'sprintIn', prevTime: since };
    return since < 0.3 && j > 0 ? { key: 'sprintOut', time: since, prev: 'sprintLoop', prevTime: since } : null;
  }

  /** the gun's offsets at t (model space: x forward, y left, z up; pitch > 0 down, yaw > 0 left, roll):
   *  - the base position and angles as the game computes them (CalculateWeaponPosition_BasePosition_movement /
   *    BG_CalculateWeaponPosition_BasePosition_angles): the stance's *Move / *Rot targets by the speed's share
   *    above *MinSpeed of g_speed (none while reloading), the *Ofs of the view height target (crouched,
   *    prone), followed per axis at posMoveRate / posRotRate (posProne* while prone; at least 0.1 / s, never
   *    past), x (1 - 2 ADS) over the first half of the ADS - simulated in 1/60 s steps over the last 2.5 s on
   *    a fixed time grid, so the same t gives the same pose at any speed and after a seek;
   *  - the ADS aim pitch, the lean (roll -2 f, 1.6 f aside), the idle sway (BG_CalculateWeaponPosition_
   *    IdleAngles: hip / ADS amount and speed, the stance factor followed at 0.5 / s, holdBreathScale, sines
   *    of the idle time) - for a scoped weapon the view's sway instead (out.viewSway);
   *  - the landing dip (a quarter of the camera's: landDip);
   *  - approximated with the weapon file's numbers: the bob, the turn sway, the gun kick */
  motion(out, cl, t, s, W, ri, P, ads) {
    const M = this.M, pos = out.offset.pos, rot = out.offset.rot, v = k => P[k] || 0;
    const sim = this.simNow = this.gunFollow(cl, t, W, P);
    pos[0] += sim.org[0]; pos[1] -= sim.org[1]; pos[2] += sim.org[2];
    rot[0] += sim.ang[0]; rot[1] += sim.ang[1]; rot[2] += sim.ang[2];
    rot[0] += ads * v('adsAimPitch');
    // the lean: the gun rolls with it and moves aside (CalculateWeaponPosition, BG_CalculateWeaponAngles)
    const lean = this.leanAt(cl, t, W, ri);
    if (lean) {
      const f = (2 - Math.abs(lean)) * lean;
      rot[2] -= 2 * f;
      if (ads < 1) pos[1] -= (1 - ads) * f * 1.6;
    }
    // the idle sway
    const scoped = P.adsOverlayReticle && P.adsOverlayReticle !== 'none';
    const amount = P.hipIdleAmount === 0 && !P.adsIdleAmount ? 80 : v('hipIdleAmount') + (v('adsIdleAmount') - v('hipIdleAmount')) * ads;
    let scale = amount * sim.idleFactor * sim.breath;
    // the idle time: the hip / ADS speed (and the breath) integrated since the map's start
    const it = this.idleTime(cl, t, W, P);
    // the scope's sway moves the view, not the gun (CG_CalculateView_IdleAngles: weapons with an overlay
    // reticle - amount x stance factor x ADS x holdBreathScale; pitch / yaw degrees for the camera)
    out.viewSway = scoped && ads > 0 ? [scale * ads * Math.sin(it * 0.001) * 0.01, scale * ads * Math.sin(it * 0.0007) * 0.01] : null;
    if (scoped) scale *= 1 - ads;
    rot[2] += scale * Math.sin(it * 0.0005) * 0.01;
    rot[1] += scale * Math.sin(it * 0.0007) * 0.01;
    rot[0] += scale * Math.sin(it * 0.001) * 0.01;
    // the landing dip: the gun a quarter of the camera's (CalculateWeaponPosition)
    pos[2] += 0.25 * this.landDip(cl, t);
    // bob (approximated): the recorder's bob cycle, else the distance walked (one cycle per 2 steps)
    const crouch = s.crouch && !s.prone ? 1 : 0, prone = s.prone ? 1 : 0, stand = 1 - crouch - prone;
    const move = clamp01(sim.speed / RUN_SPEED) * sim.ground;
    let phase;
    if (W) {
      let b = W.bob[ri];
      if (ri + 1 < W.t.length && W.client[ri + 1] === cl && W.t[ri + 1] > W.t[ri]) {
        let d = W.bob[ri + 1] - b; if (d < -128) d += 256;
        b += d * clamp01((t - W.t[ri]) / (W.t[ri + 1] - W.t[ri]));
      }
      phase = b / 256 * Math.PI * 2;
    } else {
      const Ps = M.d.positions[cl], D = this.distOf(cl), i = lower(Ps.t, t);
      let d = i >= 0 ? D[i] : 0;
      if (i >= 0 && i + 1 < Ps.t.length && Ps.t[i + 1] > Ps.t[i]) d += (D[i + 1] - D[i]) * clamp01((t - Ps.t[i]) / (Ps.t[i + 1] - Ps.t[i]));
      phase = d / 96 * Math.PI;
    }
    const bobAmp = move * (stand + 0.6 * crouch + 0.35 * prone) * (1 - ads + ads * (v('adsBobFactor') * 0.3));
    pos[2] -= Math.abs(Math.sin(phase)) * 0.55 * bobAmp;
    pos[1] += Math.sin(phase) * 0.35 * bobAmp;
    rot[2] += Math.sin(phase) * 0.8 * bobAmp;
    rot[0] += Math.abs(Math.sin(phase)) * 0.4 * bobAmp;
    // the turn sway (approximated): the gun lags behind the view (sway*: the lag, its maximum, the sideways shift)
    const a0 = M.sampleAt(cl, t - 60);
    if (a0) {
      let dyaw = s.yaw - a0.yaw; dyaw = ((dyaw + 540) % 360) - 180;
      const rateY = dyaw / 0.06, rateP = (s.pitch - a0.pitch) / 0.06;
      // (the hip / ADS values mixed by the ADS fraction: switched at a half, the lag jumped while turning and aiming in)
      const mix = (h, a) => v(h) + (v(a) - v(h)) * ads;
      const max = mix('swayMaxAngle', 'adsSwayMaxAngle') * 0.25, lerp = (P.swayLerpSpeed || 4) + ((P.adsSwayLerpSpeed || 4) - (P.swayLerpSpeed || 4)) * ads;
      const yawS = mix('swayYawScale', 'adsSwayYawScale'), pitS = mix('swayPitchScale', 'adsSwayPitchScale');
      const lagY = Math.max(-max, Math.min(max, -rateY / lerp * 0.1 * Math.abs(yawS || 1)));
      const lagP = Math.max(-max, Math.min(max, rateP / lerp * 0.1 * Math.abs(pitS || 1)));
      rot[1] += lagY; rot[0] += lagP;
      pos[1] += lagY * mix('swayHorizScale', 'adsSwayHorizScale') * 0.3;
    }
    // the gun kick (approximated): the shots of the last 1.2 s through the weapon's kick spring
    const k = this.kick(cl, t, P, ads);
    rot[0] -= k[0]; rot[1] += k[1];
  }

  /** the inputs of the gun's motion at demo time tm: horizontal speed, stance flags, the view height
   *  target, reloading, the ADS fraction - the recorder's player state (interpolated), else the samples */
  inputAt(cl, tm, W, P, out = {}) {
    const M = this.M, s = M.sampleInto(cl, tm, this.scratchS || (this.scratchS = {}));
    if (!s) return null;
    out.prone = s.prone; out.crouch = s.crouch && !s.prone; out.speed = 0; out.ground = true; out.reloading = false; out.ads = 0; out.breath = 1;
    const r = W ? this.recorderRow(cl, tm) : -1;
    if (r >= 0) {
      const f = r + 1 < W.t.length && W.client[r + 1] === cl && W.t[r + 1] > W.t[r] ? clamp01((tm - W.t[r]) / (W.t[r + 1] - W.t[r])) : 0, n = f ? r + 1 : r;
      out.speed = Math.hypot(W.vx[r] + (W.vx[n] - W.vx[r]) * f, W.vy[r] + (W.vy[n] - W.vy[r]) * f);
      out.ground = W.ground[r] !== ENTITYNUM_NONE;
      out.reloading = W.state[r] === 7;
      const A2 = M.d.psAim;
      if (A2 && r < A2.t.length) {
        out.ads = A2.ads[r] + (A2.ads[n] - A2.ads[r]) * f;
        // holdBreathScale (PM_UpdateHoldBreath): 0 holding the breath, above 1 gasping after it
        if (A2.breath) out.breath = A2.breath[r] + (A2.breath[n] - A2.breath[r]) * f;
      }
    } else {
      // (the positions are mostly whole units: over 50 ms one unit of rounding was 20 units / s, the ground flag - and
      // with it the bob's strength - flipping frame by frame on a slope or stairs; the chord over +-100 ms instead, a
      // half faster than 600 units / s - a teleport, a respawn - left out)
      const a = M.sampleInto(cl, tm - 100, this.scratchA || (this.scratchA = {})), b = M.sampleInto(cl, tm + 100, this.scratchB || (this.scratchB = {}));
      const half = q => (q ? Math.hypot(q.x - s.x, q.y - s.y) * 10 : Infinity), okA = half(a) <= 600, okB = half(b) <= 600;
      if (okA && okB) { out.speed = Math.hypot(b.x - a.x, b.y - a.y) * 5; out.ground = Math.abs(b.z - a.z) * 5 < 60; }
      else if (okA || okB) { const q = okA ? a : b; out.speed = half(q); out.ground = Math.abs(q.z - s.z) * 10 < 60; }
      out.ads = this.adsOther(cl, tm, P);
      out.reloading = this.reloadingOther(cl, tm, P);
    }
    return out;
  }

  /** another player reloads at tm: a reload event less than the weapon's reload time before (until a
   *  raise / put away) */
  reloadingOther(cl, tm, P) {
    const E = this.eventsOf(cl, P.meleeDelay);
    for (let k = lower(E.t, tm); k >= 0 && tm - E.t[k] < 4000; k--) {
      const ev = E.ev[k];
      if (ev === 15 || ev === 16 || ev === 17) return tm - E.t[k] < (P.reloadTime || 2.5) * 1000 || ev === 17;
      if (ev === 18 || ev === 21 || ev === 22 || ev === 23 || ev === 26 || ev === 27) return false;
    }
    return false;
  }

  /** the base position / angles' follow simulation (see motion) -> {org [f, r, u], ang [p, y, r], idleFactor, speed,
   *  ground (the bob's share: 1 on the ground, 0.3 in the air - the others' estimate followed at 6 / s), breath,
   *  aim (the others' aimSpreadScale 0 - 255: PM_UpdateAimSpread on the same steps - the recorder's is in the demo)} */
  gunFollow(cl, t, W, P) {
    const STEP = 1000 / 60, v = k => P[k] || 0, G_SPEED = 190;
    let tm = Math.floor((t - SIM_MS) / STEP) * STEP;
    const org = [0, 0, 0], ang = [0, 0, 0];
    let idle = null, last = null, ground = null, aim = 0, wasGround = true;
    const shots = W ? null : this.shotsOf(cl);
    let shot = shots ? lower(shots, tm) + 1 : 0;
    const follow = (cur, target, rate, dt) => {
      if (target === cur) return cur;
      let d = dt * (target - cur) * rate;
      if (target > cur) { d = Math.max(d, dt * 0.1); return Math.min(target, cur + d); }
      d = Math.min(d, -dt * 0.1); return Math.max(target, cur + d);
    };
    while (tm < t) {
      const dt = Math.min(STEP, t - tm) / 1000;
      tm += dt * 1000;
      // (one input object per simulation: 150 steps a frame, nothing allocated per step)
      const inp = this.inputAt(cl, tm, W, P, this.scratchIn || (this.scratchIn = {}));
      if (!inp) continue;
      last = inp;
      const st = inp.prone ? 'prone' : inp.crouch ? 'ducked' : 'stand';
      // the position: *Move by the speed above *MoveMinSpeed, the *Ofs of the stance
      const target = this.scratchT || (this.scratchT = [0, 0, 0]), angT = this.scratchR || (this.scratchR = [0, 0, 0]);
      target[0] = target[1] = target[2] = angT[0] = angT[1] = angT[2] = 0;
      const mMin = v(st + 'MoveMinSpeed'), rMin = v(st + 'RotMinSpeed');
      if (inp.speed > mMin && !inp.reloading) {
        const sc = Math.min(1, (inp.speed - mMin) / (G_SPEED - mMin));
        target[0] = v(st + 'MoveF') * sc; target[1] = v(st + 'MoveR') * sc; target[2] = v(st + 'MoveU') * sc;
      }
      if (inp.crouch || inp.prone) { const o = inp.prone ? 'prone' : 'ducked'; target[0] += v(o + 'OfsF'); target[1] += v(o + 'OfsR'); target[2] += v(o + 'OfsU'); }
      if (inp.speed > rMin && !inp.reloading) {
        const sc = Math.min(1, (inp.speed - rMin) / (G_SPEED - rMin)) * (1 - inp.ads);
        angT[0] = v(st + 'RotP') * sc; angT[1] = v(st + 'RotY') * sc; angT[2] = v(st + 'RotR') * sc;
      }
      const mRate = inp.prone ? v('posProneMoveRate') : v('posMoveRate'), rRate = inp.prone ? v('posProneRotRate') : v('posRotRate');
      for (let a = 0; a < 3; a++) { org[a] = follow(org[a], target[a], mRate, dt); ang[a] = follow(ang[a], angT[a], rRate, dt); }
      // the idle sway's stance factor at 0.5 / s (not while scoped)
      const fT = inp.prone ? (P.idleProneFactor || 1) : inp.crouch ? (P.idleCrouchFactor || 1) : 1;
      if (idle == null) idle = fT;
      const scoped = P.adsOverlayReticle && P.adsOverlayReticle !== 'none';
      if (!scoped || inp.ads === 0) idle = idle < fT ? Math.min(fT, idle + dt * 0.5) : Math.max(fT, idle - dt * 0.5);
      const gT = inp.ground ? 1 : 0.3;
      ground = ground == null || W ? gT : ground < gT ? Math.min(gT, ground + dt * 6) : Math.max(gT, ground - dt * 6);
      if (!W) {
        // PM_UpdateAimSpread: the decay (hipSpreadDecayRate x the stance's factor, half in the air) unless something
        // adds - hipSpreadMoveAdd x speed / g_speed above bg_aimSpreadMoveSpeedThreshold, 2 x 1.28 in the air; nothing
        // while fully aiming. PM_Weapon_AddFiringAimSpreadScale: + hipSpreadFireAdd a shot, Jump_Start: + jump_spreadAdd
        // 64, moving prone: the maximum (PM_Weapon)
        let rate = v('hipSpreadDecayRate');
        if (!inp.ground) rate *= 0.5; else if (inp.prone) rate *= v('hipSpreadProneDecay'); else if (inp.crouch) rate *= v('hipSpreadDuckedDecay');
        let add = 0;
        if (inp.ads < 1) {
          if (v('hipSpreadMoveAdd') && inp.speed > AIM_SPEED_MIN) add += v('hipSpreadMoveAdd') * inp.speed / G_SPEED;
          if (!inp.ground) add += 2.56;
        }
        aim += (add > 0 ? add : -rate) * dt * 255;
        if (wasGround && !inp.ground) aim += JUMP_SPREAD_ADD;
        wasGround = inp.ground;
        for (; shot < shots.length && shots[shot] <= tm; shot++) if (inp.ads < 1) aim += v('hipSpreadFireAdd') * 255;
        if (inp.prone && inp.ads < 1 && inp.speed > AIM_SPEED_MIN) aim = 255;
        aim = aim < 0 ? 0 : aim > 255 ? 255 : aim;
      }
    }
    const ads = last ? last.ads : 0, k = ads === 0 ? 1 : ads < 0.5 ? 1 - 2 * ads : 0;
    return { org: org.map(x => x * k), ang: ang.map(x => x * k), idleFactor: idle == null ? 1 : idle,
      speed: last ? last.speed : 0, ground: ground == null ? 1 : ground, breath: last ? last.breath : 1, aim };
  }

  /** the lean (-1 .. 1) of client cl at t: the recorder's player state, else the entity's */
  leanAt(cl, t, W, ri) {
    const A2 = this.M.d.psAim;
    const lerp = (a, T, i, ok) => (ok && T[i + 1] > T[i] ? a[i] + (a[i + 1] - a[i]) * clamp01((t - T[i]) / (T[i + 1] - T[i])) : a[i]);
    if (W && A2 && ri < A2.t.length) return lerp(A2.lean, A2.t, ri, ri + 1 < A2.t.length && A2.client[ri + 1] === cl);
    const Ps = this.M.d.positions[cl];
    if (!Ps || !Ps.lean) return 0;
    const i = lower(Ps.t, t);
    return i >= 0 ? lerp(Ps.lean, Ps.t, i, i + 1 < Ps.t.length) : 0;
  }

  /** the eye's move by the lean at t (CG_CalcViewValues: AddLeanToPosition - 20 x f units along the right vector of the
   *  view's yaw with a roll of 16 x f degrees, f = GetLeanFraction) -> [x, y, z] or null */
  leanEye(cl, t, yaw) {
    const ri = this.recorderRow(cl, t), l = this.leanAt(cl, t, ri >= 0 ? this.rec.W : null, ri);
    if (!l) return null;
    const f = (2 - Math.abs(l)) * l, y = yaw * Math.PI / 180, r = 16 * f * Math.PI / 180, d = 20 * f;
    return [Math.cos(r) * Math.sin(y) * d, -Math.cos(r) * Math.cos(y) * d, -Math.sin(r) * d];
  }

  /** the recorder's stair steps per client: {t, from, amount}. The demo has no step event (pm->viewChange stays in the
   *  client's prediction): a step is the height between two snapshots on the ground that the vertical velocity does not
   *  explain (on a ramp the velocity follows the plane, on stairs it is level), at least cg_viewZSmoothingMin, at most a
   *  step (18 units: a teleport or a mantle is none) */
  stepsOf(cl) {
    const C = this.steps || (this.steps = new Map());
    let S = C.get(cl);
    if (S) return S;
    S = { t: [], from: [], amount: [] };
    C.set(cl, S);
    const W = this.rec && this.rec.W, P = this.M.d.positions[cl];
    if (!W || !P) return S;
    let j = 0, prev = null;
    for (let i = 0; i < W.t.length; i++) {
      if (W.client[i] !== cl) { prev = null; continue; }
      while (j < P.t.length && P.t[j] < W.t[i]) j++;
      if (j >= P.t.length) break;
      if (P.t[j] !== W.t[i]) { prev = null; continue; }
      if (prev && W.ground[i] !== NO_GROUND && W.ground[prev.i] !== NO_GROUND && W.t[i] - W.t[prev.i] <= 100) {
        // (the height moved, and more than the velocity says - a standing player keeps a small velocity into the ground)
        const dz = P.z[j] - prev.z, a = dz - (W.vz[i] + W.vz[prev.i]) / 2 * (W.t[i] - W.t[prev.i]) / 1000;
        const step = Math.sign(dz) * Math.min(Math.abs(dz), Math.abs(a));
        if (a * dz > 0 && Math.abs(step) >= STEP_MIN && Math.abs(dz) <= STEP_SIZE) { S.t.push(W.t[i]); S.from.push(W.t[prev.i]); S.amount.push(step); }
      }
      prev = { i, z: P.z[j] };
    }
    return S;
  }

  /** the height added to the first-person eye at t: the recorder's stair steps spread over cg_viewZSmoothingTime
   *  (CG_PredictPlayerState + CG_SmoothCameraZ: the eye keeps its height and follows a step within 100 ms, at most
   *  cg_viewZSmoothingMax behind - the game does so live, its demo playback does not). While the snapshots' interpolation
   *  already rises towards a step, that rise is held back too */
  stepOffset(cl, t) {
    const S = this.stepsOf(cl);
    if (!S.t.length) return 0;
    const k = lower(S.t, t);
    let off = 0;
    for (let i = k; i >= 0 && t - S.t[i] < STEP_MS; i--) off -= S.amount[i] * (1 - (t - S.t[i]) / STEP_MS);
    if (k + 1 < S.t.length && t > S.from[k + 1]) off -= S.amount[k + 1] * (t - S.from[k + 1]) / (S.t[k + 1] - S.from[k + 1]);
    return Math.max(-STEP_MAX, Math.min(STEP_MAX, off));
  }

  /** the recorder's hits: ps.damageEvent changed with a damageCount (CG_CheckPlayerstateEvents -> CG_DamageFeedback) */
  hitsOf(cl) {
    const C = this.hits || (this.hits = new Map());
    let L = C.get(cl);
    if (L) return L;
    L = { t: [], count: [], yaw: [], pitch: [] };
    C.set(cl, L);
    const H = this.M.d.psHud;
    for (let i = 1; H && i < H.t.length; i++) {
      if (H.client[i] !== cl || H.client[i - 1] !== cl || H.damageEvent[i] === H.damageEvent[i - 1] || !H.damageCount[i]) continue;
      L.t.push(H.t[i]); L.count.push(H.damageCount[i]); L.yaw.push(H.damageYaw[i]); L.pitch.push(H.damagePitch[i]);
    }
    return L;
  }

  /** the recorder's flinch when hit (CG_DamageFeedback, BG_CalculateView_DamageKick): the kick is the damage x bg_viewKickScale
   *  0.2 (5 .. 90) along the view - pitch by the damage direction's share forward, roll by its share to the left (no
   *  direction: pitch up by all of it) - rising over 100 ms and falling over the next 400 ms (GetLeanFraction), half as much at
   *  full ADS (x (1 + ADS / 2) with a scope) -> [pitch, roll] (degrees) or null */
  damageKick(cl, t, entryOf) {
    const L = this.hitsOf(cl), k = lower(L.t, t);
    if (k < 0 || t - L.t[k] >= 500) return null;
    const M = this.M, dt = t - L.t[k], A = M.d.psAim, r = A ? lower(A.t, t) : -1, ads = r >= 0 && A.client[r] === cl ? A.ads[r] : 0;
    const lf = f => f * (2 - Math.abs(f)), s0 = M.sampleAt(cl, t), e = s0 ? entryOf(M.weaponName(s0.weapon, t)) : null;
    let scale = 1 - 0.5 * ads;
    if (ads && e && e.params && e.params.overlayReticle && e.params.overlayReticle !== 'none') scale *= 1 + 0.5 * ads;
    const v = dt < 100 ? scale * lf(dt / 100) : (1 - lf((dt - 100) / 400)) * scale;
    const kick = Math.min(90, Math.max(5, L.count[k] * 0.2));
    if (L.yaw[k] === 255 && L.pitch[k] === 255) return [-kick * v, 0];
    const s = M.sampleAt(cl, L.t[k]);
    if (!s) return null;
    const D2 = Math.PI / 180, dy = L.yaw[k] / 255 * 360 * D2, dp = L.pitch[k] / 255 * 360 * D2;
    const dir = [Math.cos(dp) * Math.cos(dy), Math.cos(dp) * Math.sin(dy), -Math.sin(dp)];
    const vy = s.yaw * D2, vp = s.pitch * D2;
    const fw = [Math.cos(vp) * Math.cos(vy), Math.cos(vp) * Math.sin(vy), -Math.sin(vp)], left = [-Math.sin(vy), Math.cos(vy), 0];
    const kp = (dir[0] * fw[0] + dir[1] * fw[1] + dir[2] * fw[2]) * kick, kr = -kick * (dir[0] * left[0] + dir[1] * left[1]);
    return [kp * v, kr * v];
  }

  /** the first-person camera's bob at t (CG_OffsetFirstPersonView: BG_GetVerticalBobFactor / HorizontalBobFactor; the recorder's
   *  bobCycle, else the distance walked, one cycle per 2 steps) -> {up, right} (units). Promod sets bg_bobMax 0: none there */
  viewBob(cl, t, s, bobMax) {
    if (!bobMax) return null;
    const M = this.M, ri = this.recorderRow(cl, t), W = ri >= 0 ? this.rec.W : null;
    let cycle, speed, ampH, ampV;
    if (W) {
      let b = W.bob[ri];
      const nx = ri + 1 < W.t.length && W.client[ri + 1] === cl && W.t[ri + 1] > W.t[ri] ? ri + 1 : -1;
      const f = nx > 0 ? clamp01((t - W.t[ri]) / (W.t[nx] - W.t[ri])) : 0;
      if (nx > 0) { let d = W.bob[nx] - b; if (d < -128) d += 256; b += d * f; }
      cycle = b / 255 * Math.PI * 2 + Math.PI * 2;
      speed = Math.hypot(W.vx[ri] + (nx > 0 ? (W.vx[nx] - W.vx[ri]) * f : 0), W.vy[ri] + (nx > 0 ? (W.vy[nx] - W.vy[ri]) * f : 0));
    } else {
      const Ps = M.d.positions[cl], D = this.distOf ? this.distOf(cl) : null, i = lower(Ps.t, t);
      const a = M.sampleAt(cl, t - 50);
      speed = a ? Math.hypot(s.x - a.x, s.y - a.y) * 20 : 0;
      cycle = D && i >= 0 ? D[i] / 96 * Math.PI : 0;
    }
    const sprint = W && W.state[ri] >= 22 && W.state[ri] <= 23;
    [ampH, ampV] = s.prone ? BOB_AMP.prone : s.crouch ? BOB_AMP.ducked : sprint ? BOB_AMP.sprint : BOB_AMP.stand;
    const v = Math.min(bobMax, speed * ampV), h = Math.min(bobMax, speed * ampH);
    return { up: (Math.sin(4 * cycle + Math.PI / 2) * 0.2 + Math.sin(2 * cycle)) * 0.75 * v, right: Math.sin(cycle) * h };
  }

  /** the landing dip (units, <= 0) of client cl's view at t (CG_EntityEvent EV_LANDING / EV_LANDING_PAIN,
   *  CG_CalcViewValues): the event's parameter, or with fall damage 4 + (h - 12) / 26 x 4 (at most 24) of the
   *  fall height h (bg_fallDamageMinHeight / MaxHeight 128 / 300) - down over 150 ms, back over 300 ms */
  landDip(cl, t) {
    let L = this.lands;
    if (!L) {
      L = this.lands = new Map();
      for (const r of (this.M.d.sounds3d && this.M.d.sounds3d.events) || []) {
        const ev = r[2];
        let change = null;
        if (ev > 77 && ev < 105) change = -r[3];
        else if (ev > 106 && ev < 134) {
          const h = r[3] * 0.01 * (300 - 128) + 128;
          const dip = h > 12 ? Math.min(24, Math.floor((h - 12) / 26 * 4 + 4)) : 0;
          if (dip > 0) change = -dip;
        }
        if (change == null) continue;
        let a = L.get(r[1]); if (!a) L.set(r[1], a = { t: [], c: [] });
        a.t.push(r[0]); a.c.push(change);
      }
    }
    const a = L.get(cl);
    if (!a) return 0;
    const k = lower(a.t, t);
    if (k < 0) return 0;
    const d = t - a.t[k];
    if (d <= 0 || d >= 450) return 0;
    return a.c[k] * (d < 150 ? d / 150 : 1 - (d - 150) / 300);
  }

  /** the eye's height over the origin of client cl at t: the recorder's view height (interpolated), else
   *  the stance's (60 / 40 / 11) moving over PM_GetViewHeightLerpTime (200 ms; 400 ms to prone and up from
   *  prone to crouched) */
  eyeHeight(cl, t, s) {
    const H = x => x.prone ? 11 : x.crouch ? 40 : 60;
    const ri = this.recorderRow(cl, t), A2 = this.M.d.psAim;
    if (ri >= 0 && A2 && ri < A2.t.length) {
      let vh = A2.vh[ri];
      if (ri + 1 < A2.t.length && A2.client[ri + 1] === cl && A2.t[ri + 1] > A2.t[ri]) vh += (A2.vh[ri + 1] - vh) * clamp01((t - A2.t[ri]) / (A2.t[ri + 1] - A2.t[ri]));
      return vh;
    }
    const Ps = this.M.d.positions[cl], to = H(s);
    if (!Ps) return to;
    const i = lower(Ps.t, t);
    let j = i;
    const PF = window.C4.collect.PF, flag = k => (Ps.flags[k] & PF.PRONE) ? 11 : (Ps.flags[k] & PF.CROUCH) ? 40 : 60;
    while (j > 0 && flag(j - 1) === to && t - Ps.t[j - 1] < 1000) j--;
    if (j <= 0 || flag(j - 1) === to) return to;
    const from = flag(j - 1), since = t - (Ps.t[j - 1] + Ps.t[j]) / 2;
    const dur = to === 11 ? 400 : to === 40 ? (from === 11 ? 400 : 200) : 200;
    return from + (to - from) * clamp01(since / dur);
  }

  /** the gun kick's angles (deg: pitch up, yaw) at t: every shot of the last 1.2 s adds a speed in the
   *  weapon file's range, a spring (kick accel) pulls the gun back, the speed and the angle decay */
  kick(cl, t, P, ads) {
    const shots = this.shotsOf(cl);
    let k = lower(shots, t);
    const from = t - 1200;
    let j = k;
    while (j >= 0 && shots[j] > from) j--;
    if (k < 0 || j === k) return [0, 0];
    const pre = ads > 0.5 ? 'adsGunKick' : 'hipGunKick', g = n => P[pre + n] || 0;
    const accel = g('Accel') || 800, smax = g('SpeedMax') || 1200, sdec = g('SpeedDecay'), stat = g('StaticDecay');
    const ang = [0, 0], spd = [0, 0], dt = 0.005;
    let tm = shots[j + 1], next = j + 1;
    while (tm < t) {
      while (next <= k && shots[next] <= tm) {
        const r = hash01(shots[next] * 7 + cl);
        spd[0] += g('PitchMin') + (g('PitchMax') - g('PitchMin')) * r;
        spd[1] += g('YawMin') + (g('YawMax') - g('YawMin')) * hash01(shots[next] * 13 + cl);
        next++;
      }
      for (let a = 0; a < 2; a++) {
        spd[a] = Math.max(-smax, Math.min(smax, spd[a] - ang[a] * accel * dt));
        spd[a] *= Math.max(0, 1 - sdec * dt * 0.05);
        ang[a] += spd[a] * dt * 0.05;
        ang[a] *= Math.max(0, 1 - stat * dt * 0.05);
      }
      tm += dt * 1000;
    }
    return ang;
  }

  shotsOf(cl) {
    const key = 'shots' + cl;
    if (!this[key]) {
      const a = [];
      for (const r of this.M.d.weapEvents || []) if (r[1] === cl && SHOT_EVENTS.has(r[2])) a.push(r[0]);
      this[key] = Int32Array.from(a);
    }
    return this[key];
  }

  /** the crosshair's spread (deg): BG_GetSpreadForWeapon's stance minimum and maximum by the view height, between them
   *  aimSpreadScale (CG_CalcReticleSpread) - the recorder's from the player state, interpolated between the
   *  snapshots with his spread override and the steady aim perk; the others' simulated (gunFollow) */
  spread(cl, t, s, W, ri, P, ads) {
    const v = k => P[k] || 0, A2 = this.M.d.psAim, rec = W && A2 && ri < A2.t.length;
    const vh = this.eyeHeight(cl, t, s);
    let mn, mx;
    if (vh <= 40) { const f = clamp01((vh - 11) / 29); mn = v('hipSpreadProneMin') + (v('hipSpreadDuckedMin') - v('hipSpreadProneMin')) * f; mx = v('hipSpreadProneMax') + (v('hipSpreadDuckedMax') - v('hipSpreadProneMax')) * f; }
    else { const f = clamp01((vh - 40) / 20); mn = v('hipSpreadDuckedMin') + (v('hipSpreadStandMin') - v('hipSpreadDuckedMin')) * f; mx = v('hipSpreadDuckedMax') + (v('hipSpreadMax') - v('hipSpreadDuckedMax')) * f; }
    let scale;
    if (rec) {
      const n = ri + 1 < A2.t.length && A2.client[ri + 1] === cl && A2.t[ri + 1] > A2.t[ri] ? ri + 1 : ri;
      const f = n > ri ? clamp01((t - A2.t[ri]) / (A2.t[n] - A2.t[ri])) : 0;
      scale = (A2.aim[ri] + (A2.aim[n] - A2.aim[ri]) * f) / 255;
      const so = A2.spreadOverrideState[ri];                     // PSOS_RESETTING 1, PSOS_ENABLED 2
      if (so === 2) mn = mx = A2.spreadOverride[ri]; else if (so === 1) mx = A2.spreadOverride[ri];
      if (A2.perks[ri] & 2) { mn *= 0.65; mx *= 0.65; }          // perk_weapSpreadMultiplier
    } else scale = (this.simNow ? this.simNow.aim : 0) / 255;
    this.lastScale = scale;
    return (mx - mn) * scale + mn;
  }
}
