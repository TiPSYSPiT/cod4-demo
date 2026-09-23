/* Engine constants of CoD4 MP (patch 1.7); verified against KisakCOD and the
 * sample demos, see python/cod4demo/constants.py for the sources. */
C4.define('constants', function (C4) {
  'use strict';
  const EVENT_NAMES = [
    'none', 'foliage_sound', 'stop_weapon_sound', 'sound_alias', 'sound_alias_as_master',
    'stopsounds', 'stance_force_stand', 'stance_force_crouch', 'stance_force_prone',
    'item_pickup', 'ammo_pickup', 'noammo', 'emptyclip', 'empty_offhand', 'reset_ads',
    'reload', 'reload_from_empty', 'reload_start', 'reload_end', 'reload_start_notify',
    'reload_addammo', 'raise_weapon', 'first_raise_weapon', 'putaway_weapon', 'weapon_alt',
    'pullback_weapon', 'fire_weapon', 'fire_weapon_lastshot', 'rechamber_weapon',
    'eject_brass', 'melee_swipe', 'fire_melee', 'prep_offhand', 'use_offhand',
    'switch_offhand', 'melee_hit', 'melee_miss', 'melee_blood', 'fire_weapon_mg42',
    'fire_quadbarrel_1', 'fire_quadbarrel_2', 'bullet_hit', 'bullet_hit_client_small',
    'bullet_hit_client_large', 'grenade_bounce', 'grenade_explode', 'rocket_explode',
    'rocket_explode_nomarks', 'flashbang_explode', 'custom_explode',
    'custom_explode_nomarks', 'change_to_dud', 'dud_explode', 'dud_impact', 'bullet',
    'play_fx', 'play_fx_on_tag', 'phys_explosion_sphere', 'phys_explosion_cylinder',
    'phys_explosion_jolt', 'phys_jitter', 'earthquake', 'grenade_suicide', 'detonate',
    'nightvision_wear', 'nightvision_remove', 'obituary'
  ];
  const EV = {
    OBITUARY: 66, BULLET_HIT: 41, BULLET_HIT_CLIENT_SMALL: 42, BULLET_HIT_CLIENT_LARGE: 43,
    GRENADE_BOUNCE: 44, GRENADE_EXPLODE: 45, ROCKET_EXPLODE: 46, ROCKET_EXPLODE_NOMARKS: 47,
    FLASHBANG_EXPLODE: 48, CUSTOM_EXPLODE: 49, CUSTOM_EXPLODE_NOMARKS: 50, FIRE_WEAPON: 26,
    FIRE_WEAPON_LASTSHOT: 27
  };
  const ET = { GENERAL: 0, PLAYER: 1, PLAYER_CORPSE: 2, ITEM: 3, MISSILE: 4, EVENTS: 17 };
  const MEANS_OF_DEATH = [
    'MOD_UNKNOWN', 'MOD_PISTOL_BULLET', 'MOD_RIFLE_BULLET', 'MOD_GRENADE', 'MOD_GRENADE_SPLASH',
    'MOD_PROJECTILE', 'MOD_PROJECTILE_SPLASH', 'MOD_MELEE', 'MOD_HEAD_SHOT', 'MOD_CRUSH',
    'MOD_TELEFRAG', 'MOD_FALLING', 'MOD_SUICIDE', 'MOD_TRIGGER_HURT', 'MOD_EXPLOSIVE', 'MOD_IMPACT'
  ];
  const TEAM = { FREE: 0, AXIS: 1, ALLIES: 2, SPECTATOR: 3 };
  const TEAM_NAMES = ['free', 'axis', 'allies', 'spectator'];
  const ENTITYNUM_WORLD = 1022, ENTITYNUM_NONE = 1023;
  /* entity flags confirmed in the engine (bg_animation_mp.cpp, ent.h) */
  const EF = { CROUCH: 0x4, PRONE: 0x8, FIRING: 0x40, DEAD: 0x20000 };
  /* config string indexes (MP layout of patch 1.7) */
  const CS = {
    SERVERINFO: 0, SYSTEMINFO: 1, GAME_VERSION: 2, GAMEENDTIME: 11, MAPCENTER: 12,
    CODINFO: 20, CODINFO_VALUE: 148, LOCALIZED: 309, NORTHYAW: 822, MINIMAP: 823,
    SOUNDALIASES: 1342, WEAPONFILES: 2258
  };
  C4.constants = { EVENT_NAMES, EV, ET, MEANS_OF_DEATH, TEAM, TEAM_NAMES, ENTITYNUM_WORLD, ENTITYNUM_NONE, EF, CS };
});
