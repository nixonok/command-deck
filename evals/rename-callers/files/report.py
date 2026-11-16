from orders import calc


def summary(items):
    return f"{len(items)} items, total {calc(items)}"
