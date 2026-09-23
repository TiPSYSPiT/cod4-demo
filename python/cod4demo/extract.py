"""High-level extraction: turns the parser events into tables.

``extract(path)`` runs one pass over a demo and returns a ``DemoData`` with
all tables (see README.md for the full column reference). Every table is a
``Table`` (column names + rows) so it can be written as CSV, JSON or JSONL
without holding millions of dicts in memory.

The extraction reports what is in the file. Where a value is inferred rather
than transmitted (for example the victim of a bullet hit seen from outside),
the column says so.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from . import parser as P
from .bitmsg import s32, u2f
from .constants import (CS_CODINFO, CS_CODINFO_VALUE, CS_GAME_VERSION, CS_LOCALIZED_STRINGS,
                        CS_MAPCENTER, CS_MINIMAP, CS_MODELS, CS_SERVER_MATERIALS, CS_SERVERINFO,
                        CS_SOUNDALIASES, CS_EFFECT_NAMES, CS_SYSTEMINFO, CS_WEAPONFILES,
                        ENTITYNUM_NONE, ENTITYNUM_WORLD, ET_EVENTS, ET_GENERAL,
                        ET_MISSILE, ET_PLAYER, ET_PLAYER_CORPSE, EV_OBITUARY, HUD_ELEM_TYPES,
                        MAX_CLIENTS, MEANS_OF_DEATH, OBITUARY_MOD_FLAG, OBJECTIVE_STATES,
                        PM_TYPES, TEAM_NAMES, WEAPON_STATES,
                        configstring_category, entity_type_name, event_name)
from .delta import HUD_INDEX, PS_INDEX
from .servercmd import BigConfigStringAssembler, decode
from .states import (E, client_dict, entity_dict, flag_names, hud_dict, perk_names,
                     stance_from_eflags)
from .constants import PMF_FLAGS
from .text import parse_infostring, strip_colors

EV_BULLET_HIT = 41
EV_BULLET_HIT_CLIENT_SMALL = 42
EV_BULLET_HIT_CLIENT_LARGE = 43
EV_GRENADE_EXPLODE = 45
EV_FLASHBANG_EXPLODE = 48
EV_SOUND_ALIAS = 3
EV_SOUND_ALIAS_AS_MASTER = 4
EV_PLAY_FX = 55
SURF_FLESH = 7

#: how old a position may be to be used for kill distances / hit attribution
POSITION_MAX_AGE_MS = 1000


# ---------------------------------------------------------------------------
# Table container
# ---------------------------------------------------------------------------

class Table:
    """A named table: ``columns`` plus ``rows`` (lists in column order)."""

    def __init__(self, name: str, columns: list[str], description: str = "") -> None:
        self.name = name
        self.columns = columns
        self.description = description
        self.rows: list[list] = []

    def add(self, *values) -> None:
        self.rows.append(list(values))

    def __len__(self) -> int:
        return len(self.rows)

    def dicts(self):
        cols = self.columns
        for r in self.rows:
            yield dict(zip(cols, r))

    def __repr__(self) -> str:
        return f"<Table {self.name}: {len(self.rows)} rows x {len(self.columns)} cols>"


@dataclass
class DemoData:
    """Everything extracted from one demo."""
    meta: dict = field(default_factory=dict)
    serverinfo: dict = field(default_factory=dict)
    systeminfo: dict = field(default_factory=dict)
    tables: dict[str, Table] = field(default_factory=dict)
    #: path of the streamed full snapshot dump (only with full_output)
    full_output: str | None = None

    def __getattr__(self, name):
        tables = self.__dict__.get("tables", {})
        if name in tables:
            return tables[name]
        raise AttributeError(name)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _f(v: float, nd: int = 4):
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return round(v, nd)


def _pos(state) -> tuple:
    return (_f(u2f(state[6])), _f(u2f(state[7])), _f(u2f(state[8])))


def _dist(a, b) -> float | None:
    if a is None or b is None or None in a or None in b:
        return None
    return round(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5, 1)


class _Extractor:
    def __init__(self, path, full_output=None, progress=None) -> None:
        self.path = Path(path) if not isinstance(path, (bytes, bytearray)) else None
        self.parser = P.DemoParser(path)
        self.full_fh = None
        if full_output is not None:
            Path(full_output).parent.mkdir(parents=True, exist_ok=True)
            self.full_fh = open(full_output, "w", encoding="utf-8", newline="\n")
        self.progress = progress
        self.data = DemoData()
        self.data.full_output = str(full_output) if full_output is not None else None
        T = self._table
        # -- tables -------------------------------------------------------
        T("configstrings", ["index", "category", "category_offset", "value", "source",
                            "updates", "last_update_time"],
          "Final state of every config string that was transmitted")
        T("configstring_changes", ["server_time", "message_seq", "index", "category",
                                   "old_value", "new_value"],
          "Config string updates after the gamestate (server command 'd' / 'x y z')")
        T("dvars", ["index", "name", "value"],
          "Server dvars announced to clients (config strings 20-147 name, +128 value)")
        T("server_commands", ["server_time", "message_seq", "cmd_seq", "verb", "name", "text"],
          "Every reliable server command, raw")
        T("chat", ["server_time", "scope", "sender_client", "sender_name", "message", "raw"],
          "Chat (h = all, i = team)")
        T("game_messages", ["server_time", "verb", "kind", "text", "raw"],
          "Game / announcement messages (c, e, f, g)")
        T("scoreboards", ["server_time", "count", "score_axis", "score_allies", "scorelimit"],
          "Scoreboard updates (b)")
        T("scoreboard_entries", ["server_time", "client", "name", "score", "ping", "deaths",
                                 "kills", "assists", "status_icon"],
          "One row per player per scoreboard update")
        T("team_scores", ["server_time", "team", "score"], "Team score updates (G/H)")
        T("client_scores", ["server_time", "client", "score"], "Single client score updates (I)")
        T("client_dvars", ["server_time", "name", "value"],
          "Dvars the server sets on the recording client (v)")
        T("pov_commands", ["server_time", "verb", "name", "args"],
          "Other commands addressed to the recording client (a, C, J, N, t, u, o, s, w ...)")
        T("names", ["server_time", "client", "name", "clantag", "source"],
          "Player name / clan tag announcements (gamestate, configclient, client state)")
        T("client_states", ["server_time", "client", "team", "team_name", "netname", "rank",
                            "prestige", "perks", "perk_names", "modelindex",
                            "attached_models", "attached_tags", "max_sprint_time_mult",
                            "attached_veh_ent", "attached_veh_slot", "changed"],
          "Client state (team, name, rank, perks ...) whenever it changes")
        T("snapshots", ["message_seq", "server_time", "delta_num", "snap_flags",
                        "num_entities", "num_clients", "changed_entities",
                        "removed_entities", "changed_clients", "ps_client",
                        "ps_origin_from_archive"],
          "One row per decoded snapshot")
        T("pov", ["server_time", "message_seq", "client", "spectating", "pm_type",
                  "pm_type_name", "pm_flags", "pm_flags_names", "eflags", "stance", "health",
                  "max_health", "x", "y", "z", "vx", "vy", "vz", "pitch", "yaw", "roll",
                  "weapon", "weapon_name", "weaponstate", "weaponstate_name", "offhand",
                  "offhand_name", "weapons_mask", "inventory", "perks", "ads_frac", "lean",
                  "view_height", "damage_event", "damage_yaw", "damage_pitch",
                  "damage_count", "grenade_time_left", "shellshock_index",
                  "shellshock_time", "killcam_entity", "cursor_hint", "spawn_count",
                  "ident_client", "command_time", "origin_source"],
          "Player state of the recording client (or the player it spectates), per snapshot")
        T("pov_ammo", ["server_time", "kind", "slot", "value"],
          "Ammo / clip counters of the player state whenever one changes")
        T("pov_archive", ["index", "server_time", "x", "y", "z", "vx", "vy", "vz",
                          "pitch", "yaw", "roll", "movement_dir", "bob_cycle"],
          "Client archive frames: the recorder's own predicted view at frame rate")
        T("player_positions", ["server_time", "client", "source", "transmitted", "x", "y",
                               "z", "pitch", "yaw", "roll", "weapon", "weapon_name",
                               "eflags", "stance", "firing", "dead", "lean",
                               "movement_dir", "legs_anim", "torso_anim",
                               "ground_entity", "torso_pitch", "waist_pitch"],
          "Player positions: every player entity in every snapshot, plus the POV from the player state")
        T("entity_events", ["server_time", "message_seq", "source", "entity",
                            "entity_type", "client", "event", "event_name", "event_parm",
                            "x", "y", "z", "other_entity", "attacker_entity", "weapon",
                            "weapon_name", "surf_type", "resolved", "ring_lost", "fields"],
          "Every event the client would play: temp event entities, entity event rings, player state events")
        T("kills", ["server_time", "message_seq", "attacker", "attacker_name",
                    "attacker_team", "victim", "victim_name", "victim_team", "weapon",
                    "weapon_name", "mod", "mod_name", "headshot", "suicide", "world",
                    "teamkill", "attacker_x", "attacker_y", "attacker_z", "victim_x",
                    "victim_y", "victim_z", "distance", "event_parm"],
          "Kill feed (EV_OBITUARY event entities)")
        T("hits", ["server_time", "message_seq", "kind", "attacker", "attacker_name",
                   "victim", "victim_name", "victim_inferred", "victim_distance", "weapon",
                   "weapon_name", "headshot", "x", "y", "z"],
          "Bullet hits on players (EV_BULLET_HIT seen by the recorder / EV_BULLET_HIT_CLIENT_* taken by the recorder)")
        T("missiles", ["server_time", "entity", "transmitted", "weapon", "weapon_name",
                       "launch_time", "tr_type", "tr_time", "x", "y", "z", "vx", "vy", "vz",
                       "ground_entity", "eflags"],
          "Missile (grenade / projectile) entities per snapshot")
        T("grenades", ["entity", "weapon", "weapon_name", "launch_time", "first_time",
                       "last_time", "start_x", "start_y", "start_z", "start_vx",
                       "start_vy", "start_vz", "last_x", "last_y", "last_z", "points",
                       "explode_time", "explode_x", "explode_y", "explode_z"],
          "One row per thrown missile (grouped by entity number + launch time)")
        T("entities", ["entity", "entity_type", "first_time", "last_time", "snapshots",
                       "client", "weapon", "index", "model", "first_x", "first_y", "first_z",
                       "last_x", "last_y", "last_z"],
          "Lifetime of every non-player, non-event entity (corpses, items, movers, fx ...)")
        T("hud", ["server_time", "list", "slot", "type", "type_name", "text", "text_string",
                  "label", "label_string", "value", "x", "y", "z", "color", "material",
                  "material_name", "font", "font_scale", "align_org", "align_screen",
                  "time", "duration", "target_entity", "sort", "flags", "fields"],
          "HUD elements of the player state whenever one changes (type 0 = removed)")
        T("objectives", ["server_time", "slot", "state", "state_name", "x", "y", "z",
                         "icon", "icon_name", "entity", "team"],
          "Objectives of the player state whenever one changes")
        T("baselines", ["entity", "entity_type", "fields"],
          "Entity baselines from the gamestate")
        T("issues", ["offset", "message_seq", "text"], "Anything that could not be decoded")

        # -- state ----------------------------------------------------------
        self.cs: dict[int, str] = {}
        self.cs_source: dict[int, str] = {}
        self.cs_updates: dict[int, int] = {}
        self.cs_last: dict[int, int] = {}
        self.weapons: list[str] = []
        self.pov_client: int | None = None
        self.gamestate_info: dict = {}
        self.names: dict[int, str] = {}
        self.clantags: dict[int, str] = {}
        self.teams: dict[int, int] = {}
        self.client_prev: dict[int, list] = {}
        self.prev_entities: dict[int, list] = {}
        self.cur_entities: dict[int, list] = {}
        self.ent_prev_seq: dict[int, int] = {}
        self.ent_life: dict[int, list] = {}
        self.last_pos: dict[int, tuple] = {}              # client -> (time, (x,y,z))
        self.grenades: dict[tuple, list] = {}
        self.missile_key: dict[int, tuple] = {}          # entity -> current grenade key
        self.prev_ps = None
        self.big_cs = BigConfigStringAssembler()
        self.first_time = None
        self.last_time = None
        self.first_archive = None
        self.last_archive = None
        self.map_center = None
        self.event_counts: dict[str, int] = {}
        self.gamestates = 0

    def _table(self, name, columns, description=""):
        self.data.tables[name] = Table(name, columns, description)

    def t(self, name) -> Table:
        return self.data.tables[name]

    # -- lookups ------------------------------------------------------------
    def weapon_name(self, idx) -> str | None:
        if idx is None or idx <= 0:
            return None
        if idx <= len(self.weapons):
            return self.weapons[idx - 1]
        return None

    def cs_at(self, base: int, idx: int) -> str | None:
        v = self.cs.get(base + idx)
        return v if v else None

    def name(self, c: int | None) -> str | None:
        if c is None:
            return None
        if c == ENTITYNUM_WORLD:
            return "<world>"
        if c >= MAX_CLIENTS:
            # a non-player entity (e.g. an exploding car killed someone)
            st = self.cur_entities.get(c) or self.prev_entities.get(c)
            return f"<entity {c}: {entity_type_name(st[1])}>" if st else f"<entity {c}>"
        return self.names.get(c)

    def team(self, c: int | None) -> str | None:
        if c is None or c not in self.teams:
            return None
        t = self.teams[c]
        return TEAM_NAMES[t] if 0 <= t < len(TEAM_NAMES) else str(t)

    # -- run --------------------------------------------------------------------
    def run(self) -> DemoData:
        total = len(self.parser.data)
        n = 0
        for ev in self.parser:
            if isinstance(ev, P.Snapshot):
                self.on_snapshot(ev)
                n += 1
                if self.progress and n % 1000 == 0:
                    self.progress(ev.offset / total)
            elif isinstance(ev, P.ArchiveFrame):
                self.on_archive(ev)
            elif isinstance(ev, P.ServerCommand):
                self.on_command(ev)
            elif isinstance(ev, P.Gamestate):
                self.on_gamestate(ev)
            elif isinstance(ev, P.ConfigClient):
                self.set_name(ev.client, ev.name, ev.clantag, ev.server_time, "configclient")
            elif isinstance(ev, P.ParseIssue):
                self.t("issues").add(ev.offset, ev.message_seq, ev.text)
            elif isinstance(ev, P.ReliableMessage):
                self.t("issues").add(ev.offset, None,
                                     f"reliable message record, command {ev.command}, "
                                     f"{len(ev.data)} bytes (kept raw, not decoded)")
            elif isinstance(ev, P.Download):
                self.t("issues").add(ev.offset, ev.message_seq,
                                     f"svc_download with {len(ev.data)} bytes (not decoded)")
            elif isinstance(ev, P.DemoEnd):
                self.end = ev
        self.finish()
        return self.data

    # -- gamestate ----------------------------------------------------------
    def on_gamestate(self, gs: P.Gamestate) -> None:
        self.gamestates += 1
        if self.gamestates == 1:
            self.pov_client = gs.client_num
            self.gamestate_info = {
                "server_command_seq": gs.server_command_seq,
                "server_config_seq": gs.server_config_seq,
                "client_num": gs.client_num,
                "checksum_feed": gs.checksum_feed,
                "configstrings": len(gs.configstrings),
                "configstrings_nonempty": sum(1 for v in gs.configstrings.values() if v),
                "baselines": len(gs.baselines),
            }
        for idx, val in gs.configstrings.items():
            self.cs[idx] = val
            self.cs_source[idx] = "gamestate"
        self.refresh_cs_derived()
        for c, (name, tag) in gs.clients.items():
            self.set_name(c, name, tag, None, "gamestate")
        bl = self.t("baselines")
        for num, st in sorted(gs.baselines.items()):
            bl.add(num, entity_type_name(st[1]), json.dumps(entity_dict(st), separators=(",", ":")))
        self.prev_entities = {}
        self.ent_prev_seq = {}

    def refresh_cs_derived(self, index: int | None = None) -> None:
        if index is None or index == CS_WEAPONFILES:
            self.weapons = (self.cs.get(CS_WEAPONFILES) or "").split()
        if index is None or index == CS_MAPCENTER:
            try:
                self.map_center = [float(x) for x in (self.cs.get(CS_MAPCENTER) or "").split()[:3]]
            except ValueError:
                pass

    def set_name(self, c, name, tag, time, source) -> None:
        if c is None or not 0 <= c < MAX_CLIENTS:
            return
        if self.names.get(c) == name and self.clantags.get(c, tag) == tag:
            return
        self.names[c] = name
        if tag is not None:
            self.clantags[c] = tag
        self.t("names").add(time, c, name, tag, source)

    # -- archive ------------------------------------------------------------
    def on_archive(self, fr: P.ArchiveFrame) -> None:
        if self.first_archive is None:
            self.first_archive = fr.server_time
        self.last_archive = fr.server_time
        o, v, a = fr.origin, fr.velocity, fr.angles
        self.t("pov_archive").add(fr.index, fr.server_time, _f(o[0]), _f(o[1]), _f(o[2]),
                                  _f(v[0]), _f(v[1]), _f(v[2]), _f(a[0]), _f(a[1]), _f(a[2]),
                                  fr.movement_dir, fr.bob_cycle)

    # -- server commands ----------------------------------------------------
    def on_command(self, ev: P.ServerCommand) -> None:
        t = ev.server_time
        d = decode(ev.text)
        verb = d["verb"]
        self.t("server_commands").add(t, ev.message_seq, ev.seq, verb, d["name"], ev.text)
        if verb == "d":
            self.cs_update(t, ev.message_seq, d["index"], d["value"])
        elif verb in ("x", "y", "z"):
            done = self.big_cs.feed(d)
            if done:
                self.cs_update(t, ev.message_seq, done[0], done[1])
        elif verb == "b":
            self.t("scoreboards").add(t, d.get("count"), d.get("score_axis"),
                                      d.get("score_allies"), d.get("scorelimit"))
            se = self.t("scoreboard_entries")
            for e in d.get("entries", []):
                se.add(t, e["client"], self.name(e["client"]), e["score"], e["ping"],
                       e["deaths"], e["kills"], e["assists"], e["status_icon"])
        elif verb in ("h", "i"):
            raw = d.get("text", "")
            sender, msg = self.split_chat(raw)
            self.t("chat").add(t, d["scope"], sender, self.name(sender) if sender is not None
                               else None, msg, raw)
        elif verb in ("c", "e", "f", "g"):
            raw = d.get("text", "")
            self.t("game_messages").add(t, verb, d["name"], strip_colors(raw), raw)
        elif verb in ("G", "H"):
            self.t("team_scores").add(t, d["team"], d.get("score"))
        elif verb == "I":
            self.t("client_scores").add(t, d.get("client"), d.get("score"))
        elif verb == "v":
            cd = self.t("client_dvars")
            for name, value in d.get("dvars", []):
                cd.add(t, name, value)
        elif verb in ("a", "C", "J", "K", "N", "t", "u", "o", "p", "q", "s", "k", "r",
                      "B", "n", "L", "w", "j", "D", "E", "F"):
            self.t("pov_commands").add(t, verb, d["name"],
                                       json.dumps(d.get("args", []), ensure_ascii=False))

    def cs_update(self, t, seq, index, value) -> None:
        if index is None:
            return
        old = self.cs.get(index)
        cat, off = configstring_category(index)
        self.t("configstring_changes").add(t, seq, index, cat, old, value)
        self.cs[index] = value
        self.cs_source[index] = "update" if self.cs_source.get(index) != "gamestate" \
            else "gamestate+update"
        self.cs_updates[index] = self.cs_updates.get(index, 0) + 1
        self.cs_last[index] = t
        self.refresh_cs_derived(index)

    def split_chat(self, raw: str) -> tuple[int | None, str]:
        """Chat text is "[(prefix)...]<name>^7: <message>".

        Prefixes are localisation keys or team names in parentheses, e.g.
        ``(GAME_DEAD)`` or ``(Defence)``. The sender is identified by matching
        the known player names (with and without clan tag); the longest
        matching name wins.
        """
        clean = strip_colors(raw)
        body = clean
        while body.startswith(("(", "[")):
            close = body.find(")" if body[0] == "(" else "]")
            if close < 0 or close > 40:
                break
            body = body[close + 1:].lstrip()
        best, best_len = None, -1
        for c, name in self.names.items():
            n = strip_colors(name)
            tag = strip_colors(self.clantags.get(c, "") or "")
            cands = (n, f"{tag}{n}", f"[{tag}]{n}", f"{tag} {n}") if tag else (n,)
            for cand in cands:
                if cand and body.startswith(cand + ":") and len(cand) > best_len:
                    best, best_len = c, len(cand)
        if best is not None:
            return best, body[best_len + 1:].strip()
        i = body.find(": ")
        return None, body[i + 2:] if i >= 0 else body

    # -- snapshots ----------------------------------------------------------
    def on_snapshot(self, snap: P.Snapshot) -> None:
        info = snap.info
        t = info.server_time
        if self.first_time is None:
            self.first_time = t
        self.last_time = t
        ps = info.ps
        f = ps.fields
        ps_client = f[PS_INDEX["ClientNum"]]
        self.t("snapshots").add(info.message_num, t, info.delta_num, info.snap_flags,
                                info.num_entities, info.num_clients,
                                len(info.changed_entities), len(info.removed_entities),
                                len(info.changed_clients), ps_client, ps.origin_from_archive)
        self.do_clients(snap, t)
        self.do_playerstate(snap, t, ps)
        self.do_entities(snap, t)
        if self.full_fh is not None:
            self.full_fh.write(json.dumps(self.full_dump(snap), ensure_ascii=False,
                                          separators=(",", ":")))
            self.full_fh.write("\n")

    # clients
    def do_clients(self, snap: P.Snapshot, t: int) -> None:
        tbl = self.t("client_states")
        changed = set(snap.info.changed_clients)
        present = set()
        for num, st in snap.clients:
            present.add(num)
            prev = self.client_prev.get(num)
            if num in changed or prev is None:
                if prev is not None and list(prev) == list(st):
                    continue
                d = client_dict(st)
                diff = ["new"] if prev is None else [k for k, v in d.items()
                                                    if client_dict(prev).get(k) != v]
                self.client_prev[num] = st
                self.teams[num] = d["team"]
                tbl.add(t, num, d["team"], self.team(num), d["netname"], d["rank"],
                        d["prestige"], d["perks"], " ".join(perk_names(d["perks"])),
                        d["modelindex"],
                        " ".join(str(d[f"attachModelIndex[{i}]"]) for i in range(6)),
                        " ".join(str(d[f"attachTagIndex[{i}]"]) for i in range(6)),
                        d["maxSprintTimeMultiplier"], d["attachedVehEntNum"],
                        d["attachedVehSlotIndex"], " ".join(diff))
                netname = d["netname"]
                if netname and (num not in self.names or
                                not strip_colors(self.names[num]).startswith(strip_colors(netname)[:15])):
                    self.set_name(num, netname, None, t, "client_state")
        for num in list(self.client_prev):
            if num not in present:
                tbl.add(t, num, None, None, None, None, None, None, None, None, None, None,
                        None, None, None, "removed")
                del self.client_prev[num]

    # player state
    def do_playerstate(self, snap: P.Snapshot, t: int, ps) -> None:
        f = ps.fields
        g = lambda name: f[PS_INDEX[name]]
        gf = lambda name: _f(u2f(f[PS_INDEX[name]]))
        client = g("ClientNum")
        pm_type = g("pm_type")
        pm_flags = g("pm_flags")
        eflags = g("eFlags")
        weapon = g("weapon")
        wstate = g("weaponstate")
        offhand = g("offHandIndex")
        origin = (gf("origin[0]"), gf("origin[1]"), gf("origin[2]"))
        if not ps.origin_from_archive:
            origin_source = "sent"
        elif ps.archive_found:
            origin_source = "archive"
        else:
            # no archive frame for this command time: the engine keeps the
            # previous values; before the first known position they are unknown
            origin_source = "previous"
            if not any(origin):
                origin = (None, None, None)
        self.t("pov").add(
            t, snap.message_seq, client,
            self.pov_client is not None and client != self.pov_client,
            pm_type, PM_TYPES[pm_type] if pm_type < len(PM_TYPES) else None,
            pm_flags, " ".join(flag_names(pm_flags, PMF_FLAGS)), eflags,
            stance_from_eflags(eflags), ps.stats[0], ps.stats[2],
            origin[0], origin[1], origin[2],
            gf("velocity[0]"), gf("velocity[1]"), gf("velocity[2]"),
            gf("viewangles[0]"), gf("viewangles[1]"), gf("viewangles[2]"),
            weapon, self.weapon_name(weapon), wstate,
            WEAPON_STATES[wstate] if wstate < len(WEAPON_STATES) else None,
            offhand, self.weapon_name(offhand),
            " ".join(f"{g(f'weapons[{i}]'):08x}" for i in range(4)),
            " ".join(self.inventory(f)), " ".join(perk_names(g("perks"))), gf("fWeaponPosFrac"), gf("leanf"),
            gf("viewHeightCurrent"), g("damageEvent"), g("damageYaw"), g("damagePitch"),
            g("damageCount"), s32(g("grenadeTimeLeft")), g("shellshockIndex"),
            s32(g("shellshockTime")), g("killCamEntity"), g("cursorHint"), ps.stats[4],
            ps.stats[3], s32(g("commandTime")), origin_source)

        # the followed player's position from the player state
        if 0 <= client < MAX_CLIENTS and pm_type not in (4, 5) and origin[0] is not None \
                and any(origin):
            self.last_pos[client] = (t, origin)
            self.t("player_positions").add(
                t, client, "playerstate", True, origin[0], origin[1], origin[2],
                gf("viewangles[0]"), gf("viewangles[1]"), gf("viewangles[2]"),
                weapon, self.weapon_name(weapon), eflags, stance_from_eflags(eflags),
                bool(eflags & 0x40), bool(eflags & 0x20000) or pm_type in (7, 8),
                gf("leanf"), s32(g("movementDir")), g("legsAnim"), g("torsoAnim"),
                g("groundEntityNum"), gf("fTorsoPitch"), gf("fWaistPitch"))

        prev = self.prev_ps
        # ammo / clip changes
        pa = self.t("pov_ammo")
        if prev is None or prev.ammo is not ps.ammo:
            for i, v in enumerate(ps.ammo):
                if prev is None and v or prev is not None and prev.ammo[i] != v:
                    pa.add(t, "ammo", i, v)
        if prev is None or prev.ammoclip is not ps.ammoclip:
            for i, v in enumerate(ps.ammoclip):
                if prev is None and v or prev is not None and prev.ammoclip[i] != v:
                    pa.add(t, "clip", i, v)

        # player state events (4 slot ring, CG_CheckPlayerstateEvents)
        if prev is not None:
            new_seq = g("eventSequence")
            old_seq = prev.fields[PS_INDEX["eventSequence"]]
            if prev.fields[PS_INDEX["ClientNum"]] == client:
                n = (new_seq - old_seq) & 0xFF
                if 0 < n < 128:
                    lost = max(0, n - 4)       # older events overwritten in the 4-slot ring
                    n = min(n, 4)
                    for k in range(n, 0, -1):
                        i = (new_seq - k) & 3
                        ev = f[PS_INDEX[f"events[{i}]"]]
                        parm = f[PS_INDEX[f"eventParms[{i}]"]]
                        self.add_event(t, snap.message_seq, "playerstate", client, "player",
                                       client, ev, parm, origin, None, None, weapon, None, {},
                                       lost=lost)

        # HUD elements
        if prev is None or prev.hud_current is not ps.hud_current or prev.hud_archival is not ps.hud_archival:
            for lname, cur, old in (("current", ps.hud_current, prev.hud_current if prev else None),
                                    ("archival", ps.hud_archival, prev.hud_archival if prev else None)):
                for slot, h in enumerate(cur):
                    o = old[slot] if old is not None else None
                    if (o is None and h[HUD_INDEX["type"]]) or (o is not None and o != h):
                        self.add_hud(t, lname, slot, h)

        # objectives
        if prev is None or prev.objectives is not ps.objectives:
            for slot, o in enumerate(ps.objectives):
                po = prev.objectives[slot] if prev is not None else None
                if (po is None and any(o)) or (po is not None and po != o):
                    icon = o[4]
                    self.t("objectives").add(
                        t, slot, o[0], OBJECTIVE_STATES[o[0]] if o[0] < len(OBJECTIVE_STATES) else None,
                        _f(u2f(o[1])), _f(u2f(o[2])), _f(u2f(o[3])), icon,
                        self.cs_at(CS_SERVER_MATERIALS, icon), o[5], o[6])
        self.prev_ps = ps

    def inventory(self, f) -> list[str]:
        """Weapons carried: playerState.weapons[0..3] is a 128-bit mask of weapon indices."""
        out = []
        for word in range(4):
            mask = f[PS_INDEX[f"weapons[{word}]"]]
            b = 0
            while mask:
                if mask & 1:
                    idx = 32 * word + b
                    out.append(self.weapon_name(idx) or f"#{idx}")
                mask >>= 1
                b += 1
        return out

    def add_hud(self, t, lname, slot, h) -> None:
        d = hud_dict(h)
        typ = d.get("type", 0)
        text = d.get("text", 0)
        label = d.get("label", 0)
        mat = d.get("materialIndex", 0)
        color = d.get("color.rgba")
        self.t("hud").add(
            t, lname, slot, typ, HUD_ELEM_TYPES[typ] if typ < len(HUD_ELEM_TYPES) else None,
            text, self.cs_at(CS_LOCALIZED_STRINGS, text) if text else None,
            label, self.cs_at(CS_LOCALIZED_STRINGS, label) if label else None,
            d.get("value"), d.get("x"), d.get("y"), d.get("z"),
            " ".join(map(str, color)) if color else None, mat,
            self.cs_at(CS_SERVER_MATERIALS, mat) if mat else None, d.get("font"),
            d.get("fontScale"), d.get("alignOrg"), d.get("alignScreen"), d.get("time"),
            d.get("duration"), d.get("targetEntNum"), d.get("sort"), d.get("flags"),
            json.dumps(d, separators=(",", ":")))

    # entities
    def do_entities(self, snap: P.Snapshot, t: int) -> None:
        seq = snap.message_seq
        changed = set(snap.info.changed_entities)
        prev_all = self.prev_entities
        cur_all: dict[int, list] = {}
        self.cur_entities = cur_all
        pp = self.t("player_positions")
        for num, st in snap.entities:
            cur_all[num] = st
            etype = st[1]
            prev = prev_all.get(num)
            is_new = prev is None or prev[1] != etype
            if etype >= ET_EVENTS:
                # temp event entity: fires once when it appears (or is reused)
                if is_new or prev != st:
                    self.on_event_entity(t, seq, num, st)
                continue
            # -- entity event ring (CG_CheckEvents) -------------------------
            evseq = st[E["eventSequence"]]
            # CG_ResetEntity runs only for entities that were not in the previous
            # snapshot - not on a type change (an exploding grenade turns from
            # ET_MISSILE into ET_GENERAL and keeps its event ring)
            if prev is None or prev[1] >= ET_EVENTS:
                if etype == ET_PLAYER:
                    self.ent_prev_seq[num] = evseq
                elif etype in (ET_GENERAL, ET_MISSILE) and st[E["eFlags"]] & 0x10000 \
                        and t - s32(st[E["u"][0]]) > 200:
                    self.ent_prev_seq[num] = evseq
                else:
                    self.ent_prev_seq[num] = 0
            if evseq:
                # same arithmetic as CG_CheckEvents
                pseq = self.ent_prev_seq.get(num, 0)
                if pseq > evseq + 64:
                    pseq -= 256
                lost = max(0, evseq - pseq - 4)
                if evseq - pseq > 4:
                    pseq = evseq - 4
                if pseq < evseq:
                    for k in range(evseq - pseq, 0, -1):
                        i = (evseq - k) & 3
                        ev = st[E["events"][i]]
                        parm = st[E["eventParms"][i]]
                        client = num if etype == ET_PLAYER and num < MAX_CLIENTS else \
                            (st[E["clientNum"]] if etype == ET_PLAYER_CORPSE else None)
                        self.add_event(t, seq, "entity", num, entity_type_name(etype), client,
                                       ev, parm, _pos(st), st[E["otherEntityNum"]],
                                       st[E["attackerEntityNum"]], st[E["weapon"]],
                                       st[E["surfType"]], {}, lost=lost)
                self.ent_prev_seq[num] = evseq
            else:
                self.ent_prev_seq[num] = 0

            # -- per type -------------------------------------------------------
            if etype == ET_PLAYER and num < MAX_CLIENTS:
                pos = _pos(st)
                ef = st[E["eFlags"]]
                w = st[E["weapon"]]
                ap = E["apos.trBase"]
                self.last_pos[num] = (t, pos)
                pp.add(t, num, "entity", num in changed, pos[0], pos[1], pos[2],
                       _f(u2f(st[ap[0]])), _f(u2f(st[ap[1]])), _f(u2f(st[ap[2]])),
                       w, self.weapon_name(w), ef, stance_from_eflags(ef), bool(ef & 0x40),
                       bool(ef & 0x20000), _f(u2f(st[E["u"][0]])), s32(st[E["u"][1]]),
                       st[E["legsAnim"]], st[E["torsoAnim"]], st[E["groundEntityNum"]],
                       _f(u2f(st[E["fTorsoPitch"]])), _f(u2f(st[E["fWaistPitch"]])))
            elif etype == ET_MISSILE:
                self.on_missile(t, num, st, num in changed)
                self.track_entity(t, num, st)
            else:
                self.track_entity(t, num, st)

        # entities that left the snapshot
        for num, st in prev_all.items():
            if num not in cur_all:
                self.close_entity(num)
                self.missile_key.pop(num, None)
        self.prev_entities = cur_all

    def track_entity(self, t, num, st) -> None:
        life = self.ent_life.get(num)
        if life is not None and life[1] != st[1]:
            self.close_entity(num)
            life = None
        pos = _pos(st)
        if life is None:
            etype = st[1]
            self.ent_life[num] = [num, etype, t, t, 1, st[E["clientNum"]], st[E["weapon"]],
                                  st[E["index"]], pos, pos]
        else:
            life[3] = t
            life[4] += 1
            life[9] = pos

    def close_entity(self, num) -> None:
        life = self.ent_life.pop(num, None)
        if life is None:
            return
        num, etype, t0, t1, n, client, weapon, index, p0, p1 = life
        model = self.cs_at(CS_MODELS, index) if etype in (ET_GENERAL, 6) and index else None
        self.t("entities").add(num, entity_type_name(etype), t0, t1, n,
                               client if etype == ET_PLAYER_CORPSE else None,
                               weapon or None, index, model, p0[0], p0[1], p0[2],
                               p1[0], p1[1], p1[2])

    def on_missile(self, t, num, st, transmitted) -> None:
        w = st[E["weapon"]]
        launch = s32(st[E["u"][0]])
        pos = _pos(st)
        d = E["pos.trDelta"]
        vel = (_f(u2f(st[d[0]])), _f(u2f(st[d[1]])), _f(u2f(st[d[2]])))
        trtype = st[E["pos.trType"]]
        self.t("missiles").add(t, num, transmitted, w, self.weapon_name(w), launch, trtype,
                               s32(st[E["pos.trTime"]]), pos[0], pos[1], pos[2],
                               vel[0], vel[1], vel[2], st[E["groundEntityNum"]],
                               st[E["eFlags"]])
        key = (num, launch, w)
        g = self.grenades.get(key)
        if g is None:
            g = [num, w, self.weapon_name(w), launch, t, t, pos, vel, pos, 1, None, None]
            self.grenades[key] = g
        else:
            g[5] = t
            if transmitted:
                g[8] = pos
                g[9] += 1
        self.missile_key[num] = key

    # events
    def on_event_entity(self, t, seq, num, st) -> None:
        etype = st[1]
        ev = etype - ET_EVENTS
        fields = entity_dict(st)
        fields.pop("number", None)
        fields.pop("eType", None)
        self.add_event(t, seq, "event_entity", num, "event", st[E["clientNum"]] if ev in (
            EV_BULLET_HIT_CLIENT_SMALL, EV_BULLET_HIT_CLIENT_LARGE) else None, ev,
            st[E["eventParm"]], _pos(st), st[E["otherEntityNum"]], st[E["attackerEntityNum"]],
            st[E["weapon"]], st[E["surfType"]], fields, st)

    def add_event(self, t, seq, source, entity, etype_name, client, ev, parm, pos, other,
                  attacker, weapon, surf, fields, state=None, lost=0) -> None:
        name = event_name(ev)
        self.event_counts[name] = self.event_counts.get(name, 0) + 1
        resolved = None
        if ev in (EV_SOUND_ALIAS, EV_SOUND_ALIAS_AS_MASTER) and parm:
            resolved = self.cs_at(CS_SOUNDALIASES, parm)
        elif ev == EV_PLAY_FX and state is not None:
            resolved = self.cs_at(CS_EFFECT_NAMES, parm) if parm else None
        self.t("entity_events").add(
            t, seq, source, entity, etype_name, client, ev, name, parm,
            pos[0] if pos else None, pos[1] if pos else None, pos[2] if pos else None,
            other, attacker, weapon or None, self.weapon_name(weapon) if weapon else None,
            surf, resolved, lost, json.dumps(fields, separators=(",", ":")) if fields else None)
        if source == "event_entity":
            if ev == EV_OBITUARY:
                self.on_obituary(t, seq, other, attacker, parm)
            elif ev == EV_BULLET_HIT and surf == SURF_FLESH:
                self.on_hit(t, seq, "seen", attacker, None, weapon,
                            bool(state[E["un1"]]) if state is not None else None, pos)
            elif ev in (EV_BULLET_HIT_CLIENT_SMALL, EV_BULLET_HIT_CLIENT_LARGE):
                self.on_hit(t, seq, "taken", other, client, weapon, None, pos)
        if ev in (EV_GRENADE_EXPLODE, EV_FLASHBANG_EXPLODE) and source == "entity":
            key = self.missile_key.get(entity)
            if key and key in self.grenades:
                g = self.grenades[key]
                if g[10] is None:
                    g[10] = t
                    g[11] = pos

    def pos_of(self, c, t):
        lp = self.last_pos.get(c)
        if lp is None or t - lp[0] > POSITION_MAX_AGE_MS:
            return None
        return lp[1]

    def on_obituary(self, t, seq, victim, attacker, parm) -> None:
        if parm & OBITUARY_MOD_FLAG:
            mod = parm & 0x7F
            weapon = None
        else:
            mod = None
            weapon = parm
        world = attacker == ENTITYNUM_WORLD or attacker == ENTITYNUM_NONE
        suicide = attacker == victim or world
        vteam, ateam = self.team(victim), self.team(attacker)
        teamkill = (not suicide and vteam is not None and vteam == ateam
                    and vteam in ("axis", "allies"))
        vp, ap = self.pos_of(victim, t), (None if world else self.pos_of(attacker, t))
        self.t("kills").add(
            t, seq, attacker, self.name(attacker), None if world else ateam, victim,
            self.name(victim), vteam, weapon,
            "none" if weapon == 0 else self.weapon_name(weapon), mod,
            MEANS_OF_DEATH[mod] if mod is not None and mod < len(MEANS_OF_DEATH) else None,
            mod == 8, suicide, world, teamkill,
            ap[0] if ap else None, ap[1] if ap else None, ap[2] if ap else None,
            vp[0] if vp else None, vp[1] if vp else None, vp[2] if vp else None,
            _dist(ap, vp), parm)

    def on_hit(self, t, seq, kind, attacker, victim, weapon, headshot, pos) -> None:
        inferred = False
        vdist = None
        if kind == "taken" and victim is None:
            victim = self.prev_ps.fields[PS_INDEX["ClientNum"]] if self.prev_ps else None
        if kind == "seen":
            # the victim is not transmitted: nearest known player to the impact
            best, bd = None, None
            for c, (pt, p) in self.last_pos.items():
                if c == attacker or t - pt > 200:
                    continue
                dd = _dist(p, pos)
                if dd is not None and (bd is None or dd < bd):
                    best, bd = c, dd
            if best is not None and bd is not None and bd < 80:
                victim, inferred, vdist = best, True, bd
        self.t("hits").add(t, seq, kind, attacker, self.name(attacker), victim,
                           self.name(victim), inferred, vdist, weapon or None,
                           self.weapon_name(weapon), headshot, pos[0], pos[1], pos[2])

    # full dumps
    def full_dump(self, snap: P.Snapshot) -> dict:
        from .states import ps_dict
        info = snap.info
        changed = set(info.changed_entities)
        return {
            "message_seq": info.message_num, "server_time": info.server_time,
            "delta_num": info.delta_num, "snap_flags": info.snap_flags,
            "ps": ps_dict(info.ps, full=True),
            "entities": [dict(entity_dict(st), transmitted=num in changed)
                         for num, st in snap.entities],
            "removed_entities": info.removed_entities,
            "clients": [dict(client_dict(st), client=num) for num, st in snap.clients],
        }

    # -- finish ---------------------------------------------------------------
    def finish(self) -> None:
        if self.full_fh is not None:
            self.full_fh.close()
        for num in list(self.ent_life):
            self.close_entity(num)
        g = self.t("grenades")
        for key in sorted(self.grenades, key=lambda k: self.grenades[k][4]):
            num, w, wn, launch, t0, t1, p0, v0, p1, n, te, pe = self.grenades[key]
            g.add(num, w, wn, launch, t0, t1, p0[0], p0[1], p0[2], v0[0], v0[1], v0[2],
                  p1[0], p1[1], p1[2], n, te, pe[0] if pe else None, pe[1] if pe else None,
                  pe[2] if pe else None)
        cst = self.t("configstrings")
        for idx in sorted(self.cs):
            cat, off = configstring_category(idx)
            cst.add(idx, cat, off, self.cs[idx], self.cs_source.get(idx),
                    self.cs_updates.get(idx, 0), self.cs_last.get(idx))
        dv = self.t("dvars")
        for i in range(128):
            name = self.cs.get(CS_CODINFO + i)
            if name:
                dv.add(CS_CODINFO + i, name, self.cs.get(CS_CODINFO_VALUE + i, ""))
        self.build_meta()

    def build_meta(self) -> None:
        p = self.parser
        d = self.data
        d.serverinfo = parse_infostring(self.cs.get(CS_SERVERINFO, ""))
        d.systeminfo = parse_infostring(self.cs.get(CS_SYSTEMINFO, ""))
        si = d.serverinfo
        minimap = self.cs.get(CS_MINIMAP, "")
        mm = minimap.replace('"', "").split()
        size = len(p.data)
        sha1 = hashlib.sha1(p.data).hexdigest()
        players = {}
        for c in sorted(set(self.names) | set(self.teams)):
            players[c] = {"name": self.names.get(c), "clantag": self.clantags.get(c),
                          "last_team": self.team(c)}
        dur = (self.last_time - self.first_time) if self.first_time is not None else 0
        d.meta = {
            "file": str(self.path.name) if self.path else None,
            "size_bytes": size,
            "sha1": sha1,
            "protocol": p.protocol,
            "protocol_kind": "stock CoD4 (no protocol record)" if p.protocol == 1 else
                             ("CoD4X, legacy origin encoding" if p.protocol <= 17 else "CoD4X"),
            "clean_end": p.clean_end,
            "truncated": p.truncated,
            "records": dict(p.stats),
            "decode_errors": p.decoder.errors if p.decoder else 0,
            "gamestates": self.gamestates,
            "gamestate": self.gamestate_info,
            "pov_client": self.pov_client,
            "pov_name": self.names.get(self.pov_client) if self.pov_client is not None else None,
            "first_server_time": self.first_time,
            "last_server_time": self.last_time,
            "duration_s": round(dur / 1000.0, 2),
            "first_archive_time": self.first_archive,
            "last_archive_time": self.last_archive,
            "map": si.get("mapname"),
            "gametype": si.get("g_gametype"),
            "hostname": si.get("sv_hostname"),
            "hostname_clean": strip_colors(si.get("sv_hostname", "")),
            "fs_game": si.get("fs_game") or d.systeminfo.get("fs_game"),
            "server_version": si.get("version") or si.get("shortversion"),
            "game_version": self.cs.get(CS_GAME_VERSION),
            "map_start_time": si.get("g_mapStartTime"),
            "map_center": self.map_center,
            "minimap": {"material": mm[0], "corners": [float(x) for x in mm[1:5]]}
                       if len(mm) >= 5 else (minimap or None),
            "weapons": self.weapons,
            "players": players,
            "event_counts": dict(sorted(self.event_counts.items(), key=lambda kv: -kv[1])),
            "tables": {name: len(tbl) for name, tbl in d.tables.items()},
        }


def extract(path, full_output=None, progress=None) -> DemoData:
    """Parse a demo and return all extracted tables.

    ``full_output``: optional path of a JSON Lines file that receives a
    complete dump of every snapshot (player state incl. HUD elements, ammo and
    objectives, every entity with all fields, every client state). Large:
    roughly 20-40x the demo size.
    ``progress``: optional callable receiving a fraction 0..1.
    """
    return _Extractor(path, full_output=full_output, progress=progress).run()
