#!/usr/bin/env bash
set -u
status=0
if ! grep -q '^## Unreleased$' CHANGELOG.txt; then
  echo "error: CHANGELOG.txt has no '## Unreleased' section" >&2
  status=1
fi
while IFS= read -r line; do
  if ! printf '%s\n' "$line" | grep -Eq '^- (add|fix|change)\([a-z0-9_]+\): .+ .+ .+'; then
    echo "error: CHANGELOG.txt: bad entry format: $line (expected: - add|fix|change(<lib>): <summary of at least 3 words>)" >&2
    status=1
  fi
done < <(grep '^- ' CHANGELOG.txt)
for f in lib/*.sh; do
  name=$(basename "$f" .sh)
  if ! grep -Eq "^- add\($name\): " CHANGELOG.txt; then
    echo "error: no changelog entry for lib/$name.sh; add a line under '## Unreleased' like: - add($name): <summary of at least 3 words>" >&2
    status=1
  fi
done
if [ "$status" -eq 0 ]; then echo "changelog ok"; fi
exit "$status"
