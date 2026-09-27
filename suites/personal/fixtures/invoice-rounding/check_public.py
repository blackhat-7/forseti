from invoice import invoice

lines = [
    {"sku": "desk-lamp", "price": "19.99", "qty": 3, "discount": "0"},
    {"sku": "cable-pack", "price": "4.50", "qty": 2, "discount": "10"},
    {"sku": "shelf-kit", "price": "12.00", "qty": 1, "discount": "25"},
    {"sku": "return-credit", "price": "-5.00", "qty": 1, "discount": "0"},
]
result = invoice(lines)
assert result == {"lines": ["59.97", "8.10", "9.00", "-5.00"], "total": "72.07"}, result
print("public check passed")
