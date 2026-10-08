# Developing plugins with hot reload

English | [简体中文](hot-reload.zh-CN.md)

[Author guide](README.md) · [Local plugins](local-plugins.md) · [Package management](../guide/packages.md)

For a package folder below the daemon startup workspace, declare its source entry in `package.json` and run:

```sh
agh dev ./my-plugin --profile local-dev
# Edit the source, then:
agh plugins reload my-plugin --profile local-dev
# Or reload every enabled local/file package:
agh plugins reload --profile local-dev
```

`dev` inspects, installs if necessary, trusts the inspected revision and enables it. It explicitly authorizes executing that local package. File sources stay relative to the daemon startup workspace; an absolute CLI path is accepted when it is inside that workspace. Start the daemon from the same workspace as the command. Identity collisions and inspection blockers remain errors. File packages need `package.json`; use the [local plugins folders](local-plugins.md) for a bare `plugin.ts` or `plugin.js`.

For automatic reload, use the existing local roots: `<AGNES_HOME>/plugins/<name>` or `<workspace>/.agh/plugins/<name>`. Their watcher copies changed bytes and calls the daemon's generation publication adapter. The manual command also supports these discovery-owned packages. Removing a folder disables future bindings. Reload preserves disabled choices; use `dev` or admin Enable to activate a disabled package.

## What changes for sessions

A successful activation publishes an immutable generation with enabled package versions, executable trees and client bundles. New sessions use it. Existing sessions keep their executable tools, loop/adapter selection and frontend bundle URLs, including after hibernation, cold resume and worker/daemon restart. MCP definitions and Skills are live resources, filtered by the session composition and trust. Updates become visible at the next turn; the current turn retains its snapshot. Disabling or removing an MCP server removes it from subsequent turns of retained sessions. A version number need not change to reload edited bytes.

The browser roster is session-aware: sessions use `/plugins/generations/<generationId>/…` URLs. Switching to a new session reconciles the matching bundle. Reload does not replace a running session's UI or apply code at its next turn.

Old generations remain while any durable session references them. Close/hibernation retain pins. Disable/uninstall stops new bindings and collects only unreferenced generations. Admin shows `Draining (N)`, including packages removed from inventory. `boundSessions` counts all pins; `drainingSessions` counts pins outside the current generation. There is no public session-delete command yet; backend deletion owners must release the pin after actual deletion.

## What needs restart

Persistence/storage providers, sandbox and other process backends stay `restart-required`. Package reload cannot replace them. Restore checks deployment compatibility and the persisted loop id/version. Missing snapshots, changed resource archives or incompatible deployments produce explicit `E_GENERATION_*` errors without substituting current code.

MCP definitions, revisions and SecretRefs come from current resources on cold resume; secrets are resolved only when connecting. Deployment transport policy still applies. Resume uses pinned code and current Skills, and waits for initial MCP catalog synchronization with a bounded timeout (currently 20 seconds). Historical resource archives are evidence, not the live read source. Unchanged effective MCP configurations can share connections within the worker and opener/policy/credential boundary; connections are not shared across workers or credential scopes.

## Recovery boundaries

Stable invocation identities fence uncertain dispatch and recover recorded responses. They do not guarantee exactly-once external effects or an atomic transaction with an external tool. A model send without a durable complete receipt remains uncertain; reconcile it before replay. Checkpoint associations are not external-effect commits. Atomic ledger commits do not establish power loss durability for every backend or filesystem; that requires backend-specific fsync and platform qualification. See the [contracts](../develop/contracts-v0.1.md).

Core stores a version-1 `x/core/tool-response` beside `tool/result` in the same ledger commit. It preserves the author response content (including artifact references), optional `isError`, `structured`, `details` and `terminate`. Recovery reads that representation before the driver's receipt. Legacy rows recover only persisted ledger content, `isError` and `structured`; missing author metadata cannot be reconstructed. Loop invocation receipts must have trusted Core provenance and match the pinned loop id/version. Legacy receipts without that binding refuse reconciliation with `E_RELATION`, rather than redispatching an uncertain operation.

Loop `events.emit` accepts non-reserved `x/*` events and records untrusted plugin provenance. Use typed ports such as `events.assistant(message, checkpoint)` for assistant messages and control operations. Direct ledger/control emission and `x/core/*` are rejected.

## Embedding and status

```ts
const result = await host.reloadPlugin?.('my-plugin', '/absolute/source/folder')
// { generationId, changed }; omit the folder on subsequent calls.
// Or configure HostOptions.developmentPluginDirectories for reloadPlugin(id).
const status = host.pluginGenerationStatus?.()
// currentGenerationId, generations[{ id, state, boundSessions, packages }],
// plugins[{ id, state, boundSessions, drainingSessions }]
```

`reloadPlugin(id, directory?)` inspects a trusted development package and publishes its complete target, including client rows. The caller owns authorization of that directory. It preserves configuration and disabled rows; same-byte reload returns `changed: false`. Rejection retains the previous head.

Production daemon publication uses its persisted package/target coordination path. Embedders bind PackageManager's `bindLocalPluginReload({ async reloadPlugin(id) { … } })` to that path; a direct Host adapter can await `host.reloadPlugin(id)` when sources are already staged. Persist desired state as well as session pins when recovering the current head matters.

Node admin clients call `client.packages.generations({ profile })`; read-only RPC `_agnes/v1/plugins.generations` and local BFF `POST /admin/plugins/api/generations` require `packages.read`. `packages.list` also includes optional generation status and per-package counts. Errors expose stable codes; executable source, Skills bodies and resolved secrets never appear in the status DTO.
