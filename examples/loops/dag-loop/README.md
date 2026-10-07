# DAG Agent Loop

This standalone package uses only `@agnes/extension-api` and Node's built-in crypto module. Install it with `agh package add ./examples/loops/dag-loop`, trust and enable the package, then configure its `loop:dag` plugin row. Select `example.dag@1.0.0` with `agh -p "run the plan" --loop example.dag@1.0.0`, SDK `client.createSession({ cwd, loop: { id: 'example.dag', version: '1.0.0' } })`, or a profile/admin default.

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

For model planning, omit `plan` and set `target: { "route": "your-route", "model": "your-model" }`. The first reply must be a JSON plan array; the final model request summarizes all results. Original input content, including images, goes to the planning request. This small example does not discover tool schemas: the user/planning prompt must name available tools.

Codec version 1 checkpoints input identity, the plan, completed outputs and the current wave. Restart between waves resumes without rerunning completed nodes. A restart during a wave refuses with an unfinished-tool error; reconcile the ledger receipts before clearing that wave's uncertainty. It never automatically retries tool effects whose result was not checkpointed. A summary can be regenerated if interrupted before its completed checkpoint. Production loops may add receipt reconciliation and prompt/schema discovery through further public ports.
