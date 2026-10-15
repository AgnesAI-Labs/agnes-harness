# Plugin development: bring your capabilities into AGH

English | [简体中文](plugins.zh-CN.md)

<a id="插件开发把你的能力接入-agh"></a>

[Documentation](../README.md) · [Backend tool tutorial](backend.md)

Plugins are fully trusted code running with the user's rights. Capability declarations are reviewed at admission; they do not restrict arbitrary JavaScript or enforce a hook allowlist. `ctx.hooks.register` accepts the supported observe, transform and intercept hooks regardless of the declared `hooks` list. Use only code you intend to authorize.

Turn a business function into an agent tool, capture a task method as a Skill, or add your own workbench interface. AGH provides extension entry points and a package lifecycle so you can grow from one plugin into an application. Choose an entry point below, then learn how dependencies and execution fit together.

<a id="在会话中创建第一个插件"></a>

## Create your first plugin in a session

The default-enabled `@agnes/plugin-helper` can turn a request into an AGH tool, Skill, or skin plugin. For example:

> Create an AGH plugin that counts words in text, and install it in the current AGH instance.

The helper reads version-matched templates, saves a private candidate, runs explicitly approved author tests and submits the tested tree for human review. Inspect files, test results and permissions under Settings → Plugins → Candidates. Approval publishes that exact reviewed tree through normal package governance. New sessions gain plugin code; existing sessions keep their code version. Approved Skills refresh as live resources. See [candidate review](../extend/agent-built-plugins.md) for tools, hashes, update conflicts and refusal paths.

Creating a candidate does not install, trust or enable it. Author tests execute trusted JavaScript, not isolated hostile code. The helper supports bounded self-contained text ESM tool/Skill packages and CSS/token skins; dependencies and richer interfaces follow the author workflow below. Disabling the helper does not remove published packages.

For CSS and token customization, see [skin development](skins.md).

<a id="选择扩展方式"></a>

## Choose an extension path

| What you want to add | Starting point | What to verify |
| --- | --- | --- |
| An agent-callable capability | [Backend tool plugin](backend.md) | Arguments, tool record, and structured result |
| Task methods and background knowledge | [Workspace Skill](../guide/skills.md) | Source, trust, and use in a session |
| An existing external tool service | [MCP integration](../guide/mcp.md) | Connection, catalog, and authorized tool calls |
| A workbench interface | [Frontend panel](frontend.md) | Mounting, version updates, and restoration after unload |
| An interface that reads business results | [Full-stack integration](fullstack.md) | Constrained service queries in the current session |

Choose the path closest to your need. [Plugin management](../guide/packages.md) covers the shared installation and trust flow, so each interface does not need its own backend infrastructure.

See [MHS and devices](../guide/mhs.md) for the physical-device direction; a simulated inspection bundle is available; hardware validation remains future work. The table covers existing software extension entry points.

<a id="cordis-在其中做什么"></a>

## Cordis's role

AGH uses its in-repository `@agnes/cordis` Context, service dependencies, and fiber lifecycle to organize replaceable components. Host adds installation, trust, snapshot, and capability constraints. Upstream Cordis/DeepSeek documentation may explain framework concepts, but cannot substitute for AGH's loading declarations or interfaces.

<a id="一个插件包的形状"></a>

## Shape of a plugin package

