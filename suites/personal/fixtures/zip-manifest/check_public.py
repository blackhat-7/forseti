import json
from pathlib import Path
from package import manifest

d = json.loads(Path("data.json").read_text())
got = manifest(d["listing"], d["settings"])
assert got == {
    "models": {"exposure": "v3/exposure.onnx", "contrast": "v3/contrast.onnx", "tint": "v3/tint.onnx"},
    "constants": {"vignette": 1.5},
    "missing": ["clarity"],
}, got
print("public check passed")
