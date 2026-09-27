class ShopError(Exception):
    """Base class for errors a caller is expected to handle."""


class UnknownProduct(ShopError):
    pass


class UnknownCustomer(ShopError):
    pass


class UnknownOrder(ShopError):
    pass


class InvalidOrder(ShopError):
    pass


class InvalidRefund(ShopError):
    pass
