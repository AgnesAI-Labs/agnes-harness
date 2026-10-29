# Business workflow Loops

English | [简体中文](workflow-loops.zh-CN.md)

[Author kit](README.md) · [Import map](imports.md) · [Testing](testing.md)

Start a staged business agent with `defineWorkflowLoop` from `@agnes/plugin-runtime`. Write named stages that return business evidence; the helper owns checkpoint validation, plan approval, Proceed/Cancel confirmation, tool approval continuation, cancellation and report publication. Use `defineLoop` and the full `LoopContext` contract when you need custom scheduling.

## Worked example: review a renewal note

This plugin reads an account, drafts a note, publishes it for review and records the exact note after confirmation. Replace the two connector tools with your own `defineTool` definitions. Their metadata must describe their actual effects; the recording tool still goes through backend permission and approval.

```ts
import { defineWorkflowLoop, workflowValue } from '@agnes/plugin-runtime'
import { accountLookup, recordNote } from './tools.js'

const workflow = defineWorkflowLoop({
  id: 'acme.renewal',
  version: '1.0.0',
  name: 'Renewal review',
  tools: [accountLookup, recordNote],
  deliverables: {
    directory: 'renewal-output',
    markdown: (state) => String(state.data.note ?? ''),
  },
  stages: [
    {
      name: 'account',
      async run(ctx, _state, signal) {
        return { account: workflowValue(await ctx.tools.execute({
          name: accountLookup.name, args: { id: 'A-100' },
        }, signal)) }
      },
    },
    {
      name: 'draft',
      async run(_ctx, state) {
        return { note: `Review renewal follow-up: ${JSON.stringify(state.data.account)}` }
      },
    },
    {
      name: 'record',
      confirm: () => 'Record the complete reviewed note?',
      async run(ctx, state, signal) {
        return { receipt: workflowValue(await ctx.tools.execute({
          name: recordNote.name, args: { id: 'A-100', text: String(state.data.note ?? '') },
        }, signal)) }
      },
    },
  ],
})

export const main = workflow.main
```

Declare a plugin row exporting `main`, injecting `tools`, `providers` and `skills`, with `apiRange: "^5.0.0"`. Declare model and filesystem capabilities for the connector and report directory. Select `providers.loop: { provider: "acme.renewal", version: "1.0.0" }` and `providers.tool-policy: { provider: "acme.renewal" }` through the [profile/preset configuration](bundles-and-profiles.md). Installation alone does not select a Loop. `main` registers tools, the Loop, its policy and optional `skills` using the three public registration ports; the platform owns registration cleanup. Own connector connections through `ctx.effect()` as usual.

The helper inserts a plan gate first. If the public turn view includes Plan mode, it asks `exit_plan_mode` to approve the fixed stage list before business work. It publishes a draft before a confirmation and final files on completion through official `read`, `write` and `present`. Output paths include a session/input hash and stage index. The registered policy preserves denials from the shipped default policy, allows only the generated report paths, and separately asks for business writes. `readOnly: true` denies source mutations. Optional `policy` adds your business rule after these fixed restrictions.

## Stages and confirmation

A stage implements `run(ctx, state, signal)` and returns JSON fields merged into `state.data`. State provides the original text `input`, validated `settings`, `index`, `stageCount`, `outputKey` and optional `stageInput`. `validateSettings` validates both new-session settings and resumed settings. Set `approval: true` for a stage whose tool can park for approval; a confirmed action stage also gets this handling. An approval-capable stage supports one exact tool call; split different calls into different stages. Pass the supplied signal into all asynchronous work.

`confirm(state)` returns a question or `undefined`. Default confirmation uses the session `DecisionPort`, retains the original handle across reopening and consumes the answer with the next checkpoint. A detached wait remains parked. Cancel, stopped, expired, unavailable or invalidated decisions stop the action. This business choice grants no tool permission.

Set `confirm: 'surface'` on the workflow to retain the official `ask_user_question` Proceed/Cancel surface. Only a Host-authenticated `agnes/intelligent-ui` / `action-result` system input with the matching surface, successful `ui_submit` and exactly one valid answer advances it. Free text, display summaries, unrelated notifications and failed receipts cannot approve an action. The [Business agents](../../examples/fde/README.md) demonstrate this presentation and keep their existing tools and surfaces.

`workflow.factory` and `workflow.createFactory(settings)` expose the registered Loop for direct tests or custom plugin wiring; `workflow.policy` exposes its business policy. JSON tools can use `workflowTool`, `workflowResult`, `workflowValue`, `workflowText` and `workflowChecked`; `workflowModelText` makes a narrow, tools-free prepared request with the supplied business facts. You can also use ordinary `defineTool` and `LoopContext` methods.

