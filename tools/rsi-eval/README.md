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

### Saved skills were not offered to the agent in the eval host

Saving a skill worked (it landed in the workspace's skills folder, above), but the embedded host never
scanned skills on disk, so a saved skill was never offered to the agent: not to a later session, and not to
the session that saved it. Evidence from a smoke run's own captured requests (`home/data/model-requests`):
the workflow task's `on` run installed `release-request-workflow` at the end of its first session, and all
161 requests it made after that offered only the bundled `remembering` skill in their `<available_skills>`.
Results recorded before the fix that depend on a saved skill (the `on` arm's, every workflow result, the
skill part of the frozen arm) are invalid.

Now: a host the CLI embeds offers the skills it finds on disk, scanned when a session first reads skills
(so a new session sees every saved skill), and `Booted.refreshSkills()` asks for a scan before the next
skill read of any session. The runner wraps the skill transport so that every save the handler accepts
(`ok: true`) is followed by that refresh (`refreshAfterSave` in `agh/skill-save.ts`): the session that
saved a skill is offered it from its next request. `agh/skill-save.test.ts` saves a skill through the
transport and reads the host's skill view the way a turn does, with and without the refresh.

`smoke-check.ts` still does not accept a skill folder on disk as a saved skill: it also requires the
skill in the catalogue of a later request of the `on` run, and a frozen run's seeded skills in its first
request's catalogue.

## The oracle arm and the capture rate

`agh/run-agh.ts --arms off,on,oracle` adds a third arm to the runs. The default is still `on,off`, and
`--settings` (on and off only) is the same option under its older name.

- `oracle` is `off` (refinement off) plus one paragraph, the task's own `trap.note`, written to the
  second session's workspace memory after the first session ends and before the second one opens. It goes
  through the memory provider's own edit of `MEMORY.md`, the one the memory page makes, so the agent
  reads it like any hand-written memory. The first session is the off run's. Only tasks of two or more
  sessions (or with `oracle.afterPrompt`) that are not workflow tasks have this arm; the runner skips the
  others for it.
- `sessionCost(run, session)` (`metrics.ts`) is what a session cost, summed from the rows of its own
  ledger (every lane, so the review calls of the `on` arm count): model requests, tokens, dollars. A
  parent ledger holds only a `subagent/cost` marker for each child session, without an amount, so a
  session with children, or a request without a price, is reported as a lower bound.
- The report gets a section "Cost after the first session and capture rate" (`secondSession` in `report.json`).
  It covers the sessions after the first (`laterSessionsCost`: the second session of a two-session task,
  sessions 2 to N together of a long task of N): single-session tasks have none, workflow tasks have no
  oracle arm. It gives the three arms' costs side by side, `off - on` and `off - oracle`
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

`scripts/smoke-v2.sh` runs the minimum real runs into a new folder, one repetition each: one two-session
task (default `cross-01-build-subdir`) with `--arms off,on,oracle` and then `frozen` from that `on` run,
and one workflow task (default `wf-01-release-channel`) with `--arms on`, after a preflight call. It then prints the checklist of
`smoke-check.ts` as PASS, FAIL or WARN lines and exits non-zero if any check failed. It spends model calls.

```
export <the variable your run config names as "keyEnv">=...
RSI_EVAL_CONFIG=<run-config.json> RSI_EVAL_OUT=<a folder that does not exist yet> tools/rsi-eval/scripts/smoke-v2.sh
```

`SMOKE_TWO_SESSION_TASK` and `SMOKE_WORKFLOW_TASK` change the tasks. The run config is the one the runners
take (`run-config.example.json`); the script reads no key from a file, the variable must be set already.

The checklist:

- no skill save is refused `unavailable`, and a skill the review proposed is in the workspace's skills
  folder (WARN when the model proposed no skill: run again);
- a skill an `on` run installed is offered in the skill catalogue of a later request of that run, and the
  frozen run is offered its seeded skills from its first request (WARN when there is nothing to judge by);
- the off and oracle runs wrote no skill;
- the workflow run of the first session is counted as finished;
- the oracle run's workspace memory holds the lesson, the off run's does not, and it was written
  between the two sessions;
- the oracle run's first session matches the off run's: the same prompts, system prompt, tool schema and
  context sections of the first request. The request bytes themselves differ by the throwaway workspace
  path, and so does the size of the `environment` section that holds it, which is not compared.

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
- **Wrapper scripts.** A script that starts a long run should call the preflight first, take the run
  config from one place, take the key from the `keyEnv` variable, run `mark-infra.ts` on the output folder
  before starting (so one command always resumes), and check for a running evaluation with the runner's own
  command line (`cli.mjs tools/rsi-eval/agh/run-agh.ts`), not a bare file name that also matches the shell
  doing the checking. The repository only holds `scripts/smoke-v2.sh`; the owner's wrappers for the full
  runs live outside it.

The report also prints, at its head, the model, route, upstream (without credentials) and the prices used,
and flags the prices as assumed when the run config says `"pricesAssumed": true`. It prints the share of
runs whose first session hit the trap, per arm and per task, and names the tasks where no run did.

## Runs the host's verifier blocked are not task failures

The host checks every turn; when the check fails (for example `tool_call_as_text`, a tool call the model
wrote as text, so it never ran) it asks the model to repair the turn, and when that does not take it ends
the turn `blocked`. The harness stopped that run, not its task. The runner records it as `blocked` in the
outcome (session, prompt and the verifier's reasons, from the ledger's `x/core/verifier-recovery` row;
`blocked.ts`), the report leaves it out of every metric and lists such runs per arm with their reasons, and
the next start of the same command redoes it once, noted in `blocked-runs.jsonl`, under a new proxy id as
an infrastructure redo is. A run blocked again is left as blocked.

## What the capture rate does and does not say

The report prints the capture rate as `rate = numerator / denominator over N of M tasks; 95% CI a to b`,
never as a bare number, and the means of the three arms over the tasks of the rate next to the means over
every task.

- **Which runs count.** Only runs whose sessions after the first all completed and passed their checks enter
  the means and the rate. A run that stopped early looks cheap and one that timed out looks dear, so neither
  says what completing the task costs. The report counts the ones left out per arm and reason (the run never
  reached its second session, it timed out, a session did not complete, a check failed or was not reached).
- **Headroom on other runs.** Whether the hand-written lesson saves anything for a task is decided, when you
  give `report.ts --headroom-dir <pilot folder>`, on the pilot's `off` and `oracle` runs, and the rate sums
  the full run's own `off`, `on` and `oracle` runs. Deciding on the same `off` runs that the numerator then
  sums selects the tasks whose `off` runs were dear and inflates the rate; without a pilot folder the
  report says that and that the rate is then optimistic. The pilot's runs must not be reused in the full
  run (the report refuses a folder that holds the same run, by id and start time). The per-task test is a
  Welch t interval, wide for three runs a side.
- **The interval** resamples tasks and, within each task, the runs of each arm, and decides headroom again
  in every resample.
- **Review calls.** The `on` arm reviews after every prompt, as the Prime runs do. Rows marked "all lanes"
  include those calls; rows marked "session work only" leave them out (the refinement lane of the ledger),
  and the report prints the review calls' own mean per run. The effect of the saved lesson alone is in the
  second kind of row.

## Long tasks, milestones and the request cap

A task of the category `long` is a run of many stages, one prompt each, in one session or in up to ten
sessions over the same workspace. Each session is a new conversation that picks the work up where the last
one left it, so what the agent learnt in an earlier session is not in its context any more; only what was
saved (memory, skills) or left in the files carries over. A session of a long task may hold a single
prompt. The category has no floor of five tasks; the categories of the first suite keep theirs.

- **Milestones.** A prompt with `"milestone": "<name>"` has its checks run right after it, in the live
  workspace, before any review. The run stops at the first milestone whose checks fail (`stopped` in the
  outcome), so "reached" is monotone. Prompts that are no milestone are still checked at the end, as before.
  The self-check judges a milestone the same way: before and after its own solution, with every earlier
  solution applied, and not in the final state.
- **What was spent by each prompt.** The runner records when each prompt's turn ended (`prompts` in the
  outcome). The report reads from the ledgers what the run had spent by then, over every session so far:
  main-lane tool calls, requests, tokens and dollars (all lanes, and without the refinement lane).
