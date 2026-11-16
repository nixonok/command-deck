def calc(items):
    """Total price of (price, quantity) pairs."""
    return sum(price * qty for price, qty in items)
