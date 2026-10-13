# Tool runtime and policies

English | [简体中文](tool-runtime.zh-CN.md)

[Plugin author kit](README.md) · [Loop events](loop-events.md)

`@agnes/extension-api` provides two contracts:

- `ToolRuntimeProvider.create({ maxParallel }): ToolRuntime` creates a session-owned instance with `execute(call, execution, signal)`, `batch(calls, execution, signal)`, `cancel()` and `dispose()`.
- `ToolPolicy.decide(input, signal, ports?)` returns `{ effect: 'allow' | 'ask' | 'deny', reason, review?, approval? }`. Input includes the resolved tool policy, actor, workspace, taint and full-access setting.

Ordinary Cordis plugins inject `providers` and call `providers.register(toolRuntimeKind, provider)` or `providers.register(toolPolicyKind, policy)`. Registration belongs to the calling plugin fiber. Read `providers.catalog()` and filter by `kind`; entries include id, version, sourcePackage, capabilities and selection/lifecycle metadata. Selection is by id; duplicate ids and missing selections fail explicitly. Unloading a selected provider cancels its lifetime and refuses later calls.

```yaml
tools:
  runtime: default
  max_parallel: 4
approval:
  policy: default
```

Omitting these fields preserves current behavior. The default runtime runs adjacent concurrency-safe calls in a bounded pool, drains that pool before an exclusive call, and preserves input order in returned results. The parallel limit accepts 1–64. Cancellation or dispatch failure stops replenishment and drains started calls. Nested calls retain Core's hierarchical scheduling. Instances stay alive until session close so preset switches cannot dispose an in-flight batch.

Core supplies `execution.dispatch` and owns principal authorization, approval decision requests, sandboxing, tool hooks, effect intent/settlement, result validation and recovery. A runtime may wrap a single call's returned result or replace batch scheduling. Its single-call port accepts the authorized arguments exactly once. Implement both `execute` and `batch`, propagate the supplied signal, drain started work in `cancel`, and release resources in `dispose`.

Tool permission requests are durable `decision/state` facts owned by Core. A deferred invocation retains that request's original decision handle ID as its `approvalId`, including after session reopen; it resumes the original call rather than creating another ticket. A missing handler ends delivery while leaving the decision pending. In an isolated author testkit, return a verdict with a synthetic `answeredBy` actor to exercise an authenticated answer.

A policy can attach `approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision }` to an `ask` decision. `subjectRevision` is the SHA-256 of the domain state being reviewed. Core offers only once/reject, skips session/permanent grants, and binds the decision to that revision and the exact call. Execution receives the read-only `ToolContext.approval` fact (`requestId`, `subjectRevision`, `answeredBy`); the domain must atomically compare its current revision before applying the continuation. This fact adds no decision methods to the extension API.

The bundled approval-policy plugin registers the default policy. A preset's `approval.command_policy` table is a safety floor Core applies around whichever tool policy a session selects, including a custom one: a rule that denies a call refuses it, a rule that allows a call lets the selected policy's `ask` proceed unasked (never for an `always` tool, a human-only review, or tainted context), and the selected policy may tighten but never loosen the table's answer. The table in force is the one in the preset the session runs under: a rule written in a non-default preset holds for the sessions that select that preset, and the default preset's rules do not reach sessions running under another. A table that cannot be read refuses the preset with the preset and the rule named: the default preset's at assembly, any other when a session opens under it.

A rule names the tools it covers with a fully anchored `tool` pattern and is matched against the call's identity:

| Tool | Identity a rule's `argv` is matched against |
| --- | --- |
| A tool that declares `ToolMeta.commandArg`: `shell` (`command`), `pty_send` (`text`), `run_code` (`code`), and any plugin tool that declares one | The text of that argument, with runs of whitespace folded to one space |
| `read`, `write`, `edit`, `ls`, `grep`, `find` | The resolved absolute path inside the workspace; a path that cannot be reduced to one identity is refused |
| Every other tool | The canonical JSON of all arguments |

The table matches text; it is not a sandbox. A rule written for `shell` does not cover another tool unless its `tool` pattern names it (`shell|pty_send`). Text sent to a PTY can be split across calls, and a shell or a `run_code` program can build a command at run time, so a deny rule stops the plain spelling of a command and the sandbox preset remains the containment boundary. A plugin tool that runs commands without declaring `commandArg` is matched on its argument JSON. `schedule_create` and `schedule_update` take a prompt, not a command; the turn they start is held to the table like any other. Human approval and durable tool requests use Core decisions. Permanent grants are stored and revoked by the Host, bound to the approver and the tool definition; the approval provider only delivers the question (`ask`). Principal denials remain terminal. A custom policy's `deny` or `ask` remains effective in full-access mode; the policy explicitly chooses how to interpret `input.fullAccess`. Core honors principal approval requirements under the existing host approval mode.

