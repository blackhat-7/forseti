from money import round_half_up

PROMOTIONS = [
    {"id": "BULBS10", "kind": "percent", "category": "bulbs", "percent": 10},
    {"id": "COMPOST3FOR2", "kind": "multibuy", "sku": "SL-CMP", "buy": 3, "pay": 2},
]


def apply(lines, promotions):
    """Apply every active promotion to the cart lines.

    A percentage promotion lowers the unit price of each line in its category, rounded to the
    cent. A multi-buy makes one unit free in every complete group of `buy` units of its product."""
    for promotion in promotions:
        for line in lines:
            if promotion["kind"] == "percent" and line["category"] == promotion["category"]:
                line["unit_price"] = round_half_up(line["unit_price"] * (100 - promotion["percent"]), 100)
            elif promotion["kind"] == "multibuy" and line["sku"] == promotion["sku"]:
                line["free"] = line["qty"] // promotion["buy"] * (promotion["buy"] - promotion["pay"])
    return lines
