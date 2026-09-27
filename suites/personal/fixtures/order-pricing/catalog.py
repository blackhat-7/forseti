from errors import UnknownProduct

PRODUCTS = {
    "BLB-TUL": {"name": "Tulip bulbs, pack of 10", "category": "bulbs", "list_price": 1250},
    "BLB-DAF": {"name": "Daffodil bulbs, pack of 10", "category": "bulbs", "list_price": 990},
    "SED-BAS": {"name": "Basil seeds", "category": "seeds", "list_price": 325},
    "SED-TOM": {"name": "Tomato seeds", "category": "seeds", "list_price": 410},
    "TL-TRW": {"name": "Hand trowel", "category": "tools", "list_price": 1899},
    "TL-GLV": {"name": "Gardening gloves", "category": "tools", "list_price": 1150},
    "SL-CMP": {"name": "Compost, 40 L", "category": "soil", "list_price": 845},
}


class Catalog:
    def __init__(self, products=PRODUCTS):
        self._products = {sku: dict(product) for sku, product in products.items()}
        self._listeners = []

    def skus(self):
        return sorted(self._products)

    def get(self, sku):
        if sku not in self._products:
            raise UnknownProduct(sku)
        return dict(self._products[sku])

    def on_change(self, listener):
        """listener(sku) is called after a product's price changes."""
        self._listeners.append(listener)

    def set_price(self, sku, list_price):
        if type(list_price) is not int or list_price < 1:
            raise ValueError("list price must be a positive number of cents")
        if sku not in self._products:
            raise UnknownProduct(sku)
        self._products[sku]["list_price"] = list_price
        for listener in self._listeners:
            listener(sku)
