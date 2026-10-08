# DAG Agent Loop

This standalone package uses only `@agnes/extension-api`. Install it with `agh package add ./examples/loops/dag-loop`, trust and enable the package, then configure its `ext:example-dag` plugin row. Select `example.dag@1.0.0` with `agh -p "run the plan" --loop example.dag@1.0.0`, SDK `client.createSession({ cwd, loop: { id: 'example.dag', version: '1.0.0' } })`, or a profile/admin default.

A static plugin config needs no model and emits `x/dag/result`:

```json
{
  "plan": [
    { "id": "a", "tool": "read", "args": { "path": "a.txt" }, "after": [] },
    { "id": "b", "tool": "read", "args": { "path": "b.txt" }, "after": [] },
    { "id": "join", "tool": "combine", "args": { "a": { "$result": "a" }, "b": { "$result": "b" } }, "after": ["a", "b"] }
  ]
}
```

The named tools must be installed and disclosed by the session preset; `combine` is illustrative. Each ready wave goes through `ctx.tools.batch`, so safe tools can overlap while Host still enforces approvals and concurrency policy. Results retain node order. Joins wait for every dependency; `$result` reads a completed direct dependency's content and error status. Plans are bounded to 64 nodes and reject cycles before executing tools.

For model planning, omit `plan`. The first reply must be a JSON plan array; the final model request summarizes all results. Original input content, including images, goes through `ctx.prepareRequest`. Core chooses the effective model, binds the contract, derives hashes and validates media. The planner receives the frozen executor schemas from `ctx.turn.view()`. Planning and summary requests do not invoke model tools; Host executes the resulting DAG through the controlled tool ports.

The plan array may be plain or fenced JSON, followed by explanatory prose. Only the initial array is executed; later prose is ignored, and the final summary is generated after execution. Leading prose, incomplete JSON and multiple plan arrays are refused before any tools run.

The model summary uses `ctx.events.assistant(message, checkpoint)` to atomically publish the conversation message and its completed checkpoint.

Codec version 1 checkpoints input identity, the plan, completed outputs and the current wave. Each tool uses a stable invocation id derived from the input and node. Restart between waves resumes without rerunning completed nodes. During a wave, the loop queries `ctx.effects.status`: durable responses are reused, unsent calls can proceed and `may-have-sent` refuses replay until reconciled. Model planning and summaries also use stable invocation ids; uncertain model sends refuse automatic retry. Responses are receipts, not guarantees that an external effect executed exactly once.
