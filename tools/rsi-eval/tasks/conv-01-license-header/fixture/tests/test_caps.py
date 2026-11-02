import unittest

from textkit.caps import capitalize_words


class CapsTest(unittest.TestCase):
    def test_capitalize_words(self):
        self.assertEqual(capitalize_words("hello big world"), "Hello Big World")


if __name__ == "__main__":
    unittest.main()
