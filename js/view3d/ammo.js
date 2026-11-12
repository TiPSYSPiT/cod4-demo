/* The first-person HUD's ammo as the game keeps and draws it (KisakCOD; DOM-free - also tools/audit/ammo_audit.mjs):
 *
 *   slots    The player state holds ammo[] per ammo slot and ammoclip[] per clip slot, not per weapon.
 *            BG_ClearWeaponDef (bgame/bg_weapons.cpp:189-201): slot 0 of both is weapon 0 ("none"). Then
 *            BG_SetupAmmoIndexes / BG_SetupClipIndexes (bg_weapons.cpp:236 / 304), in the weapons' registration order:
 *            a weapon takes the slot of the first earlier one with the same ammo / clip name (strcmp of the names the
 *            loader lowercased: bg_weapons_load_obj.cpp:1307), else the next new slot. The order is the demo's weapon list
 *            (config string 2258: weapon i + 1 = list entry i - cg_weapons.cpp:3980 checks it), its first entry the default
 *            weapon. Weapon 0's names are empty (the weapon files without ammo / clip names - the turrets - share slot 0;
 *            measured on the test demos: 99.99 % of the recorders' shots take the slot this gives).
 *   calibration  The names come from the weapon files we have (viewmodels.json "ammo": the stock files, Promod's
 *            differences); a server with other files (e.g. a league's Promod build) can pool its ammo differently. The
 *            demo shows its own slots: a shot takes one round from the held weapon's clip slot, a reload moves rounds from its
 *            ammo slot to its clip slot. Where the demo's evidence clearly says otherwise, it wins (AmmoBook.calibrate).
 *   display  CG_DrawPlayerAmmoValue (cgame_mp/cg_newDraw_mp.cpp:588): the weapon of the player state; the reserve
 *            BG_GetTotalAmmoReserve (bg_weapons.cpp:676) - ammo[ammo slot], a clip-only weapon's ammoclip[clip slot] and no
 *            clip; low clip: clipSize x lowAmmoWarningThreshold >= clip (CG_CheckPlayerForLowClipSpecific, :130); low
 *            reserve: 0.2 x the player's maximum >= reserve (CG_CheckPlayerForLowAmmoSpecific, :102 - the maximum: the
 *            weapon's maxAmmo, a clip-only weapon's clip size, a shared cap's size).
 *   offhand  CalcOffHandAmmo (cgame/offhandweapons.cpp:236): per offhand class the clips of the player's grenades of that
 *            class - here the distinct clip slots of the class's weapons in the list (the demo does not say which ones the
 *            player has; an empty slot adds 0). */
export const OFFHAND_CLASSES = ['Frag Grenade', 'Smoke Grenade', 'Flash Grenade'];
const STALE_MS = 1000;                      // a player state older than this: no HUD (the recorder watches someone else)
const lower = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };

/** the ammo fields of weapon n: viewmodels.json "ammo", on a Promod server with Promod's differences; null: unknown */
export function ammoParams(table, n, promod) {
  const A = table && table.ammo, P = A && A[n];
  if (!P) return null;
  const pm = promod && table.promod && table.promod.ammo && table.promod.ammo[n];
  if (!pm) return P;
  const out = Object.assign({}, P);
  for (const [k, v] of Object.entries(pm)) { if (v == null) delete out[k]; else out[k] = v; }
  return out;
}

/** BG_SetupAmmoIndexes / ClipIndexes over a weapon list -> Map name -> {index, ammo, clip, P} (P null: unknown weapon,
 *  its own slots - the engine's names are not known) */
export function slotTable(list, paramsOf) {
  const ammo = [''], clip = [''], out = new Map();          // slot 0: weapon 0, empty names
  list.forEach((raw, i) => {
    const n = String(raw).toLowerCase(), P = paramsOf(n);
    const an = P ? (P.ammoName || '') : '\0' + n, cn = P ? (P.clipName || '') : '\0' + n;
    let a = ammo.indexOf(an); if (a < 0) { a = ammo.length; ammo.push(an); }
    let c = clip.indexOf(cn); if (c < 0) { c = clip.length; clip.push(cn); }
    if (!out.has(n)) out.set(n, { index: i + 1, ammo: a, clip: c, P });
  });
  return out;
}

