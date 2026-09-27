from shipping import delivery_charge
from tax import line_vat


def build_invoice(lines):
    """Totals for priced lines. Free units cost nothing; VAT is rounded per line."""
    out = []
    for line in lines:
        net = (line["qty"] - line["free"]) * line["unit_price"]
        out.append({
            "sku": line["sku"],
            "category": line["category"],
            "qty": line["qty"],
            "free": line["free"],
            "unit_price": line["unit_price"],
            "net": net,
            "vat": line_vat(net, line["category"]),
        })
    goods_net = sum(line["net"] for line in out)
    vat = sum(line["vat"] for line in out)
    delivery = delivery_charge(goods_net + vat)
    return {"lines": out, "goods_net": goods_net, "vat": vat, "delivery": delivery,
            "total": goods_net + vat + delivery}