- **Report.** Per task, one row per run with what it had spent at each milestone it passed, the row stopping
  where the run stopped (a failed milestone, the cap, a timeout); per arm and milestone, how many runs reached
  it and the medians of those that did; and one point per run of milestones reached against what the whole run
  cost. There is no single "milestone every run reached" number: that collapses to the weakest run and hides
  an arm that fails more often.
- **Request cap.** `"maxRequests"` in the task, else `--max-requests` (default 400). The usage proxy forwards
  that many requests of a run and answers the rest with HTTP 400 and a body that says so (not sent, not
  usage, and not a status the infrastructure check takes for an upstream failure); the runner then aborts the
  turn and records `capped` with the session and prompt. Capped runs are listed apart in the report and left
  out of every mean; they appear in the milestone curves, which stop at the cap. The cap counts every request
  of the run, the review calls included. The session timeout still applies; size it to the cap.

### The long tasks

`tasks/long-01-release-train` to `tasks/long-04-test-harness` are four such tasks of ten milestones each, five
sessions of two milestones over one workspace, in four domains (a release tool, a vendor data import, a config deployer, a test harness). Each tool enforces
one rule that no prompt states, that its error does not spell out and that nothing in the workspace shows:
the tool's source (`tool/<name>.py`, outside the fixture) is packed into `fixture/bin/<name>` by
`long-tools.ts`, so reading the launcher shows neither its checks nor its messages. The launcher is a shell
script that runs the source with the macOS command line tools' own Python when there is one: inside the
eval sandbox the `/usr/bin/python3` shim prints cache warnings to stderr around every message, and agents
then hide stderr, and the tool's errors with it. Each task repeats one
multi-step procedure at every milestone. `tasks/LONG.md` (for reviewers; never copied into a workspace)
gives each task's rule and why it cannot be read off the workspace; `long-tasks.test.ts` holds the tasks to
that.

