"""Entry point. Importing an area module registers its routes in web.ROUTES."""
import payments  # noqa: F401
import billing  # noqa: F401
import treasury  # noqa: F401
import balances  # noqa: F401
import corrections  # noqa: F401
# import deposits  -- ships with the Q3 release, see README.md
import web


def handle(request):
    """Serve one request."""
    return web.dispatch(request)
