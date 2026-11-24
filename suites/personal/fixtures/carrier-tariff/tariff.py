"""Shipment pricing. The tariff in TARIFF-1.md and TARIFF-2.md is the specification."""


def quote(shipment):
    """Price one shipment under the tariff.

    shipment: {"ship_date": "YYYY-MM-DD", "service": "ground" | "express" | "overnight",
               "origin_zip": "94107", "dest_zip": "10001", "residential": bool,
               "account_tier": "standard" | "silver" | "gold" | "platinum",
               "signature": "none" | "direct" | "adult", "saturday": bool,
               "packages": [{"weight": lb, "length": in, "width": in, "height": in}, ...]}

    Returns {"total": cents, "charges": {"base": cents, "discount": cents, "residential": cents,
    "delivery_area": cents, "handling": cents, "oversize": cents, "peak": cents, "signature": cents,
    "saturday": cents, "fuel": cents}}, all ten charges present, or {"error": "<code>"} for a shipment
    the tariff refuses.
    """
    raise NotImplementedError("see TARIFF-1.md and TARIFF-2.md")