export class AmmoBook {
  /** d: the demo data (psAmmo, psWeapon, weaponLists), table: viewmodels.json, promod: a Promod server */
  constructor(d, table, promod) {
    this.d = d; this.table = table; this.promod = promod;
    this.paramsOf = n => ammoParams(table, n, promod);
    this.lists = (d.weaponLists || []).slice().sort((a, b) => a.t - b.t);
    this.tables = new Map();                 // list -> slotTable
    // the slots' values over time (psAmmo: [t, 0 ammo / 1 clip, slot, value] on every change)
    this.slots = [new Map(), new Map()];
    for (const [t, kind, slot, v] of d.psAmmo || []) {
      let s = this.slots[kind].get(slot);
      if (!s) this.slots[kind].set(slot, s = { t: [], v: [] });
      s.t.push(t); s.v.push(v);
    }
    this.calibrated = [];                    // (report) {list, weapon, kind, engine, demo, votes}
    this.calibrate();
  }

  listAt(t) {
    let list = null;
    for (const wl of this.lists) { if (wl.t <= t) list = wl.list; else break; }
    return list;
  }
  table_(list) {
    let tb = this.tables.get(list);
    if (!tb) this.tables.set(list, tb = slotTable(list, this.paramsOf));
    return tb;
  }
  value(kind, slot, t) {
    const s = this.slots[kind].get(slot);
    if (!s) return 0;
    const i = lower(s.t, t);
    return i >= 0 ? s.v[i] : 0;
  }
  offhandClipSlots(tb) {
    if (!tb.offClips) tb.offClips = new Set([...tb.values()].filter(e => e.P && e.P.offhandClass).map(e => e.clip));
    return tb.offClips;
  }

  /** the demo's own evidence (the recorder's snapshots with the same player and weapon as the one before): a shot - one
   *  clip slot down, an offhand's excluded (a grenade thrown with the weapon in hand) - votes for the weapon's clip slot; a
   *  reload - its clip slot up by x, one ammo slot down by x - for its ammo slot. A weapon with at least 3 votes, 60 % of
   *  them for one slot that is not the computed one, takes the demo's; an unknown weapon takes the demo's from 1 vote */
  calibrate() {
    const W = this.d.psWeapon, A = this.d.psAmmo || [];
    if (!W || !W.t.length) return;
    const votes = new Map();                 // list -> name -> [clip votes Map, ammo votes Map]
    const vote = (list, n, kind, slot) => {
      let L = votes.get(list); if (!L) votes.set(list, L = new Map());
      let v = L.get(n); if (!v) L.set(n, v = [new Map(), new Map()]);
      v[kind].set(slot, (v[kind].get(slot) || 0) + 1);
    };
    for (const pass of [1, 0]) {                         // clip slots first: the reloads need them
      const now = [new Map(), new Map()];
      let k = 0;
      for (let i = 1; i < W.t.length; i++) {
        const t = W.t[i], ch = [[], []];
        while (k < A.length && A[k][0] <= t) {
          const [tt, kind, slot, v] = A[k], p = now[kind].get(slot);
          if (tt > W.t[i - 1] && p != null && p !== v) ch[kind].push([slot, p, v]);
          now[kind].set(slot, v); k++;
        }
        if (W.client[i] !== W.client[i - 1] || W.weapon[i] !== W.weapon[i - 1] || !W.weapon[i] || W.client[i] >= 64) continue;
        const list = this.listAt(t);
        if (!list || W.weapon[i] > list.length) continue;
        const tb = this.table_(list), n = String(list[W.weapon[i] - 1]).toLowerCase(), e = tb.get(n);
        if (!e || (e.P && e.P.offhandClass)) continue;
        if (pass === 1) {
          const off = this.offhandClipSlots(tb), shot = ch[1].filter(c => c[2] < c[1] && !off.has(c[0]));
          if (shot.length === 1) vote(list, n, 1, shot[0][0]);
        } else {
          const clipSlot = this.slotOf(list, n, 1), up = ch[1].filter(c => c[0] === clipSlot && c[2] > c[1]);
          if (up.length !== 1) continue;
          const x = up[0][2] - up[0][1], down = ch[0].filter(c => c[1] - c[2] === x);
          if (down.length === 1) vote(list, n, 0, down[0][0]);
        }
      }
      // the demo's slots where its evidence is clear
      for (const [list, L] of votes) {
        const tb = this.table_(list);
        for (const [n, v] of L) {
          const kind = pass, m = v[kind], e = tb.get(n);
          if (!m.size) continue;
          let best = null, total = 0;
          for (const [slot, c] of m) { total += c; if (!best || c > best[1]) best = [slot, c]; }
          const engine = kind === 1 ? e.clip : e.ammo;
          if (best[0] === engine) continue;
          if ((e.P && total >= 3 && best[1] / total >= 0.6) || (!e.P && best[1] >= 1)) {
            (e.demo || (e.demo = {}))[kind === 1 ? 'clip' : 'ammo'] = best[0];
            this.calibrated.push({ list, weapon: n, kind: kind === 1 ? 'clip' : 'ammo', engine, demo: best[0], votes: best[1] + '/' + total });
          }
        }
      }
    }
  }