## Receive system notifications

An `inputStage: true` stage waits at a safe step boundary and receives the complete `LoopInput` as `state.stageInput`. The helper checkpoints it before a generic turn checkpoint can consume the input. Return `{ waitingForInput: true }` to discard an irrelevant input and wait again without advancing the stage:

```ts
{
  name: 'await-child',
  inputStage: true,
  async run(_ctx, state) {
    const input = state.stageInput
    const notice = input?.system
    const data = notice?.data
    if (input?.origin !== 'system' || notice?.source !== 'agnes/child' ||
        notice.type !== 'child-completed' || !data || typeof data !== 'object' ||
        Array.isArray(data) || data.childKey !== state.data.childKey)
      return { waitingForInput: true }
    // The preceding spawn stage stores the expected childKey in state.data.
    return { childResult: data }
  },
}
```

The hook accepts any structured system input, including background child completion notifications; it does not assume UI receipt fields or parse summaries. Host authenticates the source, while the business stage validates type, identity and payload. Notification data remains untrusted for model policy and cannot authorize a tool. Finance uses this hook for an existing UI action receipt. Its `guardToolCall` and `recordToolResult` hooks validate committed evidence before execution/resume and checkpoint processed rows after a result; deferred calls share these hooks.

## Recovery and tests

Approval continuation reconnects the original invocation, retaining its identity and receipt. Waiting tickets and a busy approval lane stay parked; blocked continuation stops. A stage interrupted with an uncertain pending outcome is refused on recovery: reconcile the original evidence before starting new work. The helper never promises exactly-once external effects. Stop cancels the driver and drains through the normal backend cancellation contract.

Workflow checkpoints use codec 1 and bind the workflow identity and stage count. Change the Loop version when changing stages, settings or evidence meaning. FDE workflows now select version 5.0.0; older codecs fail closed and retained sessions keep their pinned code. There is no old-checkpoint conversion.

Use `driveLoop(workflow.factory, { inputs, replies, tools })` from `@agnes/host/author-testkit` for deterministic fast tests. Use the full author testkit for real session decisions, authorization and deferred queue behavior. Keep process tests in the heavy tier. The official helper's unit tests cover progression, both confirmation transports, approval park/resume, stop, unknown outcomes, structured notifications and idempotent resume. Start from the [Loop template](../../templates/loop/).

Each `LoopContext` belongs to one execution generation. Timeout, replacement or disposal permanently revokes its mutation ports (`E_CLOSED`); retaining the context cannot grant authority in a later turn. Core also rechecks queued writes at ledger commit admission. Core retains late real effect receipts against the original effect; the replacement Loop can inspect them with `effects.status(invocationId)`, including after cold restore. A late receipt does not reopen the old turn or commit its assistant message or checkpoint.

The default Loop and generic `model.stream()` / `model.complete()` share Core’s model transport and settlement. Every dispatched request has one cost row and one billing record, including provider errors and cancellation. Missing usage uses the same estimated token counts and `creditSource: estimated`; repeated usage reports are request totals, so the last report replaces earlier totals. Cancellation stops waiting even when a provider ignores its signal. An unavailable billing record refuses subsequent model dispatch in that turn. Loops still choose retries, compaction and subsequent calls.


### Execution contract suite

Loop authors can run the same Core-backed execution checks as the default Loop:

```ts
import { verifyLoopExecutionContract } from '@agnes/host/author-testkit'
import { myLoopFactory } from './my-loop.js'

await verifyLoopExecutionContract(myLoopFactory)
```

The suite uses synthetic providers, tools and storage. It checks cancellation, approval rejection,
usage and missing-usage settlement, unknown outcomes, cold restore, stale scope refusal and
coexisting Loop generations. The factory must handle ordinary text prompts and model tool-call
replies; adapt a custom planning language in the supplied factory. Run it in the heavy test tier
because the stale-scope scenario waits for a real deadline. This additive Host testkit export does
not change the extension-api contract version.

A loop that sends side model calls (`ctx.sideCall`) can add the side-call checks with
`verifyLoopExecutionContract(myLoopFactory, { sideCall: true })`. The report then also lists
`side-call`, `side-call-deadline`, `side-call-cancel`, `side-call-revocation` and
`side-call-estimated-cost`. They make side calls through the loop's own context against a
payload-only adapter that the suite defines, so no account or service is needed. Without the
option the checks and the report are unchanged. See
[Side model calls from a loop](../develop/plugins.md#side-model-calls-from-a-loop).
