# Loop events

English | [简体中文](loop-events.zh-CN.md)

[Plugin author kit](README.md) · [Tool runtime and policies](tool-runtime.md)

An ordinary plugin injects `loopEvents`. `on(name, handler)` returns a disposer and binds the listener to its plugin fiber. Handlers receive a payload snapshot and `{ session, signal }`; transformers return patches rather than mutate the input.

| Event | Payload / return | Existing hook |
| --- | --- | --- |
| `before_model_request` | Request view, slot, model, attempt; return `{ patch: { samplingParams?, maxTokens?, metadata? } }` | `before_request` |
| `after_model_response` | Assistant text/thinking content and stop reason; observe only | — |
| `before_tool_call` | Call, actor, metadata and resolved policy; return `{ allow: true }` or `{ allow: false, reason }` | `tool_call` |
| `after_tool_result` | Call, result and enforcement; return `{ result? }` | `tool_result` |
| `turn_end` | Turn number and committed ending reason; observe only | — |

```ts
import type { LoopEventsPluginContext } from '@agnes/extension-api'
export const plugin = {
  inject: ['loopEvents'],
  apply(ctx: LoopEventsPluginContext) {
    ctx.loopEvents.on('before_model_request', () => ({ patch: { maxTokens: 1024 } }))
    ctx.loopEvents.on('turn_end', ({ reason }) => { console.log(reason) })
  },
}
```

Aliases run the existing hook pipeline once and then event listeners in registration order. Later transformers see the previous transformed request view or result. A tool denial is terminal. Before-request and before-tool failures stop execution; result and observer failures retain the preceding value. Each listener has a two-second bound and receives cancellation.

The default loop emits response events after a successful stream and before assistant persistence, and ending events after the ledger commits `turn/end`. These are runtime callbacks rather than additional ledger rows. Usage, cancellation, park and recovery facts remain on the session ledger.

Custom loops receive the same handling automatically through `LoopContext.model`, `tools` and `events.finish()`. The runtime also supplies `events.dispatch(name, payload, signal)` for explicit boundaries. Avoid manually dispatching an event around an operation that already emits it. The field is optional in the type for compatibility with older test ports. Custom wire requests support protocol sampling fields and `maxTokens`; unsupported sampling or metadata patches fail explicitly.

## Human controls

A `LoopFactory` may declare `controls: { steer: true, interrupt: true, pause: true }`. Omitted controls are refused by Core with `E_UNSUPPORTED` and `detail.reason = "LOOP_CONTROL_UNSUPPORTED"`. Core uses the session’s pinned factory, including during generation publication. Cancellation remains part of the driver lifecycle.

Claim steer inputs with `ctx.input.claim("next-step")` between completed scheduling edges. Never claim while a tool batch is active. Pause blocks the next edge and retains the same turn and checkpoint across reload and cold recovery. Interrupt cooperatively cancels the active execution, drains available receipts and accepts the selected queued input next. Committed effects remain recorded; missing receipts remain uncertain. Queuing, delivery, editing, withdrawal and control outcomes are Core ledger facts with actor and timestamp. `controls()` without `afterSeq` returns the latest window of at most 200 facts and sets `factsMore` when that window is full. Use `afterSeq`, starting at 0, to read history.
