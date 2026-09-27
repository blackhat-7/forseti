from errors import InvalidRefund
from tax import line_vat


class Refunds:
    def __init__(self, orders, prices):
        self.orders = orders
        self.prices = prices
        self._refunded = {}

    def refund(self, order_id, sku, quantity):
        """Refund returned units of one product on an order. Returns the amount in cents."""
        order = self.orders.get(order_id)
        line = next((line for line in order["invoice"]["lines"] if line["sku"] == sku), None)
        if line is None:
            raise InvalidRefund("%s is not on %s" % (sku, order_id))
        already = self._refunded.get((order_id, sku), 0)
        if type(quantity) is not int or quantity < 1 or already + quantity > line["qty"] - line["free"]:
            raise InvalidRefund("cannot refund %r more of %s" % (quantity, sku))
        product = self.prices.price_list(order["tier"])[sku]
        net = quantity * product["unit_price"]
        self._refunded[(order_id, sku)] = already + quantity
        return net + line_vat(net, product["category"])
