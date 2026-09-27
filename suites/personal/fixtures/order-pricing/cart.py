from errors import InvalidOrder, UnknownProduct


def build_lines(price_list, items):
    """One line per product, in the order products first appear in the cart.

    items is a list of (sku, quantity) entries; the same sku may appear more than once."""
    if not items:
        raise InvalidOrder("the cart is empty")
    lines, by_sku = [], {}
    for sku, quantity in items:
        if type(quantity) is not int or quantity < 1:
            raise InvalidOrder("quantity must be a positive whole number")
        if sku not in price_list:
            raise UnknownProduct(sku)
        if sku in by_sku:
            by_sku[sku]["qty"] += quantity
            continue
        line = price_list[sku]
        line["qty"] = quantity
        line["free"] = 0
        by_sku[sku] = line
        lines.append(line)
    return lines
