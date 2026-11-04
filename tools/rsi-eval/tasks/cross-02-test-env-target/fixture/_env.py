import os
import sys

cache = os.environ.get("TEXTKIT_CACHE")
if "unittest" in sys.modules and not cache:
    raise RuntimeError(
        "TEXTKIT_CACHE is not set: tests would write into the real cache directory. "
        "Run the tests with `make test`, which points it at a scratch file."
    )
