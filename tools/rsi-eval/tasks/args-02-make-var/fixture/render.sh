#!/usr/bin/env bash
set -eu
site="$1"
port=$(awk -v s="$site" '$1 == s { print $2 }' sites.txt)
if [ -z "$port" ]; then
  echo "error: unknown site $site (see sites.txt)" >&2
  exit 1
fi
mkdir -p site-out
printf 'name=%s\nurl=https://%s.example.test\nport=%s\n' "$site" "$site" "$port" > "site-out/$site.conf"
echo "wrote site-out/$site.conf"
