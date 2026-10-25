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
      { "apiRange": "^5.0.0", "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
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

Every step returns an explicit `outcome: 'running' | 'idle' | 'turn-ended' | 'parked'`; `phase` is optional display text. `until: 'turn-end'` stops at the first ended turn. `until: 'idle'` continues after completed turns, stopping when input is exhausted or a turn parks or ends for another reason. The production runner and `driveLoop` testkit use the same rule. End a turn with `ctx.events.finish(reason)` and return the outcome it gives back. Core closes the turn, not the driver: `finish('completed')` first passes the stop gate that every loop shares (`turn_stopping` hooks, the verifier and the repair decision). When the gate keeps the turn open it returns `running` and records the reason in history; take another step (usually a model round) before asking again. Asking again without a step ends the turn as `blocked` with `STOP_GATE_HELD`, which is the honest ending for a loop that has no further step to offer. Verifier content failures allow at most one automatic correction before `blocked`; they never ask a person to accept completion. An explicit repair decision of `complete` is preserved with its nonpassing verdict, while verifier or repair outages end the turn with verification marked unavailable. Existing business decisions can still park through their own decision ports. The step a model or tool port opens is an admission edge as well: step and credit budgets and `before_step` hooks decide there, and a refusal ends the turn in Core and throws `E_BUDGET` with `detail.reason`.

Call `ctx.input.claim('next-turn')` to open or rehydrate a turn; repeated claims return the current input until the turn ends. `claim('next-step')` consumes a steer for that turn. Each input carries stable `id`, `turnId`, `kind`, `trust`, `actor` and content. `ctx.turn.view()` returns a detached, deeply frozen view of the visible post-compaction history, the turn's tool catalog and JSON schemas, effective model and capabilities, system/runtime prompt context and budget. The view also has `toolMeta`, the static read-only, destructive and open-world facts of every tool in the catalog with `offered` (whether a request that names the tool keeps it for this model), and `disclosedTools`, the names a request without `tools` would send at this moment. `disclosedTools` keeps the order in which the request sends them. Both fields are optional in the type, so a test double of the view may leave them out; Core always fills them. Execution still checks policy and approvals.

Prepare model requests with `await ctx.prepareRequest({ system, messages, tools, sampling, invocationId, tailNote })`, then pass the returned token to `ctx.model.stream(request, signal)` or `complete(request, signal)`. Omitted messages use visible history; `tools` selects exact names from the frozen catalog (pass the same names on every request to keep the catalog stable) and `tailNote` adds a note at the end of the request; see [Shaping the request from a loop](#shaping-the-request-from-a-loop). Core resolves the route and contract, derives hashes, validates media and binds the token to this turn. Authors never supply `contractId`, `derivedHash` or `route`. Every loop goes through Core admission for maximum steps, request caps and quote/deny disposition. Batch results retain input order; policy decides which calls can overlap.

Assign stable `invocationId` values to model preparations and tool calls. `ctx.effects.status(id)` returns `not-sent`, `may-have-sent` or `responded`, with a durable result for a response. Save state with `ctx.checkpoints.write(driver.checkpoint(), { invocationIds })` to associate a checkpoint with effects. A durable response can be reused after reopen; an uncertain invocation refuses automatic replay. A responded receipt does not imply tool success or exactly-once execution outside the process.

A loop can also send a one-off request to another model without touching the conversation; see [Side model calls from a loop](#side-model-calls-from-a-loop). A tool call that the loop chooses itself, with no model reply behind it, can be recorded together with its own assistant message; see [Announcing a tool call](#announcing-a-tool-call).

`LoopContext` is the union of two documented surfaces. `GenericLoopPorts` carries everything a replaceable loop needs (model, tools with their `announce` option, side model calls through `sideCall.prepare/invoke/status`, decisions, effect receipts, inputs, events, checkpoints, wait/wake, jobs, children, compaction); type a factory as `GenericLoopFactory` to prove it needs nothing else. `DefaultLoopConvenience` (`turn.continuation`/`checkpoint`/`finishCancelled`/`finishFailure`, `model.respond`, `tools.drain`, `wait.poll`) is the coarse edge set tied to Core's ReAct stages; only the default loop should depend on it.

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

## Shaping the request from a loop

Three options let a low-level loop decide what a model request lists and how the history records it: the `tools` names of a request, a trailing note, and the announcement of a tool call. Each is optional. A loop that uses none of them sends the same requests, byte for byte, as it did before the options existed. The snippets below run inside a driver's step; `ctx` is the loop's `GenericLoopPorts`, and names such as `turnId`, `round` or `signal` stand for the loop's own values.

### A stable tool catalog

Core takes the tool catalog when a turn starts and freezes it for that turn. A tool that is registered or removed later, such as an MCP server that connects or a plugin that loads, shows up in the next turn. If the process restarts in the middle of a turn, the catalog is taken again from the tools registered at that moment.

What a request lists depends on `tools`:

- Without `tools`, the request lists the tools disclosed at that moment: the visible tools that are not deferred, plus every deferred tool that `tool_describe` has loaded in this session, narrowed by the preset's `disclosure` setting. A load is kept across turns and after a reopen. When the model loads a tool between two requests, the second request lists one more tool, and so does every later request without `tools`, in this turn and in the next ones. The tool bytes change, so does `tool_schema_hash`, and a provider's cached prefix no longer matches.
- With `tools`, the request lists exactly those names. Core sorts them by name, so the order you pass them in does not matter. Within a turn, every request that passes the same names carries identical tool bytes and an identical `tool_schema_hash`, whatever the model loaded in between. Across turns they stay identical as long as the name, the description and the parameter schema of each of those tools stay the same.

```ts
// Once per turn: choose the names from the turn's catalog, and keep them in your checkpoint.
const view = await ctx.turn.view()
const catalog = new Set(view?.tools.map((tool) => tool.name))
const toolNames = ['read', 'tool_search', 'tool_describe'].filter((name) => catalog.has(name))

// On every request of the turn: the same names.
const request = await ctx.prepareRequest({ tools: toolNames, invocationId })
```

`'read'` stands for a tool of your own. `ctx.turn.view()` lists the whole catalog of the turn, deferred tools included, so choose the names you want to send instead of passing them all.

To offer what the default loop offers, start from `view.disclosedTools` instead of a list of your own: it already leaves out deferred tools that are not loaded, tools hidden from the model and, for a model that takes no images, computer-use tools. It grows when the model loads a deferred tool with `tool_describe`; adding the new name to your set changes the tool bytes once. The built-in `ls`, `find` and `grep` also return the paths they show in `structured` (`ToolPathReferences`, schema `agh.path-references/1`), so a loop can offer them as targets without parsing the text; the model sees only the text. A `run_code` script gets the text of any result whose `structured` has that schema, whichever tool returns it. The limits of the list are in [default tools](../reference/default-tools.md#path-references).

A name that is not in the turn's catalog makes `prepareRequest` throw `E_ENVELOPE`. The catalog is frozen, so a tool that is unregistered while a turn runs stays in that turn's catalog and requests can still name it. The error shows in a later turn, or after a restart in the middle of a turn, when the catalog is taken again. Your loop handles it, for example by choosing the names again from `ctx.turn.view()`. A name that is in the catalog but is not offered to the model, such as a tool marked as not visible to the model, or a computer-use tool when the model takes no images, is left out of the request. A tool that the model loads with `tool_describe` in the middle of the turn is not added to a request whose names you fixed; add its name to the set if you want it offered, which changes the bytes once. The guarantee assumes the same slot and the same model: the computer-use filter depends on the model of the slot, so switching the model can change the list.

The guarantee covers the `tools` of a request. The system prompt lists the deferred tools of the whole catalog and tells the model to use `tool_search` and `tool_describe`. That list comes from the catalog, not from `tools`, so passing names does not change it, and it does not change within a turn. If your names leave out the two discovery tools while the catalog has deferred tools, the prompt points the model at tools it cannot call. Include both names, or accept the mismatch.

### A tail note

`tailNote` appends one user-side message at the end of a request, after the visible history and after Core's own per-request notes (runtime context, hook context and skill notes). Only Core's request-only notes, which are never written to history (a timed turn's `[turn time]`), come after a committed note; an uncommitted note is always last. The system prompt, the tools, `prompt_prefix_hash` and `tool_schema_hash` are the same as without it.

```ts
const request = await ctx.prepareRequest({
  tools: toolNames,
  tailNote: { text: `Round ${round} of ${maxRounds}: answer with JSON only.`, commit: true },
})
```

| Field | Meaning |
| --- | --- |
| `text` | 1 to 32768 UTF-8 bytes. After scrubbing it must not begin with a Core note prefix: `[runtime context]`, `[hook context]`, `[hook data]`, `[nested result]` or `[skill loaded]`, each followed by a line break. |
| `commit` | Default `false`: the note belongs to this request only. `true`: the note is also written into the history, see below. Refused together with custom `messages`. |

An invalid note makes `prepareRequest` throw `E_ENVELOPE` before anything is written. The fake `prepareRequest` of `driveLoop` does not add the note to the requests it records; test a note against a full session fixture.

**Trust.** Core scrubs the note like `system` text: zero-width characters, chat-template special tokens and any spelling of the untrusted-envelope tag are removed or replaced. It never wraps the note in an untrusted envelope. The model reads the note as the loop's own instruction, which is the point of a note. If your loop quotes untrusted content in it (a tool result, a file name, fetched text), you are responsible for that content: Core does not mark the quote as data. Label the quote as data yourself, or keep it out of the note.

**Without `commit`**, the note rides this request only. The next request's history does not contain it, so the next request no longer extends this one from the note on, and a provider's cache stops matching there.

**With `commit: true`**, Core writes the note as a history row in the same transaction that records the request as sent. Later requests carry the note as an ordinary user turn at the same place, so each request stays a prefix of the next. The row stays even if the request then fails, because the request was recorded as sent. A request that Core refuses before it is sent (a budget refusal, for example) writes no note. Once a request has been sent, sending the same prepared request again under the same `invocationId` returns the recorded result and writes nothing. Send a committed note when none of your tool calls is still running: a result recorded after the note is placed before it in later requests.

**Resuming after a committed note.** The committed note is now part of the history, so preparing the request again under the same `invocationId` gives a different request, and sending it throws `E_RELATION`. After a restart, read `ctx.effects.status(invocationId)` first. When it is `responded`, use the recorded `result` and do not prepare the request again. When it is `may-have-sent`, the request may have reached the model, and Core refuses to send it again under that id, so stop there as well.

```ts
const recorded = await ctx.effects.status(invocationId)
if (recorded.status === 'responded') return recorded.result
// The request may have reached the model: do not prepare or send it again under this id.
if (recorded.status === 'may-have-sent') return undefined
const request = await ctx.prepareRequest({ invocationId, tailNote: { text: note, commit: true } })
return ctx.model.complete(request, signal)
```

**Other slots.** A `commit: true` note on a request sent to a slot other than `primary` (such as `fast`, `verifier` or `compaction`, chosen with `slot`) is written into the main conversation history all the same. Core's own runtime-context and hook notes behave the same way on such requests. Core does not check it, so the loop author is responsible for it. A request that must stay out of the conversation belongs in [`ctx.sideCall`](#side-model-calls-from-a-loop), which takes no note.

### Announcing a tool call

`ctx.tools.execute(call, signal, options)` and `ctx.tools.batch(calls, signal, options)` take an optional third argument. Without it, a call that the loop chooses itself is recorded on its own. It is attached to the latest assistant message of the turn, which did not ask for it, or to the turn's input when there is no assistant message yet. With `announce`, Core records the call, or the whole batch, as one new assistant message that asked for it. A call that a model reply you committed with `ctx.events.assistant` asked for needs no announcement.

```ts
// The loop chose this call itself: one assistant message with no text, and the call.
const result = await ctx.tools.execute(
  { invocationId: `check-${turnId}-${attempt}`, name: 'read', args: { path } },
  signal,
  { announce: true },
)

// A model wrote some text beside a call, and the loop parsed the call and now dispatches it.
const results = await ctx.tools.batch(calls, signal, {
  announce: { content: [{ type: 'text', text: reply }] },
})
```

`announce: true` writes an assistant message with no text. `announce: { content }` keeps the text and thinking blocks that a model produced beside the call; no other block type is allowed, and Core throws `E_ENVELOPE` for one. `content` is model output in the trusted assistant frame: Core scrubs it when it renders a request and does not wrap it as untrusted.

**One transaction.** Core writes the assistant message first and the call rows after it, all in one ledger transaction, before anything runs. The history never holds the message without its calls, or a call without its message.

**Refused before anything is written.** Core checks every call first: the tool exists in the turn's catalog and the primary model may use it, the arguments match its schema, the policy resolves and the budget allows it. If one call fails a check, nothing is written. A batch that names the same `invocationId` twice is refused with `E_RELATION`, also before anything is written. A turn with a call or effect that is still unsettled refuses a new announcement with `E_RELATION`: settle the earlier calls first.

**Approval and policy are unchanged.** Each announced call still goes through approval, tool policy, hooks and the sandbox like any other call. An approval that parks the turn works as usual: the call throws `PARKED`, and `input.resumeParked()` followed by `tools.resume(invocationId, signal)` completes it.

**Replay.** Give every announced call a stable `invocationId`, and replay it with the same name, arguments and `announce` option. The receipt covers those three, not `content`. If the process died after the announcement was committed and before the tool was dispatched, the call is planned but never dispatched:

- Replay it first, before you prepare a request or make any other model or tool call, and it runs once from the recorded call, in the step that planned it. No planning rows are written again.
- Otherwise Core closes it with an error result. That happens when its step ends, or before the next model request is prepared, so the history never holds the call without a result. The `tool/result` row in the history carries the code `TOOL_NOT_STARTED`, and the model reads the text `<name> was announced but did not run`. A later replay of that id does not run the tool; it returns a `ToolResult` with that text as its content and `isError: true`. A `ToolResult` has no `code`, so look for the code in the history, not on the result. To make the call anyway, announce it again under a new `invocationId`.

A call that had been dispatched is not touched by any of this: it follows the usual rule for an uncertain call, so until Core's recovery settles it, `ctx.effects.status` reports `may-have-sent` and a replay is refused. An invocation whose receipt was written but whose message and call rows were not, because the process died between the two, stays refused; nothing ran, and a new `invocationId` starts again.

**Testing.** `driveLoop` from `@agnes/host/author-testkit` honours `announce` in a simple way: it first records the call, or the batch, in `events` as one `assistant/message` event with `stopReason: 'tool_use'`, and passes the option on to the `tools.execute` your test wrote, with each call. It does not simulate replay, the check for unsettled calls or approval.

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
| `system`, `messages`, `sampling` | Sent as written. `system` is at most 1,048,576 UTF-16 code units. Only `user` and `assistant` messages are allowed; an assistant message carries no `toolCalls` and a `tool_result` block is refused. An image needs a target model record whose `input` list includes `image`. |
| `payload` | Structured JSON handed to the adapter unchanged as `RequestBody.payload`. Plain JSON data only: at most 1 MiB of canonical JSON, nested at most 32 levels deep, and no `Date` or class instance. A payload that breaks one of these is refused as `payload-size`. |
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

`invoke` returns a result. Whatever the vendor, the clock or the caller can do to a call comes back as a status; `invoke` throws only for misuse, and then nothing was written, except for `E_CLOSED`, which can also end a call that was already sent when the loop's scope is revoked; the replacement context reads that call back with `status`.

| `status` | Meaning |
| --- | --- |
| `ok` | `text`, the parsed `json` when `output` is `'json'`, `usage`, `latencyMs` and the vendor's `response` id and model. |
| `failed` | `reason` is `deadline`, `cancelled`, `adapter-error` or `invalid-output`. `code` is the AI error code when there is one. `retryAfterMs` is present on an `adapter-error` when the vendor asked for a wait, for example a rate limit's `retry-after`: wait that many milliseconds before you retry with a new `invocationId`. It is a whole number of milliseconds, at most one hour, rounded up; a longer or invalid hint is dropped, so a missing `retryAfterMs` does not mean that the vendor asked for no wait. `dispatch` is `not-sent` or `may-have-sent`. `usage` is present when the call settled through its normal terminal: the observed usage, or an estimate (`creditSource: 'estimated'`) when none was observed and the catalog has a price. A call closed because the loop's execution scope was revoked reports none, although its cost row is written. |
| `refused` | `reason` is `budget` or `usage-unrecorded`. Nothing was written: no intent row, no cost row, no adapter call. |
| `unknown` | `reason` is `interrupted`: the process stopped before the outcome was recorded, and the call may or may not have reached the vendor. It is never sent again. |

`retryable` on a `failed` result is true for `deadline`, false for `cancelled` and `invalid-output`, and follows the adapter's own flag for `adapter-error`.

Core may add statuses or reasons to `SideCallResult` in a later release, so treat an unknown one as an error instead of relying on an exhaustive `switch`.

Errors from `prepare`, and from `invoke` before it sends, are thrown before anything is written, so such a throw means nothing was recorded. Once a call has been sent, how it ended comes back as a result, not a throw, with two exceptions: `E_CLOSED` (see the list below) and a failure of the ledger itself, after which the call reads back as `unknown` once the session reopens:

- `prepare` throws `E_ENVELOPE` (`detail.reason`: `label`, `deadline`, `payload-size`, `messages`, `image-input` or `invocation-id`) for an out-of-range option, and `E_MODEL_UNKNOWN` (`target-unknown`) when the target is not in the provider's catalog. `payload-size` also covers a payload nested deeper than 32 levels and one that is not plain JSON data, such as a `Date` or a class instance. Further `E_ENVELOPE` reasons: `output` (neither `'text'` nor `'json'`), `system` (not a string of at most 1,048,576 UTF-16 code units) and `sampling` (a key or value outside the request schema's ranges).
- `invoke` throws `E_ENVELOPE` (`signal`) when its signal is not an `AbortSignal`. `status` throws `E_ENVELOPE` (`invocation-id`) for an id that does not match the invocation id pattern or looks like a credential.
- `prepare` and `invoke` throw `E_RELATION` (`no-turn`) outside an open turn. `invoke` throws `E_RELATION` (`turn-closing`) only while a turn end that found calls in flight is waiting for them to settle; a call made after the turn has ended finds no turn and throws `no-turn`.
- `invoke` throws `E_REQUEST_FROZEN` for a call prepared by another context or turn (`foreign`, `turn`) or when the catalog record, the route's base URL or the adapter identity changed after `prepare` (`target-changed`); `E_RELATION` when the `invocationId` already has a record with a different `requestHash` (`invocation-reused`) or is running in this process (`invocation-in-flight`); and `E_LANE_BUSY` (`CONTROL_PAUSED`) while the session is paused. After `E_LANE_BUSY` the prepared call is not consumed and can be invoked again.
- Every method throws `E_CLOSED` once the session is closing or the loop's execution scope was revoked. This is the one error that can arrive after a call was sent: when the scope is revoked while a call is in flight, Core still records the call (its intent, a late receipt and an estimated cost row), and the replacement context reads it back with `status`. Read it back before you decide to call again; a retry under a new id would pay for the call twice.
- While a call is still unsettled, `ctx.events.finish` (`E_RELATION`, `side-call-in-flight`), `ctx.turn.endStep` (`E_RELATION` with no `detail.reason`), `ctx.events.assistant` and `tools.execute` / `tools.batch` with `announce` are refused. Calls may run concurrently within a turn; await every call before you end the step or finish the turn.

### Invocation ids, the deadline and retries

The invocation id makes a call idempotent. Calling `invoke` again with the same id and the same request returns the recorded result with `replayed: true` and sends nothing. The same id with a different request throws `invocation-reused`. Keep ids stable across a resume, and check `ctx.sideCall.status(id)` (`absent`, `in-flight` or `finished`) before you decide to call again. A call that was in flight when the process stopped reads as `unknown` with reason `interrupted` and is not sent again.

`deadlineMs` bounds the whole call. Core times it, so an adapter that ignores cancellation is still cut off when the deadline passes: the result is `failed` with reason `deadline` and code `TIMEOUT`.

Neither Core nor the adapter retries a side call. The loop owns that decision: call again with a new `invocationId` (the old id keeps returning its recorded failure), do it only for a `retryable` failure, keep the number of attempts small and fall back to the loop's own behaviour when the step has no time left.

### What the platform handles

Every call that was sent leaves one cost row with purpose `side-call` that counts toward credit limits and budgets. It records the observed usage or, when the spend was not seen (a deadline, a cancellation, an adapter error without usage), an estimate priced from `prepare`. The ledger keeps digests and audit metadata such as the label, route, adapter and endpoint host, not the request content.

Session and goal limits are checked between steps, so they do not stop several side calls made within one step. Before it sends, Core refuses a call only when its estimate is above the per-request cap or when a tree budget has no room left; the result is `refused` with reason `budget`. Once a per-request cap is set, a target with no catalog price is always refused, because its estimate cannot be shown to fit. A loop that makes several calls in one step should count or cap its own calls, or run under a tree budget.

Revocation, a user Stop, session close and the end of the turn need no code in the loop. Each of them cuts a call that is still in flight and records it. A turn that ends while a call is in flight, for example because a step threw or the loop ended the turn as cancelled, waits up to five seconds for that record before it ends. If the loop's execution scope is revoked while a call is in flight, for example because the loop was replaced, Core closes the call with a late receipt and the old context's methods throw `E_CLOSED`. A replacement generation reads that record back with `status`. Treat `E_CLOSED` and a `cancelled` result as the end of the step.

### Testing a loop that uses side calls

`driveLoop` from `@agnes/host/author-testkit` takes a `sideCall` option: a fake `LoopSideCallPort` that your test writes. Without it `ctx.sideCall` is `undefined`. To check a loop against the real execution path, call `verifyLoopExecutionContract(factory, { sideCall: true })`. It makes side calls through the loop's own context against a payload-only adapter that it defines, and covers success, the deadline, cancellation by the loop and by a session stop, a revoked loop generation and the estimated cost row.
