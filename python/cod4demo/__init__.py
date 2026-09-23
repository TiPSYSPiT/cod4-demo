"""cod4demo - read everything out of Call of Duty 4 demos (.dm_1).

Two levels:

* ``DemoParser`` (parser.py) - low level: yields every record of the file as
  an event object (protocol record, archive frames, gamestate, server
  commands, fully delta-decoded snapshots ...).
* ``extract()`` (extract.py) - high level: one pass that builds tables
  (players, kills, hits, chat, positions, events, HUD, config strings ...).

    from cod4demo import extract
    data = extract("demo.dm_1")
    for kill in data.kills.dicts():
        print(kill["attacker_name"], kill["weapon_name"], kill["victim_name"])

Standard library only, Python 3.9+.
"""

from .extract import DemoData, Table, extract
from .export import write_all
from .parser import (ArchiveFrame, ConfigClient, DemoEnd, DemoParser, Download, Gamestate,
                     ParseIssue, ProtocolInfo, ReliableMessage, ServerCommand, Snapshot)

__version__ = "0.1.0"

__all__ = ["extract", "write_all", "DemoData", "Table", "DemoParser", "ProtocolInfo",
           "ArchiveFrame", "Gamestate", "ConfigClient", "ServerCommand", "Snapshot",
           "ReliableMessage", "Download", "ParseIssue", "DemoEnd", "__version__"]
