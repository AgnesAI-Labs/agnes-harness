import unittest

import textkit


class ShoutTests(unittest.TestCase):
    def test_shout(self):
        self.assertEqual(textkit.shout("hi"), "HI!")


if __name__ == "__main__":
    unittest.main()
