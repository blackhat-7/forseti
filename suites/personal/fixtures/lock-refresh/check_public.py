import json
from pathlib import Path

from resolver import resolve

index = json.loads(Path("registry.json").read_text())

got = resolve(["harbor", "courier", "ledger", "tally"], index)
assert got == {"harbor": "2.10.1", "courier": "2.0.0", "ledger": "0.9.4", "tally": "2.2.0"}, got

got = resolve(["ledger", "tally", "harbor", "courier"], index)
assert got == {"ledger": "0.9.4", "tally": "2.2.0", "harbor": "2.10.1", "courier": "2.0.0"}, got

# Only a tally release that needs a ledger 1.x, which was never published.
unpublished = dict(index, tally={"3.1.0": {"ledger": ">=1.0.0"}})
got = resolve(["harbor", "courier", "ledger", "tally"], unpublished)
assert got is None, got
print("public check passed")
