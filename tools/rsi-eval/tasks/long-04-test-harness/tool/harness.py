# harness: runs the textkit test suites and keeps the dashboard. Run `bin/harness help`.
import hashlib
import importlib.util
import json
import os
import random
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))
STATE = os.path.join(ROOT, ".harness", "state")
HELP = """usage: bin/harness <command> [args]
  suites                  list the test suites
  run <suite> [options]   run a suite's cases against src/textkit/<suite>.py
      --seed N            shuffle the cases with seed N (default: a fresh seed)
      --verbose           print every case
  runs                    list the recent runs
  record <suite>          put the suite's latest run on the dashboard
  dashboard               show what is on the dashboard
  help                    show this text"""

SUITES = {"slug": 1307, "roman": 4441, "wrap": 2213, "plural": 3089}

# The runs made before this repository was handed over: suite, cases passed, cases, seed, recorded.
FIRST = [
    ("slug", 4, 4, None, False),
    ("slug", 4, 4, 1307, True),
    ("roman", 3, 4, 4441, False),
    ("roman", 4, 4, 4441, True),
    ("wrap", 4, 4, 2213, True),
    ("plural", 4, 4, None, False),
    ("plural", 4, 4, 3089, True),
]


def fail(message, code=1):
    sys.stderr.write("harness: " + message + "\n")
    sys.exit(code)


def load_state():
    if os.path.exists(STATE):
        with open(STATE, "rb") as f:
            return json.loads(zlib.decompress(f.read()).decode("utf-8"))
    state = {"runs": [], "dashboard": {}}
    for suite, passed, total, seed, recorded in FIRST:
        state["runs"].append({"n": len(state["runs"]) + 1, "suite": suite, "passed": passed, "total": total, "seed": seed, "print": None})
        if recorded:
            state["dashboard"][suite] = {"passed": passed, "total": total, "run": len(state["runs"])}
    return state


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "wb") as f:
        f.write(zlib.compress(json.dumps(state).encode("utf-8")))


def suite_of(name):
    if name not in SUITES:
        fail("no suite named %r; see bin/harness suites" % name, 2)
    return name


def case_files(suite):
    folder = os.path.join(ROOT, "tests", suite)
    return sorted(n for n in os.listdir(folder) if n.endswith(".case")) if os.path.isdir(folder) else []


def module_file(suite):
    return os.path.join(ROOT, "src", "textkit", suite + ".py")


def fingerprint(suite):
    digest = hashlib.sha256()
    for path in [module_file(suite)] + [os.path.join(ROOT, "tests", suite, n) for n in case_files(suite)]:
        digest.update(path.encode("utf-8") + b"\0")
        if os.path.exists(path):
            with open(path, "rb") as f:
                digest.update(f.read())
        digest.update(b"\0")
    return digest.hexdigest()


def read_case(suite, name):
    fields = {}
    with open(os.path.join(ROOT, "tests", suite, name), encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key.strip()] = value[1:] if value.startswith(" ") else value
    if "input" not in fields or "expect" not in fields:
        fail("tests/%s/%s: a case needs an `input:` and an `expect:` line" % (suite, name))
    return fields["input"], fields["expect"]


def run(suite, args):
    seed, verbose = None, False
    rest = list(args)
    while rest:
        flag = rest.pop(0)
        if flag == "--verbose":
            verbose = True
        elif flag == "--seed" and rest and rest[0].isdigit():
            seed = int(rest.pop(0))
        elif flag.startswith("--seed=") and flag[7:].isdigit():
            seed = int(flag[7:])
        else:
            fail("run: unknown option %r; see bin/harness help" % flag, 2)
    names = case_files(suite)
    if not names:
        fail("tests/%s holds no cases" % suite)
    spec = importlib.util.spec_from_file_location("textkit_" + suite, module_file(suite))
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        fail("src/textkit/%s.py does not load: %s" % (suite, error))
    random.Random(seed).shuffle(names)
    failed = []
    for name in names:
        given, want = read_case(suite, name)
        try:
            got = module.run(given)
        except Exception as error:
            got = "<%s: %s>" % (type(error).__name__, error)
        if got != want:
            failed.append("%s (got %r, want %r)" % (name, got, want))
        if verbose:
            print("  %s %s" % ("ok  " if got == want else "FAIL", name))
    state = load_state()
    number = len(state["runs"]) + 1
    passed = len(names) - len(failed)
    state["runs"].append({"n": number, "suite": suite, "passed": passed, "total": len(names), "seed": seed, "print": fingerprint(suite)})
    save_state(state)
    print("%s: %d/%d passed as run %d" % (suite, passed, len(names), number))
    for line in failed:
        print("  failed: " + line)
    if failed:
        sys.exit(1)


def record(suite):
    state = load_state()
    runs = [r for r in state["runs"] if r["suite"] == suite]
    if not runs:
        fail("%s has never been run" % suite)
    last = runs[-1]
    if last["passed"] != last["total"]:
        fail("cannot record run %d of %s: it has failures" % (last["n"], suite))
    if last["print"] != fingerprint(suite):
        fail("cannot record run %d of %s: the suite or its code changed since; run it again" % (last["n"], suite))
    if last["seed"] != SUITES[suite]:
        fail("record refused: run %d of %s is not reproducible" % (last["n"], suite))
    state["dashboard"][suite] = {"passed": last["passed"], "total": last["total"], "run": last["n"]}
    save_state(state)
    print("recorded run %d of %s: %d/%d" % (last["n"], suite, last["passed"], last["total"]))


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    command, args = argv[0], argv[1:]
    if command == "suites" and not args:
        for suite in sorted(SUITES):
            print("%-7s %d cases   seed %d" % (suite, len(case_files(suite)), SUITES[suite]))
    elif command == "run" and args:
        run(suite_of(args[0]), args[1:])
    elif command == "runs" and not args:
        for r in load_state()["runs"][-12:]:
            print("run %-3d %-7s %d/%d  seed %s" % (r["n"], r["suite"], r["passed"], r["total"], "fresh" if r["seed"] is None else r["seed"]))
    elif command == "record" and len(args) == 1:
        record(suite_of(args[0]))
    elif command == "dashboard" and not args:
        board = load_state()["dashboard"]
        for suite in sorted(board):
            entry = board[suite]
            print("%s: %d/%d recorded at run %d" % (suite, entry["passed"], entry["total"], entry["run"]))
    else:
        fail("unknown command or wrong arguments; see bin/harness help", 2)


main(sys.argv[1:])
