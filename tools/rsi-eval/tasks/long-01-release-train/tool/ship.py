# ship: builds and publishes the packages of this repository. Run `bin/ship help`.
import hashlib
import json
import os
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))
STATE = os.path.join(ROOT, ".ship", "state")
HELP = """usage: bin/ship <command> [args]
  build <name>     build packages/<name> into dist/
  inspect <name>   show what dist/ holds for the package's current version
  publish <name>   publish the built package with its release note (packages/<name>/NEXT.md)
  log              list the published releases
  help             show this text"""

# What was published before this repository was handed over.
FIRST = [
    ("alpha", "1.2.0"),
    ("beta", "2.0.4"),
    ("alpha", "1.3.2"),
    ("gamma", "0.8.0"),
    ("beta", "2.0.5"),
    ("delta", "3.1.0"),
]


def fail(message, code=1):
    sys.stderr.write("ship: " + message + "\n")
    sys.exit(code)


def load_state():
    if not os.path.exists(STATE):
        return {"published": [{"name": n, "version": v, "build": None, "note": ""} for n, v in FIRST]}
    with open(STATE, "rb") as f:
        return json.loads(zlib.decompress(f.read()).decode("utf-8"))


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "wb") as f:
        f.write(zlib.compress(json.dumps(state).encode("utf-8")))


def package_dir(name):
    path = os.path.join(ROOT, "packages", name)
    if not name or "/" in name or not os.path.isfile(os.path.join(path, "pkg.ini")):
        fail("no package named %r in packages/" % name, 2)
    return path


def read_version(name):
    values = {}
    with open(os.path.join(package_dir(name), "pkg.ini"), encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
    version = values.get("version", "")
    parts = version.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        fail("packages/%s/pkg.ini: version %r is not of the form X.Y.Z" % (name, version))
    return version


def as_tuple(version):
    return tuple(int(p) for p in version.split("."))


def fingerprint(name, version):
    digest = hashlib.sha256(("%s\n%s\n" % (name, version)).encode("utf-8"))
    src = os.path.join(package_dir(name), "src")
    files = []
    for top, dirs, names in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for n in sorted(names):
            if n.endswith(".pyc"):
                continue
            files.append(os.path.join(top, n))
    for path in files:
        digest.update(os.path.relpath(path, src).encode("utf-8") + b"\0")
        with open(path, "rb") as f:
            digest.update(f.read() + b"\0")
    return digest.hexdigest()[:7], len(files)


def dist_file(name, version):
    return os.path.join(ROOT, "dist", "%s-%s.pkg" % (name, version))


def read_dist(name, version):
    path = dist_file(name, version)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return json.loads(zlib.decompress(f.read()).decode("utf-8"))


def build(name):
    version = read_version(name)
    build_id, count = fingerprint(name, version)
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    with open(dist_file(name, version), "wb") as f:
        f.write(zlib.compress(json.dumps({"name": name, "version": version, "build": build_id, "files": count}).encode("utf-8")))
    print("built dist/%s-%s.pkg" % (name, version))


def inspect(name):
    version = read_version(name)
    built = read_dist(name, version)
    if built is None:
        fail("nothing is built for %s %s" % (name, version))
    print("package %s\nversion %s\nbuild %s\nfiles %d" % (built["name"], built["version"], built["build"], built["files"]))


def publish(name):
    version = read_version(name)
    built = read_dist(name, version)
    if built is None:
        fail("nothing is built for %s %s; build it first" % (name, version))
    if fingerprint(name, version)[0] != built["build"]:
        fail("the build of %s %s is out of date; build it again" % (name, version))
    state = load_state()
    earlier = [p["version"] for p in state["published"] if p["name"] == name]
    if earlier and as_tuple(version) <= max(as_tuple(v) for v in earlier):
        fail("%s %s is not newer than what was published" % (name, version))
    note_path = os.path.join(package_dir(name), "NEXT.md")
    note = ""
    if os.path.exists(note_path):
        with open(note_path, encoding="utf-8") as f:
            note = f.read().strip()
    if not note:
        fail("packages/%s/NEXT.md is missing or empty; write the release note first" % name)
    if built["build"] not in note:
        fail("publish refused: the release note is not tied to this build")
    state["published"].append({"name": name, "version": version, "build": built["build"], "note": note})
    save_state(state)
    os.remove(note_path)
    print("published %s %s" % (name, version))


def log():
    for p in load_state()["published"]:
        print("%s %s published" % (p["name"], p["version"]))


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    command, args = argv[0], argv[1:]
    one = {"build": build, "inspect": inspect, "publish": publish}
    if command in one and len(args) == 1:
        one[command](args[0])
    elif command == "log" and not args:
        log()
    else:
        fail("unknown command or wrong arguments; see bin/ship help", 2)


main(sys.argv[1:])
