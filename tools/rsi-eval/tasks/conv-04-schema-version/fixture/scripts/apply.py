import pathlib
import sqlite3
import sys

target = pathlib.Path(sys.argv[1])
if target.exists():
    target.unlink()
conn = sqlite3.connect(target)
for path in sorted(pathlib.Path("migrations").glob("*.sql")):
    conn.executescript(path.read_text())
conn.commit()
print(f"built {target}")
