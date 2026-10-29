# Extension API changes

API additions require a minor version; removals or semantic changes require a major version and migration notes. This file records the initial contract under implementation. Local consistency checks do not establish release readiness or authorize publication.

## 5.0.0

### Added

- `ToolContext.turnTimeLimit` (optional, read-only): `{ timeLimitMs, deadlineAt }` of the turn the call
  runs in, present only when its prompt set a wall-clock limit (`agh -p --timeout`, SDK
  `prompt({ timeLimitMs })`); `deadlineAt` is epoch milliseconds. A tool that waits on something long can
  keep the wait inside the time the turn has left. The official `shell` tool ends a foreground wait
  before the deadline (leaving the larger of 15 s and 5% of the limit) and says so in its result.
- `ToolMeta.requiresUser` (optional, default false): the tool asks a person who is present, or shows them
  something to act on now (a question, a form, a live UI surface). A turn whose input declares that
  nobody attends it (`agh -p`, `agh run`, SDK `runHeadless` or `session.prompt(..., { unattended: true })`)
  leaves the tool out of its catalog: the model is not offered it, discovery cannot find it, and a call
  to it is refused as an unknown tool. The official `ask_user_question`, `ui_render`, `ui_update`,
  `ui_close` and `ui_guide` declare it.

Every `agnes.plugins[].apiRange` and `@agnes/extension-api` dependency range (including
`hostProvidedExternals`) moves from `^4.0.0` to `^5.0.0`; a `^4` range is refused with
`E_API_RANGE`. The bundled default plugins move with the API. No compatibility shim is provided.

### Changed

- `SeamAdaptersView.storage.namespace` is required; the Host always supplies it.

  Migration: drop optional calls such as `storage.namespace?.(name)`. A hand-built
  `SeamAdaptersView` must provide `namespace`.

### Removed

- `SeamAdaptersView.storage.sql`. Nothing read it; seam providers keep their state in the
  namespaced metadata store returned by `storage.namespace(name)`.

  Migration: move the state to `storage.namespace(name)`.
- `ChildControlStore.lookupWorkspaceByPath`. It had no callers.

  Migration: delete the method from a custom store. `lookupByKey` returns the `workspaceId` that
  `updateWorkspace` takes.

## 4.0.0

### Preview additions

- `schedulingKind` and `SchedulingService` expose the fixed daemon scheduler to admitted plugin
  callbacks. Declare the six `schedulingServiceCapabilities` and obtain the matching service lease
  grants before `ctx.providers.bindOwn(schedulingKind)`. Bindings recheck exact declarations,
  grants and callback lifetime on every operation. This unreleased preview keeps its API number;
  publish these additions in a minor version before a public package release.

- `workspaceStateKind` declares read-only workspace state providers whose queries are selected
  through the session's backend composition. This unreleased preview retains its API number;
  publication requires the same minor-version review as the additions below.

- Experimental `profileRuntime` facet for current-profile managed resources and declared streams,
  with `managedServiceCapabilities` for the static status/configuration/check/retry/configure
  service declarations. Trusted in-process services use an explicit `in-process` artifact kind;
  node/OCI artifacts retain their process supervisor. Older Hosts refuse the unknown facet or
  artifact kind. This unreleased preview keeps its API number; these additions need a minor
  version before publication under the published-package compatibility policy.


Every `agnes.plugins[].apiRange` and `@agnes/extension-api` dependency range moves from `^3.0.0` to
`^4.0.0`; a `^3` range is refused with `E_API_RANGE`.

### Removed

- The `sourcePackage` argument of `ctx.providers.register`. The one signature is
  `register(kind, provider)`: the Host attributes the registration to the package of the calling
  plugin row, for a bundled package as well as an installed one, and for every kind (reference
  resolvers, memory, system prompt and persistence were not checked against the row before).
  `ProviderConformanceOptions.sourcePackage` is gone for the same reason.

  Migration: delete the second argument.
- `ExtensionAPI` and `ExtensionFactory` from the package root. They are the Host's backend port
  behind the context facets, never an author entry, and now live at `@agnes/extension-api/host`.
  The root keeps `ExtensionContext` (what `ctx.self` returns) and `TrustTier`.

  Migration: a Host adapter imports the two types from `@agnes/extension-api/host`. A plugin uses
  the facets it lists in `inject`.
- `WorkflowOptions.source` in `@agnes/plugin-runtime`: the Host attributes the workflow's loop and
  policy to the plugin's package. `name` is optional and defaults to `id`.

  Migration: delete `source`.

### Changed

- The tool result budget counts UTF-8 bytes (text) and encoded JSON bytes (`structured`, `details`),
  and stops walking a wide array or object at the node ceiling instead of enumerating it. A cut
  result keeps what fits plus one marker block; blocks and refs past the budget are dropped, so a
  result that must stay whole is returned as an artifact ref. A `tool_result` hook return over
  16 MiB is refused as an invalid hook return.
- Replay of an installed plugin's tool. A tool that does not state `meta.replay` is `never`
  replayed (`defineTool` fills it in, and so does the Host for a plain object). `replay: 'safe'`
  is refused with `E_TOOLDEF_META` unless the tool is `isReadOnly`, and a `classify` result that
  returns `safe` for a call that is not read-only is rejected. Bundled tools are unchanged.

  Migration: a write that tolerates a rerun declares `replay: 'idempotent'`.

### Added

- `ToolMeta.deferLoading: 'auto'`: core keeps the turn's auto tools visible while there are at most
  15 of them with schemas under about 4,000 tokens, and defers them together past either limit.
  MCP server tools use it by default. `true` and `false` keep their meaning.
- `ToolMeta.discoveryGroup`: a one-line label (at most 120 characters) that lists deferred tools
  sharing it as one line with their count; `tool_search` also matches it.
