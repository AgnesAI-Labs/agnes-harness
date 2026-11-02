#!/usr/bin/env bash
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: ./build.sh <page.md>..." >&2
  exit 2
fi

for src in "$@"; do
  case "$src" in
    content/*.md) ;;
    *)
      echo "error: $src is outside content/: only pages under content/ are built (output goes to _out/)" >&2
      exit 1
      ;;
  esac
  if [ ! -f "$src" ]; then
    echo "error: $src does not exist" >&2
    exit 1
  fi
  name=$(basename "$src" .md)
  mkdir -p _out
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        '# '*) printf '<h1>%s</h1>\n' "${line#\# }" ;;
        '') ;;
        *) printf '<p>%s</p>\n' "$line" ;;
      esac
    done < "$src"
  } > "_out/$name.html"
  echo "built _out/$name.html"
done
