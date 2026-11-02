#!/usr/bin/env bash
set -u
expected='# Copyright 2026 Orbit Works. All rights reserved. [OW-INT]'
status=0
while IFS= read -r f; do
  first=$(head -n 1 "$f")
  if [ "$first" != "$expected" ]; then
    echo "error: $f: missing license header; line 1 must be exactly: $expected" >&2
    status=1
  fi
done < <(find src -name '*.py' | sort)
if [ "$status" -eq 0 ]; then echo "license headers ok"; fi
exit "$status"
