import unittest

from pkg import words


class WordsTest(unittest.TestCase):
    def test_tidy(self):
        self.assertEqual(words.tidy("  hello   big world "), "Hello Big World")


if __name__ == "__main__":
    unittest.main()
