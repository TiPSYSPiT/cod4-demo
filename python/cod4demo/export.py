"""Writers for ``DemoData``: CSV, JSON and JSON Lines."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from .extract import DemoData, Table


def _cell(v):
    if isinstance(v, (list, tuple, dict)):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    if v is None:
        return ""
    if isinstance(v, bool):
        return "1" if v else "0"
    return v


def write_csv(table: Table, path: Path) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(table.columns)
        for r in table.rows:
            w.writerow([_cell(v) for v in r])


def write_jsonl(table: Table, path: Path) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for d in table.dicts():
            fh.write(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
            fh.write("\n")


def summary_dict(data: DemoData) -> dict:
    return {
        "meta": data.meta,
        "serverinfo": data.serverinfo,
        "systeminfo": data.systeminfo,
        "tables": {name: {"rows": len(t), "columns": t.columns, "description": t.description}
                   for name, t in data.tables.items()},
    }


def write_all(data: DemoData, out_dir: Path, fmt: str = "csv",
              tables: list[str] | None = None) -> list[Path]:
    """Write ``summary.json`` plus one file per table into ``out_dir``.

    ``fmt``: ``csv`` (default), ``jsonl`` or ``json`` (one combined file).
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    summary = out_dir / "summary.json"
    summary.write_text(json.dumps(summary_dict(data), ensure_ascii=False, indent=1),
                       encoding="utf-8")
    written.append(summary)
    selected = [t for name, t in data.tables.items() if tables is None or name in tables]
    if fmt == "json":
        path = out_dir / "tables.json"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({t.name: list(t.dicts()) for t in selected}, fh, ensure_ascii=False,
                      separators=(",", ":"))
        written.append(path)
    else:
        for t in selected:
            path = out_dir / f"{t.name}.{fmt}"
            (write_jsonl if fmt == "jsonl" else write_csv)(t, path)
            written.append(path)
    if data.full_output:
        written.append(Path(data.full_output))
    return written
