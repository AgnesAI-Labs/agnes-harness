# Zero-build local plugins

English | [简体中文](local-plugins.zh-CN.md)

[Author guide](README.md) · [Build a plugin by asking the agent](agent-built-plugins.md)

The daemon discovers immediate plugin directories under `<AGNES_HOME>/plugins/<name>/` and `<workspace>/.agh/plugins/<name>/`. `<AGNES_HOME>` means the configured runtime home (the CLI uses `AGH_HOME`); the workspace is the daemon startup workspace, not every session cwd. Folder names use lowercase letters, digits, dots, underscores and hyphens.

A folder can contain a normal package with `package.json`, `agnes.plugins` and a source entry:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": "./src/index.ts",
  "agnes": {
    "plugins": [{ "apiRange": "^1.4.0", "export": "main", "id": "ext:my-plugin/main", "inject": ["extension"] }]
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
    costHint: undefined, deferLoading: undefined,
  },
  async execute({ name }, ctx) {
    ctx.signal.throwIfAborted()
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] }
  },
})
```

The existing jiti transpiler loads TypeScript on demand. No compilation step is needed. Declare the source export explicitly; a missing `dist/index.js` is an error, not an implicit fallback. Author helpers and TypeBox resolve to the Host namespaces. Third-party dependencies must already be resolvable by the runtime; local discovery does not install dependencies. `node_modules` and `.git` are excluded from source snapshots, and symlinks inside plugins are refused.

Placing source in either configured local root opts it into trusted in-process execution. First discovery installs, trusts and enables it through the package store; existing disabled choices are preserved. Do this only for code you intend to execute. Session tool approvals govern plugin-creator operations and later tool calls; they do not sandbox the module's initialization code. Package identity collisions are errors; neither root silently overrides an installed package.

Open `/admin/plugins` to see source `local`, desired installed/enabled state, and activation failures with a fix hint. Malformed folders are shown as failed even before a successful installation. Changes are debounced and copied into a new immutable package snapshot. Removing a source folder disables its future binding and retains installed/pinned bytes for recovery.

See [hot reload](hot-reload.md) for manual commands and cold-resume behavior. The watcher uses the generation owner's `LocalPluginReload.reloadPlugin(id)` interface. The daemon binds that interface to its existing target publication path. Changed source activates for new sessions after the worker confirms the target; existing sessions keep their generation. Base backends still require restart. Startup publishes through the merged session-generation mechanism, preserving old session snapshots. It does not replace tools inside a running session. Failed reloads retain the previous activation and report the local source failure.

For embedders, configure `createPackageManager({ localPlugins: localPluginRoots(home, workspace), ... })`, call `refreshLocalPlugins(profileDir)` at startup, then `watchLocalPlugins(profileDir)`. Bind the generation service with `bindLocalPluginReload({ reloadPlugin })`; close the watcher during shutdown. The reload implementation must publish the new snapshot/desired package state through the generation owner, including deletion or disabling, and reject on failure.
