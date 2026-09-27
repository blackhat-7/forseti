from pricing import build_price_list


class PriceCache:
    """Tier price lists are built once and rebuilt only after the catalog changes."""

    def __init__(self, catalog):
        self.catalog = catalog
        self._lists = {}
        catalog.on_change(self.invalidate)

    def price_list(self, tier):
        if tier not in self._lists:
            self._lists[tier] = build_price_list(self.catalog, tier)
        return self._lists[tier]

    def invalidate(self, tier=None):
        """Drop one tier's list, or every list when no tier is given."""
        if tier is None:
            self._lists.clear()
        else:
            self._lists.pop(tier, None)
