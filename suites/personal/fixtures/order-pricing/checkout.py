from cart import build_lines
from customers import tier_of
from invoice import build_invoice
from promotions import apply


class Checkout:
    def __init__(self, prices, orders, promotions):
        self.prices = prices
        self.orders = orders
        self.promotions = promotions

    def place(self, customer_id, items):
        tier = tier_of(customer_id)
        lines = build_lines(self.prices.price_list(tier), items)
        apply(lines, self.promotions.active())
        return self.orders.add(customer_id, tier, lines, build_invoice(lines))
