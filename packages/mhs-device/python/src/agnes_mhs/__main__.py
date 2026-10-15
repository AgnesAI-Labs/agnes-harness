"""Offline declaration check; it does not certify hardware safety or network conformance."""
import argparse
import json
from pathlib import Path
from .validation import registration

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("description", type=Path)
args = parser.parse_args()
registration(json.loads(args.description.read_text()))
print("MHS declaration valid; hardware safety remains the adapter's responsibility.")
