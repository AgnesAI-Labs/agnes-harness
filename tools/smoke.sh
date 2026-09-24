#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# A stage passes only when tests actually ran. Vitest exits 0 when a `-t` filter
# matches nothing, so exit code alone lets a renamed test turn a stage into a
# silent no-op; the passed-count assertion is what catches that.
run_stage() {
  local stage="$1"
  shift

  printf 'smoke: running %s\n' "$stage"

  local output
  if ! output="$("$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    printf 'smoke: FAILED %s\n' "$stage" >&2
    return 1
  fi

  local passed
  passed="$(printf '%s\n' "$output" | sed -n 's/.*Tests  *\([0-9][0-9]*\) passed.*/\1/p' | tail -n 1)"
  if [[ -z "$passed" || "$passed" -eq 0 ]]; then
    printf '%s\n' "$output" >&2
    printf 'smoke: FAILED %s (no test ran — check the -t selector)\n' "$stage" >&2
    return 1
  fi

  printf 'smoke: passed %s (%s tests)\n' "$stage" "$passed"
}

# The CLI test boots the real one-shot entry path and uses the scripted faux
# provider, so the smoke test never depends on a developer API key.
run_stage \
  cli-print \
  pnpm exec vitest run packages/cli/test/main.test.ts \
    -t 'runs a whole one-shot turn and returns its exit code'

# This suite exercises the Unix daemon from startup through real SDK/core
# traffic, including create/send, interruption, durable resume and close.
run_stage \
  daemon-lifecycle \
  pnpm exec vitest run packages/daemon/test/sdk-unix-integration.test.ts

# TUI startup is verified through the repository's pseudo-terminal renderer.
run_stage \
  tui-first-screen \
  pnpm exec vitest run packages/cli/test/tui/app.test.ts \
    -t 'paints the startup brand bar, header brand and editor divider once, never twice across /new'

printf 'smoke: all stages passed\n'
