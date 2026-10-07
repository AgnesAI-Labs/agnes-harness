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

For automatic reload, use the existing local roots: `<AGNES_HOME>/plugins/<name>` or `<workspace>/.agnes/plugins/<name>`. Their watcher copies changed bytes and calls the daemon's generation publication adapter. The manual command also supports these discovery-owned packages. Removing a folder disables future bindings. Reload preserves disabled choices; use `dev` or admin Enable to activate a disabled package.

## What changes for sessions

A successful activation publishes an immutable generation with enabled package versions, executable trees, client bundles and private resource views. New sessions use it. Existing sessions keep their tools, loop/adapter selection, MCP definitions, Skills view and frontend bundle URLs, including after hibernation, cold resume and worker/daemon restart. A version number need not change to reload edited bytes.

The browser roster is session-aware: sessions use `/plugins/generations/<generationId>/…` URLs. Switching to a new session reconciles the matching bundle. Reload does not replace a running session's UI or apply code at its next turn.

Old generations remain while any durable session references them. Close/hibernation retain pins. Disable/uninstall stops new bindings and collects only unreferenced generations. Admin shows `Draining (N)`, including packages removed from inventory. `boundSessions` counts all pins; `drainingSessions` counts pins outside the current generation. There is no public session-delete command yet; backend deletion owners must release the pin after actual deletion.

## What needs restart

Persistence/storage providers, sandbox and other process backends stay `restart-required`. Package reload cannot replace them. Restore checks deployment compatibility and the persisted loop id/version. Missing snapshots, changed resource archives or incompatible deployments produce explicit `E_GENERATION_*` errors without substituting current code.

MCP generations persist definitions, revisions and SecretRefs, reconstruct factories on cold resume, and resolve secrets only when connecting. Deployment transport policy still applies. Skills bodies, indexed files and directories are copied privately; scoped workspace views are pinned when the session first opens. Missing credentials or rejected transport policy can still prevent connection.

Custom dynamic extensions can supply declarative `generation` metadata and a Host `restoreGenerationExtension` callback. Custom Skills inputs can supply `generationSnapshot()`. Without restorable input, live generations can run, but cold resume refuses with `E_GENERATION_FACTORY_UNAVAILABLE` or `E_GENERATION_SKILLS_UNRESTORABLE`. Custom authorization cannot be serialized.

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
