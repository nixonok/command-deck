import unittest

from orders import calc
from registry import run
from report import summary

ITEMS = [(10, 2), (5, 1)]


class OrdersTest(unittest.TestCase):
    def test_calc(self):
        self.assertEqual(calc(ITEMS), 25)

    def test_summary(self):
        self.assertEqual(summary(ITEMS), "2 items, total 25")

    def test_command(self):
        self.assertEqual(run("total", ITEMS), 25)


if __name__ == "__main__":
    unittest.main()
