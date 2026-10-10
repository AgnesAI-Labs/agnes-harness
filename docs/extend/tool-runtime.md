# Tool runtime and policies

English | [简体中文](tool-runtime.zh-CN.md)

[Plugin author kit](README.md) · [Loop events](loop-events.md)

`@agnes/extension-api` provides two contracts:

- `ToolRuntimeProvider.create({ maxParallel }): ToolRuntime` creates a session-owned instance with `execute(call, execution, signal)`, `batch(calls, execution, signal)`, `cancel()` and `dispose()`.
- `ToolPolicy.decide(input, signal, ports?)` returns `{ effect: 'allow' | 'ask' | 'deny', reason, review? }`. Input includes the resolved tool policy, actor, workspace, taint and full-access setting.

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

Optional `meta.isPresentational: true` declares that the effect only publishes display state to the user and has no external side effect. It cannot be combined with `isDestructive` or `isOpenWorld`. The default tool policy does not escalate a presentational, non-read-only tool solely because the turn is tainted. `requiresApproval: always` and a destructive approval band still ask. Omitting the flag leaves the tool subject to tainted-write approval. The [tool metadata reference](../../packages/extension-api/docs/tools-meta.md) lists the flag with the other metadata keys.

Tools may declare `meta.paths: [{ arg: 'path', access: 'read' | 'write' }]` on the public `ToolMeta` contract. Each declaration names a top-level string argument; optional `default` supplies an omitted path, and `nonWorkspaceSchemes` delegates named URI schemes to the tool's resource service. Core preflights declared paths against the live workspace filesystem before policy selection in manual, smart, auto-review and off modes. It uses no official tool or argument names. Tools without this metadata retain their existing behavior. These checks do not replace filesystem enforcement during execution; declared resource schemes never widen filesystem access. Metadata is snapshotted and included in the definition fingerprint.

Set `meta.deferLoading: true` to omit a tool's schema from the initial model request. Official `tool_search` searches available deferred plugin tools as well as the MCP index; `tool_describe` calls the optional `ToolContext.tools.disclose(name): Promise<void>` port to make an available schema visible in later requests. Core records this selection durably and rejects names outside the frozen turn catalog or the active model's capabilities. Selection is separate from permission: normal call validation, policy, approvals and cancellation still apply. Custom Loops can select exact names with `prepareRequest({ tools: [...] })` when their workflow already knows the required tools.

## Model-assisted policies

The official `@agnes/base` policy registers `auto-review` alongside `default`. Select it with `approval.policy: auto-review`, or enable its Web policy card when the selected base policy is `default`. Trusted profiles can select `approvals.mode: auto-review`. The settings card does not replace custom, read-only or full-access policies.

`ToolPolicyInput` includes optional `config: AutoReviewConfig`, category (`read`, `write`, `external`), trusted retained human `instructions`, and the pending call's description, parameters and definition fingerprint. Arguments and tool descriptions are data, not authorization. The optional `ToolPolicyPorts` exposes `reserve(limit): boolean | Promise<boolean>` and `model({ slot: 'fast' | 'verifier', prompt }, signal, onUsage?)`. The model operation returns `{ text, model, cost, costSource? }`, discloses no tools, makes no automatic retries, obeys the active request cap, and accounts for usage. The optional usage callback supplies `{ model, cost, costSource }`, including estimates on interrupted streams. Reservations are session-wide durable attempt counts; an interrupted reservation is not refunded. Propagate cancellation and fall back to `ask` when a port is unavailable.

A decision may attach a protocol-owned `ToolReviewFact`: `model`, `promptHash`, `argsHash`, `scopeHash`, `decision` (`allow`, `deny`, `escalate`), `risk`, `reason`, `latencyMs`, `cost`, `costSource`, and `source` (`model`, `human-override`, `fallback`). Its decision must correspond to the returned effect (`escalate` means `ask`). Core persists and reuses the bound decision before effects. Public settings methods `_agnes/v1/autoReview.get` and `.save` consume/return `AutoReviewConfig`; the Node SDK exposes `client.autoReview.get()` and `.save(config)`. Browser administration uses the authority-checked same-origin admin surface.

Consistency checks, eligibility, the maximum automatically allowed risk and explicit future rules belong to the policy plugin. Core supplies model execution, durable reservations and facts; it does not embed the review algorithm. Hard denials and private-state enforcement remain runtime responsibilities and cannot be widened by a review. See [Security](../guide/security.md#approvals) for defaults and operator controls.
