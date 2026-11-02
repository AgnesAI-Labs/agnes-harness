#!/usr/bin/env bash
set -u
status=0
for f in migrations/*; do
  if ! basename "$f" | grep -Eq '^[0-9]{3}_[a-z0-9_]+\.sql$'; then
    echo "error: bad migration name: $f (expected NNN_name.sql, three digits)" >&2
    status=1
  fi
done
latest=$(ls migrations | sed -n 's/^\([0-9]\{3\}\)_.*\.sql$/\1/p' | sort | tail -n 1)
if [ -z "$latest" ]; then echo "error: no migrations found" >&2; exit 1; fi
latest_n=$((10#$latest))
declared=$(tr -d '[:space:]' < db/SCHEMA_VERSION)
if [ "$declared" != "$latest_n" ]; then
  echo "error: schema version mismatch: latest migration is $latest but db/SCHEMA_VERSION says $declared; set db/SCHEMA_VERSION to $latest_n" >&2
  status=1
fi
doc=$(sed -n 's/^current schema version: //p' docs/schema.txt)
if [ "$doc" != "$latest_n" ]; then
  echo "error: docs/schema.txt says schema version '$doc' but latest migration is $latest_n; update its 'current schema version:' line" >&2
  status=1
fi
if [ "$status" -eq 0 ]; then echo "schema version ok"; fi
exit "$status"
