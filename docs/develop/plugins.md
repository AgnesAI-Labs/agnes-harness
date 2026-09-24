# Plugin development: bring your capabilities into AGH

English | [简体中文](plugins.zh-CN.md)

<a id="插件开发把你的能力接入-agh"></a>

[Documentation](../README.md) · [Backend tool tutorial](backend.md)

Turn a business function into an agent tool, capture a task method as a Skill, or add your own workbench interface. AGH provides extension entry points and a package lifecycle so you can grow from one plugin into an application. Choose an entry point below, then learn how dependencies and execution fit together.

<a id="在会话中创建第一个插件"></a>

## Create your first plugin in a session

The default-enabled `@agnes/plugin-helper` can turn a request into an AGH tool, Skill, or skin plugin. For example:

> Create an AGH plugin that counts words in text, and install it in the current AGH instance.

The helper reads the development guide and templates bundled with the current version, saves source under `.plugin-helper/<random-directory>` in the current workspace, and returns package identity, capabilities, and content hashes. After installation confirmation, AGH installs, trusts, and enables that code through the normal package-management flow. Inspect actual state under Settings → Plugin management → Installed. New capabilities become available at turn boundaries; check status and call the new tool in the next turn.

Creating source does not install a plugin. Inspection validates package structure and declarations, and confirmation applies to the specific code identified by its hash. Enabling it runs JavaScript with local process privileges. Review the generated source before installation.

The session helper currently supports self-contained text ESM tool/Skill plugins without external dependencies, and pure CSS/token skins. It does not overwrite an existing package with the same name or publish packages automatically. Skins can be selected in appearance settings, support light/dark modes, and revert to the default when disabled. The helper reads the `kind: skin` template without needing to locate source examples. For interactive frontend interfaces, services, dependency builds, or version updates, use the relevant tutorial and standard package workflow below. Disabling or removing the helper does not affect other installed plugins.

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

See [MHS and devices](../guide/mhs.md) for the physical-device direction; integration documentation and examples are coming soon. The table covers existing software extension entry points.

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
      { "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
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

Dependency names must agree between static declarations and exported metadata. The backend loader needs the dependency graph before executing arbitrary modules. `provide` must also match on both sides. Include every required build artifact. A local TypeScript deep path or an unpackaged dependency does not form a portable immutable snapshot.

<a id="配置依赖与清理"></a>

## Configuration, dependencies, and cleanup

`defineAgnesPlugin()` preserves types; it grants no additional permissions. A plugin can declare Standard Schema `Config`, which the loader validates. [cordis-greeting](../../examples/packages/cordis-greeting/index.ts) demonstrates configuration validation, `provide`, and service values. [hot-service](../../examples/packages/hot-service/v1/index.mjs) demonstrates installable ESM without external imports.

A value published by `ctx.provide('name', value)` belongs to the current Context's service space, and consumers declare `inject`. Dependencies determine loading order; array order does not replace the graph. Register manually acquired timers, connections, and listeners with `ctx.effect(() => disposer)`. Disposers withdraw resources on unload; they cannot automatically reverse completed external business actions.

<a id="不同-api-不可混用"></a>

## Keep API boundaries distinct

| Interface | Capabilities | Boundary |
| --- | --- | --- |
| Ordinary Cordis Context | Plugins, services, events, and effect lifecycle | In-process services do not automatically become cross-process RPC |
| `ctx.extension()` / PluginExtensionAPI | Tools, `on` observation hooks, `registerHook` transform/intercept hooks, and constrained events | Cannot register Service/Projection/Slot/Resource through this API; runtime permissions and ordering still apply |
| `ctx.skills` | Runtime Skill contributions and providers | Cannot read/enumerate other Skills; separate from disk governance |
| Row `ctx.services` / `ctx.slots` / `ctx.projections` / `ctx.resources` | Corresponding contributions on verified rows, cleaned up with the row fiber | Not unconditional global objects; service calls still require identity, session, and client allow-list checks |
| Browser ClientContext | Declared slots, frontend services/commands, and constrained backend service relay | No Host Context, Node system capabilities, or daemon management credentials |

The [full-stack tutorial](fullstack.md) uses `ctx.services.register()` and `agnes.clientDescriptors` on the same trusted Cordis row. It does not turn `ctx.provide()` into a remote method or bypass restrictions with `ctx.extension().registerService()`.

Current source exposes all 17 hook types through `registerHook` and routes ordinary third-party backends through `agnes.plugins` rows. Legacy `agnes.extensions` is no longer an ordinary third-party backend entry. Built-in compatibility rules differ from third-party authoring rules. Check current source, package preview, and actual row state for registration and authorization.

<a id="前后端生命周期"></a>

## Frontend and backend lifecycles

Host's ordinary tree and the Web page create separate Contexts. `web:` is a platform-synthesized client-row namespace; package authors must not declare it in `agnes.plugins`. These rows remain in the complete runtime target but do not execute as ordinary Host rows.

Third-party runtime sources require trusted immutable snapshots. An arbitrary file path is not an installed, trusted row. Host manages constrained live-tree transactions, while Web reconciles roster revisions. Unsupported static-component replacement, orphaned dependencies, expired leases, and unauthorized operations must be refused.

Next: [Backend tools](backend.md) · [Frontend panels](frontend.md) · [Full-stack integration](fullstack.md) · [Installation and updates](../guide/packages.md).

Source: [author types](../../packages/plugin-runtime/src/author.ts), [manifest parsing](../../packages/package-manager/src/plugin-manifest.ts), [PluginExtensionAPI](../../packages/extension-api/src/plugin-extension.ts), [row API](../../packages/host/src/ext-host/row-extension-api.ts), [ClientContext](../../packages/web-client/src/client-module.ts).
