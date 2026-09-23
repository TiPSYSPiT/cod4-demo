"""Decoding of reliable server commands (``svc_serverCommand`` strings).

The first character of a command selects the handler (see
``CG_DeployServerCommand`` in cg_servercmds_mp.cpp and
``CL_CGameNeedsServerCommand`` in cl_cgame_mp.cpp). ``decode()`` returns a
dict with the verb, a readable name and the decoded arguments.
"""

from __future__ import annotations

from .constants import SERVER_COMMANDS
from .text import strip_colors, tokenize

#: handled by the client engine itself before cgame sees them
ENGINE_COMMANDS = {
    "w": "disconnect",                 # w <reason> [PB]
    "x": "big_configstring_start",     # x <index> <part>
    "y": "big_configstring_append",    # y <index> <part>
    "z": "big_configstring_end",       # z <index> <part>
}


def _int(s: str, default: int | None = None) -> int | None:
    try:
        return int(s)
    except (TypeError, ValueError):
        try:
            return int(float(s))
        except (TypeError, ValueError):
            return default


def _float(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def decode(text: str) -> dict:
    """Decode one server command string."""
    verb = text[:1] if text else ""
    name = ENGINE_COMMANDS.get(verb) or SERVER_COMMANDS.get(verb) or "unknown"
    out: dict = {"verb": verb, "name": name}
    if verb in ("d", "x", "y", "z"):
        argv = tokenize(text, 3)
        out["index"] = _int(argv[1]) if len(argv) > 1 else None
        out["value"] = argv[2] if len(argv) > 2 else ""
        return out
    argv = tokenize(text)
    args = argv[1:]
    out["args"] = args
    if verb == "b" and args:
        n = _int(args[0], 0) or 0
        out["count"] = n
        out["score_axis"] = _int(args[1]) if len(args) > 1 else None
        out["score_allies"] = _int(args[2]) if len(args) > 2 else None
        out["scorelimit"] = _int(args[3]) if len(args) > 3 else None
        entries = []
        for i in range(min(n, 64)):
            base = 4 + 7 * i
            if base + 7 > len(args):
                break
            c, score, ping, deaths, icon, kills, assists = (_int(a) for a in args[base:base + 7])
            entries.append({"client": c, "score": score, "ping": ping, "deaths": deaths,
                            "status_icon": icon, "kills": kills, "assists": assists})
        out["entries"] = entries
    elif verb in ("h", "i"):
        out["text"] = args[0] if args else ""
        out["scope"] = "all" if verb == "h" else "team"
    elif verb in ("c", "e", "f", "g"):
        out["text"] = args[0] if args else ""
    elif verb in ("G", "H"):
        out["team"] = "axis" if verb == "G" else "allies"
        out["score"] = _int(args[0]) if args else None
    elif verb == "I" and len(args) >= 2:
        out["client"] = _int(args[0])
        out["score"] = _int(args[1])
    elif verb in ("a", "C") and args:
        out["weapon"] = _int(args[0])
    elif verb == "J" and args:
        out["menu"] = _int(args[0])
    elif verb == "K" and args:
        out["client"] = _int(args[0])
    elif verb == "N" and len(args) >= 2:
        out["stat"] = _int(args[0])
        out["value"] = _int(args[1])
    elif verb == "v":
        out["dvars"] = [(args[i], args[i + 1] if i + 1 < len(args) else "")
                        for i in range(0, len(args), 2)]
    elif verb == "t" and args:
        out["menu"] = _int(args[0])
    elif verb == "o" and args:
        out["alias"] = args[0]
        out["volume"] = _int(args[1]) if len(args) > 1 else None
    elif verb == "p" and args:
        out["fade_time"] = _int(args[0])
    elif verb == "q" and len(args) >= 2:
        out["volume"] = _float(args[0])
        out["time"] = _int(args[1])
    elif verb == "s" and args:
        out["alias"] = args[0]
    elif verb == "w":
        out["reason"] = args[0] if args else ""
    elif verb == "j" and len(args) >= 8:
        out["id"] = _int(args[0])
        out["draw_type"] = _int(args[1])
        out["pos"] = [_float(a) for a in args[2:5]]
        out["dir"] = [_float(a) for a in args[5:8]]
    return out


class BigConfigStringAssembler:
    """Reassembles ``x`` / ``y`` / ``z`` pieces into one config string update."""

    def __init__(self) -> None:
        self.index: int | None = None
        self.buf = ""

    def feed(self, d: dict) -> tuple[int, str] | None:
        verb = d["verb"]
        if verb == "x":
            self.index = d["index"]
            self.buf = d["value"]
        elif verb == "y":
            self.buf += d["value"]
        elif verb == "z":
            self.buf += d["value"]
            if self.index is not None:
                done = (self.index, self.buf)
                self.index, self.buf = None, ""
                return done
        return None


def clean(text: str) -> str:
    return strip_colors(text)
