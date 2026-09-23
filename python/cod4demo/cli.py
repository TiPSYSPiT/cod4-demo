"""Command line interface.

    python -m cod4demo DEMO [DEMO ...] [-o OUTDIR] [--format csv|jsonl|json]
                         [--tables a,b,c] [--full] [--quiet]
    python -m cod4demo --info DEMO          print a short summary only
    python -m cod4demo --selftest           verify the Huffman table
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import __version__
from .export import write_all
from .extract import extract
from .text import strip_colors


def _progress(prefix: str):
    last = [0.0]

    def cb(frac: float) -> None:
        now = time.time()
        if now - last[0] > 0.5:
            last[0] = now
            sys.stderr.write(f"\r{prefix} {frac * 100:5.1f}%")
            sys.stderr.flush()
    return cb


def _info(data) -> str:
    m = data.meta
    lines = [
        f"file        {m['file']}  ({m['size_bytes']:,} bytes)",
        f"protocol    {m['protocol']} - {m['protocol_kind']}",
        f"server      {m.get('hostname_clean')}  ({m.get('server_version')})",
        f"map / mode  {m.get('map')} / {m.get('gametype')}   fs_game {m.get('fs_game')}",
        f"recorder    client {m.get('pov_client')} = {strip_colors(m.get('pov_name') or '')}",
        f"length      {m['duration_s']:.1f} s of server time, "
        f"{m['records']['snapshots']:,} snapshots, {m['records']['archives']:,} archive frames",
        f"integrity   clean end {m['clean_end']}, truncated {m['truncated']}, "
        f"snapshots dropped {m['records']['snapshots_dropped']}, issues {m['records']['issues']}",
        "tables:",
    ]
    for name, n in m["tables"].items():
        lines.append(f"  {name:<22} {n:>9,}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="cod4demo",
                                 description="Extract all data from Call of Duty 4 demos (.dm_1)")
    ap.add_argument("demos", nargs="*", type=Path, help="demo files or folders")
    ap.add_argument("-o", "--out", type=Path, default=None,
                    help="output folder (default: ./out/<demo name>/)")
    ap.add_argument("--format", choices=("csv", "jsonl", "json"), default="csv")
    ap.add_argument("--tables", default=None,
                    help="comma separated list of tables to write (default: all)")
    ap.add_argument("--full", action="store_true",
                    help="also write snapshots_full.jsonl (complete state of every snapshot, large)")
    ap.add_argument("--info", action="store_true", help="print a summary, write nothing")
    ap.add_argument("--selftest", action="store_true", help="verify the Huffman table and exit")
    ap.add_argument("-q", "--quiet", action="store_true")
    ap.add_argument("--version", action="version", version=f"cod4demo {__version__}")
    args = ap.parse_args(argv)

    if args.selftest:
        from .huffman import selftest
        return 0 if selftest(verbose=True) else 1
    if not args.demos:
        ap.print_help()
        return 2

    files: list[Path] = []
    for p in args.demos:
        if p.is_dir():
            files.extend(sorted(p.glob("*.dm_*")))
        else:
            files.append(p)
    tables = args.tables.split(",") if args.tables else None
    rc = 0
    for f in files:
        name = f.name.rsplit(".", 1)[0]
        out_dir = (args.out / name) if (args.out and len(files) > 1) else \
                  (args.out or Path("out") / name)
        t0 = time.time()
        try:
            data = extract(f, full_output=(out_dir / "snapshots_full.jsonl") if args.full and not args.info else None,
                           progress=None if args.quiet else _progress(f.name))
        except Exception as exc:                          # keep going with the next file
            sys.stderr.write(f"\n{f}: ERROR {exc!r}\n")
            rc = 1
            continue
        if not args.quiet:
            sys.stderr.write("\r" + " " * 70 + "\r")
        if args.info:
            print(_info(data))
            print()
            continue
        written = write_all(data, out_dir, args.format, tables)
        if not args.quiet:
            print(f"{f.name}: {len(written)} files -> {out_dir}  ({time.time() - t0:.1f} s)")
    return rc


if __name__ == "__main__":
    sys.exit(main())
