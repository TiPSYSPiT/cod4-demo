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

  C4.weapons = { label, grenadeKind, MOD_LABELS: MOD };
});
