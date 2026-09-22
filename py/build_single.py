#!/usr/bin/env python3
"""Bundle source/ into a single self-contained HTML file.

    py source/py/build_single.py [-o dist/dm1-standalone.html]

source/ is the source of truth; this file only produces the bundle from it
(handy for passing around or opening straight in a browser).

The map images under ``source/maps`` are not included; without them the map
view falls back to the floor plan built from the positions. To get them, put
a ``maps`` folder next to the generated file.
"""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
#: source/ is the directory above this one - the page sits next to py/.
WEB = Path(__file__).resolve().parents[1]

#: Placeholder in index.html -> file under source/.
REPLACEMENTS = (
    ('<link rel="stylesheet" href="css/style.css">', "css/style.css", "style"),
    ('<script src="js/netfields.js"></script>', "js/netfields.js", "script"),
    ('<script src="js/snapshot.js"></script>', "js/snapshot.js", "script"),
    ('<script src="js/dm1.js"></script>', "js/dm1.js", "script"),
    ('<script src="js/app.js"></script>', "js/app.js", "script"),
)


def build() -> str:
    html = (WEB / "index.html").read_text(encoding="utf-8")
    for marker, name, tag in REPLACEMENTS:
        if marker not in html:
            raise SystemExit(f"placeholder not found in source/index.html: {marker}")
        body = (WEB / name).read_text(encoding="utf-8")
        if "</script" in body.lower():
            raise SystemExit(f"{name} contains '</script' - cannot be inlined")
        html = html.replace(marker, f"<{tag}>\n{body}\n</{tag}>")
    return html


def main() -> int:
    ap = argparse.ArgumentParser(description="Bundle source/ into a single HTML file.")
    ap.add_argument("-o", "--out", type=Path, default=ROOT / "dist" / "dm1-standalone.html")
    args = ap.parse_args()
    html = build()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(html, encoding="utf-8", newline="\n")
    print(f"{args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out}: "
          f"{len(html.encode('utf-8')):,} Bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
