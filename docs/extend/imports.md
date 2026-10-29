# What to import when authoring a plugin

English | [简体中文](imports.zh-CN.md)

[Author kit](README.md) · [Quickstart](quickstart.md) · [Testing](testing.md)

Import plugin code from one package, `@agnes/plugin-runtime`: it carries the author helpers and re-exports every contract of `@agnes/extension-api` (kinds, Loop ports, provider types, errors), so the rows below that name `@agnes/extension-api` are reachable from it too. Use **`@agnes/host/author-testkit` for author tests**. `@agnes/extension-api/host` holds the Host's backend port and is not an author entry. Every kind, registered or bound, is one token type; import a Host-service token from its owning contract package only when you need that service. There is no unified SDK package or public npm release; use the matching source checkout and [local SDK linker](quickstart.md#5-optional-compilation-and-tests).

**Author** below means the supported public author surface in this preview, not a frozen API guarantee. **Specialist** means an explicit contract or integration task. **Internal/legacy — don't use** means avoid that entry in new author templates; existing exports remain available.

## Task → package → symbol

Names marked “type” use `import type`. Registration methods are supplied by the Host context, not standalone imports.

| Task | Import package | Exported symbols | Surface / use |
| --- | --- | --- | --- |
| Define a tool and its plugin | `@agnes/plugin-runtime` | `defineAgnesPlugin`, `defineTool`, `readOnlyTool`, `writeTool`, `toolError`, `toolCancelled`; types `Context`, `TypedToolDef`, `TypedToolResult` | Author. Inject `tools`, then call `ctx.tools.register(tool)`; [tool starter](../../templates/tool/src/index.ts). |
| Describe tool inputs, results and invocation ports | `@agnes/extension-api` | Types `ToolDef`, `ToolMeta`, `ToolContext`, `ToolResult`, `PluginContextFacets` | Author contracts. The only `defineTool` is exported by `@agnes/plugin-runtime`, for official and community authors. |
| Build TypeBox schemas | `@sinclair/typebox` | `Type`; types `Static`, `TSchema` | Author. Schemas must carry TypeBox Kind symbols; plain JSON Schema is insufficient for tool inputs. |
| Validate or compile a schema | `@sinclair/typebox/value`, `@sinclair/typebox/compiler` | `Value`, `TypeCompiler`, respectively | Author, when needed. These are separate subpaths, not exports of Agnes helpers. |
| Add a browser panel or UI asset | `@agnes/web-client` | Types `ClientContext`, `ClientModule`; `workbenchPanels` | Author, browser only. Export `apply(ctx, config)`, register through `ctx.slots` or `workbenchPanels`, and declare entry/styles/slots in a client descriptor. A simple JS sidebar needs no SDK import; see [frontend modules](../develop/frontend.md) and [workbench panels](workbench-panels.md). |
| Describe a client asset manifest | `@agnes/extension-api` | Type `ExtensionManifest` | Author contract for the descriptor's `client` section. `agnes.clientDescriptors` binds that descriptor to its backend row; paths stay inside the package. |
| Define an Agent Loop | `@agnes/plugin-runtime` | `defineWorkflowLoop`, `defineLoop`, `defineAgnesPlugin` | Author. Inject `providers`, register with `ctx.providers.register(loopKind, loop)`. |
| Implement Loop steps and checkpoints | `@agnes/extension-api` | `loopCheckpointCodec`; types `LoopFactory`, `LoopContext`, `LoopDriver`, `LoopCheckpoint`, `ProviderPluginContext` | Author contracts; [Loop starter](../../templates/loop/src/index.ts). Use controlled model/tool ports and the supplied cancellation signal. |
| Define a model adapter | `@agnes/plugin-runtime` | `defineModelAdapter`, `defineAgnesPlugin` | Author. Inject `providers`, then `ctx.providers.register(modelAdapterKind, adapter)`. |
| Implement adapter configuration and streaming | `@agnes/extension-api` | Types `ModelAdapter`, `ModelAdapterConfig`, `ModelAdapterInstance`, `ModelAdapterEvent`, `ProviderPluginContext` | Author contracts; [adapter starter](../../templates/model-adapter/src/index.ts). |
| Package MCP + Skills | `@agnes/plugin-runtime`, `@agnes/protocol` | `defineAgnesPlugin`, type `Context`; type `McpServerDefinitionInput`, respectively | Author. MCP definitions and `SKILL.md` are package data, not tool helpers. Inject `skills` and call `ctx.skills.register(...)`; the source starter imports `@agnes/resource-control-runtime` for its context typing. That package is not a Host-provided external; the candidate creator omits that import. See [starter](../../templates/mcp-skills/src/index.ts) and [MCP management](../guide/mcp.md). |
| Declare package capabilities / scopes | `@agnes/protocol` | Type `PluginCapabilities` | Author. Describes `package.json` → each `agnes.plugins[].capabilities` (filesystem paths, network hosts, exec commands, model/UI flags). See [capability format](../guide/packages.md#capabilities). Metadata does not grant authorization. |
| Describe an extension's capabilities / tool approval policy | `@agnes/extension-api` | Types `ExtensionCapabilities`, `ExtensionManifest`, `ToolMeta`, `ResolvedToolCallPolicy` | Author contracts. Descriptor capabilities and package capabilities have different shapes. Use invocation `ToolContext` ports for authorized I/O; see [tool policies](tool-runtime.md). |
| Use a Host service by kind token | Owning contract package in the table below | Types `BindableKind`, `LoopServiceReader` from `@agnes/extension-api` | Specialist. Use the actual supplied service port; importing a token does not install, select or authorize its provider. |
| Test tools, Skills, Loops and adapters | `@agnes/host/author-testkit` | `createPluginTestHost`, `driveLoop`, `scriptedModel`, `runModelAdapter` | Author, test files only. The Host registration bridge is automatic. Supply explicit service doubles for lightweight contracts. |
| Test sessions, generation pins, model replay or HTTP/SSE faults | `@agnes/host/author-testkit` | `createAuthorTestkit`, `recordModelFixture`, `replayModelFixture`, `startModelFaultServer`, `ScriptedProvider`, `fakeModel`, `fakeRequest` | Author, test files only; [testing guide](testing.md) explains fixture limits and cleanup. |
| Check specialist provider lifecycle contracts | `@agnes/extension-api/testkit` | `runProviderConformance`, `loopConformance`, `modelAdapterConformance`, `compactionConformance`, `toolRuntimeConformance`, `toolPolicyConformance`, `persistenceConformance`, `sandboxConformance`, `childAgentConformance` | Specialist. Requires a real Host registration/session probe; this is not a second starter testkit. Optional Vitest persistence suites live at `@agnes/extension-api/testkit/persistence-contract`. |

For profile pages, import React from `react` and call your declared backend through `ctx.profile.services.query/effect/readOperation`; see the [browser author reference](../reference/plugin-author-api.md) and working [panel template](../../templates/tool-with-panel/). For Node DOM tests, import `createClientPanelTestHost` from `@agnes/web-client/testkit` and stub only its `profileCaller` argument. `createPluginTestHost` accepts an isolated `storeDir` for restart retention and exposes `invokeProfileService` for registered handler contracts; native admission/approvals are outside this lightweight fixture.

## Kind tokens

A kind is one token made with `defineKind`. It declares whether it supports `ctx.providers.register`, `ctx.providers.bindOwn`, or both (a `bind` option adds binding). `ctx.providers.register(kind, provider)` and `ctx.providers.bindOwn(kind)` take the same token type, and the Host refuses an operation the kind does not declare.

Host-installed provider kinds are exported by `@agnes/extension-api` (and re-exported by `@agnes/plugin-runtime`): `loopKind`, `modelAdapterKind`, `compactionKind`, `persistenceKind`, `sandboxKind`, `toolRuntimeKind`, `toolPolicyKind`, `childAgentKind`, `referenceResolverKind`, `memoryKind`, `systemPromptKind`, `webhookTriggerKind`; the seven seam kinds (`approvalKind`, `principalsKind`, `billingKind`, `checkpointKind`, `artifactsKind`, `verifierKind`, `repairKind`) come from `@agnes/extension-api/seams`.

These are the six bindable kinds in the Host-provided public author namespaces. Import the exact owning path so reloads preserve token identity; do not copy a token or recreate it with `defineKind`.

| Service | Import package | Exported token | Contract source |
| --- | --- | --- | --- |
| Task telemetry | `@agnes/observability/contract` | `observabilityKind` | [contract](../../packages/observability/src/contract.ts) |
| Intelligent UI | `@agnes/intelligent-ui-contract` | `intelligentUiKind` | [index](../../packages/intelligent-ui-contract/src/index.ts) |
| UI data source | `@agnes/intelligent-ui-contract` | `uiDataSourceKind` | [index](../../packages/intelligent-ui-contract/src/index.ts) |
| Git worktree | `@agnes/git-worktree-contract` | `gitWorktreeKind` | [index](../../packages/git-worktree-contract/src/index.ts) |
| Deferred tool queue | `@agnes/plugin-runtime/deferred-contract` | `deferredQueueKind` | [contract](../../packages/plugin-runtime/src/deferred-contract.ts) |
| Deferred invocation producer | `@agnes/plugin-runtime/deferred-contract` | `deferredProducerKind` | [contract](../../packages/plugin-runtime/src/deferred-contract.ts) |

`ctx.providers.bindOwn(kind)` binds the admitted owner's instance when that port is available. A Loop uses its optional `LoopContext.services.get(kind)` reader and must handle an absent service. Ordinary plugins register through `ctx.providers.register(kind, provider)` and bind through `ctx.providers.bindOwn(kind)`. Host admission, owner and source-package checks apply to both. Some tokens are for Host-owned services; their presence in a public namespace does not make every instance callable by every plugin.

## Entries to avoid in new author code

| Entry | Status | Use instead |
| --- | --- | --- |
| `@agnes/plugin-runtime/testkit` + `@agnes/host/testkit` (`createPluginTestHost` + `createPluginTestRegistration`) | Legacy composition; don't use in new author templates. Kept for existing integration tests and explicit registration bridges. | `createPluginTestHost(plugin)` from `@agnes/host/author-testkit`. |
| Provider conformance re-exports from `@agnes/plugin-runtime/testkit` | Legacy alias; don't use in new documentation. | The owning `@agnes/extension-api/testkit` contract entry. |
| `@agnes/plugin-runtime/host`, `@agnes/plugin-runtime/provided-externals`, Host implementation paths, Core/daemon private modules | Internal; don't use in plugins. Exported infrastructure is not an author contract. | Public author helpers, contracts and controlled context ports. |
| Host's internal `feedbackKind` | Internal; don't use. Not a public contract export. | Supported tools/services; no author token import exists for this internal binding. |

Production backend loading supplies only the [listed public externals](quickstart.md#host-provided-dependencies); it does not supply testkits or browser modules. Keep testkit imports in tests. Browser assets must use their supported browser externals or bundle dependencies. The fixed candidate test runner separately supplies `@agnes/host/author-testkit`, including for the bounded helper's `.mjs` tests.

The bounded helper still accepts only its self-contained tool/Skill/skin format. Its manifest/file whitelist differs from the standard scaffolds; changing the testkit import does not add `kinds`, `capabilities`, dependencies, scripts or advanced client contributions to that format. See [agent-built plugins](agent-built-plugins.md).

## Where these imports are defined

The package `exports` maps select the entry; the entry's exports select the symbol. Verify both before copying an import:

- [plugin-runtime package](../../packages/plugin-runtime/package.json) and [author index](../../packages/plugin-runtime/src/index.ts).
- [extension-api package](../../packages/extension-api/package.json) and [contract index](../../packages/extension-api/src/index.ts).
- [protocol package](../../packages/protocol/package.json) and [index](../../packages/protocol/src/index.ts).
- [web-client package](../../packages/web-client/package.json) and [index](../../packages/web-client/src/index.ts).
- [Host package](../../packages/host/package.json) and [author testkit index](../../packages/host/testkit/author/index.ts).
- [observability package](../../packages/observability/package.json), [Intelligent UI contract package](../../packages/intelligent-ui-contract/package.json), and [Git worktree contract package](../../packages/git-worktree-contract/package.json).

TypeBox is the declared `@sinclair/typebox` dependency; its own package exports provide the root, `/value` and `/compiler` entries. The [runtime module list](../../packages/plugin-runtime/src/provided-externals.ts) supplies those same namespaces.

## Session decisions

Optional `presentation` maps locale tags to `{ title, fields: [{ label, value, href? }], responseValue? }`. Fields are plain text; links must be same-origin paths beginning with a single `/`. Web selects the exact locale, language, then English and submits that entry's `responseValue` unchanged (null when absent). Keep `prompt` as the fallback for older clients. Include meaningful display values in `subject`, validate answers with `responseSchema`, and verify the authenticated human result before acting. Persist the exact selected meaning rather than translating it after signing. Presentation grants no authority and does not change the offered options.

`ToolContext.decisions`, `LoopContext.decisions` and granted `ServicePorts.decisions` expose the same `DecisionPort` (`request`, `get`, `wait`, and optional `admit`). Import its types and `APPROVAL_DEFAULTS` from `@agnes/extension-api`. A spec declares a namespaced key, purpose, complete immutable JSON subject, prompt, offered options and an optional bounded JSON response schema. Host stamps the session, author and original operation; purpose grants no authority.

The ledger persists the request before returning its handle. Repeating an owner's key with the same spec returns the original ID and deadline; changing the spec conflicts. `wait` returns a resolved snapshot or a pending handle when detached. Disconnect and aborting a waiter leave the durable request pending. Answers are accepted only through the authenticated backend.

A tool can call `admit(handle)` after an approving answer to consume that exact operation once and receive a private `PermissionEffectAdmission`. Call `verify()` before preparing the write and pass the capability as the second argument to `store.transaction(work, admission)`; Host checks it inside the synchronous transaction before work and immediately before commit. Nested calls join the root transaction: every joined admission remains registered until the real root commit, where all are checked again, even if an inner call already returned successfully. Commit or rollback clears that root registry. Full-access business confirmations retain the human principal, exact declared presentation value, authorization epoch and explicit automatic mode; see [security](../guide/security.md#full-access-exceptions). Older hosts without `admit` cannot perform automatic business signatures.

A Loop stores the handle in its existing checkpoint and uses `get` on recovery. To advance a pure phase after a human answer, pass `{ decisionRefs: [handle] }` to `checkpoints.write`: consumption and the next checkpoint commit together. The port cannot resume arbitrary tool JavaScript after a restart. Service kinds must declare `decisions` among their maximum ports and the Host descriptor must grant it; calls without a live session admission fail closed.

Tool permission and plan review persist before display. Native clients answer with
`client.approval.decide({ sessionId, id, revision, commandId, response: { option, value } })`
and query open requests with `client.approval.list(sessionId)`. Identity comes from the authenticated
connection; the answer body contains no actor or credential. A missing handler, disconnect or local
wait timeout leaves the same request pending. Plan review offers human, once-only answers and exposes
the complete immutable plan. Ordinary tools retain once, session and synchronously persisted permanent grants.
