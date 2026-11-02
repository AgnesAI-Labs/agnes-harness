#!/usr/bin/env bash
set -eu
shop="${1:?usage: cards.sh <shop>}"
exec python3 - "$shop" <<'PY'
import os
import sys

shop = sys.argv[1]
path = "menus/%s.txt" % shop
if not os.path.exists(path):
    sys.exit("error: no menu %s" % path)
raw = open(path, "rb").read()
if not raw.isascii():
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    else:
        sys.exit(
            "error: %s is UTF-8; menu files must be ISO-8859-1 (convert with: iconv -f UTF-8 -t ISO-8859-1)"
            % path
        )
os.makedirs("cards", exist_ok=True)
lines = ["== %s ==" % shop]
for row in raw.decode("latin-1").splitlines():
    if not row.strip():
        continue
    item, price = row.rsplit(";", 1)
    lines.append("%s: %.2f" % (item, float(price)))
with open("cards/%s.card" % shop, "w", encoding="utf-8") as out:
    out.write("\n".join(lines) + "\n")
print("wrote cards/%s.card" % shop)
PY
