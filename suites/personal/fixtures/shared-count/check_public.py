from callers import invoice_total, stock_total
assert invoice_total([{"quantity": " 3 "}, {"quantity": None}]) == 3
assert stock_total([{"available": "bad"}, {"available": 2}]) == 2
print("public check passed")