[Read-only policy example](../../examples/policies/read-only/) denies writes and destructive tools, including in full-access sessions. Install and enable its row, then select `tool-policy: { provider: read-only }`. Both contracts apply to the default loop and custom loops through `LoopContext.tools`.

Optional `meta.isPresentational: true` declares that the effect only publishes display state to the user and has no external side effect. It cannot be combined with `isDestructive` or `isOpenWorld`. The default tool policy does not escalate a presentational, non-read-only tool solely because the turn is tainted. `requiresApproval: always` and a destructive approval band still ask. Omitting the flag leaves the tool subject to tainted-write approval. The [tool metadata reference](../../packages/extension-api/docs/tools-meta.md) lists the flag with the other metadata keys.

Tools may declare `meta.paths: [{ arg: 'path', access: 'read' | 'write' }]` on the public `ToolMeta` contract. Each declaration names a top-level string argument; optional `default` supplies an omitted path, and `nonWorkspaceSchemes` delegates named URI schemes to the tool's resource service. Core preflights declared paths against the live workspace filesystem before policy selection in manual, smart, auto-review and off modes. It uses no official tool or argument names. Tools without this metadata retain their existing behavior. These checks do not replace filesystem enforcement during execution; declared resource schemes never widen filesystem access. Metadata is snapshotted and included in the definition fingerprint.

Set `meta.deferLoading: true` to omit a tool's schema from the initial model request. Official `tool_search` searches available deferred plugin tools as well as the MCP index. Queries are scored per term, with an exact tool-name term ranked first (for example, `ui_render render detail card UI`); result limits and explicit Skill discovery slots still apply; `tool_describe` calls the optional `ToolContext.tools.disclose(name): Promise<void>` port to make an available schema visible in later requests. Core records this selection durably and rejects names outside the frozen turn catalog or the active model's capabilities. Selection is separate from permission: normal call validation, policy, approvals and cancellation still apply. Custom Loops can select exact names with `prepareRequest({ tools: [...] })` when their workflow already knows the required tools.

## Model-assisted policies

The official `@agnes/base` policy registers `auto-review` alongside `default`. Select it with `tool-policy: { provider: auto-review }`, or enable its Web policy card when the selected base policy is `default`. Trusted profiles can select `approvals.mode: auto-review`. The settings card does not replace custom, read-only or full-access policies.

`ToolPolicyInput` includes optional `config: AutoReviewConfig`, category (`read`, `write`, `external`), trusted retained human `instructions`, and the pending call's description, parameters and definition fingerprint. Arguments and tool descriptions are data, not authorization. The optional `ToolPolicyPorts` exposes `reserve(limit): boolean | Promise<boolean>` and `model({ slot: 'fast' | 'verifier', prompt }, signal, onUsage?)`. The model operation returns `{ text, model, cost, costSource? }`, discloses no tools, makes no automatic retries, obeys the active request cap, and accounts for usage. The optional usage callback supplies `{ model, cost, costSource }`, including estimates on interrupted streams. Reservations are session-wide durable attempt counts; an interrupted reservation is not refunded. Propagate cancellation and fall back to `ask` when a port is unavailable.

A decision may attach a protocol-owned `ToolReviewFact`: `model`, `promptHash`, `argsHash`, `scopeHash`, `decision` (`allow`, `deny`, `escalate`), `risk`, `reason`, `latencyMs`, `cost`, `costSource`, and `source` (`model`, `human-override`, `fallback`). Its decision must correspond to the returned effect (`escalate` means `ask`). Core persists and reuses the bound decision before effects. Public settings methods `_agnes/v1/autoReview.get` and `.save` consume/return `AutoReviewConfig`; the Node SDK exposes `client.autoReview.get()` and `.save(config)`. Browser administration uses the authority-checked same-origin admin surface.

Consistency checks, eligibility, the maximum automatically allowed risk and explicit future rules belong to the policy plugin. Core supplies model execution, durable reservations and facts; it does not embed the review algorithm. Hard denials and private-state enforcement remain runtime responsibilities and cannot be widened by a review. See [Security](../guide/security.md#approvals) for defaults and operator controls.
