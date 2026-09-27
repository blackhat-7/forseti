from errors import UnknownOrder


class OrderBook:
    def __init__(self):
        self._orders = {}

    def add(self, customer_id, tier, lines, invoice):
        order_id = "O-%d" % (len(self._orders) + 1)
        self._orders[order_id] = {"order_id": order_id, "customer_id": customer_id, "tier": tier,
                                  "lines": lines, "invoice": invoice}
        return order_id

    def get(self, order_id):
        order = self._orders.get(order_id)
        if order is None:
            raise UnknownOrder(order_id)
        return order