## Context window

The run config may name `contextWindow` and `maxOutputTokens` for the declared model; without them the
model is declared with 200,000 and 8,192 as before, so old runs are unchanged. What the host does with the
window, read from its code (`createCompactionThreshold` in `packages/extension-api/src/compaction-engine.ts`,
`compactionSettingsFor` in `packages/core/src/execution/turn/gate.ts`, the defaults in
`packages/core-common/src/step/preset.ts`; `context-window.test.ts` pins the parts that can be run alone):

- It compacts when the context passes `window - reserve`. The reserve is 16,384 tokens; it becomes
  `min(16,384, window / 4)` only when a session works with a window smaller than its model's capacity or
  the window is not above 16,384, neither of which happens with a declared window above 16,384. Once per
  stretch, while at least half of the last request was read from the prompt cache, it waits up to half the
  reserve (8,192 tokens) longer.
- A window too small for the fixed instructions and tool schemas ends the turn with a budget error instead
  of compacting (`contextBudgetError`).
- A compaction keeps a model-written summary and the most recent `min(20,000, (window - reserve - fixed
  prefix) / 2)` tokens. The fixed prefix (instructions and tool schemas) was about 6,200 tokens in the
  first evaluation's first requests.

| declared window | compacts past | keeps of the recent context |
| --- | --- | --- |
| 200,000 (default) | 183,616 | 20,000 |
| 128,000 | 111,616 | 20,000 |
| 64,000 | 47,616 | 20,000 |
| 32,000 | 15,616 | about 4,700 |

