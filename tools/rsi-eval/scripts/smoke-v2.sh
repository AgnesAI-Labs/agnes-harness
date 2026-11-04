#!/usr/bin/env bash
# Smoke run of the evaluation: skill saves in the eval host, the oracle and frozen arms. The minimum real
# runs, one repetition each, into a new folder:
#   - one long task (five sessions in one workspace) with the arms off, on, oracle and frozen (4 runs; the
#     frozen run copies the on run of the same invocation)
#   - optionally one workflow task with the arm on (SMOKE_WORKFLOW_TASK; the suite has none now)
# then a PASS/FAIL checklist (smoke-check.ts) of what only a real run can show. It makes real model calls,
# about as many as four pilot runs of the long task, after one tiny preflight call.
#
# It takes no key from a file: export the variable that the run config names as "keyEnv" first.
#
#   RSI_EVAL_CONFIG=<run-config.json> RSI_EVAL_OUT=<new folder> tools/rsi-eval/scripts/smoke-v2.sh
#
# Optional: SMOKE_TWO_SESSION_TASK (default long-01-release-train), SMOKE_WORKFLOW_TASK (none by default: the
# suite holds no workflow task). Needs mise, python3 and bash on PATH.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
: "${RSI_EVAL_CONFIG:?set RSI_EVAL_CONFIG to the run config (see tools/rsi-eval/run-config.example.json)}"
: "${RSI_EVAL_OUT:?set RSI_EVAL_OUT to a folder that does not exist yet, outside any git repository}"
[ -f "$RSI_EVAL_CONFIG" ] || { echo "run config not found: $RSI_EVAL_CONFIG"; exit 1; }
[ ! -e "$RSI_EVAL_OUT" ] || { echo "$RSI_EVAL_OUT already exists; pick another RSI_EVAL_OUT"; exit 1; }
KEYENV="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keyEnv"])' "$RSI_EVAL_CONFIG")"
[ -n "${!KEYENV:-}" ] || { echo "the API key is not set: export $KEYENV (the keyEnv of the run config) first"; exit 1; }
TWO="${SMOKE_TWO_SESSION_TASK:-long-01-release-train}"
WF="${SMOKE_WORKFLOW_TASK:-}"
mise exec -- pnpm exec tsx tools/rsi-eval/preflight.ts --config "$RSI_EVAL_CONFIG" || { echo "preflight failed: nothing was started"; exit 1; }
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @agnes/host build:native
mise exec -- pnpm --filter @agnes/system-node build:native
mkdir -p "$RSI_EVAL_OUT"
# The frozen run comes right after the on run of the same task and repetition, and copies what it saved.
mise exec -- pnpm exec tsx tools/rsi-eval/agh/run-agh.ts --config "$RSI_EVAL_CONFIG" --out "$RSI_EVAL_OUT" --tasks "$TWO" --reps 1 --arms off,on,oracle,frozen --frozen-from "$RSI_EVAL_OUT"
if [ -n "$WF" ]; then
  mise exec -- pnpm exec tsx tools/rsi-eval/agh/run-agh.ts --config "$RSI_EVAL_CONFIG" --out "$RSI_EVAL_OUT" --tasks "$WF" --reps 1 --arms on
fi
mise exec -- pnpm exec tsx tools/rsi-eval/report.ts --run-dir "$RSI_EVAL_OUT" --config "$RSI_EVAL_CONFIG"
echo
echo "== checklist =="
rc=0
mise exec -- pnpm exec tsx tools/rsi-eval/smoke-check.ts --run-dir "$RSI_EVAL_OUT" --two-session "$TWO" ${WF:+--workflow "$WF"} --rep 1 || rc=$?
echo "done: $RSI_EVAL_OUT (report.md and report.json; the cost after the first session needs more than one repetition for intervals)"
exit $rc
