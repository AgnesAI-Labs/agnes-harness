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
