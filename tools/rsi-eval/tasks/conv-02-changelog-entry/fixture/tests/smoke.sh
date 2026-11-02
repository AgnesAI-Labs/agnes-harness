#!/usr/bin/env bash
set -eu
for f in lib/*.sh; do
  bash -n "$f"
done
source lib/upper.sh
[ "$(echo abc | upper)" = "ABC" ]
echo "smoke ok"
