# Frontend plugins: add a workbench interface

English | [简体中文](frontend.zh-CN.md)


<a id="前端插件为工作台增加一个界面"></a>

[Documentation](../README.md) · [Plugin lifecycle](../guide/packages.md)

Use the [client-panel/v1](../../examples/packages/client-panel/v1/package.json) fixture to learn how to declare and implement a browser contribution. The fixture adds a version label to the `workbench.panel` slot when loaded by a test. This is a browser contribution path, distinct from slot registration through Host `ctx.slots`.

The official workbench loads native JavaScript and CSS only from verified clients shipped with the current AGH release or an exact client approved through [application adoption or a presentation role](../extend/applications.md). The shipped navigation, conversation and composer, goals, interactions, and deliverables clients do not need separate approval. Installing, trusting, and enabling a third-party plugin does not approve its native UI. Tools, backend services, configuration, and readable session history keep their existing permissions. Intelligent UI renderers run in a separate sandboxed frame.

## Add a host-rendered plugin entry

An installed, trusted and enabled plugin can declare `uiEntries` on one of its `agnes.plugins` rows in `package.json`. Use this for a short feature guide or a link to that row's configuration. The workbench renders both the entry and its content without loading a browser module or stylesheet.

```json
{
  "export": "archive",
  "uiEntries": [
    {
      "id": "archive-settings",
      "placement": "settings",
      "title": { "en": "Session archive", "zh-CN": "会话归档" },
      "markdown": { "en": "Choose **Configure** to set archive options." },
      "configure": true
    }
  ]
}
```

This excerpt shows only the fields relevant to the entry. Use `settings` for Settings → Extensions, `sidebar` for the sidebar's extension menu, or `workbench.right` or `workbench.bottom` for the corresponding workbench dock. The host decides order and overflow. You can omit `icon` or use a shared icon name. Supply `title.en`; other locales fall back to English if no translation is provided. Provide at least one of `markdown` and `configure: true`. Entry Markdown shows link labels and image alt text but cannot open links or load images. Configure opens only the declaring row and follows normal configuration permissions.

You can declare up to eight entries per row and 32 per package. IDs must be unique per row, start with a lowercase letter, and contain at most 64 lowercase letters, digits, periods or hyphens. Each localized title is limited to 80 characters and each localized Markdown string to 2,048. Old packages need no changes. Existing native entry points do not migrate automatically or receive new approval. For live session content and actions, use [Intelligent UI](intelligent-ui-web.md).

Use a managed installed package to try declaration entries. Editable `workspace:` and `local:` packages keep their existing behavior, but do not publish these entries.

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

Use the hashes from the preview to trust and enable the fixture. In the official workbench, open its plugin details and verify that its native UI is not approved. The version label does not appear. The backend state still reflects the operation you performed.

To try explicit approval, install [Deliverables Gallery](../../examples/community/deliverables-gallery/README.md). In **Settings → Application**, review and adopt the application or choose its deliverables role. Open a session with a deliverable to see the approved gallery. Approval covers the reviewed client and version, not every client in the plugin. If a change invalidates approval, review it again. If the old interface has already run in your tab, reload the tab to clear its code.

If the adopted interface prevents you from opening settings, open `/?admin` on the workbench origin or run `agh app clear`. Restoring the official interface does not change session pins or remove data.

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
