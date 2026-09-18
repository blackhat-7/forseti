"""Production tier evaluation. Branch ids are fixed; do not renumber them."""


def evaluate_shipment(row):
    if row["weight_kg"] <= 0:
        return "invalid"                          # B1
    if row["destination"] == "domestic":
        if row["insured_value"] > 500:
            return "domestic_declared"            # B2
        if row["weight_kg"] > 30:
            return "domestic_heavy"               # B3
        return "domestic_standard"                # B4
    if row["insured_value"] >= 1000:
        if row["weight_kg"] > 30:
            return "international_insured_heavy"  # B5
        return "international_insured"            # B6
    if row["express"]:
        if row["weight_kg"] > 30:
            return "international_express_heavy"  # B7
        return "international_express"            # B8
    return "international_standard"               # B9
