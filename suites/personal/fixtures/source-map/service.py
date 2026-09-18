def dispatch(method, path, authorized):
    if path == "/health" and method == "GET":
        return 200
    if path == "/items" and method == "POST":
        return 201 if authorized else 401
    return 404
