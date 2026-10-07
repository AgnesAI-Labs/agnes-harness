# Programmatic tools and workflows

English | [简体中文](code-workflows.zh-CN.md)

Select the **ptc** preset when creating a local session. It inherits the
workspace-write permission policy and exposes `run_code` to the model. The tool
SDK supplies TypeScript parameter declarations for available tools.

Each cell runs in a fresh Node process owned by the selected sandbox provider.
Top-level `await` and `return` are supported; variables do not survive cells.

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
by the current permission preset.

Stages execute sequentially, with at most four parallel members per stage.
Children use the official `subagent_spawn` tool and inherit its depth, fan-out,
budget and worktree rules. Each later stage receives the preceding stage's
bounded results. A failed member stops the workflow.

Retain the returned `runId`. Use `workflow_status({ runId })` to inspect durable
state or `workflow({ runId })` to resume an interrupted run. The session ledger
records accepted child identities before collection; resume reuses those
identities and completed members. If interruption happens during child creation
before its identity is recorded, resume refuses another dispatch. Reconcile that
ambiguous child before starting a new run. Cancellation cancels accepted
children; a cancelled or failed run cannot be resumed.

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
Python 3 must be installed. Python supports top-level await/return and the same
tool bindings, without persistent kernel or snapshot/restore support.
