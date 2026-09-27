from customers import TIERS
from money import round_half_up


def tier_price(list_price, tier):
    return round_half_up(list_price * TIERS[tier], 100)


def build_price_list(catalog, tier):
    """Everything a cart line needs to know about each product, at the tier's price."""
    price_list = {}
    for sku in catalog.skus():
        product = catalog.get(sku)
        price_list[sku] = {
            "sku": sku,
            "name": product["name"],
            "category": product["category"],
            "unit_price": tier_price(product["list_price"], tier),
        }
    return price_list
