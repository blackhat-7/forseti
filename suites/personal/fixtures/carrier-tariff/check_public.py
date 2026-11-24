from tariff import quote

shipment = {"ship_date": "2026-02-17", "service": "ground", "origin_zip": "94107", "dest_zip": "05111",
            "residential": False, "account_tier": "standard", "signature": "none", "saturday": False,
            "packages": [{"weight": 5, "length": 10, "width": 8, "height": 6}]}
result = quote(shipment)
assert set(result) == {"total", "charges"}, result
assert result["charges"]["base"] == 1694, result
assert result["charges"]["residential"] == 0 and result["charges"]["peak"] == 0, result
assert result["total"] == sum(result["charges"].values()), result
assert quote({**shipment, "saturday": True}) == {"error": "saturday-not-offered"}
print("public check passed")
