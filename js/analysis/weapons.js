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
  const ICONS = {
    'ak47.png': { size: [128, 32], box: [11, 0, 104, 32] },
    'akd74u.png': { size: [128, 64], box: [17, 10, 95, 44] },
    'benelli_m4.png': { size: [128, 32], box: [5, 3, 117, 27] },
    'car.png': { size: [64, 64], box: [3, 6, 60, 45] },
    'colt45.png': { size: [128, 64], box: [31, 10, 67, 43] },
    'desert_eagle.png': { size: [128, 64], box: [25, 10, 77, 43] },
    'falling.png': { size: [32, 32], box: [2, 0, 27, 32] },
    'g3.png': { size: [128, 32], box: [5, 0, 120, 31] },
    'g36c_mp.png': { size: [128, 64], box: [16, 15, 97, 38] },
    'grenade.png': { size: [64, 64], box: [0, 0, 64, 64] },
    'grenade_round.png': { size: [32, 32], box: [0, 0, 32, 32] },
    'headshot.png': { size: [32, 32], box: [1, 0, 31, 32] },
    'knife.png': { size: [64, 64], box: [2, 3, 61, 61] },
    'm14.png': { size: [128, 32], box: [0, 1, 128, 28] },
    'm16a4.png': { size: [128, 32], box: [6, 0, 117, 32] },
    'm40a3.png': { size: [128, 32], box: [0, 0, 128, 29] },
    'm4carbine.png': { size: [128, 64], box: [7, 14, 115, 37] },
    'm9beretta.png': { size: [128, 64], box: [33, 10, 63, 43] },
    'mini_uzi.png': { size: [64, 64], box: [1, 9, 62, 46] },
    'mp44.png': { size: [128, 64], box: [7, 14, 118, 42] },
    'mp5.png': { size: [128, 64], box: [17, 10, 97, 45] },
    'remington_700.png': { size: [128, 32], box: [0, 1, 126, 28] },
    'skorpian.png': { size: [64, 64], box: [1, 11, 63, 41] },
    'suicide.png': { size: [32, 32], box: [1, 1, 31, 30] },
    'usp_45.png': { size: [64, 64], box: [3, 12, 57, 40] },
    'winchester1200.png': { size: [128, 32], box: [0, 0, 128, 31] }
  };
  // base weapon (internal name without "_mp" and attachments) -> icon file
  const WEAPON_ICON = {
    ak47: 'ak47.png', ak74u: 'akd74u.png', m1014: 'benelli_m4.png', colt45: 'colt45.png',
    deserteagle: 'desert_eagle.png', deserteaglegold: 'desert_eagle.png', g3: 'g3.png', g36c: 'g36c_mp.png',
    frag_grenade: 'grenade.png', frag_grenade_short: 'grenade.png', gl: 'grenade_round.png',
    m14: 'm14.png', m16: 'm16a4.png', m40a3: 'm40a3.png', m4: 'm4carbine.png', beretta: 'm9beretta.png',
    uzi: 'mini_uzi.png', mp44: 'mp44.png', mp5: 'mp5.png', remington700: 'remington_700.png',
    skorpion: 'skorpian.png', usp: 'usp_45.png', winchester1200: 'winchester1200.png',
    knife: 'knife.png', destructible_car: 'car.png'
  };
  // means of death -> icon file (used when the obituary names no weapon)
  const MOD_ICON = { MOD_MELEE: 'knife.png', MOD_FALLING: 'falling.png', MOD_SUICIDE: 'suicide.png', MOD_HEAD_SHOT: 'headshot.png' };
  const ATTACH_RE = /_(silencer|acog|reflex|grip|gl|gold|bipod_stand|bipod_crouch|bipod_prone)$/;

  /** 'ak47_silencer_mp' -> 'ak47', 'gl_m16_mp' -> 'gl' (the launcher), 'deserteaglegold_mp' -> 'deserteaglegold' */
  function baseWeapon(name) {
    let n = String(name || '').toLowerCase().replace(/_mp$/, '');
    if (/^gl_/.test(n)) return 'gl';
    while (ATTACH_RE.test(n) && WEAPON_ICON[n] == null) n = n.replace(ATTACH_RE, '');
    return n;
  }
  const iconOf = (file, title, heuristic) => file && ICONS[file] ? Object.assign({ file, src: ICON_DIR + file, title, heuristic: !!heuristic }, ICONS[file]) : null;
  /** icon of an internal weapon name or a means of death (MOD_FALLING, MOD_MELEE ...; null if none) */
  function weaponIcon(name) {
    if (MOD_ICON[name]) return iconOf(MOD_ICON[name], MOD[name] || name);
    return iconOf(WEAPON_ICON[baseWeapon(name)], label(name));
  }

  /**
   * Killfeed icons of a kill - THE mapping for all tabs:
   * {weapon: icon | null, headshot: icon | null, text: label shown when there is no weapon icon}.
   * Suicide by an own weapon (grenade) shows that weapon, otherwise the suicide icon; falling ->
   * falling icon; a destroyed car -> car icon; a headshot -> weapon icon (the killer's held weapon,
   * marked heuristic) + headshot icon.
   */
  function killIcons(k) {
    const out = { weapon: null, headshot: null, text: killText(k) };
    if (k.headshot) out.headshot = iconOf(MOD_ICON.MOD_HEAD_SHOT, 'Headshot');
    if (k.falling) out.weapon = iconOf(MOD_ICON.MOD_FALLING, 'Falling');
    else if (k.car) out.weapon = iconOf('car.png', 'Car explosion');
    else if (k.weaponName && k.weaponName !== 'none') {
      const ic = WEAPON_ICON[baseWeapon(k.weaponName)];
      out.weapon = iconOf(ic, label(k.weaponName) + (k.weaponHeuristic ? ' (weapon the killer held - the obituary of a headshot names none)' : ''), k.weaponHeuristic);
    } else if (k.mod && MOD_ICON[k.mod] && k.mod !== 'MOD_HEAD_SHOT') out.weapon = iconOf(MOD_ICON[k.mod], MOD[k.mod] || k.mod);
    if (!out.weapon && k.suicide) out.weapon = iconOf(MOD_ICON.MOD_SUICIDE, 'Suicide');
    return out;
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
    isNonMissileWeapon, isBombKill, isCarKill, MOD_LABELS: MOD,
    ICONS, ICON_DIR, WEAPON_ICON, MOD_ICON, baseWeapon, weaponIcon, killIcons, killText };
});
