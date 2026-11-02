#!/usr/bin/env bash
set -eu
name="${1:-}"
if [ -z "$name" ]; then echo "usage: bash run.sh <plugin> [args...]" >&2; exit 2; fi
shift
file="plugins/$name.sh"
if [ ! -f "$file" ]; then echo "error: no such plugin: $name" >&2; exit 1; fi
sum=$(cksum < "$file" | awk '{print $1}')
entry=$(awk -v n="$name" '$1 == n { print $2 }' plugins.index)
if [ -z "$entry" ]; then
  echo "error: plugin '$name' is not registered in plugins.index (generated file, do not edit by hand); run: make index" >&2
  exit 1
fi
if [ "$entry" != "$sum" ]; then
  echo "error: plugins.index is stale for '$name'; run: make index" >&2
  exit 1
fi
exec bash "$file" "$@"