- Theme tokens `--agnes-bg-fill`, `--agnes-bg-fill-hover` (the soft neutral fill of text fields,
  secondary buttons and icon tiles), `--agnes-bg-group` (the surface of a grouped card),
  `--focus-outline`, `--focus-line` and `--focus-line-inset` (the one keyboard focus ring: a solid
  1px line inside a soft halo) and `--shadow-raised` (the current item of a
  navigation rail). A skin that sets none of them keeps the theme's values.

- `LoopEventRegistryPort.dispatch` takes an optional `resultMaxBytes`: an `after_tool_result`
  replacement is cut to that many UTF-8 text bytes (and the shared block, depth and size ceilings)
  before the next handler receives it.
- `@agnes/plugin-runtime` re-exports the root of this package, so a plugin imports helpers and
  contracts from one package.
- The `agnes.plugins` entry is the one declaration of what a plugin injects: `inject` lists every
  service name and the new `optionalInject` (a subset of `inject`) marks those it can run without.
  An export carries no list of its own; an in-process export that repeats one must agree with the
  entry or the load fails with `plugin-export-shape`. `@agnes/host/author-testkit`'s
  `createPluginTestHost` reads the same entry from the package.json in `packageDir` (default: the
  working directory) for the export named by `exportName` (default `main`), so a test no longer
  repeats the list.

### Changed

- `GenericLoopPorts.events.finish(reason, error?)` returns the `LoopStepOutcome` Core ended with
  instead of `void`. `finish('completed')` passes the stop gate first: `turn_stopping` hooks, the
  verifier and the repair decision run for every loop, not only through the default loop's
  `turn.checkpoint`. A gate that keeps the turn open returns `running` with the reason recorded in
  history; a second `completed` request with no step in between ends the turn as `blocked`
  (`STOP_GATE_HELD`). A gate that has to ask a person returns `parked`: the loop's part of that
  turn is over, and Core completes the turn when the person approves or ends it as `blocked`
  otherwise, without calling the driver again for it. A driver returns the outcome it was given.
- The step a generic model or tool port opens fires `before_step`. A park or block ends the turn in
  Core and the port throws `E_BUDGET` with `detail.reason` (`parked`, `blocked` or `aborted`),
  the same refusal a step or credit budget produces.
- `GenericLoopPorts.events.emit(name, data)` takes a relative event name. Core writes it as
  `x/<owning package without @>/<name>` with origin `ext:<that owner>`; a full `x/...` type is
  refused, so a loop cannot write into another owner's namespace. Migration: pass the name only and
  read the event back under the package's namespace.
- A plugin projection folds an `x/<owner>/...` event only when Core or that owner wrote it. Listing
  another package's event type in `inputEventTypes` no longer makes any writer of that type an
  input.
- An `approval_request` hook can only raise the risk a person is shown
  (`budget` < `destructive` < `always`); a lower value is ignored, along the waterfall and against
  the platform's own value. A `summary` or `context` it returns no longer replaces the platform's
  summary silently: the decision subject records `rewrite: { by, summary }` (the hook sources and
  the platform's summary), the timeline's approval node carries it as `rewrite`, and the Web
  approval card shows both.
- Two requests of one loop that pass the same `LoopRequestOptions.tools` names carry the same tool
  schemas, sorted by name whatever the order passed, and the same `tool_schema_hash` for the rest of
  the turn, also when the model loads a deferred tool in between; across turns the same holds while
  those tools' definitions are unchanged, for the same slot and model. Omitting `tools` follows the
  current disclosure, which grows whenever the model loads a deferred tool (loads are kept for the
  session). The guarantee already held; it is now documented and covered by a contract test.
- A message a loop supplies in `LoopRequestOptions.messages` is no longer served from the session's
  envelope memo: each request carries the text it was prepared with. Earlier, a later request in the
  same session could resend the text of the first.
- When a usage event gives no `credits`, the AI facade takes them from the gateway's billing (a
  `billing` of source `gateway` that is not a subscription) and reports the source `gateway`;
  otherwise it prices the request from the catalog and reports `estimated`. An adapter's own
  `creditSource` label is ignored unless the same event also gives `credits`, so an adapter that
  prices a request itself sets both.
