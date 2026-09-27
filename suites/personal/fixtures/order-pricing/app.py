import copy

from catalog import Catalog
from checkout import Checkout
from orders import OrderBook
from price_cache import PriceCache
from promotions import PROMOTIONS
from refunds import Refunds


class ActivePromotions:
    def __init__(self, promotions):
        self._promotions = [dict(promotion) for promotion in promotions]

    def active(self):
        return list(self._promotions)

    def end(self, promotion_id):
        self._promotions = [p for p in self._promotions if p["id"] != promotion_id]


class Shop:
    """The public face of the shop. Every call is what the web layer uses."""

    def __init__(self):
        self.catalog = Catalog()
        self.prices = PriceCache(self.catalog)
        self.orders = OrderBook()
        self.promotions = ActivePromotions(PROMOTIONS)
        self.checkout = Checkout(self.prices, self.orders, self.promotions)
        self.refunds = Refunds(self.orders, self.prices)

    def place_order(self, customer_id, items):
        """items: list of (sku, quantity). Returns the order id."""
        return self.checkout.place(customer_id, [tuple(item) for item in items])

    def invoice(self, order_id):
        return copy.deepcopy(self.orders.get(order_id)["invoice"])

    def refund(self, order_id, sku, quantity):
        return self.refunds.refund(order_id, sku, quantity)

    def set_price(self, sku, list_price):
        self.catalog.set_price(sku, list_price)

    def end_promotion(self, promotion_id):
        self.promotions.end(promotion_id)
