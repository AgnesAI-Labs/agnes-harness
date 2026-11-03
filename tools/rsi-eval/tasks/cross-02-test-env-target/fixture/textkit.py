import os

from _env import cache


def cache_path():
    return cache or os.path.expanduser("~/.textkit/cache")


def shout(text):
    return text.upper() + "!"