- `timeoutMs.firstToken` and `timeoutMs.total` in the options a model adapter receives can be as low
  as 100 ms (a side call's `deadlineMs` sets them), where they used to be at least 1000 ms. An adapter
  must not assume a larger value.

### Added

- `ToolMeta.commandArg`: the top-level string argument that carries the command text a tool runs.
  The command table matches a rule's `argv` against that text (whitespace-folded) for any tool that
  declares it; `shell`, `pty_send` and `run_code` do. A tool that declares nothing is matched on the
  canonical JSON of its arguments, as before. The tool name `shell` no longer implies an identity.
- `PresetView.approval.commandTable`: the command table of the preset a session runs under. Core
  applies it around the session's selected tool policy, so the floor follows the session's preset
  instead of the Host's default preset. `ToolPolicyRegistryPort` is unchanged; a Host no longer
  wraps it.
- `GenericLoopPorts.sideCall` (optional) and the `LoopSideCallPort` contract in `side-call.ts`:
  a loop sends a one-off model request to a chosen route and model, outside the conversation.
  `prepare(options)` validates the options and returns a frozen `PreparedSideCall` with an
  estimate; `invoke(prepared, signal)` sends it and returns a `SideCallResult` (`ok`, `failed`,
  `unknown` after a crash, or `refused` with nothing written); `status(invocationId)` reads a
  recorded call back. The request goes out as written, with no main system prompt, history or
  untrusted envelope. Also exported: `SideCallTarget` (a route and model only), `SideCallOptions`,
  `PreparedSideCall`, `SideCallUsage`, `SideCallFailure` and `SideCallStatus`. The port is optional
  so a test double of `LoopContext` that does not provide it keeps compiling.
- `LoopRequestOptions.tailNote` (`LoopTailNote`): one user-side note appended after the visible
  history and after Core's own per-request notes. It is trusted at the level of the loop's
  instructions, like `system`: scrubbed, never wrapped as untrusted, so a loop that quotes untrusted
  content in it answers for that content. The system prompt, tools, `prompt_prefix_hash` and
  `tool_schema_hash` are unchanged by it. With `commit: true` the note is written as a history row
  in the transaction that records the request as sent, so later requests carry it as an ordinary
  turn and each request stays a prefix of the next. A note of 0 or more than 32768 UTF-8 bytes, one
  that begins with a Core note prefix, or `commit` together with custom `messages` is refused with
  `E_ENVELOPE` before anything is written. A request without `tailNote` is unchanged.
- `CostLedger.purpose` accepts `'side-call'`, and `CostLedger` has the optional `route`, `adapter`
  (`{ id, version? }`) and `endpointHost`.
- `ModelAdapterCapabilities.payload` and `.payloadOnly` (both optional booleans). `payload: true`
  declares that the adapter reads `RequestBody.payload`; without it the facade rejects a request
  that carries a payload before sending. `payloadOnly: true` declares that the adapter accepts only
  a payload and no messages, and requires `payload: true`; pickers of the conversation model leave
  such an adapter out. A registration whose `payload` or `payloadOnly` is not a boolean, or that
  sets `payloadOnly` without `payload`, is refused as an invalid model adapter registration. The
  catalog and the capability names list both keys when they are true.
- `LoopTestOptions.sideCall` for `driveLoop` in `@agnes/plugin-runtime/testkit` (re-exported by
  `@agnes/host/author-testkit`): a fake `LoopSideCallPort` that becomes `ctx.sideCall`. Without it
  `ctx.sideCall` stays undefined, as before.
- `verifyLoopExecutionContract(factory, options)` in `@agnes/host/author-testkit` takes the new
  `LoopContractOptions`. `{ sideCall: true }` adds the checks `side-call`, `side-call-deadline`,
  `side-call-cancel`, `side-call-revocation` and `side-call-estimated-cost`; they make side calls
  through the loop's own context against a payload-only adapter that the suite defines. Without the
  option the report is unchanged.
- `LoopToolCallOptions` and an optional third parameter of `tools.execute` and `tools.batch`:
  `announce` records the call, or the whole batch, as one new assistant message written in the same
  transaction as the call rows, before anything runs; each call still goes through approval and tool
  policy. A planned announced call that was never dispatched continues on replay with the same
  `invocationId` while the step that planned it is open, so a loop that replays it first after a
  reopen still runs that very call. Otherwise the call is closed with an error result (the history's
  `tool/result` row carries the code `TOOL_NOT_STARTED`) when its step ends, or before the next
  model request is prepared, and the loop can announce again with a new `invocationId`. Without
  `announce` nothing changes.
- `SideCallResult` (`status: 'failed'`) has an optional `retryAfterMs`: for an `adapter-error` whose
  vendor asked for a wait, such as a rate limit with `retry-after`, the milliseconds to wait before a
  retry. It is a whole number up to one hour (a longer or invalid hint is dropped), recorded with the
  call, so `status` and a replay return it too. Core still never retries; the loop retries with a new
  `invocationId`.
- `driveLoop` in `@agnes/plugin-runtime/testkit` (re-exported by `@agnes/host/author-testkit`) honours
  the `announce` option of `tools.execute` and `tools.batch`: it first records the call, or the batch,
  as one `assistant/message` event with `stopReason: 'tool_use'`, and passes the option on to the
  test's tool port with each call. Replay is not simulated.
- `ToolPathReferences` and `TOOL_PATH_REFERENCES` (`'agh.path-references/1'`): a `ToolResult.structured`
  payload that lists the workspace paths a tool found and showed, each `{ kind, path }` with `path`
  relative to the session's `workspaceRoot` and `/`-separated, plus `total` (every path found,
  including those left out) and `truncated`. The built-in `ls`, `find` and `grep` return it beside
  their text, which is unchanged, and the model still sees only the text. A payload holds at most 100
  paths, all of them shown in the text; a path outside the workspace, longer than 1024 bytes once
  encoded as a JSON string or, where the separator is `/`, with a backslash in a name is left out and
  counted in `total`. `truncated` is also true when the search was partial or the output guard cut
  the text. A result with `isError` carries no payload. A `run_code` script gets the text of any
  result whose `structured` has this schema, whichever tool returns it. A loop that tells payloads
  apart reads `schema`; every other `structured` payload belongs to its tool. `workflowValue` from
  `@agnes/plugin-runtime` returns this payload for an `ls`, `find` or `grep` result; it used to parse
  their text as JSON, which throws for nearly every listing.
- `LoopTurnView.toolMeta` and `LoopTurnView.disclosedTools`. `toolMeta[name]` (`LoopToolMeta`) gives
  `isReadOnly`, `isDestructive` and `isOpenWorld` from the static meta of every tool in the turn's
  catalog, and `offered`: whether a request that names the tool keeps it for the view's model (false
  for a tool hidden from the model, or a computer-use tool when the model takes no images).
  `disclosedTools` lists the names a request without `tools` would send at this moment, in the order
  it sends them. Both are
  optional, so a test double of the view keeps compiling; Core always fills them. The elements of
  `view.tools` are unchanged.

## 3.1.0

