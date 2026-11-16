import unittest

from cart import cart_total


class CartTest(unittest.TestCase):
    def test_no_discount(self):
        self.assertEqual(cart_total([100, 50]), 150)

    def test_discount(self):
        self.assertAlmostEqual(cart_total([100, 50], 10), 135)


if __name__ == "__main__":
    unittest.main()
