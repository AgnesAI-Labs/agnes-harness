# Tool runtime and policies

English | [简体中文](tool-runtime.zh-CN.md)

[Plugin author kit](README.md) · [Loop events](loop-events.md)

`@agnes/extension-api` provides two contracts:

- `ToolRuntimeProvider.create({ maxParallel }): ToolRuntime` creates a session-owned instance with `execute(call, execution, signal)`, `batch(calls, execution, signal)`, `cancel()` and `dispose()`.
- `ToolPolicy.decide(input, signal)` returns `{ effect: 'allow' | 'ask' | 'deny', reason }`. Input includes the resolved tool policy, actor, workspace, taint and full-access setting.

Ordinary Cordis plugins inject `toolRuntimes` or `toolPolicies` and call `register(sourcePackage, provider)`. Public `registerToolRuntimePlugin` and `registerToolPolicyPlugin` helpers bind registration to the plugin lifecycle. Both services expose read-only `catalog()` entries of `{ id, version, sourcePackage }`. Selection is by id; duplicate ids and missing selections fail explicitly. Unloading a selected provider cancels its lifetime and refuses later calls.

```yaml
tools:
  runtime: default
  max_parallel: 4
approval:
  policy: default
```

Omitting these fields preserves current behavior. The default runtime runs adjacent concurrency-safe calls in a bounded pool, drains that pool before an exclusive call, and preserves input order in returned results. The parallel limit accepts 1–64. Cancellation or dispatch failure stops replenishment and drains started calls. Nested calls retain Core's hierarchical scheduling. Instances stay alive until session close so preset switches cannot dispose an in-flight batch.

Core supplies `execution.dispatch` and owns principal authorization, approval prompts/tickets, sandboxing, tool hooks, effect intent/settlement, result validation and recovery. A runtime may wrap a single call's returned result or replace batch scheduling. Its single-call port accepts the authorized arguments exactly once. Implement both `execute` and `batch`, propagate the supplied signal, drain started work in `cancel`, and release resources in `dispose`.

The bundled approval-policy plugin registers the default policy. Command rules, human approval and durable tickets continue through its approval seam. Principal denials remain terminal. A custom policy's `deny` or `ask` remains effective in full-access mode; the policy explicitly chooses how to interpret `input.fullAccess`. Core honors principal approval requirements under the existing host approval mode.

[Read-only policy example](../../examples/policies/read-only/) denies writes and destructive tools, including in full-access sessions. Install and enable its row, then select `approval.policy: read-only`. Both contracts apply to the default loop and custom loops through `LoopContext.tools`.
