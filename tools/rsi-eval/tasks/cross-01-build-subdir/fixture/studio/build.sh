#!/usr/bin/env bash
set -eu
part="${1:?usage: build.sh <part>}"
if [ ! -d ../parts ] || [ ! -f ./build.sh ]; then
  echo "error: ../parts not found; build.sh must be run from inside the studio/ directory" >&2
  exit 1
fi
if [ ! -f "../parts/$part.txt" ]; then
  echo "error: unknown part $part (expected ../parts/$part.txt)" >&2
  exit 1
fi
mkdir -p bundles
{
  echo "PACK 1"
  echo "name=$part"
  cat "../parts/$part.txt"
} > "bundles/$part.pack"
echo "wrote studio/bundles/$part.pack"
