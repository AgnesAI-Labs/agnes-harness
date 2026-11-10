# rollout: deploys the service configs in services/ to the environments. Run `bin/rollout help`.
import hashlib
import json
import os
import re
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))
STATE = os.path.join(ROOT, ".rollout", "state")
HELP = """usage: bin/rollout <command> [args]
  envs                     list the environments
  lint <service>           check services/<service>.conf
  diff <service> <env>     compare services/<service>.conf with what <env> runs
  apply <service> <env>    deploy services/<service>.conf to <env>
  status <service>         what dev, canary and prod run
  get <service> <env> <key>
                           one setting as <env> runs it
  history <service>        past prod deploys of a service
  help                     show this text"""

ENVS = ["dev", "canary", "shadow", "prod"]
REGIONS = ["eu-1", "eu-2", "us-1", "us-2"]
SCHEMA = {
    "web": {"timeout": ("int", 1, 300), "workers": ("int", 1, 64), "cache": ("enum", ["on", "off"]), "region": ("enum", REGIONS)},
    "api": {"max_conn": ("int", 1, 2000), "timeout": ("int", 1, 300), "log_level": ("enum", ["debug", "info", "warn", "error"]), "region": ("enum", REGIONS)},
    "worker": {"concurrency": ("int", 1, 32), "retries": ("int", 0, 10), "queue": ("name",), "region": ("enum", REGIONS)},
}

# The deploys made before this repository was handed over, oldest first.
FIRST = [
    ("web", "shadow", {"timeout": "30", "workers": "6", "cache": "on", "region": "eu-1"}),
    ("api", "dev", {"max_conn": "50", "timeout": "15", "log_level": "debug", "region": "eu-1"}),
    ("web", "prod", {"timeout": "30", "workers": "6", "cache": "on", "region": "eu-1"}),
    ("api", "shadow", {"max_conn": "250", "timeout": "30", "log_level": "info", "region": "eu-1"}),
    ("worker", "canary", {"concurrency": "2", "retries": "3", "queue": "jobs", "region": "eu-1"}),
    ("api", "prod", {"max_conn": "250", "timeout": "30", "log_level": "info", "region": "eu-1"}),
    ("web", "canary", {"timeout": "20", "workers": "8", "cache": "on", "region": "eu-1"}),
    ("worker", "shadow", {"concurrency": "4", "retries": "3", "queue": "jobs", "region": "eu-1"}),
    ("web", "dev", {"timeout": "60", "workers": "2", "cache": "off", "region": "eu-1"}),
    ("worker", "prod", {"concurrency": "4", "retries": "3", "queue": "jobs", "region": "eu-1"}),
    ("web", "shadow", {"timeout": "30", "workers": "8", "cache": "on", "region": "eu-1"}),
    ("api", "canary", {"max_conn": "300", "timeout": "30", "log_level": "info", "region": "eu-1"}),
    ("web", "prod", {"timeout": "30", "workers": "8", "cache": "on", "region": "eu-1"}),
    ("worker", "dev", {"concurrency": "1", "retries": "0", "queue": "jobs-dev", "region": "eu-1"}),
    ("api", "dev", {"max_conn": "50", "timeout": "15", "log_level": "debug", "region": "eu-1"}),
]


def fail(message, code=1):
    sys.stderr.write("rollout: " + message + "\n")
    sys.exit(code)


def change_id(values):
    text = "\n".join("%s=%s" % (k, values[k]) for k in sorted(values))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def load_state():
    if os.path.exists(STATE):
        with open(STATE, "rb") as f:
            return json.loads(zlib.decompress(f.read()).decode("utf-8"))
    state = {"live": {}, "history": []}
    for service, env, values in FIRST:
        record(state, service, env, values)
    return state


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "wb") as f:
        f.write(zlib.compress(json.dumps(state).encode("utf-8")))


def record(state, service, env, values):
    state["live"].setdefault(service, {})[env] = dict(values)
    state["history"].append({"n": len(state["history"]) + 1, "service": service, "env": env, "change": change_id(values), "values": dict(values)})


