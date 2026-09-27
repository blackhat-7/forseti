def line_amount(line):
    price = float(line["price"])
    discount = float(line["discount"])
    return round(price * line["qty"] * (1 - discount / 100), 2)


def invoice(lines):
    amounts = [line_amount(line) for line in lines]
    return {
        "lines": [f"{amount:.2f}" for amount in amounts],
        "total": f"{sum(amounts):.2f}",
    }
