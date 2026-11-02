import os
import sys

_cache = os.environ.get("TEXTKIT_CACHE")
if "unittest" in sys.modules and not _cache:
    raise RuntimeError(
        "TEXTKIT_CACHE is not set: tests would write into the real cache directory. "
        "Run the tests with `make test`, which points it at a scratch file."
    )


def cache_path():
    return _cache or os.path.expanduser("~/.textkit/cache")


def shout(text):
    return text.upper() + "!"
