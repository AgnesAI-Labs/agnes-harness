# Extension API changes

API additions require a minor version; removals or semantic changes require a major version and migration notes. This file records the initial contract under implementation. Local consistency checks do not establish release readiness or authorize publication.

## Unreleased

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
