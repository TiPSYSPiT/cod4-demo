"""Engine constants and enumerations of CoD4 multiplayer (IW3, patch 1.7).

Values come from the KisakCOD reimplementation (bg_public.h, q_shared.h,
g_public_mp.h, cg_servercmds_mp.cpp) and the CoD4X client source
(qcommon.h, cl_main.c). Where a value was confirmed on real demos this is
noted.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Demo container
# ---------------------------------------------------------------------------

#: Record type byte that precedes every record in a .dm_1 file.
REC_MESSAGE = 0     # server message: int seq, int len, len bytes (4-byte reliableAck + Huffman data)
REC_ARCHIVE = 1     # client archive frame (predicted player position), 48 bytes + index
REC_PROTOCOL = 2    # CoD4X only, first record: protocol, legacyEnd(-1), 8 reserved bytes
REC_RELIABLE = 3    # CoD4X reliable message: int len, len bytes (not Huffman coded)

RECORD_NAMES = {REC_MESSAGE: "message", REC_ARCHIVE: "archive",
                REC_PROTOCOL: "protocol", REC_RELIABLE: "reliable"}

#: Stock CoD4 demos carry no REC_PROTOCOL record; DM1 calls this protocol 1.
PROTOCOL_STOCK = 1
#: CoD4X up to this protocol encodes origins against the map centre, above it
#: origins are raw 32-bit floats.
COD4X_FALLBACK_PROTOCOL = 17

# ---------------------------------------------------------------------------
# Server -> client message opcodes (svc_ops_e, CoD4X qcommon.h)
# ---------------------------------------------------------------------------

SVC_NOP = 0
SVC_GAMESTATE = 1
SVC_CONFIGSTRING = 2
SVC_BASELINE = 3
SVC_SERVERCOMMAND = 4
SVC_DOWNLOAD = 5
SVC_SNAPSHOT = 6
SVC_EOF = 7
SVC_STEAMCOMMANDS = 8
SVC_STATSCOMMANDS = 9
SVC_CONFIGDATA = 10
SVC_CONFIGCLIENT = 11
SVC_ACDATA = 12

SVC_NAMES = {
    0: "nop", 1: "gamestate", 2: "configstring", 3: "baseline", 4: "serverCommand",
    5: "download", 6: "snapshot", 7: "EOF", 8: "steamcommands", 9: "statscommands",
    10: "configdata", 11: "configclient", 12: "acdata",
}

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_CLIENTS = 64
GENTITYNUM_BITS = 10
MAX_GENTITIES = 1 << GENTITYNUM_BITS
ENTITYNUM_NONE = MAX_GENTITIES - 1      # 1023, also ends the entity list in a snapshot
ENTITYNUM_WORLD = MAX_GENTITIES - 2     # 1022
MAX_CONFIGSTRINGS = 2442
PACKET_BACKUP = 32
MAX_PARSE_ENTITIES = 2048
MAX_PARSE_CLIENTS = 2048
MAX_HUDELEMENTS = 31
MAX_OBJECTIVES = 16
MAX_STATS = 5
MAX_ARCHIVE_FRAMES = 256

# ---------------------------------------------------------------------------
# Config string layout (MP, KisakCOD q_shared.h ConstStringOffsets)
# ---------------------------------------------------------------------------

CS_SERVERINFO = 0
CS_SYSTEMINFO = 1
CS_GAME_VERSION = 2
CS_MESSAGE = 3
CS_SCORES1 = 4
CS_SCORES2 = 5
CS_CULLDIST = 6
CS_SUNLIGHT = 7
CS_SUNDIR = 8
CS_FOGVARS = 9
CS_MOTD = 10
CS_GAMEENDTIME = 11
CS_MAPCENTER = 12
CS_VOTE_TIME = 13
CS_VOTE_STRING = 14
CS_VOTE_YES = 15
CS_VOTE_NO = 16
CS_VOTE_MAPNAME = 17
CS_VOTE_GAMETYPE = 18
CS_MULTI_MAPWINNER = 19
CS_CODINFO = 20                 # 128 dvar names ...
CS_CODINFO_VALUE = 148          # ... and their values at name index + 128
CS_ENEMY_CROSSHAIR = 276
CS_USE_TRIG_STRINGS = 277
CS_LOCALIZED_STRINGS = 309
CS_AMBIENT = 821
CS_NORTHYAW = 822
CS_MINIMAP = 823
CS_VISIONSET_NAKED = 824
CS_VISIONSET_NIGHT = 825
CS_NIGHTVISION = 826
CS_LOC_SEL_MTLS = 827
CS_MODELS = 830
CS_SOUNDALIASES = 1342
CS_EFFECT_NAMES = 1598
CS_EFFECT_TAGS = 1698
CS_SHELLSHOCKS = 1954
CS_SCRIPT_MENUS = 1970
CS_SERVER_MATERIALS = 2002
CS_WEAPONFILES = 2258
CS_STATUS_ICONS = 2259
CS_HEAD_ICONS = 2267
CS_TAGS = 2282
CS_ITEMS = 2314

_CS_SINGLE = {
    0: "serverinfo", 1: "systeminfo", 2: "game_version", 3: "message", 4: "scores1",
    5: "scores2", 6: "culldist", 7: "sunlight", 8: "sundir", 9: "fogvars", 10: "motd",
    11: "gameendtime", 12: "mapcenter", 13: "vote_time", 14: "vote_string", 15: "vote_yes",
    16: "vote_no", 17: "vote_mapname", 18: "vote_gametype", 19: "multi_mapwinner",
    276: "enemy_crosshair", 821: "ambient", 822: "northyaw", 823: "minimap",
    824: "visionset_naked", 825: "visionset_night", 826: "nightvision",
    2258: "weaponfiles", 2314: "items",
}
#: (first, last, name) of the config string ranges
CS_RANGES = (
    (20, 147, "codinfo_name"),
    (148, 275, "codinfo_value"),
    (277, 308, "use_trigger_string"),
    (309, 820, "localized_string"),
    (827, 829, "location_selection_material"),
    (830, 1341, "model"),
    (1342, 1597, "sound_alias"),
    (1598, 1697, "effect"),
    (1698, 1953, "effect_tag"),
    (1954, 1969, "shellshock"),
    (1970, 2001, "script_menu"),
    (2002, 2257, "server_material"),
    (2259, 2266, "status_icon"),
    (2267, 2281, "head_icon"),
    (2282, 2313, "tag"),
)


def configstring_category(index: int) -> tuple[str, int]:
    """Return ``(category, offset_in_category)`` of a config string index."""
    if index in _CS_SINGLE:
        return _CS_SINGLE[index], 0
    for first, last, name in CS_RANGES:
        if first <= index <= last:
            return name, index - first
    if index >= MAX_CONFIGSTRINGS:
        return "extended", index - MAX_CONFIGSTRINGS
    return "unused", 0


# ---------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------

ET_GENERAL = 0
ET_PLAYER = 1
ET_PLAYER_CORPSE = 2
ET_ITEM = 3
ET_MISSILE = 4
ET_INVISIBLE = 5
ET_SCRIPTMOVER = 6
ET_SOUND_BLEND = 7
ET_FX = 8
ET_LOOP_FX = 9
ET_PRIMARY_LIGHT = 10
ET_MG42 = 11
ET_HELICOPTER = 12
ET_PLANE = 13
ET_VEHICLE = 14
ET_VEHICLE_COLLMAP = 15
ET_VEHICLE_CORPSE = 16
ET_EVENTS = 17          # eType >= ET_EVENTS: temporary event entity, event = eType - 17

ENTITY_TYPE_NAMES = (
    "general", "player", "player_corpse", "item", "missile", "invisible", "script_mover",
    "sound_blend", "fx", "loop_fx", "primary_light", "mg42", "helicopter", "plane",
    "vehicle", "vehicle_collmap", "vehicle_corpse",
)


def entity_type_name(etype: int) -> str:
    if 0 <= etype < ET_EVENTS:
        return ENTITY_TYPE_NAMES[etype]
    return "event"


#: Entity events (entity_event_t, MP). EV_OBITUARY = 66 is confirmed on demos.
EVENT_NAMES = [
    "none", "foliage_sound", "stop_weapon_sound", "sound_alias", "sound_alias_as_master",
    "stopsounds", "stance_force_stand", "stance_force_crouch", "stance_force_prone",
    "item_pickup", "ammo_pickup", "noammo", "emptyclip", "empty_offhand", "reset_ads",
    "reload", "reload_from_empty", "reload_start", "reload_end", "reload_start_notify",
    "reload_addammo", "raise_weapon", "first_raise_weapon", "putaway_weapon", "weapon_alt",
    "pullback_weapon", "fire_weapon", "fire_weapon_lastshot", "rechamber_weapon",
    "eject_brass", "melee_swipe", "fire_melee", "prep_offhand", "use_offhand",
    "switch_offhand", "melee_hit", "melee_miss", "melee_blood", "fire_weapon_mg42",
    "fire_quadbarrel_1", "fire_quadbarrel_2", "bullet_hit", "bullet_hit_client_small",
    "bullet_hit_client_large", "grenade_bounce", "grenade_explode", "rocket_explode",
    "rocket_explode_nomarks", "flashbang_explode", "custom_explode",
    "custom_explode_nomarks", "change_to_dud", "dud_explode", "dud_impact", "bullet",
    "play_fx", "play_fx_on_tag", "phys_explosion_sphere", "phys_explosion_cylinder",
    "phys_explosion_jolt", "phys_jitter", "earthquake", "grenade_suicide", "detonate",
    "nightvision_wear", "nightvision_remove", "obituary", "no_frag_grenade_hint",
    "no_special_grenade_hint", "target_too_close_hint", "target_not_enough_clearance",
    "lockon_required_hint", "footstep_sprint", "footstep_run", "footstep_walk",
    "footstep_prone", "jump",
]
EV_OBITUARY = 66
EV_LANDING_FIRST = 77
EV_LANDING_PAIN_FIRST = 106
EV_MAX_EVENTS = 135


def event_name(ev: int) -> str:
    if 0 <= ev < len(EVENT_NAMES):
        return EVENT_NAMES[ev]
    if EV_LANDING_FIRST <= ev < EV_LANDING_PAIN_FIRST:
        return f"landing:{SURFACE_TYPES[ev - EV_LANDING_FIRST] if ev - EV_LANDING_FIRST < len(SURFACE_TYPES) else ev - EV_LANDING_FIRST}"
    if EV_LANDING_PAIN_FIRST <= ev < EV_MAX_EVENTS:
        i = ev - EV_LANDING_PAIN_FIRST
        return f"landing_pain:{SURFACE_TYPES[i] if i < len(SURFACE_TYPES) else i}"
    return f"event_{ev}"


#: Surface types (SURF_TYPE_*, surfaceflags.cpp; 0 = default); landing events and surfType.
SURFACE_TYPES = (
    "default", "bark", "brick", "carpet", "cloth", "concrete", "dirt", "flesh", "foliage",
    "glass", "grass", "gravel", "ice", "metal", "mud", "paper", "plaster", "rock", "sand",
    "snow", "water", "wood", "asphalt", "ceramic", "plastic", "rubber", "cushion", "fruit",
    "paintedmetal", "opaqueglass",
)

#: Means of death (meansOfDeath_t, g_public_mp.h).
MEANS_OF_DEATH = (
    "MOD_UNKNOWN", "MOD_PISTOL_BULLET", "MOD_RIFLE_BULLET", "MOD_GRENADE",
    "MOD_GRENADE_SPLASH", "MOD_PROJECTILE", "MOD_PROJECTILE_SPLASH", "MOD_MELEE",
    "MOD_HEAD_SHOT", "MOD_CRUSH", "MOD_TELEFRAG", "MOD_FALLING", "MOD_SUICIDE",
    "MOD_TRIGGER_HURT", "MOD_EXPLOSIVE", "MOD_IMPACT",
)
#: Obituary eventParm: bit 7 set = 0x80 | means of death (only for MOD 7, 8, 9,
#: 11, 12, 15 - GScr_Obituary), otherwise the weapon index.
OBITUARY_MOD_FLAG = 0x80

#: Trajectory types (trType_t, q_shared.h)
TRAJECTORY_TYPES = ("stationary", "interpolate", "linear", "linear_stop", "sine", "gravity",
                    "accelerate", "decelerate", "physics", "ragdoll", "ragdoll_gravity",
                    "ragdoll_interpolate")

# ---------------------------------------------------------------------------
# Players
# ---------------------------------------------------------------------------

TEAM_NAMES = ("free", "axis", "allies", "spectator")

#: playerState_t.stats[] (statIndex_t)
STAT_NAMES = ("health", "dead_yaw", "max_health", "ident_client_num", "spawn_count")

#: pmtype_t
PM_TYPES = ("normal", "normal_linked", "noclip", "ufo", "spectator", "intermission",
            "laststand", "dead", "dead_linked")

#: playerState_t.pm_flags bits (pmflags_t, bg_local.h, MP build)
PMF_FLAGS = {
    1 << 0: "prone", 1 << 1: "ducked", 1 << 2: "mantle", 1 << 3: "ladder",
    1 << 4: "sight_aiming", 1 << 5: "backwards_run", 1 << 6: "walking",
    1 << 7: "time_hardlanding", 1 << 8: "time_knockback", 1 << 9: "pronemove_overridden",
    1 << 10: "respawned", 1 << 11: "frozen", 1 << 12: "no_prone", 1 << 13: "ladder_fall",
    1 << 14: "jumping", 1 << 15: "sprinting", 1 << 16: "shellshocked",
    1 << 17: "melee_charge", 1 << 18: "no_sprint", 1 << 19: "no_jump",
    1 << 20: "vehicle_attached",
}

#: eFlags bits whose meaning is confirmed in the engine code (bg_animation_mp.cpp,
#: bg_weapons.cpp, ent.h). Other bits are reported by number only.
EF_FLAGS = {
    0x4: "crouching", 0x8: "prone", 0x40: "firing", 0x100: "turret_active_stand",
    0x200: "turret_active_duck", 0x20000: "dead",
}

#: weaponstate values of playerState_t (weaponstate_t, MP)
WEAPON_STATES = (
    "ready", "raising", "raising_altswitch", "dropping", "dropping_quick", "firing",
    "rechambering", "reloading", "reloading_interupt", "reload_start",
    "reload_start_interupt", "reload_end", "melee_init", "melee_fire", "melee_end",
    "offhand_init", "offhand_prepare", "offhand_hold", "offhand_start", "offhand",
    "offhand_end", "detonating", "sprint_raise", "sprint_loop", "sprint_drop",
    "nightvision_wear", "nightvision_remove",
)

#: Perks (perksEnum / bg_perkNames, bg_perks_mp.cpp); bit i of the perks mask
PERK_NAMES = (
    "specialty_gpsjammer", "specialty_bulletaccuracy", "specialty_fastreload",
    "specialty_rof", "specialty_holdbreath", "specialty_bulletpenetration",
    "specialty_grenadepulldeath", "specialty_pistoldeath", "specialty_quieter",
    "specialty_parabolic", "specialty_longersprint", "specialty_detectexplosive",
    "specialty_explosivedamage", "specialty_exposeenemy", "specialty_bulletdamage",
    "specialty_extraammo", "specialty_twoprimaries", "specialty_armorvest",
    "specialty_fraggrenade", "specialty_specialgrenade",
)

#: HUD element types (he_type_t)
HUD_ELEM_TYPES = (
    "free", "text", "value", "playername", "mapname", "gametype", "material",
    "timer_down", "timer_up", "tenths_timer_down", "tenths_timer_up", "clock_down",
    "clock_up", "waypoint",
)

#: Objective states (objectiveState_t)
OBJECTIVE_STATES = ("empty", "active", "invisible", "done", "current", "failed")

# ---------------------------------------------------------------------------
# Reliable server commands (first character of the command string)
# CG_DeployServerCommand (cg_servercmds_mp.cpp) and CL_ConfigstringModified
# ---------------------------------------------------------------------------

SERVER_COMMANDS = {
    "B": "map_restart",
    "C": "set_equipped_offhand",       # C <weaponIndex>
    "D": "reverb_deactivate",
    "E": "channel_volume_set",
    "F": "channel_volume_deactivate",
    "G": "team_score_axis",            # G <score>
    "H": "team_score_allies",          # H <score>
    "I": "client_score",               # I <client> <score>
    "J": "menu_show_notify",           # J <menu>
    "K": "reset_player_muting",        # K <client>
    "L": "close_ingame_menu",
    "N": "set_stat",                   # N <index> <value>
    "a": "select_weapon",              # a <weaponIndex>
    "b": "scoreboard",                 # b <n> <axis> <allies> <limit> n*(client score ping deaths icon kills assists)
    "c": "announcement",               # c "<text>"  bold announcement
    "d": "configstring",               # d <index> <value>
    "e": "game_message",               # e "<text>"  (print in killfeed area)
    "f": "game_message",               # f "<text>"
    "g": "bold_game_message",          # g "<text>"
    "h": "chat",                       # h "<text>"
    "i": "team_chat",                  # i "<text>"
    "j": "dynent_destroy",             # j <id> <drawType> <pos x3> <dir x3>
    "k": "local_sound_stop",
    "n": "map_restart_persist",        # fast_restart
    "o": "play_music",                 # o <alias> <volume>
    "p": "stop_music",                 # p <fadetime>
    "q": "fade_sounds",                # q <volume> <time>
    "r": "reverb",
    "s": "local_sound",                # s <alias>
    "t": "open_script_menu",           # t <menuIndex> <?>
    "u": "close_script_menu",
    "v": "set_client_dvars",           # v <name> <value> [<name> <value> ...]
}
