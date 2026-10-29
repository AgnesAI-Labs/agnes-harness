#!/usr/bin/env bash
set -euo pipefail

# Disposable CI runners need actual namespaces, not just an installed bwrap binary.
# Ubuntu restricts unprivileged user namespaces through AppArmor. Authorize only
# the system bwrap executable; do not change global sysctls or disable AppArmor.
if [[ -f /sys/module/apparmor/parameters/enabled ]] &&
  [[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]] &&
  [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == 1 ]]; then
  sudo tee /etc/apparmor.d/agh-e2e-bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/agh-e2e-bwrap
fi

# Fail provisioning if filesystem/process/network namespaces remain unusable.
/usr/bin/bwrap --unshare-user --unshare-pid --unshare-net \
  --ro-bind / / --proc /proc --dev /dev -- /bin/true
