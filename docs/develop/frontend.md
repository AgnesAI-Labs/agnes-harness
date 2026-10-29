# Frontend plugins: add a workbench interface

English | [简体中文](frontend.zh-CN.md)


<a id="前端插件为工作台增加一个界面"></a>

[Documentation](../README.md) · [Plugin lifecycle](../guide/packages.md)

Display your own panel, update its version, and confirm that disabling it removes the added view. Learn the lifecycle first, then replace the version label with content useful for the role.

Reuse [client-panel/v1](../../examples/packages/client-panel/v1/package.json). It displays a version label in the supported `workbench.panel` slot; v2 tests page updates. This is a browser contribution path, distinct from slot registration through ordinary Host `ctx.slots`.

<a id="声明和代码"></a>

## Declaration and code

The package declares a backend Cordis row with `agnes.plugins`, then binds a browser descriptor to the same row ID through `agnes.clientDescriptors`. The descriptor's `client` section is:

```json
{
  "client": {
    "entry": "./client/index.js",
    "lifetime": "profile",
    "styles": ["./client/index.css"],
    "slots": ["workbench.panel"],
    "publicConfig": { "label": "Agnes client module demo · v1" },
    "services": [],
    "projections": []
  }
}
```

If the client uses `streams`, declare each stream in the bound backend row's `capabilities.streams`. Inspection and packing validate against that row's capabilities; a sibling row's declarations do not authorize the client. Stream scope changes require a new trust decision.

See [package.json](../../examples/packages/client-panel/v1/package.json) and the complete [agnes.client.json](../../examples/packages/client-panel/v1/extensions/main/agnes.client.json). The client entry is resolved relative to the descriptor and must be native ESM executable by the browser:

```js
export function apply(ctx, config) {
  ctx.slots.register(
    'workbench.panel',
    () => config.publicConfig.label,
  )
}
```

This view position appends a workbench panel. Disabling the contribution synchronously removes it. This profile contribution follows the current activation; use a separate session descriptor for pinned recorded renderers. Use a presentation takeover only when replacing an entire experience. Do not assume unexposed regions can be replaced or depend on private Host DOM/CSS structure.

If a view position is declared by another region when it mounts, wrap registration in `ctx.slots.inject(name, () => ctx.slots.register(...))` and retain the returned cleanup. The factory returns the registration cleanup; removing the parent revokes the entry, and rebuilding it registers the current owner again. A supported slot name is not proof that its outlet currently exists. Keep independent panels and data subscriptions outside the factory, and dispose the injection when its role is replaced. Session modules may wait only for their declared public session slots at the reviewed slot catalog version; teardown removes pending injections as well as registered entries. Unknown or unauthorized slots remain refused.

Browser failure diagnostics retain a safe error code, package, presentation role and failure phase, without plugin exception text. A display failure does not mean saved deliverables are absent. Reload retries the currently authorized presentation; it does not grant trust or choose another package.

`publicConfig` is public presentation metadata from package contents, not backend runtime configuration. Client entry/styles must be validated paths inside the package. They cannot escape the snapshot, import arbitrary local modules, or obtain connection credentials. Use the host platform externals for React and shared Agnes packages; bundle only other dependencies into browser artifacts.

The browser singleton allowlist is [`CLIENT_PLATFORM_IMPORTS`](../../packages/protocol/src/client-platform-imports.ts), including React, the client/UI APIs, browser SDK/protocol and the optional public presentation renderers. See [Build a presentation plugin](../extend/presentations.md) for exact exports and build instructions. These exact imports resolve through the HTML import map; an external package name does not imply arbitrary mapped subpaths. Distribution packaging rejects unresolved emitted externals.

<a id="安装与观察"></a>

## Install and inspect

Run from the repository root using an isolated instance:

```sh
node agnes.mjs package inspect file:./examples/packages/client-panel/v1
node agnes.mjs install file:./examples/packages/client-panel/v1
```

Trust and enable using hashes from the preview, then open Web for the same instance and create a new session. You should see v1. Update to `file:./examples/packages/client-panel/v2` through Web management or TUI, complete its trust/enable steps, and create another session to check v2. Return to the first session to confirm that this profile contribution follows the current activation and shows v2 there too. Disable the package and confirm that its additional view disappears immediately; management navigation stays available.

Package desired=enabled, backend web row ready, and successful loading in this page are distinct stages. A closed browser, failed script/CSS fetch, unauthorized slot, or exception in apply can prevent frontend activation. Inspect per-row actual state as well as package enablement.

<a id="验证"></a>

## Verification

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

These tests check actual example ESM, Cordis bindings, slots, cleanup, and update failure handling. Without a browser, they are not real rendering acceptance. See [verification](../maintainers/verification.md) for browser coverage and source-candidate results.

Next: [Connect a backend service to the panel](fullstack.md). Declare public configuration fields and callable services separately. Keep secrets on the backend.

Implementation: [loading coordination](../../packages/web/src/client-modules/reconcile.ts), [ClientContext](../../packages/web-client/src/client-module.ts), [asset checks](../../packages/package-manager/src/client-assets.ts), [slots](../../packages/web-client/src/slots.ts).

## Consistent interfaces

Follow the [short UI author guide](ui-author-guide.md): shared components and `.agh-btn*` contracts, contextual workbench tabs, settings groups and Intelligent UI summaries. Settings has four everyday groups (General, Models, Permissions and Application), optional Extensions and Advanced. Run configuration is under Models; Jobs and Run diagnostics are under Advanced. Registries control presentation; backend facts and authorization remain with their services.


Client stylesheets load in the `app` cascade layer through a native CSS import. Author ordinary CSS; relative imports and asset URLs remain relative to the package stylesheet. Shared `@agnes/web-ui` CSS uses the canonical layer order from `@agnes/web-ui/layers.css`. See [skin precedence](skins.md#23-特异性为什么用钩子选择器就够不需要-important).
