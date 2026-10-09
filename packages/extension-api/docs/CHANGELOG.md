# Extension API changes

API additions require a minor version; removals or semantic changes require a major version and migration notes. This file records the initial contract under implementation. Local consistency checks do not establish release readiness or authorize publication.

## Unreleased

The runtime surface snapshot includes the preview plugin config helpers
(`DEFAULT_PLUGIN_CONFIG_RELOAD`, `PLUGIN_SECRET_REF_PATTERN`, `compilePluginConfig`,
`redactPluginConfig`), the two reserved feedback event constants, and `webhookTriggerKind`.
They add author contracts without removing existing exports; release versioning remains pending.

`ExtensionAPI.intelligentUi` adds an optional owner-bound factory adapter for namespace-bound ledger
projections and idempotent SC1 delivery. It requires existing events/projection grants and provides
no execution authority; actions use the generic deferred-invocation contract.

`memoryKind` adds an optional, versioned session memory provider with per-turn snapshots,
ordinary file ports and explicit human editing. `memoryPrivateEvent` exports structural event
facts while omitting memory-derived payloads. Existing hosts without a provider keep their
ordinary file behavior; the official file provider defaults to off. These are unpublished
preview additions; release versioning follows the policy below.

The Node-only `@agnes/extension-api/mcp-naming` subpath shares stable and legacy MCP naming
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

Initial contract under implementation: six controlled register methods, events and ctx, plus the existing optional latestExtEvent reader. It includes tool metadata and context, seventeen hook contracts, four UI slots, resource and manifest types, error codes, stable API range checks and the optional fixture authoring entry. S2/P3 add Service and Projection types, Service metadata validation, lease scopes and testkit samples. Generated references describe wire schemas; Host dispatch and invocation readers are accepted separately. This private workspace change is not an API release.

- Intelligent UI adds `IntelligentUiPorts.invocationId(toolUseId)` and `IntelligentUiService.submittedInput` for authenticating the existing deferred form collector. They confer no execution or approval authority.
