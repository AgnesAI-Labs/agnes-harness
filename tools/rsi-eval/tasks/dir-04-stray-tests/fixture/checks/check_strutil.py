import unittest

import strutil


class CheckShout(unittest.TestCase):
    def test_shout(self):
        self.assertEqual(strutil.shout('hi'), 'HI!')
