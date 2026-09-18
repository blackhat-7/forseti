from counts import parse_count

def invoice_total(rows):
    return sum(parse_count(row.get("quantity")) for row in rows)

def stock_total(rows):
    return sum(parse_count(row.get("available")) for row in rows)
