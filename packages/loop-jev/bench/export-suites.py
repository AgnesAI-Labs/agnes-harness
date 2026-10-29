# Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
"""Export the reference benchmark suites as plain JSON for the Jev loop bench tools.

Run once against a checkout of the reference repository and commit the output:

    python3 -I packages/loop-jev/bench/export-suites.py <reference-repo-root> packages/loop-jev/bench/suites

It writes two files:

* fastapi-families.json: the payload of ``suite_payload()`` in
  backend/benchmarks/fastapi_families.py, plus a top-level ``source`` record.
* smoke.json: backend/benchmarks/scenarios.json with every file check rewritten
  as a ``python -B -c`` probe (the file-name and content checks of the reference
  ``_check_files``, case-insensitive), so the checks run outside the agent.
"""

import importlib.util
import json
import re
import shlex
import sys
from pathlib import Path

SOURCE = {
    "repository": "https://github.com/parkavenue9639/jevloop",
    "commit": "61e7994",
    "file": "backend/benchmarks/fastapi_families.py",
    "license": "Apache-2.0",
}
SMOKE_SOURCE = {**SOURCE, "file": "backend/benchmarks/scenarios.json"}
FILE_SCAN_CAP = 40
TURN_KEYS = {"goal", "answer_contains", "answer_max_chars", "files", "any_file_contains", "min_files", "soft"}

# Shared preamble of every probe: the visible files of the workspace (relative
# paths, hidden files and directories skipped), mirroring the reference listing.
PREAMBLE = """import os, sys
names = []
for root, dirs, files in os.walk("."):
    dirs[:] = sorted(d for d in dirs if not d.startswith("."))
    for f in sorted(files):
        if not f.startswith("."):
            names.append(os.path.relpath(os.path.join(root, f), "."))
def read(n):
    with open(n, encoding="utf-8", errors="replace") as h:
        return h.read()
"""


def load_suite_payload(root):
    path = Path(root) / "backend" / "benchmarks" / "fastapi_families.py"
    spec = importlib.util.spec_from_file_location("fastapi_families", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.suite_payload()


def probe_command(body, marker):
    script = PREAMBLE + body + f"print({json.dumps(marker)})\n"
    return "python -B -c " + shlex.quote(script)


def file_probe(want, marker):
    name = json.dumps(want["name"].lower())
    sub = want.get("contains")
    body = f"matched = [n for n in names if {name} in n.lower()]\n"
    body += "if not matched:\n    sys.exit(\"no file matches; files: \" + repr(names))\n"
    if sub is not None:
        body += f"if not any({json.dumps(sub.lower())} in read(n).lower() for n in matched):\n"
        body += "    sys.exit(\"content mismatch\")\n"
    return probe_command(body, marker)


def file_check_name(want):
    sub = want.get("contains")
    if sub is not None:
        return f"file matching {want['name']!r} contains {sub!r}"
    return f"file matching {want['name']!r} exists"


def min_files_probe(count, marker):
    body = f"if len(names) < {int(count)}:\n    sys.exit(\"found \" + str(len(names)) + \": \" + repr(names))\n"
    return probe_command(body, marker)


def any_file_probe(sub, marker):
    body = f"if not any({json.dumps(sub.lower())} in read(n).lower() for n in names[:{FILE_SCAN_CAP}]):\n"
    body += "    sys.exit(\"no file contains the text\")\n"
    return probe_command(body, marker)


def rewrite_turn(scenario_id, index, turn):
    unknown = set(turn) - TURN_KEYS
    if unknown:
        raise ValueError(f"{scenario_id} turn {index}: unexpected keys {sorted(unknown)}")
    slug = re.sub(r"[^A-Z0-9]+", "_", scenario_id.upper()).strip("_")
    soft = [fragment.lower() for fragment in turn.get("soft") or []]
    probes = []

    def add(command_for, name):
        marker = f"SMOKE_{slug}_T{index}_{len(probes) + 1}_OK"
        entry = {"command": command_for(marker), "contains": marker}
        if any(fragment in name.lower() for fragment in soft):
            entry["soft"] = True
        probes.append(entry)

    if turn.get("min_files") is not None:
        count = turn["min_files"]
        add(lambda marker: min_files_probe(count, marker), f"at least {count} files")
    for want in turn.get("files") or []:
        add(lambda marker, want=want: file_probe(want, marker), file_check_name(want))
    for sub in turn.get("any_file_contains") or []:
        add(lambda marker, sub=sub: any_file_probe(sub, marker), f"some file contains {sub!r}")

    out = {"goal": turn["goal"]}
    if turn.get("answer_contains"):
        out["answer_contains"] = turn["answer_contains"]
    if turn.get("answer_max_chars") is not None:
        out["answer_max_chars"] = turn["answer_max_chars"]
    if probes:
        out["bash"] = probes
    return out


def smoke_suite(root):
    path = Path(root) / "backend" / "benchmarks" / "scenarios.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    scenarios = []
    for scenario in payload["scenarios"]:
        turns = [rewrite_turn(scenario["id"], i, t) for i, t in enumerate(scenario["turns"], 1)]
        scenarios.append({**{k: v for k, v in scenario.items() if k != "turns"}, "turns": turns})
    return {
        "suite": payload["suite"],
        "description": payload["description"],
        "source": SMOKE_SOURCE,
        "scenarios": scenarios,
    }


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv):
    if len(argv) != 3:
        sys.exit("usage: export-suites.py <reference-repo-root> <output-dir>")
    root, out = argv[1], Path(argv[2])
    out.mkdir(parents=True, exist_ok=True)
    families = load_suite_payload(root)
    write_json(out / "fastapi-families.json", {**families, "source": SOURCE})
    write_json(out / "smoke.json", smoke_suite(root))


if __name__ == "__main__":
    main(sys.argv)
