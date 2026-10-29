# Programmatic tools and workflows

English | [简体中文](code-workflows.zh-CN.md)

Select the **ptc** preset when creating a local session, for example
`agh --preset ptc`. It exposes `run_code` to the model; the tool SDK supplies
TypeScript parameter declarations for available tools. The preset does not
choose a permission: the session runs under `workspace-write` unless you pick
another level, for example `agh --preset ptc --permission read-only`. See
[permissions and presets](security.md#permissions-and-presets).

Each cell runs in a fresh Node process owned by the selected sandbox provider.
Top-level `await` and `return` are supported; variables do not survive cells.
Cells use Node type stripping: type annotations are supported; runtime TypeScript
features such as enums and parameter properties should use ordinary JavaScript equivalents.

## Batch independent tool calls

One model response can contain several tool calls. Batch independent reads, searches and status checks in that response: read-only calls can run together; other calls execute in the given order. Wait for a result before choosing dependent inputs. Dependent shell steps that need no inspection between them can use one command with `&&` or a short script.

Inside `run_code`, await every call and inspect every result, for example with `Promise.allSettled` for independent reads. The bridge allows at most four concurrent calls; do not parallelize edits to the same file or steps that need an approval/result first. A response that hands off a background job does not prove completion: inspect its actual state with `job_output` on the returned ID instead of starting it again. See [shell wait limits and job controls](../reference/default-tools.md).

## Run a workflow

```ts
return await tools.workflow({
  name: 'review',
  stages: [
    { name: 'Inspect', members: [
      { name: 'Tests', task: 'Review test coverage; do not modify files.' },
      { name: 'Design', task: 'Review module boundaries; do not modify files.' },
    ] },
    { name: 'Report', members: [
      { name: 'Writer', task: 'Summarize findings from the previous stage.' },
    ] },
  ],
})
```

A cell requires approval under the ordinary approval policy. Nested tools also
pass through validation, approval, budget and depth checks. Up to four bridge
calls may run concurrently; a cell accepts at most 256 calls. Cells respect the
configured elapsed-time and output limits. Cancellation terminates the process
and cancels outstanding bridge calls. Direct process operations remain confined
by the session's permission.

Tools called inside a cell stay out of the model's context: only what the cell
prints or returns comes back, and the nested calls and results remain visible in
the session record. The `run_code` result ends with a `nested calls:` line that
lists each non-read-only call as ok, error, or pending (waiting for approval)
and counts the read-only ones.
Bridge error code 1006 (`APPROVAL_PENDING`) means a nested call is waiting for
the user's approval; the cell should end. If several calls got 1006, only one
waits for approval; the others were withdrawn and did not run, and should be
called again after it is settled if they are still needed. A call that is
approved after the cell has ended has already run, and a `[nested result]` note
reports any nested outcome that no code consumed.

The official preset sets `raw_io: false`. Node permission mode blocks direct
filesystem access and child-process creation; use the approved tools instead.
Custom presets may explicitly enable raw I/O with `code_runtime.raw_io: true`;
these cells have cell-level approval and report `ioEnforcement: cell-approval`,
while their process still uses the session's OS sandbox.

Stages execute sequentially, with at most four parallel members per stage.
Children use the official `subagent_spawn` tool and inherit its depth, fan-out,
budget and worktree rules. Each later stage receives the preceding stage's
bounded results. A failed member stops the workflow.

Default child agents and workflows use Git worktrees through the workspace-scoped `gitWorktreeKind` from `@agnes/git-worktree-contract`. Host registers the only provider, and the bundled subagent binds it with `providers.bindOwn` during a tool call. Add `.worktrees/` to the repository ignore rules first. The service generates branches, lists only its registered worktrees and removes clean trees without force; dirty trees and unmerged branches are retained for review, with ownership and cleanup stages preserved across restart. Creation, listing, removal and cleanup refusals appear as `worktree-*` facts in the trace. Agent tools remain unable to read or modify `.git`. Non-repositories, missing Git and remote sandboxes report `not-git`, `git-error` and `remote-sandbox`; when isolation is omitted, only `not-git` falls back to the shared folder and the tool result explains why. Explicit `isolation: "worktree"` and all other worktree failures still refuse execution. Choose `isolation: "shared"` explicitly if sharing the working directory is intended.

`ctx.subagent.collect()` may return an optional `receipt` with workspace isolation, up to 32 recent tool results (name, ledger sequence and error status), and a `truncated` flag. Older or external child providers may omit it; missing evidence is not a successful execution receipt.

Workflow receipts distinguish backend tool results from child-authored reports. The parent and later stages receive current execution facts through a context section, including workspace isolation and whether tool evidence is partial or unavailable. Worktree outputs remain in the child workspace: Workflow does not merge their branches into the main workspace. The Web card marks this explicitly. Verify a separate integration operation before claiming those files are present in the main workspace; a child's statement that it merged files is not an integration receipt.

Retain the returned `runId`. Use `workflow_status({ runId })` to inspect durable
state or `workflow({ runId })` to resume an interrupted run. The session ledger
records accepted child identities before collection; resume reuses those
identities and completed members. If interruption happens during child creation
before its identity is recorded, resume refuses another dispatch. Reconcile that
ambiguous child before starting a new run. Cancellation cancels accepted
children; a cancelled or failed run cannot be resumed.

A spawned in-process child starts with its own task conversation. Its ledger keeps the parent
ancestry for audit, but the model does not receive the parent's in-flight tool calls or prior
conversation. A forked child inherits the prefix captured before its delegating tool call; its
new task identifies it as the child. Both retain the selected code generation, tool filters,
workspace isolation and permission limits. Workflow stages pass the preceding stage's named
results explicitly in the next child's task, rather than relying on inherited conversation.

The Web run card groups members by stage. Expand a stage to see member status
and its child-session link. In-process children currently lack daemon session
adoption and ownership registration, so opening these links through the daemon
is pending that integration. Cards show recorded state; use `workflow_status`
to refresh it. Older terminal runs may be evicted from the bounded projection;
their events remain in the ledger.

The local provider supports the bridge on macOS and Linux. Other providers must
declare `capabilities.programmatic: true` and implement the JSON request/reply
pipe. Unsupported providers refuse execution. Windows and remote sandbox
deployments currently do not support PTC. A custom preset may set
`code_runtime.language: python` for experimental stateless CPython cells;
Python 3 must be installed, and `raw_io: true` is required; Python `raw_io: false`
is refused until its I/O bridge is available. Python supports top-level await/return and the same
tool bindings, without persistent kernel or snapshot/restore support.
