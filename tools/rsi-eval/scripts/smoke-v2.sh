#!/usr/bin/env bash
# Smoke run of the evaluation changes: skill saves in the eval host, workflow runs counted as finished, the
# oracle arm. The minimum real runs, one repetition each, into a new folder:
#   - one two-session task with the arms off, on and oracle (3 runs), then frozen from that on run (1 run)
#   - one workflow task with the arm on (1 run)
# then a PASS/FAIL checklist (smoke-check.ts) of what only a real run can show. It makes real model calls,
# about as many as four pilot runs, after one tiny preflight call.
#
# It takes no key from a file: export the variable that the run config names as "keyEnv" first.
#
#   RSI_EVAL_CONFIG=<run-config.json> RSI_EVAL_OUT=<new folder> tools/rsi-eval/scripts/smoke-v2.sh
#
# Optional: SMOKE_TWO_SESSION_TASK (default cross-01-build-subdir), SMOKE_WORKFLOW_TASK (default
# wf-01-release-channel). Needs mise, python3, bash and make on PATH (the tasks use them).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
: "${RSI_EVAL_CONFIG:?set RSI_EVAL_CONFIG to the run config (see tools/rsi-eval/run-config.example.json)}"
: "${RSI_EVAL_OUT:?set RSI_EVAL_OUT to a folder that does not exist yet, outside any git repository}"
[ -f "$RSI_EVAL_CONFIG" ] || { echo "run config not found: $RSI_EVAL_CONFIG"; exit 1; }
[ ! -e "$RSI_EVAL_OUT" ] || { echo "$RSI_EVAL_OUT already exists; pick another RSI_EVAL_OUT"; exit 1; }
KEYENV="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keyEnv"])' "$RSI_EVAL_CONFIG")"
[ -n "${!KEYENV:-}" ] || { echo "the API key is not set: export $KEYENV (the keyEnv of the run config) first"; exit 1; }
TWO="${SMOKE_TWO_SESSION_TASK:-cross-01-build-subdir}"
WF="${SMOKE_WORKFLOW_TASK:-wf-01-release-channel}"
mise exec -- pnpm exec tsx tools/rsi-eval/preflight.ts --config "$RSI_EVAL_CONFIG" || { echo "preflight failed: nothing was started"; exit 1; }
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @agnes/host build:native
mise exec -- pnpm --filter @agnes/system-node build:native
mkdir -p "$RSI_EVAL_OUT"
mise exec -- pnpm exec tsx tools/rsi-eval/agh/run-agh.ts --config "$RSI_EVAL_CONFIG" --out "$RSI_EVAL_OUT" --tasks "$TWO" --reps 1 --arms off,on,oracle
mise exec -- pnpm exec tsx tools/rsi-eval/agh/run-agh.ts --config "$RSI_EVAL_CONFIG" --out "$RSI_EVAL_OUT" --tasks "$WF" --reps 1 --arms on
# The frozen arm: the two-session task again, refinement off, starting with what its on run above saved.
mise exec -- pnpm exec tsx tools/rsi-eval/agh/run-agh.ts --config "$RSI_EVAL_CONFIG" --out "$RSI_EVAL_OUT" --tasks "$TWO" --reps 1 --arms frozen --frozen-from "$RSI_EVAL_OUT"
mise exec -- pnpm exec tsx tools/rsi-eval/report.ts --run-dir "$RSI_EVAL_OUT" --config "$RSI_EVAL_CONFIG"
echo
echo "== checklist =="
rc=0
mise exec -- pnpm exec tsx tools/rsi-eval/smoke-check.ts --run-dir "$RSI_EVAL_OUT" --two-session "$TWO" --workflow "$WF" --rep 1 || rc=$?
echo "done: $RSI_EVAL_OUT (report.md and report.json; the second-session section needs more than one repetition for intervals)"
exit $rc
