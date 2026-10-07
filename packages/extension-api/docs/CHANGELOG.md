# Extension API changes

API additions require a minor version; removals or semantic changes require a major version and migration notes. This file records the initial contract under implementation. Local consistency checks do not establish release readiness or authorize publication.

## Unreleased

`definePersistenceProvider` publishes a session persistence provider. The store methods are the ones Core's
log storage and the host package tables already use: `open`, `commit`, `renew`, `release`, `scan`,
`registers`, `tables`, and `close`. `DEFAULT_PERSISTENCE_PROVIDER_ID` is `sqlite`. `PERSISTENCE_SCAN_PAGE_MAX`
is 500, the same page cap as a log scan. `PERSISTENCE_EFFECT` is `restart-required`: selecting another id
applies on the next process start. `persistenceRegisterKey` and `isPersistenceTombstone` spell register cells
the same way Core does. `API_VERSION` stays 1.4.0.

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
