"""Production tier evaluation. Branch ids are fixed; do not renumber them."""


def evaluate_shipment(row):
    if row["weight_kg"] <= 0:
        return "invalid"                          # B1
    if row["destination"] == "domestic":
        if row["weight_kg"] > 30:
            return "domestic_heavy"               # B2
        return "domestic_standard"                # B3
    if row["insured_value"] >= 1000:
        if row["weight_kg"] > 30:
            return "international_insured_heavy"  # B4
        return "international_insured"            # B5
    if row["express"]:
        return "international_express"            # B6
    return "international_standard"               # B7
