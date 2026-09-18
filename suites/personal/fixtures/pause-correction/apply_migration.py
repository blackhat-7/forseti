"""Step 4 of the migration: switch the mode over and mark the change published."""
import json
from pathlib import Path

settings = json.loads(Path("settings.json").read_text())
settings["mode"] = "new"
settings["published"] = True
Path("settings.json").write_text(json.dumps(settings))
print("migration applied")