The current ordinary plugin entry is `agnes.plugins` in `package.json`, referencing a named export from the package module:

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./index.mjs",
  "agnes": {
    "plugins": [
      { "apiRange": "^4.0.0", "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
    ]
  }
}
```

This is the example's own identity, not a package address available from npm. Its `index.mjs`:

```js
export const example = {
  inject: ['skills'],
  apply(ctx) {
    ctx.skills.register({
      name: 'review-notes',
      description: 'Review documentation without modifying files',
      body: 'List contradictions with file references. Do not modify content.',
    })
  },
}
```

Declare what the plugin injects once, in its `agnes.plugins` entry: `inject` lists every service name and `optionalInject` marks the ones it can run without. The backend loader needs the dependency graph before executing arbitrary modules, and the export carries no list of its own (a repeated one must agree). `provide` must match the export. Include every required build artifact. A local TypeScript deep path or an unpackaged dependency does not form a portable immutable snapshot.

<a id="配置依赖与清理"></a>

## Configuration, dependencies, and cleanup

`defineAgnesPlugin()` preserves types; it grants no additional permissions. A plugin can declare Standard Schema `Config`, which the loader validates. [cordis-greeting](../../examples/packages/cordis-greeting/index.ts) demonstrates configuration validation, `provide`, and service values. [hot-service](../../examples/packages/hot-service/v1/index.mjs) demonstrates installable ESM without external imports.

A value published by `ctx.provide('name', value)` belongs to the current Context's service space, and consumers declare `inject`. Dependencies determine loading order; array order does not replace the graph. Register manually acquired timers, connections, and listeners with `ctx.effect(() => disposer)`. Disposers withdraw resources on unload; they cannot automatically reverse completed external business actions.

## Model adapter packages

An ordinary trusted plugin can inject `providers` and call `ctx.providers.register(modelAdapterKind, adapter)`. Declare the same injection in `agnes.plugins`. The [public ModelAdapter contract](../../packages/extension-api/src/model-adapter.ts) wraps the existing WireAdapter shape: id, version, `wireApi` wire format, capabilities (including image input), and `create({ routes })` returning a wire instance. The [fixture package](../../packages/host/test/fixtures/model-adapter/index.ts) shows registration without depending on Host or Core.

Set `providers.model-adapter.provider` in the profile to the registration id or its enabled source package, and set the route's `api` to that registration id. Route `compat` carries adapter-specific configuration. Existing `@agnes/ai` selections and pi API names keep working, including API-key and managed subscription OAuth routes.

The instance streams wire events; the existing AI facade continues to own stamps, tool-call recovery and usage accounting. Credentialed structural instances implement `bindCredential`; Host resolves secrets before inference. `dispose()` releases instance resources, and optional registration `cleanup()` releases shared resources. Both run when the owning plugin unloads. Duplicate ids and unavailable selections are refused.

Admin integrations can call Host's `modelAdapterCatalog(root)` or the assembled `modelAdapterCatalog()` to read id, version, source package, API name and capabilities. The catalog exposes no configuration, credentials or executable factories. Adapter implementations stay pinned to each session’s code generation. Model routes, catalogs and credential configuration update across retained containers; in-flight requests retain their admitted settings. See [pinned code, live resources](architecture-plugins.md#pinned-code-live-resources).

## Persistence providers

A full Host provider implements ledger, metadata, child control, reclaim and integrity; SQL is optional. The built-in `sqlite` and [JSONL example](../../examples/persistence/) supply these ports. Select `providers.persistence: { provider: jsonl }` in the user profile after installing its package. Missing required capabilities refuse startup; there is no fallback to SQLite for child control. Selection requires restart and does not migrate files. Use the [persistence author guide](../extend/persistence.md) for contracts, conformance and supported export/import migration.

## Child agent providers

A provider starts a child and returns a handle with events, `sendMessage`, `interrupt`, and `result`. The kind is `child-agent`, defined with `defineKind`. Register it through `ctx.providers.register(childAgentKind, provider)`. The built-in id is `in-process`. `acp` runs an external ACP process and is not loaded by default. Capabilities that are false are refused at start. The author guide is [Child agent providers](../extend/child-agents.md).

The preset schema has no child allowlist. Set `allow` and `sessions` on the subagent extension, or call `childAgents.setSessionAllowlist`. An omitted list is unrestricted. An empty list refuses that kind. A set model list requires the caller to name the model.

Optional `ToolContext.subagent` controls (`list`, `models`, `sendMessage`, `interrupt`) are exposed only when the extension declares `subagent: true` and the Host provides them. Without that capability, `job_list` skips child syncing and still lists shell jobs; other subagent calls remain capability-gated.

When fitted, `LoopContext.children` is the parent-bound `ChildAgentSessionService` facade; it uses the configured provider and exposes continuable child handles.

<a id="不同-api-不可混用"></a>

## Keep API boundaries distinct

| Interface | Capabilities | Boundary |
| --- | --- | --- |
| Ordinary Cordis Context | Plugins, services, events, and effect lifecycle | In-process services do not automatically become cross-process RPC |
| `ctx.tools` | `register(tool)`, owned by the calling plugin lifecycle | Uses the same validation and permission boundary as official tools |
| `ctx.hooks`, `ctx.eventLog`, `ctx.self` | `hooks.register(event, handler)` for all 16 hook events, ledger events in the plugin's own namespace, and the plugin's identity/logger/signal | Observe-only events ignore handler results; runtime permissions and ordering still apply |
| `ctx.skills` | Runtime Skill contributions and providers | Cannot read/enumerate other Skills; separate from disk governance |
| `ctx.services` / `ctx.slots` / `ctx.projections` / `ctx.resources` | Corresponding contributions, cleaned up with the plugin | Not unconditional global objects; service calls still require identity, session, and client allow-list checks |
| Browser ClientContext | Declared slots, frontend services/commands, and constrained backend service relay | No Host Context, Node system capabilities, or daemon management credentials |

The [full-stack tutorial](fullstack.md) uses `ctx.services.register()` and `agnes.clientDescriptors` on the same trusted Cordis row. It does not turn `ctx.provide()` into a remote method.

Official and third-party packages share one plugin form: `defineAgnesPlugin({ inject, apply })`, with the facets listed above injected by name. Bundled packages are mounted by the Host over its backend API and installed packages as Cordis rows, but `apply` is the same code. Check current source, package preview, and actual row state for registration and authorization.

<a id="前后端生命周期"></a>

## Frontend and backend lifecycles

Host's ordinary tree and the Web page create separate Contexts. `web:` is a platform-synthesized client-row namespace; package authors must not declare it in `agnes.plugins`. These rows remain in the complete runtime target but do not execute as ordinary Host rows.

Third-party runtime sources require trusted immutable snapshots. An arbitrary file path is not an installed, trusted row. Host manages constrained live-tree transactions, while Web reconciles roster revisions. Unsupported static-component replacement, orphaned dependencies, expired leases, and unauthorized operations must be refused.

Next: [Backend tools](backend.md) · [Frontend panels](frontend.md) · [Full-stack integration](fullstack.md) · [Installation and updates](../guide/packages.md).

Source: [author types](../../packages/plugin-runtime/src/author.ts), [manifest parsing](../../packages/package-manager/src/plugin-manifest.ts), [plugin context facets](../../packages/extension-api/src/plugin-context.ts), [row API](../../packages/host-extensions/src/ext-host/row-extension-api.ts), [ClientContext](../../packages/web-client/src/client-module.ts).

## Writing an Agent Loop

For a fixed business workflow, start with [`defineWorkflowLoop`](../extend/workflow-loops.md) and the [Loop template](../../templates/loop/). It owns staged checkpoints, confirmation and approval continuation. The lower-level factory contract below is for custom scheduling.

An Agent Loop owns scheduling and checkpoint state. Export a `LoopFactory` with `id`, `version`, `capabilities`, a versioned `codec`, `create(ctx)` and `resume(ctx, checkpoint)`. Its driver implements `step(signal)`, `cancel()`, `dispose()` and `checkpoint()`. Register it during plugin apply with `ctx.providers.register(loopKind, factory)` from `@agnes/extension-api`; declare the exported plugin in `agnes.plugins` with `inject: ["providers"]`. Registrations belong to the plugin fiber and disappear on unload. `kernel.loops.catalog()` exposes installed identities, capabilities and verified source packages.

Every step returns an explicit `outcome: 'running' | 'idle' | 'turn-ended' | 'parked'`; `phase` is optional display text. `until: 'turn-end'` stops at the first ended turn. `until: 'idle'` continues after completed turns, stopping when input is exhausted or a turn parks or ends for another reason. The production runner and `driveLoop` testkit use the same rule. End a turn with `ctx.events.finish(reason)` and return the outcome it gives back. Core closes the turn, not the driver: `finish('completed')` first passes the stop gate that every loop shares (`turn_stopping` hooks, the verifier and the repair decision). When the gate keeps the turn open it returns `running` and records the reason in history; take another step (usually a model round) before asking again. Asking again without a step ends the turn as `blocked` with `STOP_GATE_HELD`, which is the honest ending for a loop that has no further step to offer. When the gate has to ask a person it returns `parked`: the loop's part of that turn is over, and Core completes the turn on approval or ends it as `blocked` otherwise, without running the driver's work again. The step a model or tool port opens is an admission edge as well: step and credit budgets and `before_step` hooks decide there, and a refusal ends the turn in Core and throws `E_BUDGET` with `detail.reason`.

Call `ctx.input.claim('next-turn')` to open or rehydrate a turn; repeated claims return the current input until the turn ends. `claim('next-step')` consumes a steer for that turn. Each input carries stable `id`, `turnId`, `kind`, `trust`, `actor` and content. `ctx.turn.view()` returns a detached, deeply frozen view of the visible post-compaction history, the turn's tool catalog and JSON schemas, effective model and capabilities, system/runtime prompt context and budget. Execution still checks policy and approvals.

Prepare model requests with `await ctx.prepareRequest({ system, messages, tools, sampling, invocationId })`, then pass the returned token to `ctx.model.stream(request, signal)` or `complete(request, signal)`. Omitted messages use visible history; `tools` selects exact names from the frozen catalog. Core resolves the route and contract, derives hashes, validates media and binds the token to this turn. Authors never supply `contractId`, `derivedHash` or `route`. Every loop goes through Core admission for maximum steps, request caps and quote/deny disposition. Batch results retain input order; policy decides which calls can overlap.

Assign stable `invocationId` values to model preparations and tool calls. `ctx.effects.status(id)` returns `not-sent`, `may-have-sent` or `responded`, with a durable result for a response. Save state with `ctx.checkpoints.write(driver.checkpoint(), { invocationIds })` to associate a checkpoint with effects. A durable response can be reused after reopen; an uncertain invocation refuses automatic replay. A responded receipt does not imply tool success or exactly-once execution outside the process.

A loop can also send a one-off request to another model without touching the conversation; see [Side model calls from a loop](#side-model-calls-from-a-loop).

`LoopContext` is the union of two documented surfaces. `GenericLoopPorts` carries everything a replaceable loop needs (model, tools, decisions, effect receipts, inputs, events, checkpoints, wait/wake, jobs, children, compaction); type a factory as `GenericLoopFactory` to prove it needs nothing else. `DefaultLoopConvenience` (`turn.continuation`/`checkpoint`/`finishCancelled`/`finishFailure`, `model.respond`, `tools.drain`, `wait.poll`) is the coarse edge set tied to Core's ReAct stages; only the default loop should depend on it.

The controlled `turn.checkpoint`, `model.respond`, `tools.drain` and deferred-wait convenience ports, with compaction, preserve Core's ledger and recovery invariants. A scheduler can select these edges through `ctx.turn.continuation()` without accessing a private program counter; Core may add continuation stages additively, so a loop must treat an unknown `LoopContinuation` value as an error rather than rely on an exhaustive switch. `@agnes/loop-default` does this using only the public context; the Base distribution registers it as an ordinary plugin row. Its `checkpointMode: 'ledger'` uses Core continuation recovery and accepts historical sessions without driver checkpoints. Stateful drivers use the default `'driver'` mode and reject unsupported codec versions before resumed work. Host fits `ctx.children` with a parent-bound `ChildAgentSessionService` supporting start/list/message/interrupt/result/events/dispose. An omitted providerId uses the child-agent configuration; every start checks the current allowlist and inherits the parent workspace, pinned code generation, budget and tool filter. Child options can only narrow those constraints. Session close cancels and joins running or starting children before closing the log.

There are two scheduling styles:

| Style | Operations and ownership |
| --- | --- |
| Coarse edges | The official default selects `turn.checkpoint`, `model.respond`, `tools.drain`, compaction and deferred-wait edges from `turn.continuation()`. Core performs the existing model/tool/gate policy and ledger recovery. |
| Low-level ports | A third-party loop owns its state machine, reply parsing and scheduling through input claims, turn views, `prepareRequest` + `model.stream`, `tools.batch`, effect receipts, compaction, children and wait/wake. Core still owns admission, approval bindings and effects. [The standalone ReAct loop](../../examples/loops/react-loop/README.md) demonstrates this style without any coarse scheduling edge. |

For a low-level driver, commit each parsed assistant response with `ctx.events.assistant(message, nextCheckpoint)`: the assistant and checkpoint share a transaction and Core establishes its tool-call association. Save stable tool ids and a park intent before dispatch. Tool ports throw an error with `code: 'PARKED'` after draining siblings and closing an approval-parked turn; return a parked outcome. On resume, `input.resumeParked()` opens the original approval continuation and `tools.resume(invocationId, signal)` executes that call with its existing grant. `E_LANE_BUSY` means another request still owns a later continuation; retain those ids, finish the current continuation as parked and wait for its decision. Other uncertain sends refuse replay. Before compaction, await effects and call `turn.endStep()` to close the step. These operations perform ledger transitions without choosing the next scheduler action.

For continuable children, read events through `idle` to delimit a reply; `result()` waits for lifecycle termination. After `wait.park`, check cancellation and claim any steer. For recovery and interface limits—including child-start receipts, context estimates, wake durability and deferred-job joins—see the ReAct example's [low-level port findings](../../examples/loops/react-loop/README.md#low-level-port-findings).

Honor abort signals and make disposal idempotent. Session close stops admission, cancels and drains active driver/tool work, allows final writes, then shuts down hooks, the log and workspace lease. Releasing an inactive ledger continuation preserves it for later resume.

Choose a loop for a new session with the profile's `providers.loop: { provider: example.dag, version: 1.0.0 }`, the admin defaults API, SDK `client.createSession({ cwd, loop })` (also `client.session.new({ cwd, loop })`), or `agh -p "prompt" --loop example.dag@1.0.0`. Explicit selection wins over the persisted admin default, which wins over the resolved profile and `agnes.default@1.0.0`. Session start pins the identity; changes to defaults affect new sessions. Legacy sessions map to the default identity. Missing selected or persisted loops fail before session start; resume never substitutes another loop.

[The plan-execute example](../../examples/loops/plan-execute-loop/README.md) is a non-ReAct state machine typed as `GenericLoopFactory`: it plans, asks a person through `DecisionPort`, executes steps, absorbs a structured child-completed `system` input and finishes honestly on rejection, cancellation or an unknown outcome. Its test is the conformance reference for the generic surface.

See [the standalone DAG example](../../examples/loops/dag-loop/README.md) for model planning, parallel tool waves, joins and guarded checkpoint recovery. It imports no Core or Host scheduling internals.

`await ctx.plugin(...)` (and prepared awaitable fibers) rejects with `DEPENDENCY_UNAVAILABLE` if required services are still missing, including dependency cycles. The fiber remains pending and can activate when services arrive. `Fiber.await()` waits for current lifecycle work to settle and may return a pending fiber; inspect its state before treating it as loaded. Detached async event failures are logged with the listener owner; awaited dispatch failures still propagate.

## Side model calls from a loop

`ctx.sideCall` sends one request to a route and model that you name, outside the conversation. The request carries no main system prompt, no history, no tools and no untrusted envelope, and the answer is not added to the context. Use it when a loop consults another model between steps: a decision model, a classifier, a second opinion. The member is optional in the `LoopContext` type so that a test double can leave it out; Core always provides it.

A call has two steps. `prepare` validates the options and returns a frozen `PreparedSideCall` that carries an estimate, so a loop can check the price before it spends anything. `invoke` sends the call. `status` reads a recorded call back.

```ts
const sideCall = ctx.sideCall
if (!sideCall) return fallback()
const prepared = await sideCall.prepare({
  label: 'jev.decide',
  target: { route: 'jev', model: modelId },
  payload: { state, questions },
  output: 'json',
  deadlineMs: 10_000,
  invocationId: `decide-${turnId}-${attempt}`,
})
if ((prepared.estimate.projectedCredits ?? 0) > creditLimit) return fallback()
const result = await sideCall.invoke(prepared, signal)
if (result.status === 'ok') return useAnswers(result.json)
if (result.status === 'failed' && result.retryable) return retryWithNewId()
return fallback()
```

`state`, `questions`, `modelId`, `turnId`, `attempt`, `creditLimit`, `signal`, `fallback`, `useAnswers` and `retryWithNewId` stand for the loop's own values and helpers. An option outside its range is refused at `prepare` and never truncated.

| Option | Meaning |
| --- | --- |
| `label` | Your purpose tag, recorded with the call, for example `jev.decide`. Matches `/^[a-z][a-z0-9._-]{0,63}$/`. |
| `target` | `{ route, model }`, both in the assembled model catalog. A slot name is not accepted. |
| `deadlineMs` | Deadline for the whole call, raced by Core. 100 to 120000 milliseconds, default 10000. |
| `system`, `messages`, `sampling` | Sent as written. `system` is at most 1 MiB. Only `user` and `assistant` messages are allowed; an assistant message carries no `toolCalls` and a `tool_result` block is refused. An image needs a target model record whose `input` list includes `image`. |
| `payload` | Structured JSON handed to the adapter unchanged as `RequestBody.payload`. At most 1 MiB of canonical JSON. |
| `output` | `'json'` makes Core parse the returned text into `result.json`. Default `'text'`. |
| `invocationId` | Stable id; the effect id is `side:<invocationId>`. Matches `/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,122}$/` and must not look like a credential. Core generates one when it is omitted. |

### Target and adapter capabilities

The adapter behind the target route declares what a request may carry in its `capabilities` when it registers (see [Model adapter packages](#model-adapter-packages)):

| Flag | Meaning for a side call |
| --- | --- |
| `imageInput` | The adapter reads image blocks. `prepare` checks the target model record, not this flag: a side call with an image block needs a model record whose `input` list includes `image`; otherwise `prepare` throws `E_ENVELOPE` with `detail.reason` `image-input`. |
| `tools` | The adapter handles tool calls. A side call never sends tools. |
| `streaming` | The adapter streams events as they arrive. A side call works with streaming and non-streaming adapters alike and returns once, when the answer is complete. |
| `payload` | The adapter reads `RequestBody.payload`. Without it the AI facade refuses a request that carries a payload before sending anything: the result is `failed` with `reason: 'adapter-error'`, `code: 'CONTRACT_MISMATCH'` and `dispatch: 'not-sent'`. |
| `payloadOnly` | The adapter accepts only a payload and no messages. Requires `payload: true`. The conversation model pickers leave the models of such an adapter out, so only a side call reaches them. |

The built-in Jev adapter, registered as `typesafe-systemone`, declares `imageInput: false`, `tools: false`, `streaming: false`, `payload: true` and `payloadOnly: true`. Set a route's `api` to `typesafe-systemone`, name that route and one of its models in `target`, and send `payload: { state, questions }` with no `system` and no `messages`. The adapter sends one HTTP request per call and returns the answers as JSON text, so ask for `output: 'json'` to receive them in `result.json`. The route's `baseUrl` and credential come from your profile, not from the loop.

### Results and errors

`invoke` returns a result. Whatever the vendor, the clock or the caller can do to a call comes back as a status; `invoke` throws only for misuse, and then nothing was written.

| `status` | Meaning |
| --- | --- |
| `ok` | `text`, the parsed `json` when `output` is `'json'`, `usage`, `latencyMs` and the vendor's `response` id and model. |
| `failed` | `reason` is `deadline`, `cancelled`, `adapter-error` or `invalid-output`. `code` is the AI error code when there is one. `retryAfterMs` is present on an `adapter-error` when the vendor asked for a wait, for example a rate limit's `retry-after`: wait that many milliseconds before you retry with a new `invocationId`. `dispatch` is `not-sent` or `may-have-sent`. `usage` is present when the call settled through its normal terminal: the observed usage, or an estimate (`creditSource: 'estimated'`) when none was observed and the catalog has a price. A call closed because the loop's execution scope was revoked reports none, although its cost row is written. |
| `refused` | `reason` is `budget` or `usage-unrecorded`. Nothing was written: no intent row, no cost row, no adapter call. |
| `unknown` | `reason` is `interrupted`: the process stopped before the outcome was recorded, and the call may or may not have reached the vendor. It is never sent again. |

`retryable` on a `failed` result is true for `deadline`, false for `cancelled` and `invalid-output`, and follows the adapter's own flag for `adapter-error`.

Errors are thrown before anything is written, so a throw means nothing was recorded:

- `prepare` throws `E_ENVELOPE` (`detail.reason`: `label`, `deadline`, `payload-size`, `messages`, `image-input` or `invocation-id`) for an out-of-range option, and `E_MODEL_UNKNOWN` (`target-unknown`) when the target is not in the provider's catalog. Further `E_ENVELOPE` reasons: `output` (neither `'text'` nor `'json'`), `system` (not a string of at most 1 MiB) and `sampling` (a key or value outside the request schema's ranges).
- `invoke` throws `E_ENVELOPE` (`signal`) when its signal is not an `AbortSignal`.
- `prepare` and `invoke` throw `E_RELATION` (`no-turn`) outside an open turn, and `invoke` throws `E_RELATION` (`turn-closing`) once the turn has begun to end.
- `invoke` throws `E_REQUEST_FROZEN` for a call prepared by another context or turn (`foreign`, `turn`) or when the catalog record or adapter identity changed after `prepare` (`target-changed`); `E_RELATION` when the `invocationId` already has a record with a different `requestHash` (`invocation-reused`) or is running in this process (`invocation-in-flight`); and `E_LANE_BUSY` (`CONTROL_PAUSED`) while the session is paused. After `E_LANE_BUSY` the prepared call is not consumed and can be invoked again.
- Every method throws `E_CLOSED` once the session is closing or the loop's execution scope was revoked.
- `ctx.events.finish` throws `E_RELATION` (`side-call-in-flight`) while a call is still unsettled. Calls may run concurrently within a turn; await them before you finish the turn.

### Invocation ids, the deadline and retries

The invocation id makes a call idempotent. Calling `invoke` again with the same id and the same request returns the recorded result with `replayed: true` and sends nothing. The same id with a different request throws `invocation-reused`. Keep ids stable across a resume, and check `ctx.sideCall.status(id)` (`absent`, `in-flight` or `finished`) before you decide to call again. A call that was in flight when the process stopped reads as `unknown` with reason `interrupted` and is not sent again.

`deadlineMs` bounds the whole call. Core times it, so an adapter that ignores cancellation is still cut off when the deadline passes: the result is `failed` with reason `deadline` and code `TIMEOUT`.

Neither Core nor the adapter retries a side call. The loop owns that decision: call again with a new `invocationId` (the old id keeps returning its recorded failure), do it only for a `retryable` failure, keep the number of attempts small and fall back to the loop's own behaviour when the step has no time left.

### What the platform handles

Every call that was sent leaves one cost row with purpose `side-call` that counts toward credit limits and budgets. It records the observed usage or, when the spend was not seen (a deadline, a cancellation, an adapter error without usage), an estimate priced from `prepare`. The ledger keeps digests and audit metadata such as the label, route, adapter and endpoint host, not the request content.

Revocation, a user Stop, session close and the end of the turn need no code in the loop. Each of them cuts a call that is still in flight and records it. A turn that ends while a call is in flight, for example because a step threw or the loop ended the turn as cancelled, waits up to five seconds for that record before it ends. If the loop's execution scope is revoked while a call is in flight, for example because the loop was replaced, Core closes the call with a late receipt and the old context's methods throw `E_CLOSED`. A replacement generation reads that record back with `status`. Treat `E_CLOSED` and a `cancelled` result as the end of the step.

### Testing a loop that uses side calls

`driveLoop` from `@agnes/host/author-testkit` takes a `sideCall` option: a fake `LoopSideCallPort` that your test writes. Without it `ctx.sideCall` is `undefined`. To check a loop against the real execution path, call `verifyLoopExecutionContract(factory, { sideCall: true })`. It makes side calls through the loop's own context against a payload-only adapter that it defines, and covers success, the deadline, cancellation by the loop and by a session stop, a revoked loop generation and the estimated cost row.
