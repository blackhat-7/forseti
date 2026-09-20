"""Builds the manifest for a profile zip from the trainer's output listing."""


def manifest(listing, settings):
    newest = {}
    for name in sorted(listing):
        version, file = name.split("/")
        newest[file.rstrip(".onnx")] = name
    result = {"models": {}, "constants": {}, "missing": []}
    for slider, setting in settings.items():
        if not setting:
            continue
        if setting != "learned":
            result["constants"][slider] = setting
        elif slider in newest:
            result["models"][slider] = newest[slider]
        else:
            result["missing"].append(slider)
    result["missing"].sort()
    return result
