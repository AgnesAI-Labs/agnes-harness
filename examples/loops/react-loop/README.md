# ReAct Agent Loop

This standalone package imports only `@agnes/extension-api`. Install with `agh package add ./examples/loops/react-loop`, trust and enable it, then select `example.react@1.0.0` with `agh -p "your task" --loop example.react@1.0.0`, the SDK or a profile default. Its ordinary `loop:react` plugin row declares `apiRange` and injects `loops`.

The loop owns its state machine: claim input, inspect the turn, prepare and stream a model request, collect text/thinking and complete tool calls, publish an assistant message, batch independent tools, then ask the model again. Core owns request stamps/media, admission, authorization, approval bindings, effect receipts and ledger writes. The package never calls `turn.continuation`, `turn.checkpoint`, `model.respond`, `tools.drain`, `turn.finishCancelled`, `turn.finishFailure` or `wait.poll`.

Optional plugin configuration:

```json
{
  "compactAfterTools": true,
  "waitForWake": false,
  "childTask": "Research a supporting question",
  "childMessage": "Check the conclusion once more"
}
```

Omit child options to run a plain model/tool loop. Compaction runs once after the first tool round of a turn through the installed compaction engine. `waitForWake` waits before inference; enqueue a steer to wake the loop. The child provider comes from Host configuration. Child turns are observed to `idle` or a terminal status and recorded in `x/react/child`; this demonstration treats them as a separate task, not an injected model instruction. `x/react/budget` records the advisory view used by the scheduler; Core still enforces each operation's admission.

Codec version 1 stores the turn identity, model round, tool invocations, buffered response, park intent and ending. Model and tool ids are deterministic within a turn. Checkpoints associate ids before dispatch; a durable response is reused and a `may-have-sent` outcome refuses automatic replay. Assistant publication and its next checkpoint are atomic. A saved park intent handles a crash at Core's park transaction before the driver receives the exception. Multiple approval tickets are resumed one at a time, using their original calls and policy bindings. Loop cancellation follows the supplied signal and does not poison a later turn.

[The Core integration tests](../../../packages/core/test/react-loop.test.ts) fit every coarse scheduling edge with a throwing sentinel. Scripted model tests cover model/tool rounds, overlapping safe tools, approval acceptance/rejection for one or two calls, cold resume at model receipt/assistant commit/tool receipt/park transaction, uncertain-send refusal, wake/steer, cancellation during wait and inference, budget refusal, compaction and a real continuable child.

## Low-level port findings

These are the missing or awkward points encountered while implementing the loop. “Fixed” means this example exercises the new public operation against real Core, rather than emulating Core in the driver.

| Finding | Resolution or remaining limitation |
| --- | --- |
| Compaction required a closed execution step, but only coarse scheduling could close it. | **Fixed:** `turn.endStep()` closes a settled step without scheduling work. Then `compaction.run(signal)` can run at the boundary. |
| `events.emit('assistant/message', ...)` and checkpoint writes were separate transactions; it also did not establish the assistant association in Core's operation. | **Fixed:** `events.assistant(message, checkpoint)` commits both and binds the assistant identity. A crash cannot publish the same response twice. |
| Retrying `tools.execute` with an approved invocation refused its uncertainty fence; minting another call lost the original one-shot grant. | **Fixed:** `tools.resume(invocationId, signal)` executes only the opened original approval continuation, preserves policy/authorization and reuses a durable refusal or response. It never retries an uncertain external send. |
| Approval recovery assumed model and tools shared an execution step. | **Fixed:** Core locates the preceding assistant within the original turn, so independently scheduled tool steps still have their correct source. |
| `may-have-sent` alone could not distinguish a different outstanding approval ticket from an uncertain dispatched effect. | **Fixed:** `tools.resume` reports `E_LANE_BUSY` for a known call awaiting its own approval continuation. The driver retains those ids and parks between single-call continuations. |
| Core closes an approval-parked turn before returning the `PARKED` exception. | **Handled in the driver:** save a park intent before batching; on restart use the turn view to distinguish a still-open batch from a parked continuation. The exception's `code` is documented on the tool ports. |
| Streaming gives deltas and tool-call events, not a committed assistant or a ready next batch. | **Intentional author work:** consume the whole stream, buffer the response, parse complete `toolcall_end` events, then atomically publish. Stopping iteration early leaves uncertainty, not a reusable response. |
| Prepared request objects cannot be serialized and reused after reopening; deriving again can change their fingerprint as history advances. | **Handled:** checkpoint the stable invocation id, query its receipt first and prepare only an unsent request. Omitted messages preserve Core's trust envelopes and media handling; the raw history view is not a wire-message array. |
| The budget view has step/spend/cap facts but no projected request cost, remaining context tokens or public compaction-trigger calculation. | **Remaining:** the example uses an explicit compaction policy and relies on Core admission. An adaptive loop would benefit from a read-only request/context estimate. Tool/model steps are Core execution steps, not driver checkpoint steps. |
| Child creation has no stable invocation id/status or durable handle-adoption operation. | **Remaining:** checkpoint before creation and refuse replay of an interrupted start. Cold child adoption is not proven. This limitation is independent of model/tool effect receipts. |
| A continuable child emits `idle` after its answer; `result()` waits for the child's lifecycle to terminate. | **Handled:** delimit each reply using `events()`, send a follow-up after idle, then dispose. A typed per-turn child result would be simpler. |
| `wait.park` resolves for wake/input/cancellation without a reason; wake is in-memory and not latched or durable. | **Remaining:** check the signal and claim steer after waking. Use durable inbox input for a restart-safe wake. Do not assume a wake sent before waiter registration is retained. |
| Deferred tools return a job id but the available join is `wait.poll`, which runs the default deferred edge. | **Remaining:** this example does not join deferred background tools. A low-level job status/result subscription is still needed to prove that scheduling independently. |

The proof establishes the requested model/tool/approval/recovery/compaction/child paths. It does not establish complete parity with every official default policy, background-job workflow or live model adapter. There are no network calls or new external runtime dependencies in the tests.