So with a 64,000 window the host does compact, but each compaction keeps the last 20,000 tokens verbatim
plus a summary: compaction is not the same as forgetting. A run's ledger shows the window it used
(`session/start`, `modelSettings[].settings.contextWindow`) and each compaction (`x/core/compaction-end`).
The first evaluation's 200,000 window never compacted. The Prime runner's model file declares no window;
this option is for AGH only.

## The oracle on long tasks

A long task of several sessions gets the lesson as a two-session task does: written to the workspace memory
after the first session ends, before the second opens. So the oracle's gap to `off` leaves out the first
discovery of the rule, which refinement can never avoid, and covers every later session, each of which
starts without the rule in its context. The cost after the first session (the report's section 4) is then
what sessions 2 to N cost together; a run that stopped before its last session is left out of it.

`"oracle": { "afterPrompt": <n> }` in a task instead writes the lesson after prompt `n` (zero-based) of the
first session, before the next one; that is for a long task of one session.

## The frozen arm

`--arms off,frozen --frozen-from <the output folder of a finished run with on runs>`: refinement off, and
before the first session the run starts with exactly what the `on` run of the same task and repetition in
that folder saved: its saved workspace memory paragraphs, its saved user memory sections and its installed
workspace skills (`agh/frozen.ts`). Not the notes the agent wrote into memory itself (an `off` run writes
those too) and not the work it left in the files. The runner refuses a missing source, one that is not an
`on` run, one the upstream ended, and one the host's verifier blocked (it saved only part of a run); it
checks every source before the first run starts.

The on runs and the frozen runs can be made in one invocation: `--reps 5 --arms on,off,oracle,frozen
--frozen-from <the same folder as --out>`. Then frozen always runs right after the on run of the same task
and repetition (`orderArms` moves it behind `on` whatever order `--arms` names), its source is checked at
that point instead of before the first run, and a frozen run whose on run cannot be a source (blocked,
ended by the upstream) is skipped with a message while the others go on; start the same command again to
redo the on run and then its frozen run. With `--frozen-from` another folder, the sources must all be there
before the start, as before.

- The paragraphs are written as hand-written memory text, without their markers: a saved paragraph is shown
  to the agent only while the host's registry vouches for it, and the fresh run's registry knows nothing of
  another run's saves.
- The skills are copied into the workspace's skills folder before the host starts, where the `on` run left
  them, and the host offers them from the first request.
- The runner records which throwaway workspace each fixture used (`workspaces` in the outcome), so a later
  frozen run can find each workspace's memory. A source recorded before that is accepted only for a task of
  one workspace.
- The report compares frozen with `off` and the oracle per session and for the whole run, over sessions that
  completed and passed their checks: no review calls and no experience guidance are in the measured run, so
  this measures the lessons, not refinement's overhead. Report the `on` run's own cost as the one-time
  investment.

## Driving the on arm by refinement's own triggers

`--on-protocol triggers` sends no manual review after the prompts and none of the end-of-session saves
(the workflow task's save to the workspace, the cross-workspace task's save to user memory; the report
header says so for such runs) and leaves refinement to its own triggers (compaction, repeated failure, the model's own request). The manual reviews
were also the runner's only sign that refinement was live, so the runner then reads the session's experience
entries once per session (no model call): it is refused exactly when a review would be, and a dead
refinement stops the run. The default stays `reviews`. The report says how many `on` runs used each; do not
pool the two.

## Rule forgetting

For every run, the report says whether the trap rule was broken again after the first hit: later in the same
session (and of those, after a compaction), or in a later session, from the ledgers and with the same trap
rule as the other metrics. If `off` never breaks the rule again there is nothing for a saved lesson to save.
On the first evaluation's 13-run sample: of 4 `off` runs that hit the trap, 1 broke the rule again later in
the same session and 1 of the 2 with a second session broke it there.
