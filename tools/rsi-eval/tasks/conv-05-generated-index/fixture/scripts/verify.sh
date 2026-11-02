#!/usr/bin/env bash
set -eu
tmp=$(mktemp "${TMPDIR:-/tmp}/plugidx.XXXXXX")
trap 'rm -f "$tmp"' EXIT
bash scripts/genindex.sh "$tmp" >/dev/null
if ! diff -q "$tmp" plugins.index >/dev/null; then
  echo "error: plugins.index is stale; run: make index" >&2
  exit 1
fi
echo "index fresh"
