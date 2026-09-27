from money import round_half_up

# VAT percentage by product category.
VAT_RATES = {"bulbs": 5, "seeds": 5, "soil": 5, "tools": 20}


def line_vat(net, category):
    return round_half_up(net * VAT_RATES[category], 100)