Adds optional `ToolPolicyDecision.allowedBy`. The command-table floor sets it to `command-policy` when a rule allows a call the selected policy asked about, so the policy's own `review` (for example an `escalate` fallback) is kept as an observation beside the final `allow` instead of being rewritten.

## 3.0.0

### Removed

- Two kind-token families. `defineProviderKind` and `defineServiceKind` are replaced by
  `defineKind`: a kind with a `bind` option also supports `ctx.providers.bindOwn`, a kind
  without it is register-only, and `register: false` makes a Host-installed bind-only kind.
  `ServiceKind` / `ServiceKindToken` become `BindableKind` / `BindableKindToken`. Every kind
  carries `operations: { register, bind }`; the registry refuses an operation the kind does
  not declare.
- `KindMap`, `PROVIDER_LIFECYCLE_SCOPES` and string kind names in `ctx.providers.register` /
  `resolve`. Host-installed kinds export tokens: `loopKind`, `modelAdapterKind`,
  `compactionKind`, `persistenceKind`, `sandboxKind`, `toolRuntimeKind`, `toolPolicyKind`,
  `childAgentKind`, `referenceResolverKind`, beside the existing `memoryKind`,
  `systemPromptKind` and `webhookTriggerKind`. The token carries the lifecycle scope and
  validator, so `defineProvider(kind, provider)` in `@agnes/plugin-runtime` takes a token too.
- `defineExtension` and the author-facing role of `ExtensionAPI` / `ExtensionFactory`. A bundled
  package is `defineAgnesPlugin({ inject, apply })` like any other: the Host injects the
  `PluginContextFacets` it lists (`tools`, `hooks`, `projections`, `services`, `slots`,
  `resources`, `eventLog`, `providers`, `self`). `ExtensionAPI` stays only as the Host backend the
  facets run over for a bundled package (`@agnes/plugin-runtime/bundled`: `extensionFactoryOf`).
- `PluginExtensionAPI` and the `ctx.extension()` service. `ctx.hooks.register(event, handler)`
  replaces both `on` and `registerHook` (all 16 events), `ctx.eventLog.append` replaces
  `extension().events`, and `ctx.self` replaces `extension().ctx`.

- Two manifest files and two `capabilities` shapes. A bundled extension is described by its
  package's `package.json` like any other plugin: one `agnes.plugins` entry carries `id`
  (`ext:<id>`), `apiRange`, `capabilities`, `metadata` and, for bundled packages only,
  `contributes`, `lease`, `liveResources` and `runtimeSupports`. `agnes.extension.json` and the
  package-level `agnes.capabilities` are gone; `bundledExtensionManifest` derives the runtime
  `ExtensionManifest` from an entry and `bundledPackageJson` is its inverse.
- `ExtensionManifest.provides` (seam names; seams are provider kinds now).

### Changed

- One `PluginCapabilities` shape for every plugin. Registration keys (`tools`, `hooks`, `slots`,
  `events`, `resources`, `services`, `projections`, `tools.invoke`, `network.publicRead`,
  `artifacts`, `subagent`) and authority keys (`network`, `exec`, `secrets`, `credentials`,
  `filesystem`, `model`, `device`, `childAgents`, `ui`, `uiData`) live in one object.
  `network` is a list of host patterns (the `{ hosts }` object form is removed) and `ui` is a
  flag (the `['skin', 'client']` list is removed; `contributes.skins` and `contributes.client`
  require `ui: true`).
- `ctx.providers.register(kind, source, provider)` no longer infers its provider type from
  `provider`; the kind token alone decides it.

## 2.3.0

### Added

- `@agnes/extension-api/seams`: the contracts of the seven seam kinds (`ApprovalSeam`,
  `PrincipalsSeam`, `BillingSeam`, `CheckpointSeam`, `ArtifactsSeam`, `VerifierSeam`,
  `RepairSeam`), their value types, `SeamProvider<T>` (`create(init, signal)`), `SeamInit`,
  `SEAM_KINDS` and `PINNED_SEAM_KINDS`.
- `KindMap` entries `approval`, `principals`, `billing`, `checkpoint`, `artifacts`,
  `verifier`, `repair`. A seam is registered with `ctx.providers.register(kind, pkg, provider)`
  and selected with `seams.<kind>: { provider, version? }`.
- `ProviderKind` and `ProviderCatalogEntry` carry `required` and `pinned` next to `authority`; `defineProviderKind` takes `required` and `pinned` as optional inputs (`authority` is
  already optional).

### Removed

- The package-exported `seam:<name>` rows, `defineSeamPlugin`, the dynamic entries of the
  `PackageModule.seams` factory table and the `seams` named export (a seam is a registered
  provider, not a factory), and the string form of `seams.<name>`.

## 2.2.0

### Added

- `SandboxProvider.openTransport?(config, ctx)` and `SandboxTransportContext`: a provider whose commands run on another machine hands the Host its channel opener. The Host opens the channel once during assembly from the config of the package that exports the provider, and runs its own exec gate and workspace fence over it. `@agnes/sandbox-remote` exports `defineRemoteSandboxProvider` to build one.
- `ProviderKind.authority` (`'open' | 'host'`, default `open`), `ProviderAuthority`, and `ProviderCatalogEntry.authority`. A `host` kind has one Host-registered implementation: packages cannot register or select it, and the catalog shows it read-only. The first such kind is `platform`.
- Protocol: `RuntimeAdminSnapshot.providers[].authority` (optional).

### Changed

- Permanent approval grants bind to `policyDigest`, a digest of the profile fields that decide authorization (approvals, policy, computer use, seams, presets, sandbox, isolation, command hooks, fixed adapters), instead of the whole resolved-profile `profileHash`. Switching the model route or credential account no longer orphans grants. Protocol `ApprovalGrant` and `ApprovalGrantRecord` carry `policyDigest` in place of `profileHash`; the grant store schema version is 3 and an older store reports `reset-required`.

