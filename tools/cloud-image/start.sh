#!/bin/bash
set -euo pipefail
umask 077
export AGH_HOME="${AGH_HOME:-/data/agh}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace/data}"
export AGNES_PROFILE="${AGNES_PROFILE:-local-dev}"
export AGH_ASSETS_DIR="${AGH_ASSETS_DIR:-/data/agh-assets}"
export AGH_SYNC_DIR="${AGH_SYNC_DIR:-/run/agh-sync}"
# LLMSG's short-lived CFS directory initializer uses this dedicated workspace
# and deliberately supplies no state identity. It needs envd only, never Harness.
if [ "$WORKSPACE_DIR" = /workspace/llmsg-cfs-init ]; then
  for name in AGH_TENANT_ID AGH_USER_ID AGH_STATE_ID AGH_STATE_EPOCH AGH_STATE_INITIALIZED AGH_STATE_PREFIX AGH_RESTORE_FROM_EPOCH; do
    if [ "${!name+x}" ]; then
      echo SYNC_INITIALIZER_IDENTITY_UNEXPECTED >&2
      exit 64
    fi
  done
  exec /usr/bin/envd
fi
: "${AGH_CLOUD_API_BASE_URL:?Missing AGH_CLOUD_API_BASE_URL}"
: "${LLMSG_TRACK_URL:?Missing LLMSG_TRACK_URL}"
# envd must be reachable before the provider can write the initial STS file.
envd_pid=""
manager_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$manager_pid" ]; then
    kill -TERM "$manager_pid" 2>/dev/null || true
    for attempt in {1..310}; do
      if ! kill -0 "$manager_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    kill -KILL "$manager_pid" 2>/dev/null || true
  fi
  if [ -n "$envd_pid" ]; then kill -TERM "$envd_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
/usr/bin/envd &
envd_pid=$!
node /opt/agh/sync/main.mjs &
manager_pid=$!
wait -n "$envd_pid" "$manager_pid"
