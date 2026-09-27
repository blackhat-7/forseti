def round_half_up(numerator, denominator):
    """numerator / denominator rounded to the nearest integer, halves up. Both are non-negative ints."""
    return (2 * numerator + denominator) // (2 * denominator)


def euros(cents):
    return "EUR %d.%02d" % divmod(cents, 100)