### Removed

- `profile.seams.sandbox` and `profile.seams.platform` (and the `sandbox` / `platform` keys of the package `seams` export table). Select the sandbox with top-level `sandbox: { provider }`; `platform` is Host-owned. Writing either key is a configuration error that names the replacement. `ResolvedProfile.seams` and the profile schema lose both keys.
- The `openTransport` package export, replaced by `SandboxProvider.openTransport` on an exported `sandboxProvider`.
- `SandboxHostServices` and the `sandboxHost` field of the seam init context; the Host builds the sandbox seam itself.

## 2.1.0

### Removed

- `ToolPolicyInput.approvalMode` no longer includes `'smart'`. The mode never had a
  working reviewer behind it (it behaved as `manual`); a profile that still writes
  `approvals.mode: smart` is now a configuration error that points to `auto-review`.
  Protocol `ApprovalMode`, `ApprovalProfile` and `ProfileFragment` follow, and the
  `approval/guardian-decided` ledger event with its `ApprovalGuardianDecision` type is gone.
- The approval seam's `guard` and `resume` methods and the guardian effect kind. The seam
  keeps `ask`, the command table and the grant methods.

### Changed (approval responsibilities)

- The approval contract is `ask` only. `ApprovalSeam.policy`, `checkTool` and `forWorkspace` are
  gone: the `approval.command_policy` table is a deployment floor the Host wraps around whichever
  tool policy a session selects (`@agnes/core/command-table`), so a selected policy may tighten but
  never loosen it. `ToolPolicy` and `ToolPolicyInput` are unchanged.
- `ApprovalSeam.listGrants`, `putGrant`, `revokeGrant` and `onGrantRevoked` are gone. Permanent
  grants are a Host-owned port (`ApprovalGrantsPort`: `list`, `put`) handed to the Kernel; storage,
  revocation and its broadcast stay in the Host. `SeamRuntime.approvalRevokeGrant` is removed.
- An unreadable `approval.command_policy` stops assembly with `E_PRESET_UNSUPPORTED` naming the rule.
  A third-party principals seam answering `require_approval` is no longer overridden by a table
  `allow`.

### Changed

- The cost seam is renamed `billing` (`BillingSeam`, `BillingRow`, `seams.billing`, runtime
  methods `billingRecord` / `billingProjected`). `seams.ledger` is not accepted.
- `harness` is no longer a seam: profiles do not select it and the kernel does not require it.
  The refine extension keeps its own queue-backed intake.


## Unreleased

### Added (protocol, additive)

- `_agnes/v1/session.runtime` (client tier, SDK `client.session.runtime(id)`): `SessionRuntimeDescriptor`
  with generation, composition, loop, providers (with `pending`), seam bindings (`pinned`),
  resource revisions, effective policy and `restartRequired`.
- `plugins.generations` generation items carry optional `sessions: { key, open }[]`.

## 2.0.0

### Removed

