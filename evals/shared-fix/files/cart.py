from pricing import apply_discount


def cart_total(prices, percent=0):
    return sum(apply_discount(p, percent) for p in prices)
