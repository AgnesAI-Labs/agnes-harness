# Deferred tool invocations

English | [简体中文](deferred-invocations.zh-CN.md)

[Intelligent UI](intelligent-ui.md) · [Loop contracts](plugins.md)

A producer can enqueue a pre-validated tool invocation for execution at a Loop's next safe boundary. This is one public, plugin-agnostic contract in `@agnes/plugin-runtime/deferred-contract`; UI actions, webhook rules and schedules can use it. The queue does not accept executable functions, permission decisions or another Agent input channel. Core is unchanged.

`DeferredToolInvocation` binds `id`, `sessionKey`, `lane`, `source`, `sourceSeq`, authenticated `actor`, declared `tool` and JSON `args`. Host binds one session-scoped queue and one producer callback per owner. A producer submits through that owner's queue facade, which can read and move only its own invocations. Its `notify` acknowledges only those receipts. Validation includes membership in the selected session tool catalog and business/task constraints. It never grants permission. The backend adapter must authenticate and resolve the actor/session before building the invocation.

Host uses `withDeferredToolInvocations(factory, resolve)` to expose the queue through the generic `LoopContext.services` reader while preserving the selected factory identity, capabilities, codec and driver lifecycle. The reader keeps the bound session queue when its producer later unloads; a new enqueue still fails closed without that producer. A supporting Loop declares the `deferred-invocations` capability and calls `drainDeferredToolInvocations(ctx, signal)` at its ordinary step boundaries. An empty queue or a missing reader does not change default Loop scheduling. Custom Loops can use exactly the same drain; they do not receive UI-specific methods.

The drain processes at most one invocation per step. New queued work starts at the `model` boundary after the ordinary checkpoint; it does not interrupt a planned model tool batch or compaction. An original approval continuation may resume at a `tools` boundary. Failure boundaries only recover existing receipts or report a not-dispatched/uncertain outcome. Cancellation propagates without pretending an interrupted effect failed safely. Idle wake uses normal SC1 queued input to open a turn; producer results also use SC1, with durable dedupe keys. The drain opens its own original approval continuation with `input.resumeParked` when needed, including a rejected ticket that settles without reopening a turn. Loops retain responsibility for ordinary input and non-queue approvals; the queue never claims them.

| Queue state | Durable evidence and behavior |
| --- | --- |
| `queued` | `x/agnes/deferred-invocations/state` stores the full immutable invocation before wake. Repeated id/same canonical binding returns the first receipt without consulting the source event again; a new or different binding must cite an admissible source event, and a changed binding refuses. |
| `executing` | State fact precedes `ctx.tools.execute({invocationId: id, name: tool, args})`. Existing tool policy, approval, auto review, deny-list and sandbox remain authoritative. |
| `pending-approval` | `PARKED` saves this state; after the original turn reopens, `ctx.tools.resume(id)` resumes only the original ticket. `E_LANE_BUSY` keeps it parked. |
| `succeeded` | Requires the original durable tool-result sequence; queue facts store references rather than duplicating full output. |
| `failed` | Keeps the safe error and retry eligibility. `effects.status: may-have-sent` never reruns an effect; it becomes unknown/non-retryable. A known tool response is recovered without dispatch. |
| notification | Producer `changed` receives durable state/receipt links. `x/agnes/deferred-invocations/notified` acknowledges it. A crash before acknowledgement repeats the callback, which must be idempotent. A failed callback never reruns a terminal tool. |

Terminal states are immutable; retries are new invocations linked by the producer's business facts. A deferred artifact job is joined using the original `ctx.jobs.join(id)` contract, including its cancellation and durable receipt. This queue is distinct from the existing artifact-job `deferred` continuation.

`DeferredToolInvocationQueue` exposes `enqueue`, `next`, `read`, compare-and-set `transition`, and `notify`. `DeferredInvocationLedgerPort` exposes bounded session-ledger scan/append, original outcome lookup and deduplicated SC1 wake. These are Host adapters, not permission APIs. The implementation preserves single-writer ordering, a maximum of eight unfinished invocations, a 32 KiB invocation envelope, session/lane scope and ledger-backed command identity across restart. Unknown producer or missing effect evidence fails closed. Queue notification retries are independent of display/projection cache retention. Backend business receipts may add tighter limits.

The Host adapter uses the existing session lease and public scan/append/enqueue interfaces. Closing the session releases its queue binding. A pinned session retains its producer generation. No worker timer, second database or Core program-counter mutation is introduced. Producers must make enqueue repairable from their own durable accepted fact and deliver outcomes through the existing queued-input path; they must not treat queue acceptance as successful business execution.

The executable drain and factory decorator are exported by `@agnes/plugin-runtime`. Queue and receipt types live in `@agnes/plugin-runtime/deferred-contract`. The ledger port stays a Host adapter. Loop plugins import the helper from the author runtime namespace and read the queue with `deferredQueueKind`.
