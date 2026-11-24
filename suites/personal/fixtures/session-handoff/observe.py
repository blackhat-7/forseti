"""Public batch-call protocol. No expected answers or verdicts live here.

Input: module, function, calls (a list of argument lists).
Output: one raw output/args/error snapshot per call, frozen immediately.
"""
import importlib
import json
import sys


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    load = importlib.import_module
    error_type = type
    exception = Exception
    function = getattr(load(request["module"]), request["function"])
    records = []
    for args in request["calls"]:
        output, error = None, None
        try:
            output = function(*args)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({"output": output, "args": args, "error": error}))
    write("[" + ",".join(records) + "]")