  /** the slot (kind 0 ammo, 1 clip) of weapon n in list: the demo's where calibrated, else the engine's */
  slotOf(list, n, kind) {
    const e = this.table_(list).get(n);
    if (!e) return null;
    const k = kind === 1 ? 'clip' : 'ammo';
    return e.demo && e.demo[k] != null ? e.demo[k] : e[k];
  }

  /** the HUD's numbers of client cl at t, or null (no player state of cl then): {weapon, P, clip (null: none drawn),
   *  reserve (null: unknown), lowClip, lowAmmo, offhand: [{cls, weapon, n}]} */
  at(cl, t) {
    const W = this.d.psWeapon;
    if (!W || !W.t.length) return null;
    const i = lower(W.t, t);
    if (i < 0 || W.client[i] !== cl || t - W.t[i] > STALE_MS) return null;
    const list = this.listAt(t);
    if (!list) return null;
    const tb = this.table_(list), w = W.weapon[i];
    const out = { weapon: null, P: null, clip: null, reserve: null, lowClip: false, lowAmmo: false, offhand: [] };
    // the grenades: per class the clips of its weapons (distinct slots), the weapon with rounds (else the first) for the icon
    for (const cls of OFFHAND_CLASSES) {
      const ws = [...tb.entries()].filter(([, e]) => e.P && e.P.offhandClass === cls);
      if (!ws.length) continue;
      const seen = new Set();
      let n = 0, icon = ws[0][0];
      for (const [name] of ws) {
        const s = this.slotOf(list, name, 1);
        if (seen.has(s)) continue;
        seen.add(s);
        const v = this.value(1, s, t);
        if (v > 0 && !n) icon = name;
        n += Math.max(0, v);
      }
      out.offhand.push({ cls, weapon: icon, n });
    }
    if (!w || w > list.length) return out;
    const n = String(list[w - 1]).toLowerCase(), e = tb.get(n);
    out.weapon = n;
    if (!e) return out;
    const P = e.P;
    out.P = P;
    const known = P || e.demo;              // (an unknown weapon: numbers only from the demo's own slots)
    if (!known) return out;
    const clip = this.value(1, this.slotOf(list, n, 1), t), ammo = this.value(0, this.slotOf(list, n, 0), t);
    const clipOnly = !!(P && P.clipOnly);
    out.clip = clipOnly ? null : Math.min(999, clip);
    out.reserve = Math.min(999, clipOnly ? clip : ammo);
    if (P) {
      const size = Math.min(999, P.clipSize || 0);
      out.lowClip = !clipOnly && clip >= 0 && size > 0 && size * (P.lowAmmoWarningThreshold || 0) >= clip;
      const max = Math.min(999, P.sharedAmmoCap != null && P.sharedAmmoCapName ? P.sharedAmmoCap : clipOnly ? (P.clipSize || 0) : (P.maxAmmo || 0));
      out.lowAmmo = max >= 0 && max * 0.2 >= out.reserve;
    }
    return out;
  }
}
