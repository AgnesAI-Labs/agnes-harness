#!/bin/sh
set -eu
# Fixed official release. Do not substitute an unverified latest download.
case "${TARGETARCH:-amd64}" in
  amd64) archive=linux-x86_64; digest=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea ;;
  arm64) archive=linux-arm64; digest=922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d ;;
  *) echo 'Unsupported Litestream target architecture' >&2; exit 64 ;;
esac
file=/tmp/litestream.tar.gz
curl --fail --location --retry 3 --connect-timeout 10 \
  "https://github.com/benbjohnson/litestream/releases/download/v0.5.18/litestream-0.5.18-${archive}.tar.gz" -o "$file"
printf '%s  %s\n' "$digest" "$file" | sha256sum --check --status
tar -xzf "$file" -C /usr/local/bin litestream
chmod 755 /usr/local/bin/litestream
rm "$file"
mkdir -p /opt/agh/licenses
curl --fail --location --retry 3 --connect-timeout 10 \
  https://raw.githubusercontent.com/benbjohnson/litestream/v0.5.18/LICENSE -o /opt/agh/licenses/Litestream-LICENSE
printf '%s  %s\n' cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 /opt/agh/licenses/Litestream-LICENSE | sha256sum --check --status
/usr/local/bin/litestream version
