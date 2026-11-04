# RSI evaluation tools

Offline tools and runners that measure what task-experience refinement (RSI) changes. The runner for
AGH is `agh/run-agh.ts` (its header comment lists the options and the cost warning); `report.ts`
builds the report from a run folder; `recompute.ts` recomputes the numbers of finished runs offline
and never calls a model.

## Known limits of the first evaluation

These were found by reading the ledgers of the first full AGH run (180 runs, 30 tasks, one model); no
model was called. The runner now handles both, so later runs are not affected; the first run's numbers
are.

### Skill saves were all refused `unavailable`

In all 66 refinement proposals of kind `skill` the save receipt ended `refused`, reason
`unavailable` (the receipt's steps show the checks up to `rules` passing and `memory-mode` and
`capacity` skipped). Nothing was installed in any workspace.

Cause: a skill is installed through resource control, which lives in the daemon process. The host
builds its skill sender only when it is given a transport to that process
(`RefinementSaveTransport`, `packages/host/src/runtime/assemble/refinement.ts`); without one the save
path has no skill installer and refuses the entry `unavailable`
(`packages/host/src/runtime/refinement/workspace-save.ts`). The daemon supplies the transport and
answers the request with `createRefinementSkillRequests`
(`packages/daemon/src/supervisor/refinement-skill-requests.ts`). The runner boots the host through
`bootLocal`, which passes none, so every skill save in an embedded host is refused.

Now: for a run with refinement on, `agh/skill-save.ts` gives the embedded host that transport. It runs
the daemon's own request handler and installers over a resource-control store kept in the run's home,
so a saved skill lands in the workspace's `.agh/skills/<name>`. A run with refinement off gets no
transport (and the handler also answers `refinement-off` while the switch reads off), so it never
writes a skill. `bootLocal` takes the transport as an optional `refinementSave` dependency; without
it nothing changes.

### Workflow runs were never counted as finished

All 30 runs of the workflow tasks were left out of the reuse rate because `workflow-reuse.ts` found
no completed run in their first session. Every `workflow` call in those runs (127 calls over both
sessions) was answered `TOOL_OUTCOME_UNKNOWN`, "the outcome of workflow is unknown after dispatch. The
user confirmed that it happened".

Cause: the run itself ran to its end. For 121 of the 127 calls the tool's run rows
(`x/agnes/workflow/run`) end `completed` with every member `completed` (2 end `interrupted`, 4 calls
have no run record). The tool then shows the run as a surface (`renderRun`, which calls `ui_render`).
Display-only tools are not offered to an unattended turn (`requiresUser`; `toolsForAttendance` in
core), and the runner prompts unattended, so `ui_render` is not in the session's tool catalogue and
the call fails with `unknown tool ui_render` after the run has finished. The tool throws, and the core
records a call of a mutating, never-replayed tool that threw after dispatch as an unknown outcome.
It was not a timeout and not a cancel. The runner's approval handler answered the core's "did it
happen?" question with "allowed" (it approves everything), which only decides the wording the model
reads.

Now: `workflow-reuse.ts` counts a `workflow` call that was answered `TOOL_OUTCOME_UNKNOWN` as a
finished run exactly when the last run record the tool wrote for that call ends `completed` with every
member `completed`. A call with no run record, or with any other record (interrupted, failed, a
member still running), is not counted. The rule is fixed by `workflow-finished.test.ts`, which reads
rows from the first run's ledger.

Not fixed here, because it is a product matter: the `workflow` tool treats a missing surface as a
failed call, so in any unattended session (`agh -p`, `agh run`, a scheduled run, this runner) a
workflow that ran to the end is reported to the model as an unknown outcome. `deliverables` guards the same call by checking
that `ui_render` exists; `workflow` and `workflow_status` do not.

## The oracle arm and the capture rate

`agh/run-agh.ts --arms off,on,oracle` adds a third arm to the runs. The default is still `on,off`, and
`--settings` (on and off only) is the same option under its older name.

- `oracle` is `off` (refinement off) plus one paragraph, the task's own `trap.note`, written to the
  second session's workspace memory after the first session ends and before the second one opens. It goes
  through the memory provider's own edit of `MEMORY.md`, the one the memory page makes, so the agent
  reads it like any hand-written memory. The first session is the off run's. Only tasks of two sessions
  that are not workflow tasks have this arm; the runner skips the others for it.
- `sessionCost(run, session)` (`metrics.ts`) is what a session cost, summed from the rows of its own
  ledger (every lane, so the review calls of the `on` arm count): model requests, tokens, dollars. A
  parent ledger holds only a `subagent/cost` marker for each child session, without an amount, so a
  session with children, or a request without a price, is reported as a lower bound.
- The report gets a section "Second-session cost and capture rate" (`secondSession` in `report.json`).
  It covers the second session of two-session tasks only: single-session tasks have none, workflow
  tasks have no oracle arm. It gives the three arms' costs side by side, `off - on` and `off - oracle`
  with 95% intervals over tasks, and the capture rate
  `sum(off - on) / sum(off - oracle)` (`capture.ts`).
