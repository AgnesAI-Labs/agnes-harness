# JevLoop browser plugin

[Frontend plugin guide](../../docs/develop/frontend.md) · [简体中文](../../docs/develop/frontend.zh-CN.md)

`@agnes/jev-web` provides decision graphs and the two-lane comparison workspace through the installed client-module roster. The in-process row `ext:jev-web/main` owns `client/agnes.client.json`; it does not register or configure a backend runtime. Backend runtime registration remains static Host assembly.

The single-line workspace also exposes durable root-session LLM/Jev accounting beside the Jev direct-route count. The accounting reader uses `_agnes/v1/session.accounting`, which applies the same Host pricing and missing-evidence rules as comparison without executing the session.


## Decision graph

The graph follows JevLoop's [DecisionFlow visual conventions](https://github.com/parkavenue9639/jevloop/blob/main/frontend/src/components/DecisionFlow.tsx): a horizontal main path, a circular Jev node, and individual candidate branches that fan out and merge. Node positions stay fixed when the candidate pool grows. AGH's trace projection continues to supply every displayed choice, action and result.

The graph opens in an overview fitted to both the pane width and height. Unconsumed branches keep their headings and candidate counts, with options collapsed. Expanding candidates opens a readable, scrollable canvas; **Fit canvas** restores the overview. Manual zoom stays under your control until reset. Playback reserves a stable canvas envelope from already-read session records, so main nodes and overview scale do not jump when a request settles or candidates collapse. Reserved space does not expose future candidates, probabilities or outcomes. Click a candidate or stage for its recorded evidence. Request and settlement positions remain available in those inspectors and tooltips. Live motion marks unsettled records in the latest complete ledger view; it does not prove that a model request reached its endpoint or that a tool started. Archived, stopped and historical replay views remain static apart from a brief pulse when playback reveals new evidence. Reduced-motion preferences disable animation.

## Build and install

Build the full local distribution first, then use its CLI for the same instance as the Web page. The reserved `file:./jev-web` source resolves to that distribution's bundled payload:

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs package inspect file:./jev-web
node packages/cli/dist/local/agnes.mjs install file:./jev-web
node packages/cli/dist/local/agnes.mjs package trust @agnes/jev-web INTEGRITY CAPABILITY_HASH
node packages/cli/dist/local/agnes.mjs package enable @agnes/jev-web
```

Replace `INTEGRITY` and `CAPABILITY_HASH` with the inspection preview values. The package's `private: true` follows repository publication policy; it does not prevent local file installation. This is an installable package payload, not a claim that an npm release has been published.

For source iteration, `pnpm --filter @agnes/jev-web build` builds only the UI payload. Ordinary `file:./...` paths resolve against the daemon's configured workspace, not the CLI's current directory; stage a built package there before installing an ordinary file source.

The build emits `client/index.js`, ESM chunks, `client/index.css`, the copied client descriptor and third-party notices. Every JavaScript/CSS file is checked against the existing PackageAdmin Base64 response budget. The root `agnes.client.json` is the source template; the package manifest references the built descriptor. Platform singletons use the existing import map; other browser dependencies are bundled.

## Default installation and disabling

Fresh profile default initialization installs, trusts and enables the release-owned package. Profiles whose earlier default initialization completed are not automatically opted in; install explicitly when needed. Later startup preserves existing disable and uninstall choices.

```sh
node packages/cli/dist/local/agnes.mjs package disable @agnes/jev-web
```

Disabling removes the package from the browser roster and disposes its fiber, styles, contributed DOM, listeners and observers. A page already bound to its target refuses further submissions while the provider is unavailable; it does not silently send to Native. Existing backend tasks continue independently of UI disposal. Installing this UI does not make an unconfigured Jev backend available.

## Public host boundary

The plugin uses [ctx.workbench](../web-client/src/workbench.ts) to register its provider, restore saved URLs and receive immutable first-submission workspace/model/permission snapshots. It contributes owned nodes only to the declared public surfaces and removes them on disposal; it does not depend on private host DOM IDs. Shared conversation renderers and session controllers come from [@agnes/web-session-ui](../web-session-ui/package.json).

Package enablement, backend-row readiness and successful browser loading are distinct. Failed script/style loading or `apply` is a frontend activation failure. Focused tests and build output checks do not establish real browser layout acceptance; validate desktop/mobile navigation, saved URLs and disable behavior in the target browser.
