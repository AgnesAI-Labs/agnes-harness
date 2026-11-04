# ingest: loads vendor files into the warehouse. Run `bin/ingest help`.
import csv
import json
import os
import re
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))
STORE = os.path.join(ROOT, ".warehouse", "store")
HELP = """usage: bin/ingest <command> [args]
  tables                 list the tables
  schema <table>         show a table's columns
  load <table> <file>    stage a CSV file for a table (the file is taken in and leaves its folder)
  batches                list the staged and committed batches
  commit <batch>         add a staged batch to its table
  discard <batch>        drop a staged batch
  peek <table>           show the last rows of a table
  total <table>          count a table's rows and sum its amounts
  help                   show this text"""

TABLES = {
    "orders": [("id", "int"), ("placed", "date"), ("amount", "int"), ("region", "text")],
    "refunds": [("id", "int"), ("order_id", "int"), ("amount", "int"), ("reason", "text")],
}
ID_RANGE = {"orders": (100000, 199999), "refunds": (900000, 999999)}

# The rows the warehouse held when this repository was handed over.
FIRST = {
    "orders": [
        [100101, "2026-02-03", 4250, "north"],
        [100102, "2026-02-04", 1999, "south"],
        [100103, "2026-02-07", 12000, "east"],
        [100104, "2026-02-11", 875, "west"],
        [100105, "2026-02-19", 30410, "north"],
    ],
    "refunds": [[900101, 100102, 1999, "damaged"]],
}


def fail(message, code=1):
    sys.stderr.write("ingest: " + message + "\n")
    sys.exit(code)


def load_store():
    if not os.path.exists(STORE):
        return {"tables": {k: list(v) for k, v in FIRST.items()}, "batches": []}
    with open(STORE, "rb") as f:
        return json.loads(zlib.decompress(f.read()).decode("utf-8"))


def save_store(store):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    with open(STORE, "wb") as f:
        f.write(zlib.compress(json.dumps(store).encode("utf-8")))


def table_of(name):
    if name not in TABLES:
        fail("no table named %r; see bin/ingest tables" % name, 2)
    return TABLES[name]


def fits(kind, value):
    if kind == "int":
        return re.fullmatch(r"[0-9]+", value) is not None
    if kind == "date":
        return re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is not None
    return value != "" and re.search(r"[0-9]", value) is None


def convert(kind, value):
    return int(value) if kind == "int" else value


def load(name, path):
    columns = table_of(name)
    full = os.path.join(os.getcwd(), path)
    if not os.path.isfile(full):
        fail("no file %s" % path, 2)
    with open(full, newline="", encoding="utf-8") as f:
        lines = list(csv.reader(f))
    if not lines:
        fail("%s is empty" % path)
    if re.search(r"[0-9]", ",".join(lines[0])):
        fail("%s: line 1 must be the header" % path)
    store = load_store()
    taken = {row[0] for row in store["tables"][name]}
    for batch in store["batches"]:
        if batch["table"] == name and batch["state"] == "staged":
            taken.update(row[0] for row in batch["rows"])
    orders = {row[0] for row in store["tables"]["orders"]}
    low, high = ID_RANGE[name]
    rows = []
    for number, values in enumerate(lines[1:], start=2):
        if not values:
            continue
        values = [v.strip() for v in values]
        if len(values) != len(columns) or not all(fits(kind, value) for (_, kind), value in zip(columns, values)):
            fail("batch rejected at line %d: a value does not fit the table" % number)
        row = [convert(kind, value) for (_, kind), value in zip(columns, values)]
        if not low <= row[0] <= high:
            fail("batch rejected at line %d: a value does not fit the table" % number)
        if name == "refunds" and row[1] not in orders:
            fail("batch rejected at line %d: a value does not fit the table" % number)
        if row[0] in taken:
            fail("batch rejected at line %d: id %d is already in the table" % (number, row[0]))
        taken.add(row[0])
        rows.append(row)
    if not rows:
        fail("%s holds no rows" % path)
    number = len(store["batches"]) + 1
    store["batches"].append({"id": number, "table": name, "state": "staged", "rows": rows, "file": os.path.basename(path)})
    save_store(store)
    os.remove(full)
    print("staged batch %d for %s: %d rows" % (number, name, len(rows)))


def batch_of(store, text):
    for batch in store["batches"]:
        if str(batch["id"]) == text:
            return batch
    fail("no batch %s; see bin/ingest batches" % text, 2)


def commit(text):
    store = load_store()
    batch = batch_of(store, text)
    if batch["state"] != "staged":
        fail("batch %s is %s, not staged" % (text, batch["state"]))
    store["tables"][batch["table"]].extend(batch["rows"])
    batch["state"] = "committed"
    save_store(store)
    print("committed batch %s: %d rows into %s" % (text, len(batch["rows"]), batch["table"]))


def discard(text):
    store = load_store()
    batch = batch_of(store, text)
    if batch["state"] != "staged":
        fail("batch %s is %s, not staged" % (text, batch["state"]))
    batch["state"] = "discarded"
    save_store(store)
    print("discarded batch %s" % text)


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    command, args = argv[0], argv[1:]
    if command == "tables" and not args:
        print(" ".join(sorted(TABLES)))
    elif command == "schema" and len(args) == 1:
        print("%s: %s" % (args[0], ", ".join("%s %s" % c for c in sorted(table_of(args[0])))))
    elif command == "load" and len(args) == 2:
        load(args[0], args[1])
    elif command == "batches" and not args:
        for batch in load_store()["batches"]:
            print("batch %d  %-8s %-9s %d rows  from %s" % (batch["id"], batch["table"], batch["state"], len(batch["rows"]), batch["file"]))
    elif command == "commit" and len(args) == 1:
        commit(args[0])
    elif command == "discard" and len(args) == 1:
        discard(args[0])
    elif command == "peek" and len(args) == 1:
        table_of(args[0])
        for row in load_store()["tables"][args[0]][-5:]:
            print(" | ".join(str(v) for v in row))
    elif command == "total" and len(args) == 1:
        table_of(args[0])
        rows = load_store()["tables"][args[0]]
        print("%s: %d rows, %d cents" % (args[0], len(rows), sum(row[2] for row in rows)))
    else:
        fail("unknown command or wrong arguments; see bin/ingest help", 2)


main(sys.argv[1:])