- `ExtensionAPI.latestExtEvent`, a declared optional method no host implemented.
- Authored root profile `loop`, `compaction`, model `provider.adapters`, composition
  `modelAdapters`, and preset `tools.runtime` / `approval.policy`. Select through
  `providers.<kind>: { provider }` (profile, bundle, preset, admin and session layers;
  a preset's table also takes `tool-runtime` and `tool-policy`). Loop composition also requires
  `version`. `model-adapter.provider` accepts an id, source package or unique list
  so multiple transports remain available. Resolved profiles and session pins
  retain backend identities; stored pins are not author config. Missing explicitly
  selected adapters now use the generic provider-unknown assembly failure.

- Named author registration ports (`loops`, `modelAdapters`, `compactionEngines`,
  `childAgents`, `sandboxProviders`), their registration context types, and
  `registerLoopPlugin`. Use `ctx.providers.register(kind, packageId, provider)`;
  registration cleanup is owned by the calling plugin fiber. Runtime operations stay
  with their backend owners.
- `PluginExtensionAPI.registerTool` and its duplicate `providers` facade. Inject
  `tools` and use `ctx.tools.register(tool)`; register and bind service providers
  through `ctx.providers`. The embedding-only `ExtensionAPI` retains its backend
  adapter for official extensions.
- `extension-api.defineTool`. Import the sole `defineTool` from `@agnes/plugin-runtime`
  in official extensions and community plugins alike; it also validates optional
  structured result schemas.

- Top-level `InputPresentation` and the text-based `AgentInputPort.deliver` signature.
  Migrate to `deliver(key, { type, data, summary, presentation? }, signal)`. Host stamps
  source from the admitted service owner and refuses caller-supplied source; ordinary
  prompt RPCs cannot write this field. Loops read `system.data`; receipt string prefixes
  and queue-based authenticity checks are removed.

### Changed

`ToolMeta.costHint`, `deferLoading` and `requiresApproval` are optional. Omission means
no estimate, initial model discovery, and the existing approval default (destructive
for destructive tools, otherwise never). Required safety booleans and replay remain
explicit. `@agnes/plugin-runtime` exports `readOnlyTool` / `writeTool` metadata presets;
spread a preset to declare contract-specific overrides.

### Added

`@agnes/plugin-runtime` exports `defineWorkflowLoop` and the `WorkflowOptions`,
`WorkflowStage`, `WorkflowState`, `WorkflowData` author types. The helper defines a
staged Loop plus public tools/policy/Skills registrations, validates checkpoints,
handles DecisionPort or official surface confirmation, original tool approval
continuation, cancellation, generic structured input stages and optional report
publication. JSON/tool/model convenience exports are `workflowTool`, `workflowResult`,
`workflowValue`, `workflowText`, `workflowChecked`, `workflowModelText`. No extension-api
port or protocol schema changes are required. FDE Loops migrate to version 5.0.0 with
the helper's codec 1; old checkpoints are refused and retained sessions keep pinned code.

`ToolMeta.modelVisible` defaults to true; false hides a tool from model schemas and
discovery while preserving internal invocation. `requiresImageInput` defaults to false
and restricts discovery/execution to a model with native image input. Neither grants
execution authority. Update manifest `apiRange` to `^2.0.0` when migrating.

`LoopInput.origin` and `LoopInput.system` expose platform-authenticated structured
notifications. `SystemInput` owns source, type, JSON data, summary and optional localized
`SystemInputPresentation`. Core renders summaries and compact data for the model; clients
render a status line and expandable data. Content remains untrusted for model policy.
Intelligent UI action receipts and deferred wakeups use this path. Core `enqueue`
optionally deduplicates commandId atomically against historical inbox facts.

`SystemInputPresentation` is now a union of `ui-action` and `child-completed`. Core delivers
one `child-completed` system input (`source: agnes/child`) to the parent when a background
child finishes a turn or ends: `data` is `{ childKey, status, continuable?, result?, truncated?,
credits? }` with `status` one of `completed | failed | cancelled | budget_stopped`. Workflow
loops read it from `LoopInput.system`; `subagent_collect` stays for explicit reads.

Protocol preview changes: `UserMessage`, `InboxItem` and user `UINode` replace top-level
presentation with `system`; user `UINode` carries origin. No old-field compatibility shim.
Use extension API dependencies and plugin `apiRange` compatible with `2.0.0` for both
registration and structured-input migrations.

`LoopContext` is now `GenericLoopPorts & DefaultLoopConvenience`; its members and behaviour are
unchanged. `GenericLoopPorts` is the controlled-execution surface a replaceable Loop needs: model
`stream`/`complete` over `prepareRequest`, tool `execute`/`batch`/`resume`, `decisions`, effect
receipts, inputs (including the structured `system` field), events, checkpoints, `wait.park`/`wake`/
`delay`, jobs, children and `compaction`. `DefaultLoopConvenience` holds the coarse edges tied to
Core's ReAct stages: `turn.continuation`/`checkpoint`/`finishCancelled`/`finishFailure`,
`model.respond`, `tools.drain` and `wait.poll`. `GenericLoopFactory` is a `LoopFactory` whose
`create`/`resume` take only `GenericLoopPorts`. `@agnes/plugin-runtime/testkit` `driveLoop` gains
`decisions`, `effects`, `turnOpen` and `resumeParked` options plus a `scriptedDecisions` port.

## 1.6.0

Removed from the unpublished protocol `0.1.0` ledger contract: `approval/asked`,
`approval/decided`, `ApprovalAsked` and `ApprovalDecided`. Every human approval domain uses
`decision/state`; old ledgers are intentionally unsupported. Guardian machine facts retain
`approval/guardian-decided` with their complete tool-definition and policy binding.
The legacy Core ticket callback was removed; clients answer decision handles and revisions.

Adds `DecisionReviewPort`, extending the public DecisionPort with `review(spec, options)` for
one-shot operation candidates. Core handles approval delivery, verified human responses and
consumption. Detached or unavailable delivery withdraws the candidate; it cannot be approved
later or create reusable tool grants. Admitted Core operations receive it as `ctx.decisions`.
The official refine operation now reviews its exact edits and baseline through this port.

## 1.5.0

Adds an optional typed `InputPresentation` to `AgentInputPort.deliver`. Backend UI actions can retain full machine input while clients render a localized terminal summary. Input metadata does not grant actor, lane or tool authority; the service binding validates it and ordinary prompt RPCs do not accept it.

## Earlier preview repairs (included in 2.0.0)

The entries below preserve the pre-release record. Their historical version notes are
superseded by 2.0.0; the runtime contract and all shipped manifests now use that version.

`PluginGenerationStatus` adds `historical` for generations referenced only by saved sessions,
required generation `openSessions` / `live` fields, and plugin `historicalSessions` counts.
`boundSessions` still counts durable pins; `drainingSessions` still counts all non-current pins.
Consumers must distinguish open sessions from historical references. Historical snapshots retain
their pinned code while retired in-memory containers close after the configured idle timeout.
The unpublished protocol package version and extension API version remain unchanged.

Web styling now uses the canonical `tokens, base, vendor, ui, app, skin` cascade
layers. Client-module CSS loads in `app`; the host adopts skin CSS in `skin`,
so normal region-hook overrides also win over application ID selectors. Skin
manifest fields, token names, asset resolution and theme switching are unchanged.


Additive contract repairs: `@agnes/protocol` now exports the existing `UiArtifactFileData`
type from its root, without changing the schema, wire format or runtime exports.
`--agnes-scrollbar-thumb` joins the generated `THEME_TOKEN_NAMES` / `ThemeTokenName`
vocabulary and skin manifest allowlist; skins may override it in both light and dark modes.
Existing manifests remain valid and unknown tokens remain rejected. As with the adjacent
`--agnes-focus-ring-soft` token addition, these preview contract repairs retain extension API
`1.5.0` and the unpublished protocol package version.

Tool policy/runtime plugins now inject `providers` and register by kind through
`providers.register`. The named author services, plugin contexts and registration helpers
were removed. Read the combined `providers.catalog`; typed backend selection, execution
and cancellation/disposal remain with their owners.

Model adapter declarations and catalogs now require `wireApi`; the `api` alias was removed.
`Route.api` still selects the adapter registration id.

`DecisionPort` adds session-owned request/get/wait to ToolContext, LoopContext and admitted
ServicePorts. Its DTOs come from the protocol schema; `APPROVAL_DEFAULTS` holds the existing
approval configuration defaults. A checkpoint association can consume decision references
with the next phase. Community `PluginExtensionAPI.providers` now shares the official
owner-scoped service facade. Registration has no admitted session and refuses decision access.
These are unpublished preview changes; release versioning remains pending.

`ToolPolicyInput.workspaceRoot` is now required and Host-injected. `LoopContext.session`
adds the existing `SessionRef` identity. Tools and session-bound services reuse
`session.workspaceRoot`; non-session services must refuse operations that need an absent
workspace identity. The surface snapshot records these identity access paths separately
from runtime exports. `cwd` is an execution directory snapshot at call start, and may differ
from `workspaceRoot` in a future version. Use `workspaceRoot` to locate workspace-owned
state, policy and config. Session defaults remain equal today; explicit process overrides
never change identity or authority. Policy-input and Loop test fixtures must supply the new
required identity fields. No directory-change port or protocol event is added. These are
unpublished pre-freeze contract changes; `API_VERSION` stays `1.4.0` pending release versioning.

Git worktree types moved to `@agnes/git-worktree-contract`. The dedicated init field is removed.
Host registers `gitWorktreeKind`. The bundled subagent binds it. `API_VERSION` stays `1.4.0`.

Deferred tool-invocation queue and receipt types moved to `@agnes/plugin-runtime/deferred-contract`.
`LoopContext` no longer carries a dedicated queue field. A loop reads the session queue through the
generic `services` reader. `API_VERSION` stays `1.4.0`.

`defineServiceKind` and `ExtensionAPI.providers` add the shared service-provider contract. Host grants
on the existing provider registry supply the owner-scoped ledger, agent input, projection read, and
generation pin. Authors do not pass a package id. `API_VERSION` stays `1.4.0`.

`observabilityKind`, `ObservabilityProvider`, `ObservabilityHealth`, and `ObservabilitySession` moved
from this package to `@agnes/observability`. The exporter is a process-scoped service kind.

The runtime surface snapshot includes the preview plugin config helpers
(`DEFAULT_PLUGIN_CONFIG_RELOAD`, `PLUGIN_SECRET_REF_PATTERN`, `compilePluginConfig`,
`redactPluginConfig`) and `webhookTriggerKind`.
The reserved feedback event constants and the feedback service factory moved to `@agnes/host`.
Release versioning remains pending.

Intelligent UI types moved to `@agnes/intelligent-ui-contract`. `ExtensionAPI.intelligentUi` is removed.
The official plugin registers `intelligentUiKind` and tools bind it with `providers.bindOwn`.
Session actions still require the existing events and `surfaces` grants and confer no execution
authority; delivery stays on the generic deferred-invocation contract.

`memoryKind` adds an optional, versioned session memory provider with per-turn snapshots,
ordinary file ports and explicit human editing. `memoryPrivateEvent` exports structural event
facts while omitting memory-derived payloads. Existing hosts without a provider keep their
ordinary file behavior; the official file provider defaults to off. These are unpublished
preview additions; release versioning follows the policy below.

The Node-only `@agnes/extension-api/mcp-naming` subpath shares stable MCP naming
helpers with Base and Host. Root runtime exports remain unchanged.

Loop factories now accept an optional construction signal and return a driver or Promise; callers
must await create/resume. Sandbox create accepts an optional signal, and persistence open options
accept `signal`. Existing synchronous factories remain valid. Host drains constructors, disposes
late cancelled/invalid results and preserves cleanup failures. Store I/O remains noncancellable.

Model adapter config adds optional instance/provider identity and a live credential resolve/rejection
port (`ModelAdapterCredential`). Official API-key/OAuth adapters use the public create path; no
builtin factory bypass remains. Experimental `createCompactionThreshold` and `defaultToolPolicy`
share the existing algorithms without importing Core. Named provider admission/resolution errors use
ProviderError; session `E_LOOP_MISSING`, sandbox execution `SANDBOX_UNAVAILABLE` and ledger recovery
codes remain consumer compatibility boundaries. See the bilingual v0.1 contract inventory.
These are unpublished preview changes; API_VERSION/package versions remain 1.4.0 until release
versioning is decided. This entry does not authorize publication under an unchanged released version.


`HookReturnMap.before_step` gains optional `park?: boolean`: a pending interaction ends the turn as
parked before another inference request. Blocking still takes precedence when both directives are set.
`SearchProvider.search(queries, { signal, timeoutMs }): Promise<SearchResult[]>` is an additive
deployment-owned search interface; the Host passes it only to the official web-tools factory.
`tool.card.inline` accepts optional typed question and deliverable payloads. Existing payloads remain
valid, and clients submit answers through ordinary user messages using the shared protocol helpers.


`definePersistenceProvider` publishes a session persistence provider. The store methods are the ones Core's
log storage uses: `open`, `commit`, `renew`, `release`, `scan`,
`registers` and `close`. Optional SQL tables are exposed only under `store.sqlite`. `DEFAULT_PERSISTENCE_PROVIDER_ID` is `sqlite`. `PERSISTENCE_SCAN_PAGE_MAX`
is 500, the same page cap as a log scan. `PERSISTENCE_EFFECT` is `restart-required`: selecting another id
applies on the next process start. `persistenceRegisterKey` and `isPersistenceTombstone` spell register cells
the same way Core does. `API_VERSION` stays 1.4.0.

A full Host now requires ledger, metadata, child-control, reclaim and integrity, with SQLite optional.
Package seam storage gains owner-bound `namespace(name): PersistenceMetadataNamespace`; the legacy
SQL table surface refuses explicitly when unsupported. The Vitest testkit adds
`persistenceHostContract(name, create)` for durable metadata, integrity/op-state, child CAS, exact
budgets and reclaim. Store port signatures remain compatible. JSONL is a complete example provider.

`ToolContext` gains the optional read-only `defaultTimeoutMs`: the preset-wide default for a tool call
(`tools.timeout_ms`), next to `timeoutMs`, which is this call's own limit. A tool that lets a caller ask for
more time uses the default when asked for nothing and caps a request at `timeoutMs`; the `shell` tool does.
It is optional so code that builds a `ToolContext` itself keeps compiling, and a tool must cope with its
absence.

`ExecResult` gains the optional `timedOut`: true when the executor's own deadline was the first cause to cut
the command short, so the process was killed and the output is what it had printed so far. It is mutually
exclusive with a caller cancel (whichever came first is the cause), and absent means the executor did not
say, so an `exec` implementation or test double that never sets it keeps conforming. `ToolContext.timeoutMs`
is now documented as a soft deadline: the kernel hands a tool the call's limit minus a short grace
(`min(2000, limit / 10)` ms) and cuts the call off at the full limit, so a tool that honours
`ctx.timeoutMs` can return its own result before the kernel's cut-off. The value a tool sees only gets
smaller; no limit is raised.

`ToolContext` gains the read-only `outputMaxBytes`: the most text of one tool result the model sees before
the output guard cuts it. The kernel fills it from the Preset key `tools.output_max_bytes` (integer,
4096 to 1048576, default 32768 where it was a fixed 8192), next to `timeoutMs`. A tool that sizes its own
output against it follows the deployment instead of a constant. `DEFAULT_OUTPUT_MAX_BYTES`,
`MIN_OUTPUT_MAX_BYTES` and `MAX_OUTPUT_MAX_BYTES` are new runtime exports. The addition is not breaking
for tool authors; code that builds a `ToolContext` itself (test doubles, adapters) must now supply the
field.

The `before_provider_headers` hook event is removed: the kernel never dispatched it, so no handler could
have run. The public table now has sixteen events, and registering the old name is refused with an
invalid-registration error. This is a removal that would normally call for a major version; the project
is pre-alpha with no published package and no known external plugin, so `API_VERSION` stays at 1.4.0 and
the change is recorded here instead.

Migration: delete `before_provider_headers` from any manifest `capabilities.hooks`, lockfile or Preset
`hooks` entry (each now fails validation with an unknown-event error) and remove any `registerHook` call
for it. Provider request headers are not an extension point; the only mechanism is the static `headers`
field on a model record.

`checkToolDef` now bounds what a model is shown: a description of at most `TOOL_DESCRIPTION_MAX_LENGTH`
(4096) UTF-16 code units, and a parameter schema of at most `TOOL_PARAMETERS_MAX_BYTES` (262144)
serialized bytes and `TOOL_PARAMETERS_MAX_DEPTH` (32) levels, root at depth 0. Symbol keys are ignored,
so TypeBox schemas are measured as the JSON a provider receives; a cyclic schema is reported. A tool
outside these bounds now fails registration with the problem named, where it used to register and then
break every request. The three constants are new runtime exports.

## 1.4.0

- Add optional, session-bound deferred tool invocations and a generic Loop drain through the existing tool policy/approval ports.

- Add the passive `ObservabilityProvider` contract and `observabilityKind` for opt-in telemetry on public committed events and lifecycle ports.

- Optional `ToolContext.pluginManage` port for approved AGH plugin authoring and installation. Host controls identity, invocation lifetime and native approval.

## 1.3.0

Ordinary trusted plugin tools may receive optional `ToolContext.mcpManage.request`. The Host binds requests to live main-conversation invocations; the daemon validates them and owns native approval. This is not a general admin client. Availability depends on the host, and removing the plugin revokes its live tool context. Additive local API version bump; no public release is implied.

## 1.2.0

Additive: `PluginExtensionAPI` (the `ctx.extension()` facade a third-party plugin row receives) gains
`registerHook`, mirroring `ExtensionAPI['registerHook']` — a plugin row may now register on any of
the seventeen hook events and participate in the transform/intercept chain, not just the seven
observe-only ones `on` already covered. `on` is unchanged and stays the simplified observe-only
entry. No new runtime export; `PluginExtensionAPI` is a type. See [hook types](../src/hooks.ts).

B1-A adds `TRANSPORT_CONTRACT_CASES` and its fixture/case types to the optional
`@agnes/extension-api/testkit` entry. Fixtures supply their own remote commands; the suite does not
require a particular interpreter. The negotiated root author API is unchanged. The fixture includes
`commands.readRelative`, used to verify per-command cwd by reading different markers through the same
relative path in two directories.

## 1.1.0

Additive: every author context gains a read-only `platform` member (`PlatformView` on ToolContext
and ServiceContext, `PlatformFacts` on HookContext and ExtensionContext), and `ToolContext.sandbox`
gains `enforcement(): SandboxEnforcement`. No runtime export changes; no manifest capability key is
added. Which of the eleven seams an extension may reach, at which moment and through which gate,
is documented in [the seam reference](seams.md).

## 1.0.0

Initial contract under implementation: six controlled register methods, events and ctx. It includes tool metadata and context, seventeen hook contracts, four UI slots, resource and manifest types, error codes, stable API range checks and the optional fixture authoring entry. S2/P3 add Service and Projection types, Service metadata validation, lease scopes and testkit samples. Generated references describe wire schemas; Host dispatch and invocation readers are accepted separately. This private workspace change is not an API release.

- Intelligent UI adds `IntelligentUiPorts.invocationId(toolUseId)` and `IntelligentUiService.submittedInput` for authenticating the existing deferred form collector. They confer no execution or approval authority.
