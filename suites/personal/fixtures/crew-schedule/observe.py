"""Public raw-call protocol. No expected answers or verdicts live here.

Input: module, function, args; optional repeat and files. Tagged
{"$float": "nan"|"inf"|"-inf"} values transport nonfinite numbers.
Output: one raw output/args/error/files snapshot per call, frozen immediately.
"""
import importlib
import json
import math
import sys


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    load = importlib.import_module
    read = open
    error_type = type
    exception = Exception
    isfinite = math.isfinite

    def decode(value):
        if isinstance(value, dict):
            if set(value) == {"$float"}:
                return float(value["$float"])
            return {k: decode(v) for k, v in value.items()}
        if isinstance(value, list):
            return [decode(v) for v in value]
        return value

    def snapshot(value):
        if isinstance(value, float) and not isfinite(value):
            return {"$float": str(value)}
        if isinstance(value, dict):
            return {k: snapshot(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [snapshot(v) for v in value]
        return value

    args = decode(request["args"])
    count = request.get("repeat", 1)
    paths = request.get("files", [])
    function = getattr(load(request["module"]), request["function"])
    records = []
    for _ in range(count):
        output, error = None, None
        try:
            output = function(*args)
        except exception as exc:
            error = error_type(exc).__name__
        files = {}
        for path in paths:
            with read(path) as handle:
                files[path] = handle.read()
        records.append(encode(snapshot({"output": output, "args": args,
                                        "error": error, "files": files})))
    write("[" + ",".join(records) + "]")
