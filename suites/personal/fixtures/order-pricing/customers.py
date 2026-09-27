from errors import UnknownCustomer

# Percentage of the list price each tier pays.
TIERS = {"retail": 100, "trade": 85}

CUSTOMERS = {
    "C-100": {"name": "Amira", "tier": "retail"},
    "C-200": {"name": "Brook Landscaping", "tier": "trade"},
    "C-300": {"name": "Cedar Row Allotments", "tier": "trade"},
    "C-400": {"name": "Dmitri", "tier": "retail"},
}


def tier_of(customer_id):
    customer = CUSTOMERS.get(customer_id)
    if customer is None:
        raise UnknownCustomer(customer_id)
    return customer["tier"]