def service_of(name):
    if name not in SCHEMA:
        fail("no service named %r in services/" % name, 2)
    return SCHEMA[name]


def env_of(name):
    if name not in ENVS:
        fail("no environment named %r; see bin/rollout envs" % name, 2)
    return name


def read_conf(service):
    schema = service_of(service)
    path = os.path.join(ROOT, "services", service + ".conf")
    if not os.path.exists(path):
        fail("services/%s.conf is missing" % service)
    values, problems = {}, []
    with open(path, encoding="utf-8") as f:
        for number, line in enumerate(f, start=1):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            if "=" not in line:
                problems.append("line %d: expected key = value" % number)
                continue
            key, value = (part.strip() for part in line.split("=", 1))
            if key not in schema:
                problems.append("line %d: unknown key %r" % (number, key))
                continue
            rule = schema[key]
            if rule[0] == "int" and not (value.isdigit() and rule[1] <= int(value) <= rule[2]):
                problems.append("line %d: %s must be a whole number from %d to %d" % (number, key, rule[1], rule[2]))
            elif rule[0] == "enum" and value not in rule[1]:
                problems.append("line %d: %s must be one of %s" % (number, key, ", ".join(rule[1])))
            elif rule[0] == "name" and re.fullmatch(r"[a-z][a-z0-9-]*", value) is None:
                problems.append("line %d: %s must be lower case letters, digits and dashes" % (number, key))
            values[key] = value
    for key in schema:
        if key not in values:
            problems.append("%s is not set" % key)
    return values, problems


def shown(values):
    return " ".join("%s=%s" % (k, values[k]) for k in sorted(values))


def lint(service):
    values, problems = read_conf(service)
    if problems:
        fail("services/%s.conf:\n  %s" % (service, "\n  ".join(problems)))
    return values


def apply(service, env):
    env_of(env)
    values = lint(service)
    state = load_state()
    change = change_id(values)
    if env == "prod":
        proven = state["live"].get(service, {}).get("shadow")
        if proven is None or change_id(proven) != change:
            fail("prod refused: change %s of %s is unproven" % (change, service))
    record(state, service, env, values)
    save_state(state)
    print("applied %s change %s to %s" % (service, change, env))


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    command, args = argv[0], argv[1:]
    if command == "envs" and not args:
        print(" ".join(ENVS))
    elif command == "lint" and len(args) == 1:
        values = lint(args[0])
        print("services/%s.conf: ok (change %s)" % (args[0], change_id(values)))
    elif command == "diff" and len(args) == 2:
        env_of(args[1])
        values = lint(args[0])
        live = load_state()["live"].get(args[0], {}).get(args[1], {})
        same = True
        for key in sorted(set(values) | set(live)):
            if values.get(key) != live.get(key):
                same = False
                print("%s: %s runs %s, the file says %s" % (key, args[1], live.get(key, "-"), values.get(key, "-")))
        if same:
            print("%s runs what services/%s.conf says" % (args[1], args[0]))
    elif command == "apply" and len(args) == 2:
        apply(args[0], args[1])
    elif command == "status" and len(args) == 1:
        service_of(args[0])
        live = load_state()["live"].get(args[0], {})
        for env in ("dev", "canary", "prod"):
            if env in live:
                print("%-7s %s" % (env, shown(live[env])))
            else:
                print("%-7s -" % env)
    elif command == "get" and len(args) == 3:
        service_of(args[0])
        env_of(args[1])
        live = load_state()["live"].get(args[0], {}).get(args[1], {})
        if args[2] not in live:
            fail("%s does not run %s with %s set" % (args[1], args[0], args[2]))
        print("%s@%s %s=%s" % (args[0], args[1], args[2], live[args[2]]))
    elif command == "history" and len(args) == 1:
        service_of(args[0])
        for entry in load_state()["history"]:
            if entry["service"] == args[0] and entry["env"] == "prod":
                print("#%-3d %-7s %s  %s" % (entry["n"], entry["env"], entry["change"], shown(entry["values"])))
    else:
        fail("unknown command or wrong arguments; see bin/rollout help", 2)


main(sys.argv[1:])
