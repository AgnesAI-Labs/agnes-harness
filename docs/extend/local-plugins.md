# Zero-build local plugins

English | [简体中文](local-plugins.zh-CN.md)

[Author guide](README.md) · [Build a plugin by asking the agent](agent-built-plugins.md)

The daemon discovers immediate plugin directories under `<AGH_HOME>/plugins/<name>/` and `<workspace>/.agh/plugins/<name>/`. `<AGH_HOME>` means the configured runtime home (the CLI uses `AGH_HOME`); the workspace is the daemon startup workspace, not every session cwd. Folder names use lowercase letters, digits, dots, underscores and hyphens.

For a fresh home, let `agh daemon start` initialize it while empty before creating its `plugins/` folder. Home-root plugins use discovery and the existing rescan/reload controls. `agh dev FOLDER` currently requires a folder below the daemon startup workspace, so use the [workspace tutorial](quickstart.md) for that command; pointing it at an external home plugin is refused.

A folder can contain a normal package with `package.json`, `agnes.plugins` and a source entry:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": "./src/index.ts",
  "agnes": {
    "plugins": [{ "apiRange": "^5.0.0", "export": "main", "id": "ext:my-plugin/main", "inject": ["extension"] }]
  }
}
```

Or it can contain just `plugin.ts` or `plugin.js`, with a default export (or `main`) created by `defineTool` or `defineAgnesPlugin`:

```ts
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export default defineTool({
  name: 'local_hello',
  description: 'Say hello.',
  parameters: Type.Object({ name: Type.String() }),
  meta: {
    isReadOnly: true, isDestructive: false, isConcurrencySafe: true,
    isOpenWorld: false, replay: 'safe', requiresApproval: 'never',
  },
  async execute({ name }, ctx) {
    ctx.signal.throwIfAborted()
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] }
  },
})
```

Tool parameters must have an object root. A `Type.Module(...).Import(...)` is accepted when its root resolves to an object in its own `$defs`; the pi model adapter inlines that root before sending it to a provider. Other root types, missing definitions and root reference cycles fail registration with the owning plugin and tool identified, rather than causing a provider request to fail.

The existing jiti transpiler loads TypeScript on demand. No compilation step is needed. Declare the source export explicitly; a missing `dist/index.js` is an error, not an implicit fallback. Author helpers and TypeBox resolve to the Host namespaces. Third-party dependencies must already be resolvable by the runtime; local discovery does not install dependencies. `node_modules` and `.git` are excluded from source snapshots, and symlinks inside plugins are refused.

Source deliberately placed in the runtime home plugins folder opts into trusted execution. Repository `.agh/plugins` folders are inventoried without importing their code and start disabled and untrusted. Open Settings → Runtime details → Local plugins, review the repository plugin count and confirm Trust; the SDK/API uses `packages.trustWorkspace` with the offered repository path. Rescan loads the approved snapshot for new sessions. Editing repository plugin bytes withdraws trust and requires another confirmation; unchanged reviewed plugins retain their disabled choices. The confirmation also binds the current `.agh/hooks.json` digest. Changed hooks do not run until reviewed again. Plugins are fully trusted code running with the user’s rights. Session tool approvals govern plugin-creator operations and later tool calls; they do not sandbox the module's initialization code. Package identity collisions are errors; neither root silently overrides an installed package.

Open `/admin/plugins` to see source `local`, desired installed/enabled state, and activation failures with a fix hint. Malformed folders are shown as failed even before a successful installation. Changes are debounced and copied into a new immutable package snapshot. Removing a source folder disables its future binding and retains installed/pinned bytes for recovery.

See [hot reload](hot-reload.md) for manual commands and cold-resume behavior. The watcher uses the generation owner's `LocalPluginReload.reloadPlugin(id)` interface. The daemon binds that interface to its existing target publication path. Changed source activates for new sessions after the worker confirms the target; existing sessions keep their generation. Base backends still require restart. Startup publishes through the merged session-generation mechanism, preserving old session snapshots. It does not replace tools inside a running session. Failed reloads retain the previous activation and report the local source failure. A reload that only found the profile lock busy is not a plugin failure: the plugin stays marked for reload and Rescan retries it. A scan that fails makes Rescan report the error, and the watcher retries it a few times.

For embedders, configure `createPackageManager({ localPlugins: localPluginRoots(home, workspace), ... })`, call `refreshLocalPlugins(profileDir)` at startup, then `watchLocalPlugins(profileDir)`. Bind the generation service with `bindLocalPluginReload({ reloadPlugin })`; close the watcher during shutdown. The reload implementation must publish the new snapshot/desired package state through the generation owner, including deletion or disabling, and reject on failure.

The local repository offer includes `trustHash`. Pass it as `expectedHash` to `packages.trustWorkspace`; missing or stale hashes refuse trust with `E_PACKAGE_PREVIEW_STALE`. Repository package lifecycle scripts, Skill helper code and repository MCP JSON are not automatically executed at startup. Managed MCP processes still require their separate explicit authorization.
