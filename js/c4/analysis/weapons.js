/* Readable weapon names. The weapon list itself comes from config string 2258
 * of the demo; this table only turns the internal names into labels. */
C4.define('weapons', function (C4) {
  'use strict';
  const BASE = {
    ak47: 'AK-47', ak74u: 'AK-74u', m16: 'M16A4', m4: 'M4 Carbine', g3: 'G3', g36c: 'G36C',
    m14: 'M14', mp44: 'MP44', mp5: 'MP5', skorpion: 'Skorpion', uzi: 'Mini-Uzi', p90: 'P90',
    m1014: 'M1014', winchester1200: 'W1200', rpd: 'RPD', saw: 'M249 SAW', m60e4: 'M60E4',
    dragunov: 'Dragunov', m40a3: 'M40A3', barrett: 'Barrett .50cal', remington700: 'R700',
    m21: 'M21', beretta: 'M9', usp: 'USP .45', colt45: 'M1911 .45', deserteagle: 'Desert Eagle',
    deserteaglegold: 'Gold Desert Eagle', frag_grenade: 'Frag Grenade',
    frag_grenade_short: 'Frag Grenade (Martyrdom)', concussion_grenade: 'Stun Grenade',
    flash_grenade: 'Flashbang', smoke_grenade: 'Smoke Grenade', c4: 'C4', claymore: 'Claymore',
    rpg: 'RPG-7', at4: 'AT4', gl: 'Grenade Launcher', airstrike: 'Airstrike',
    artillery: 'Airstrike', cobra_20mm: 'Attack Helicopter', cobra_ffar: 'Attack Helicopter',
    hind_ffar: 'Attack Helicopter', helicopter: 'Attack Helicopter',
    destructible_car: 'Car Explosion', explodable_barrel: 'Barrel Explosion',
    briefcase_bomb: 'Bomb', briefcase_bomb_defuse: 'Bomb (defuse kit)',
    defaultweapon: 'Default Weapon', knife: 'Knife', none: 'None'
  };
  const ATTACHMENTS = [
    ['_silencer', 'Silenced'], ['_acog', 'ACOG'], ['_reflex', 'Red Dot'], ['_grip', 'Grip'],
    ['_gl', 'Grenade Launcher'], ['_gold', 'Gold']
  ];
  const MOD = {
    MOD_UNKNOWN: 'Unknown', MOD_PISTOL_BULLET: 'Pistol', MOD_RIFLE_BULLET: 'Rifle',
    MOD_GRENADE: 'Grenade', MOD_GRENADE_SPLASH: 'Grenade Splash', MOD_PROJECTILE: 'Projectile',
    MOD_PROJECTILE_SPLASH: 'Projectile Splash', MOD_MELEE: 'Knife', MOD_HEAD_SHOT: 'Headshot',
    MOD_CRUSH: 'Crushed', MOD_TELEFRAG: 'Telefrag', MOD_FALLING: 'Falling', MOD_SUICIDE: 'Suicide',
    MOD_TRIGGER_HURT: 'Trigger', MOD_EXPLOSIVE: 'Explosive', MOD_IMPACT: 'Impact'
  };

  /** 'ak47_reflex_mp' -> 'AK-47 (Red Dot)', 'MOD_FALLING' -> 'Falling' */
  function label(name) {
    if (!name) return '';
    if (MOD[name]) return MOD[name];
    let base = String(name).toLowerCase().replace(/_mp$/, '');
    if (BASE[base]) return BASE[base];
    let suffix = '';
    for (const [tag, lab] of ATTACHMENTS) {
      if (base.endsWith(tag) && BASE[base.slice(0, -tag.length)]) {
        base = base.slice(0, -tag.length);
        suffix = ' (' + lab + ')';
        break;
      }
    }
    if (BASE[base]) return BASE[base] + suffix;
    return base.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + suffix;
  }

  /** grenade kind of a weapon name, or null */
  function grenadeKind(name) {
    const n = String(name || '').toLowerCase();
    if (n.startsWith('smoke_grenade')) return 'smoke';
    if (n.startsWith('flash_grenade')) return 'flash';
    if (n.startsWith('concussion_grenade')) return 'concussion';
    if (n.startsWith('frag_grenade')) return 'frag';
    return null;
  }

  /** internal weapon name without case and "_mp" ('Briefcase_Bomb_MP' -> 'briefcase_bomb') */
  const plainName = name => String(name || '').toLowerCase().replace(/_mp$/, '');

  /** frag grenade kill weapon ("nade"): frag_grenade_mp only - cooked or not, the obituary names the
   * same weapon. Martyrdom (frag_grenade_short_mp) and the grenade launcher (gl_*, *_gl_*) are not nades. */
  function isFragNade(name) {
    return plainName(name) === 'frag_grenade';
  }
  /** the S&D bomb (briefcase_bomb_mp): its explosion kills. The defuse kit is another weapon. */
  function isBombWeapon(name) { return plainName(name) === 'briefcase_bomb'; }
  /** the bomb defuse kit (briefcase_bomb_defuse_mp): carried while defusing, kills nobody */
  function isDefuseKitWeapon(name) { return plainName(name) === 'briefcase_bomb_defuse'; }
  /** an exploding car (destructible_car): a map entity, not a player weapon */
  function isCarWeapon(name) { return plainName(name) === 'destructible_car'; }
  /** weapons that are never thrown as a missile (a missile with such a weapon means the weapon list
   * does not match the weapon indices - tools/selftest) */
  function isNonMissileWeapon(name) { return isBombWeapon(name) || isDefuseKitWeapon(name) || isCarWeapon(name); }
  // the weapon named by the obituary (never the held weapon guessed for a headshot)
  const obituaryWeapon = kill => (kill && kill.weapon != null && !kill.weaponHeuristic ? kill.weaponName : null);
  /** killed by the bomb explosion */
  function isBombKill(kill) { return isBombWeapon(obituaryWeapon(kill)); }
  /** killed by an exploding car */
  function isCarKill(kill) { return isCarWeapon(obituaryWeapon(kill)); }

  /**
   * THE rule for a frag grenade kill ("nade"), used by the scoreboard (Nade K / Nade D), Round by
   * Round, the JSON export and tools/selftest: the weapon named by the obituary (never the held
   * weapon guessed for a headshot) is frag_grenade_mp. The name must come from the weapon list of
   * the map loaded at the time of the kill (DemoData resolves it so). Who gets what is up to the
   * caller: killer -> Nade K unless team kill / suicide, victim -> Nade D always.
   */
  function isFragGrenadeKill(kill) {
    return isFragNade(obituaryWeapon(kill));
  }

  /* ---- killfeed icons (assets/killfeed) ----
   * All icons point left -> right (killer -> victim). box = [x, y, w, h] of the visible content in
   * the image (measured once from the alpha channel; image size in size) - the UI scales the
   * content to one height, so icons with a transparent margin are not drawn smaller. */
  const ICON_DIR = 'assets/killfeed/';
  // <killicons> generated by tools/export/killicons_export.py: the images, the weapon files' killIcon, killIconRatio, flipKillIcon
  const ICONS = {
    "bombplanted.png": {"size": [32, 32], "box": [11, 9, 10, 15]},
    "compass_objpoint_satallite.png": {"size": [32, 32], "box": [1, 2, 26, 30]},
    "death_airstrike.png": {"size": [128, 32], "box": [0, 0, 128, 32]},
    "death_car.png": {"size": [64, 64], "box": [3, 6, 60, 45]},
    "death_crush.png": {"size": [32, 32], "box": [0, 0, 32, 32]},
    "death_falling.png": {"size": [32, 32], "box": [2, 0, 28, 32]},
    "death_grenade_round.png": {"size": [32, 32], "box": [0, 0, 32, 32]},
    "death_headshot.png": {"size": [32, 32], "box": [1, 0, 31, 32]},
    "death_heli.png": {"size": [128, 32], "box": [0, 0, 124, 32]},
    "death_knife.png": {"size": [64, 64], "box": [2, 3, 61, 61]},
    "death_suicide.png": {"size": [32, 32], "box": [1, 1, 31, 30]},
    "hud_40mmgrenade.png": {"size": [64, 32], "box": [3, 7, 59, 17]},
    "hud_ak47.png": {"size": [128, 32], "box": [13, 0, 104, 32]},
    "hud_akd74u.png": {"size": [128, 64], "box": [16, 10, 95, 44]},
    "hud_at4.png": {"size": [128, 32], "box": [6, 4, 116, 24]},
    "hud_barrett50cal.png": {"size": [128, 64], "box": [1, 16, 125, 31]},
    "hud_benelli_m4.png": {"size": [128, 32], "box": [6, 3, 117, 27]},
    "hud_c4.png": {"size": [64, 64], "box": [9, 12, 45, 39]},
    "hud_claymore.png": {"size": [32, 32], "box": [3, 1, 26, 30]},
    "hud_colt45.png": {"size": [128, 64], "box": [30, 10, 67, 43]},
    "hud_desert_eagle.png": {"size": [128, 64], "box": [26, 10, 77, 43]},
    "hud_dragunovsvd.png": {"size": [128, 32], "box": [0, 2, 128, 27]},
    "hud_enfield_scoped.png": {"size": [128, 32], "box": [1, 3, 127, 23]},
    "hud_g3.png": {"size": [128, 32], "box": [3, 0, 120, 32]},
    "hud_g36c_mp.png": {"size": [128, 64], "box": [15, 15, 97, 38]},
    "hud_m14.png": {"size": [128, 32], "box": [0, 1, 128, 29]},
    "hud_m14_scoped.png": {"size": [128, 32], "box": [0, 0, 128, 31]},
    "hud_m16a4_m203.png": {"size": [128, 32], "box": [4, 0, 119, 32]},
    "hud_m249saw.png": {"size": [128, 64], "box": [4, 14, 120, 36]},
    "hud_m249saw_mounted.png": {"size": [128, 64], "box": [4, 14, 120, 44]},
    "hud_m40a3.png": {"size": [128, 32], "box": [0, 0, 128, 29]},
    "hud_m4carbine.png": {"size": [128, 64], "box": [6, 14, 115, 37]},
    "hud_m60e4.png": {"size": [128, 32], "box": [0, 0, 128, 31]},
    "hud_m9beretta.png": {"size": [128, 64], "box": [32, 10, 63, 43]},
    "hud_mini_uzi.png": {"size": [64, 64], "box": [1, 9, 62, 46]},
    "hud_mp44.png": {"size": [128, 64], "box": [3, 14, 118, 42]},
    "hud_mp5.png": {"size": [128, 64], "box": [14, 10, 97, 45]},
    "hud_p90.png": {"size": [128, 64], "box": [23, 11, 83, 38]},
    "hud_remington_700.png": {"size": [128, 32], "box": [2, 1, 126, 28]},
    "hud_rpd.png": {"size": [128, 64], "box": [2, 15, 124, 33]},
    "hud_rpg.png": {"size": [128, 32], "box": [1, 0, 126, 31]},
    "hud_skorpian.png": {"size": [64, 64], "box": [0, 11, 63, 41]},
    "hud_us_grenade.png": {"size": [64, 64], "box": [0, 0, 64, 64]},
    "hud_us_stungrenade.png": {"size": [64, 64], "box": [0, 4, 64, 59]},
    "hud_usp_45.png": {"size": [64, 64], "box": [3, 12, 58, 40]},
    "hud_winchester1200.png": {"size": [128, 32], "box": [0, 0, 128, 31]}
  };
  // weapon -> 'image|killIconRatio|flipKillIcon' (the weapon files)
  const KILL_ICON = {
    "airstrike_mp": "death_airstrike.png|1|0",
    "ak47_acog_mp": "hud_ak47.png|4|1",
    "ak47_gl_mp": "hud_ak47.png|4|1",
    "ak47_mp": "hud_ak47.png|4|1",
    "ak47_reflex_mp": "hud_ak47.png|4|1",
    "ak47_silencer_mp": "hud_ak47.png|4|1",
    "ak74u_acog_mp": "hud_akd74u.png|2|1",
    "ak74u_mp": "hud_akd74u.png|2|1",
    "ak74u_reflex_mp": "hud_akd74u.png|2|1",
    "ak74u_silencer_mp": "hud_akd74u.png|2|1",
    "artillery_mp": "death_airstrike.png|4|0",
    "at4_mp": "hud_at4.png|4|1",
    "aw50_acog_mp": "hud_enfield_scoped.png|4|1",
    "aw50_mp": "hud_enfield_scoped.png|4|1",
    "barrett_acog_mp": "hud_barrett50cal.png|2|1",
    "barrett_mp": "hud_barrett50cal.png|2|1",
    "beretta_mp": "hud_m9beretta.png|2|1",
    "beretta_silencer_mp": "hud_m9beretta.png|2|1",
    "briefcase_bomb_defuse_mp": "hud_c4.png|1|0",
    "briefcase_bomb_mp": "hud_c4.png|1|0",
    "c4_mp": "hud_c4.png|1|0",
    "claymore_mp": "hud_claymore.png|1|0",
    "cobra_20mm_mp": "death_heli.png|4|1",
    "cobra_ffar_mp": "death_heli.png|4|1",
    "colt45_mp": "hud_colt45.png|2|1",
    "colt45_silencer_mp": "hud_colt45.png|2|1",
    "concussion_grenade_mp": "hud_us_stungrenade.png|1|1",
    "defaultweapon_mp": "hud_ak47.png|1|1",
    "deserteagle_mp": "hud_desert_eagle.png|2|1",
    "deserteaglegold_mp": "hud_desert_eagle.png|2|1",
    "destructible_car": "death_car.png|1|0",
    "dragunov_acog_mp": "hud_dragunovsvd.png|4|1",
    "dragunov_mp": "hud_dragunovsvd.png|4|1",
    "frag_grenade_mp": "hud_us_grenade.png|1|1",
    "frag_grenade_short_mp": "hud_us_grenade.png|1|1",
    "g36c_acog_mp": "hud_g36c_mp.png|2|1",
    "g36c_gl_mp": "hud_g36c_mp.png|2|1",
    "g36c_mp": "hud_g36c_mp.png|2|1",
    "g36c_reflex_mp": "hud_g36c_mp.png|2|1",
    "g36c_silencer_mp": "hud_g36c_mp.png|2|1",
    "g3_acog_mp": "hud_g3.png|4|1",
    "g3_gl_mp": "hud_g3.png|4|1",
    "g3_mp": "hud_g3.png|4|1",
    "g3_reflex_mp": "hud_g3.png|4|1",
    "g3_silencer_mp": "hud_g3.png|4|1",
    "gl_ak47_mp": "hud_40mmgrenade.png|2|0",
    "gl_g36c_mp": "hud_40mmgrenade.png|2|0",
    "gl_g3_mp": "hud_40mmgrenade.png|2|0",
    "gl_m14_mp": "hud_40mmgrenade.png|2|0",
    "gl_m16_mp": "hud_40mmgrenade.png|2|0",
    "gl_m4_mp": "hud_40mmgrenade.png|2|0",
    "gl_mp": "hud_40mmgrenade.png|2|0",
    "helicopter_mp": "death_heli.png|1|0",
    "hind_ffar_mp": "death_heli.png|4|1",
    "location_selector_mp": "bombplanted.png|1|0",
    "m1014_grip_mp": "hud_benelli_m4.png|4|1",
    "m1014_mp": "hud_benelli_m4.png|4|1",
    "m1014_reflex_mp": "hud_benelli_m4.png|4|1",
    "m14_acog_mp": "hud_m14.png|4|1",
    "m14_gl_mp": "hud_m14.png|4|1",
    "m14_mp": "hud_m14.png|4|1",
    "m14_reflex_mp": "hud_m14.png|4|1",
    "m14_silencer_mp": "hud_m14.png|4|1",
    "m16_acog_mp": "hud_m16a4_m203.png|4|1",
    "m16_gl_mp": "hud_m16a4_m203.png|4|1",
    "m16_mp": "hud_m16a4_m203.png|4|1",
    "m16_reflex_mp": "hud_m16a4_m203.png|4|1",
    "m16_silencer_mp": "hud_m16a4_m203.png|4|1",
    "m21_acog_mp": "hud_m14_scoped.png|4|1",
    "m21_mp": "hud_m14_scoped.png|4|1",
    "m40a3_acog_mp": "hud_m40a3.png|4|1",
    "m40a3_mp": "hud_m40a3.png|4|1",
    "m4_acog_mp": "hud_m4carbine.png|2|1",
    "m4_gl_mp": "hud_m4carbine.png|2|1",
    "m4_mp": "hud_m4carbine.png|2|1",
    "m4_reflex_mp": "hud_m4carbine.png|2|1",
    "m4_silencer_mp": "hud_m4carbine.png|2|1",
    "m60e4_acog_mp": "hud_m60e4.png|4|1",
    "m60e4_grip_mp": "hud_m60e4.png|4|1",
    "m60e4_mp": "hud_m60e4.png|4|1",
    "m60e4_reflex_mp": "hud_m60e4.png|4|1",
    "mp44_mp": "hud_mp44.png|2|1",
    "mp5_acog_mp": "hud_mp5.png|2|1",
    "mp5_mp": "hud_mp5.png|2|1",
    "mp5_reflex_mp": "hud_mp5.png|2|1",
    "mp5_silencer_mp": "hud_mp5.png|2|1",
    "p90_acog_mp": "hud_p90.png|2|1",
    "p90_mp": "hud_p90.png|2|1",
    "p90_reflex_mp": "hud_p90.png|2|1",
    "p90_silencer_mp": "hud_p90.png|2|1",
    "radar_mp": "compass_objpoint_satallite.png|1|0",
    "remington700_acog_mp": "hud_remington_700.png|4|1",
    "remington700_mp": "hud_remington_700.png|4|1",
    "rpd_acog_mp": "hud_rpd.png|2|1",
    "rpd_grip_mp": "hud_rpd.png|2|1",
    "rpd_mp": "hud_rpd.png|2|1",
    "rpd_reflex_mp": "hud_rpd.png|2|1",
    "rpg_mp": "hud_rpg.png|4|1",
    "saw_acog_mp": "hud_m249saw.png|2|1",
    "saw_bipod_crouch_mp": "hud_m249saw_mounted.png|2|1",
    "saw_bipod_prone_mp": "hud_m249saw_mounted.png|2|1",
    "saw_bipod_stand_mp": "hud_m249saw_mounted.png|2|1",
    "saw_grip_mp": "hud_m249saw.png|2|1",
    "saw_mp": "hud_m249saw.png|2|1",
    "saw_reflex_mp": "hud_m249saw.png|2|1",
    "skorpion_acog_mp": "hud_skorpian.png|1|1",
    "skorpion_mp": "hud_skorpian.png|1|1",
    "skorpion_reflex_mp": "hud_skorpian.png|1|1",
    "skorpion_silencer_mp": "hud_skorpian.png|1|1",
    "smoke_grenade_mp": "hud_us_grenade.png|4|1",
    "usp_mp": "hud_usp_45.png|1|1",
    "usp_silencer_mp": "hud_usp_45.png|1|1",
    "uzi_acog_mp": "hud_mini_uzi.png|1|1",
    "uzi_mp": "hud_mini_uzi.png|1|1",
    "uzi_reflex_mp": "hud_mini_uzi.png|1|1",
    "uzi_silencer_mp": "hud_mini_uzi.png|1|1",
    "winchester1200_grip_mp": "hud_winchester1200.png|4|1",
    "winchester1200_mp": "hud_winchester1200.png|4|1",
    "winchester1200_reflex_mp": "hud_winchester1200.png|4|1"
  };
  // the means of death the client draws itself (CG_Obituary; DIED: anything without an icon)
  const MOD_ICON = {"MOD_MELEE": "death_knife.png", "MOD_HEAD_SHOT": "death_headshot.png", "MOD_CRUSH": "death_crush.png", "MOD_FALLING": "death_falling.png", "MOD_SUICIDE": "death_suicide.png", "MOD_DIED": "death_suicide.png", "MOD_IMPACT": "death_grenade_round.png"};
  // </killicons>
  // CG_Obituary: baseIconSize 1.4 lines; the ratio makes it 1.4 x 1.4, 2.8 x 1.4 (2:1) or 2.8 x 0.7 (4:1) lines
  const ICON_LINES = { 1: [1.4, 1.4], 2: [2.8, 1.4], 4: [2.8, 0.7] };
  const ATTACH_RE = /_(silencer|acog|reflex|grip|gl|gold|bipod_stand|bipod_crouch|bipod_prone)$/;

  /** 'ak47_silencer_mp' -> 'ak47', 'gl_m16_mp' -> 'gl' (the launcher), 'deserteaglegold_mp' -> 'deserteaglegold' */
  function baseWeapon(name) {
    let n = String(name || '').toLowerCase().replace(/_mp$/, '');
    if (/^gl_/.test(n)) return 'gl';
    while (ATTACH_RE.test(n)) n = n.replace(ATTACH_RE, '');
    return n;
  }
  /** an icon: its file, the visible box, the size in lines of text and whether it is mirrored - THE data of every view */
  const iconOf = (file, title, heuristic, ratio = 1, flip = false) => (file && ICONS[file]
    ? Object.assign({ file, src: ICON_DIR + file, title, heuristic: !!heuristic, lines: ICON_LINES[ratio] || ICON_LINES[1], flip: !!flip }, ICONS[file]) : null);
  /** the weapon's entry of the weapon files: exact, else with _mp, else the base weapon's */
  function killIconOf(name, title, heuristic) {
    const n = String(name || '').toLowerCase();
    const e = KILL_ICON[n] || KILL_ICON[n + '_mp'] || KILL_ICON[baseWeapon(n) + '_mp'];
    if (!e) return null;
    const [file, ratio, flip] = e.split('|');
    return iconOf(file, title, heuristic, Number(ratio), flip === '1');
  }
  /** icon of an internal weapon name or a means of death (MOD_FALLING, MOD_MELEE ...; null if none) */
  function weaponIcon(name) {
    if (MOD_ICON[name]) return iconOf(MOD_ICON[name], MOD[name] || name);
    return killIconOf(name, label(name));
  }
  // GScr_Obituary: these means of death reach the client instead of the weapon, the others with it
  const OWN_ICON = new Set(['MOD_MELEE', 'MOD_HEAD_SHOT', 'MOD_CRUSH', 'MOD_FALLING', 'MOD_SUICIDE', 'MOD_IMPACT']);

  /**
   * Killfeed icons of a kill - THE mapping for all tabs:
   * {game: the icon of the game's obituary (CG_Obituary: a headshot's, the means of death's, else the weapon's or the died icon),
   *  weapon: icon | null, headshot: icon | null (the lists show both: the weapon a headshot's obituary leaves out is known from
   *  the held weapon, marked heuristic), text: label shown when there is no weapon icon}.
   */
  function killIcons(k) {
    const out = { weapon: null, headshot: null, game: null, text: killText(k) };
    if (k.headshot) out.headshot = iconOf(MOD_ICON.MOD_HEAD_SHOT, 'Headshot');
    if (k.falling) out.weapon = iconOf(MOD_ICON.MOD_FALLING, 'Falling');
    else if (k.car) out.weapon = killIconOf('destructible_car', 'Car explosion');
    else if (k.mod && OWN_ICON.has(k.mod) && k.mod !== 'MOD_HEAD_SHOT') out.weapon = iconOf(MOD_ICON[k.mod], MOD[k.mod] || k.mod);
    else if (k.weaponName && k.weaponName !== 'none') {
      out.weapon = killIconOf(k.weaponName, label(k.weaponName) + (k.weaponHeuristic ? ' (weapon the killer held - the obituary of a headshot names none)' : ''), k.weaponHeuristic);
    }
    if (!out.weapon && k.suicide) out.weapon = iconOf(MOD_ICON.MOD_SUICIDE, 'Suicide');
    out.game = out.headshot || out.weapon || iconOf(MOD_ICON.MOD_DIED, 'Died');
    return out;
  }
  /**
   * THE weapon of a kill for weapon lists (scoreboard popups, POV tab): the internal weapon name, or a
   * means of death that stands for a weapon (knife MOD_MELEE, falling ...), or null = unknown.
   * Never MOD_HEAD_SHOT: a headshot is no weapon (the kill keeps its real weapon, build.js resolves
   * it; the headshot is k.headshot).
   */
  function killWeapon(k) {
    if (k.weaponName && k.weaponName !== 'none') return k.weaponName;
    if (k.mod && k.mod !== 'MOD_HEAD_SHOT') return k.mod;
    return null;
  }

  /** killfeed text of a kill (shown when there is no weapon icon) */
  function killText(k) {
    const lab = k.weaponLabel || '';
    if (k.suicide) return k.mod === 'MOD_SUICIDE' ? MOD.MOD_SUICIDE : 'Suicide (' + lab + ')';
    if (k.world) return k.falling ? MOD.MOD_FALLING : 'World / trigger (' + lab + ')';
    if (k.entityAttacker) return k.car ? 'Car explosion' : 'World entity (' + lab + ')';
    return lab;
  }

  C4.weapons = { label, grenadeKind, isFragNade, isFragGrenadeKill, isBombWeapon, isDefuseKitWeapon, isCarWeapon,
    isNonMissileWeapon, isBombKill, isCarKill, killWeapon, MOD_LABELS: MOD,
    ICONS, ICON_DIR, KILL_ICON, MOD_ICON, baseWeapon, weaponIcon, killIcons, killText };
});
