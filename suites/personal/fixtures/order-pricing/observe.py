"""Public scenario protocol. No expected answers or verdicts live here.

Input: a list of steps run in order against one fresh app.Shop().
  {"op": "order", "customer": ..., "items": [[sku, quantity], ...]}
  {"op": "invoice", "id": order id}
  {"op": "refund", "id": order id, "sku": ..., "qty": n}
  {"op": "price", "sku": ..., "list_price": cents}
  {"op": "end", "promotion": promotion id}
Output: one {"value": raw result, "error": exception type name or null} per step.
"""
import json
import sys


def observe(payload):
    steps = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    exception, error_type = Exception, type
    from app import Shop
    shop = Shop()
    run = {
        "order": lambda s: shop.place_order(s["customer"], s["items"]),
        "invoice": lambda s: shop.invoice(s["id"]),
        "refund": lambda s: shop.refund(s["id"], s["sku"], s["qty"]),
        "price": lambda s: shop.set_price(s["sku"], s["list_price"]),
        "end": lambda s: shop.end_promotion(s["promotion"]),
    }
    records = []
    for step in steps:
        value, error = None, None
        try:
            value = run[step["op"]](step)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({"value": value, "error": error}))
    write("[" + ",".join(records) + "]")
