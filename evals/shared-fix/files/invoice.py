from pricing import apply_discount


def invoice_line(name, price, percent=0):
    return f"{name}: {apply_discount(price, percent):.2f}"
