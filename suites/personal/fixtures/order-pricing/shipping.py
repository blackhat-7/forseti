DELIVERY = 495
FREE_FROM = 5000


def delivery_charge(goods_gross):
    """Delivery is free once the goods, after promotions and with VAT, reach FREE_FROM."""
    return 0 if goods_gross >= FREE_FROM else DELIVERY
