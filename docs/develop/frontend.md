# Frontend plugins: add a workbench interface

English | [简体中文](frontend.zh-CN.md)

<a id="前端插件为工作台增加一个界面"></a>

[Documentation](../README.md) · [Plugin lifecycle](../guide/packages.md)

Display your own panel, update its version, and confirm that disabling it restores the built-in interface. Learn the lifecycle first, then replace the version label with content useful for the role.

Reuse [client-panel/v1](../../examples/packages/client-panel/v1/package.json). It displays a version label in the supported `ui:sidebar` slot; v2 tests page updates. This is a browser contribution path, distinct from slot registration through ordinary Host `ctx.extension()`.

<a id="声明和代码"></a>

## Declaration and code

The package declares a backend Cordis row with `agnes.plugins`, then binds a browser descriptor to the same row ID through `agnes.clientDescriptors`. The descriptor's `client` section is:

```json
{
  "client": {
    "entry": "./client/index.js",
    "styles": ["./client/index.css"],
    "slots": ["ui:sidebar"],
    "publicConfig": { "label": "Agnes client module demo · v1" },
    "services": [],
    "projections": []
  }
}
```

See [package.json](../../examples/packages/client-panel/v1/package.json) and the complete [agnes.client.json](../../examples/packages/client-panel/v1/extensions/main/agnes.client.json). The client entry is resolved relative to the descriptor and must be native ESM executable by the browser:

```js
export function apply(ctx, config) {
  ctx.slots.register(
    'ui:sidebar',
    () => config.publicConfig.label,
    { priority: -1 },
  )
}
```

For this singleton slot, a lower priority wins. The example replaces the built-in sidebar, which should return when the example is disabled. Choose a suitable slot for a production plugin. Do not assume unexposed regions can be replaced or depend on private Host DOM/CSS structure.

`publicConfig` is public presentation metadata from package contents, not backend runtime configuration. Client entry/styles must be validated paths inside the package. They cannot escape the snapshot, import arbitrary local modules, or obtain connection credentials. Bundle React or third-party libraries into independently loadable browser artifacts when needed.

<a id="安装与观察"></a>

## Install and inspect

Run from the repository root using an isolated instance:

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-panel/v1
```

Trust and enable using hashes from the preview, then open Web for the same instance. You should see v1. Update to `file:./examples/packages/client-panel/v2` through Web management or TUI and check v2. Finally, disable it and confirm the built-in sidebar returns. Because this example may replace management navigation, keep a terminal ready to disable it through the shell.

Package desired=enabled, backend web row ready, and successful loading in this page are distinct stages. A closed browser, failed script/CSS fetch, unauthorized slot, or exception in apply can prevent frontend activation. Inspect per-row actual state as well as package enablement.

<a id="验证"></a>

## Verification

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

These tests check actual example ESM, Cordis bindings, slots, cleanup, and update failure handling. Without a browser, they are not real rendering acceptance. See [verification](../maintainers/verification.md) for browser coverage and source-candidate results.

Next: [Connect a backend service to the panel](fullstack.md). Declare public configuration fields and callable services separately. Keep secrets on the backend.

Implementation: [loading coordination](../../packages/web/src/client-modules/reconcile.ts), [ClientContext](../../packages/web-client/src/client-module.ts), [asset checks](../../packages/package-manager/src/client-assets.ts), [slots](../../packages/web-client/src/slots.ts).
