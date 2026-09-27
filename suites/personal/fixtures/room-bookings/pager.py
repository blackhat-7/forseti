def each(fetch):
    """Every row of a keyset-paged read. fetch(after) returns (rows, cursor); None ends it."""
    after = None
    while True:
        rows, after = fetch(after)
        for row in rows:
            yield row
        if after is None:
            return
