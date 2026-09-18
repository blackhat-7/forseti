ROUTES = {
    ("GET", "/health"): 200,
    ("GET", "/items"): 200,
    ("POST", "/items"): 201,
    ("DELETE", "/items"): 204,
    ("GET", "/items/export"): 200,
}

NEEDS_AUTH = {("POST", "/items"), ("DELETE", "/items")}

ENABLED = ("/health", "/items")


def dispatch(method, path, authorized):
    if path not in ENABLED:
        return 404
    if (method, path) not in ROUTES:
        return 405
    if (method, path) in NEEDS_AUTH and not authorized:
        return 401
    if method == "DELETE":
        return 501
    return ROUTES[(method, path)]