- The capture rate is computed over the tasks where the hand-written lesson saves something: the
  task's `off - oracle` interval (runs resampled within each arm) lies above 0. Tasks where it does not
  (the interval includes 0, or the lesson costs more) are listed as no headroom and counted; tasks with
  fewer than two off or oracle runs cannot be judged and are listed too. The exclusion looks at
  `off - oracle` only, never at `on`. With no task left there is no rate, which is not a pass.
- The refinement runs of the `on` arm review after every prompt, as the Prime runs do, which is more often
  than real use, so the `on` column costs more than real use would. Compare against Prime on the same terms.

`recompute.ts --run-dir <dir>` reads finished runs offline and prints the new section; it makes no model
call. A run folder made before this section existed shows the off and on columns and no oracle.

## Smoke run of the evaluation changes

`~/rsi-eval/smoke-v2.sh` (outside the repository, like `pilot.sh`; it reads the key from
`~/.rsi-eval/env` itself) runs the minimum real runs into a new folder, one repetition each: one
two-session task (default `cross-01-build-subdir`) with `--arms off,on,oracle`, and one workflow task
(default `wf-01-release-channel`) with `--arms on`. It then prints the checklist of
`smoke-check.ts` as PASS, FAIL or WARN lines and exits non-zero if any check failed:

- no skill save is refused `unavailable`, and a skill the review proposed is in the workspace's
  `.agh/skills/` (WARN when the model proposed no skill: run again);
- the off and oracle runs wrote no skill;
- the workflow run of the first session is counted as finished;
- the oracle run's workspace memory holds the lesson, the off run's does not, and it was written
  between the two sessions;
- the oracle run's first session matches the off run's (same prompts, system prompt, tool schema and
  size of the first request; the request bytes themselves differ by the throwaway workspace path).

`RSI_EVAL_LABEL` names the output folder; `SMOKE_TWO_SESSION_TASK` and `SMOKE_WORKFLOW_TASK` change the
tasks. It spends model calls, so the owner runs it.

## Infrastructure failures are not task failures

The first evaluation lost 30 runs to HTTP 402 (the account was out of quota). They were recorded as
failed runs (exit 1, no checks) and counted in the report. Now:

- **Detection** (`infra.ts`, `agh/run-agh.ts`). After a run, the host's ledger is read: when the last
  turn ended in error with a provider error code (`AUTH`, `QUOTA`, `RATE_LIMIT`, `TRANSPORT`) or an HTTP
  status of 401, 402, 403, 429 or 5xx, the outcome gets `infraFailed` with the session, the reason and the
  status. The host has retried by then, so a rate limit or a server error that is reported persisted.
  Failing that, a run that did not end cleanly is marked when the usage proxy's last three answers for it
  were all such statuses. A 400, a refused format, a timeout or a task failure is not infrastructure.
- **Results.** `report.ts` leaves infra-failed runs out of every metric and prints, per arm, how many it
  left out and why. `recompute.ts` does the same.
- **Redo.** Starting the same command again redoes an infra-failed run from the start (a finished run is
  skipped as before). The failed attempt is noted in `infra-failures.jsonl` in the output folder, and the
  redo's model traffic goes to the proxy under `<id>~a<N>`, so what the failed attempt spent is not counted
  into the run that replaces it. `mark-infra.ts --run-dir <out>` recognises the same failures in older
  output, such as the first evaluation's runs recorded as plain failures, and marks them for the redo.
- **Stop.** After 3 runs in a row ended by the infrastructure a shard stops with a message and exit code
  3 (`INFRA_STOP_AFTER` in `infra.ts`), so a bad key or an empty account does not burn through the task
  list. Three is more than one bad moment and few enough to waste little.
- **Error bodies.** The usage proxy keeps the first 500 characters of the body of every response that is
  not a 200 in `errors.jsonl` next to `usage.jsonl` (run id, status, body). Credentials are removed first:
  the API key given to the runner, `Bearer` tokens, `sk-` keys, values of key-like fields and any long
  unbroken token. Headers and the request are never kept.
- **Preflight.** `preflight.ts --config <run-config.json>` makes one tiny real call to the configured
  upstream through the proxy path and says whether the key is missing, the key is refused, the balance is
  out, the model name is wrong, the rate limit is hit or the upstream cannot be reached. It needs the
  variable the run config names as `keyEnv`; the key is sent upstream and nowhere else.
- **Scripts.** The shell scripts in `~/rsi-eval/` (outside the repository) call the preflight first, take
  the run config from `RSI_EVAL_CONFIG`, take the key from the `keyEnv` variable when it is set, recognise
  and redo infra-failed runs on start, and check for a running evaluation with the runner's own command
  line.

The report also prints, at its head, the model, route, upstream (without credentials) and the prices used,
and flags the prices as assumed when the run config says `"pricesAssumed": true`. It prints the share of
runs whose first session hit the trap, per arm and per task, and names the tasks where no run did.
