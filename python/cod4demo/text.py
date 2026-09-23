"""Text helpers: colour codes, info strings and the engine tokenizer."""

from __future__ import annotations

import re

_COLOR = re.compile(r"\^[0-9:;<=>?]")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


def strip_colors(s: str) -> str:
    """Remove ``^N`` colour codes and control characters.

    CoD4 inserts 0x14/0x15/0x16 as localisation markers into messages (e.g.
    in front of names in chat and game messages); they are removed too.
    """
    return _CTRL.sub("", _COLOR.sub("", s or ""))


def parse_infostring(s: str) -> dict[str, str]:
    r"""``\key\value\key\value`` -> dict (order preserved)."""
    parts = (s or "").split("\\")
    if parts and parts[0] == "":
        parts = parts[1:]
    return {parts[i]: parts[i + 1] if i + 1 < len(parts) else "" for i in range(0, len(parts), 2)}


def _is_space(c: str) -> bool:
    o = ord(c)
    return o <= 0x20 and o not in (0x14, 0x15, 0x16)


def tokenize(text: str, max_tokens: int = 512) -> list[str]:
    """Port of ``Cmd_TokenizeStringInternal`` (qcommon/cmd.cpp).

    * whitespace is any byte <= 0x20 except the localisation markers 0x14-0x16
    * ``//`` ends the line, ``/* ... */`` is skipped (outside quotes)
    * ``"..."`` groups a token, ``\\"`` inside quotes is a literal quote
    * the last allowed token (``max_tokens``) receives the raw remainder
    """
    argv: list[str] = []
    i, n = 0, len(text)
    while True:
        while True:
            while i < n and _is_space(text[i]):
                i += 1
            if i >= n:
                return argv
            if text.startswith("//", i):
                return argv
            if text.startswith("/*", i):
                j = text.find("*/", i + 2)
                if j < 0:
                    return argv
                i = j + 2
                continue
            break
        max_tokens -= 1
        if max_tokens == 0:
            argv.append(text[i:])
            return argv
        if text[i] == '"':
            j = i + 1
            buf = []
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n and text[j + 1] == '"':
                    j += 1
                buf.append(text[j])
                j += 1
            argv.append("".join(buf))
            if j >= n:
                return argv
            i = j + 1
            if i >= n:
                return argv
        else:
            j = i
            while j < n and not _is_space(text[j]) and not (
                    text[j] == "/" and j + 1 < n and text[j + 1] in "/*"):
                j += 1
            argv.append(text[i:j])
            i = j
