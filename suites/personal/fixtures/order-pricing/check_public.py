from app import Shop

shop = Shop()
items = [("BLB-TUL", 2), ("SED-BAS", 3)]
first = shop.invoice(shop.place_order("C-200", items))
second = shop.invoice(shop.place_order("C-200", items))
assert first["total"] == 3374, first
assert second == first, (first, second)
print("public check passed")
