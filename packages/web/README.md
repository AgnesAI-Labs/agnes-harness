# AGH Web workbench

The browser workbench connects to AGH's shared daemon through the browser SDK. It provides tasks, conversation history, streaming output, approvals, model accounts and plugin settings.

## Run locally

From the repository root, follow the [source installation guide](../../docs/guide/install.md). A complete local build includes CLI, daemon, worker and Web assets:

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs serve
```

Open the printed loopback URL. Configure a model account, create a task and confirm its working directory. `AGH_HOME` and `AGNES_PROFILE` select the same instance used by the CLI; closing the Web server does not stop the shared daemon.

## Frontend development

After building the local backend once, stop any regular `agnes serve` Web process and run `pnpm --filter @agnes/cli dev:web` from the repository root. Closing the Web process leaves the shared daemon running. The development launcher watches frontend source and shared UI files, rebuilds the browser assets, and reloads open pages after a successful build. A page reload resets temporary UI state. Backend source changes still require a new local build.

## Guides and contracts

- [Web operations](../../docs/guide/web.md) and [first task](../../docs/guide/quickstart.md).
- [Model and account configuration](../../docs/reference/configuration.md).
- [Sessions and recovery](../../docs/guide/sessions.md).
- [Security and trust](../../docs/guide/security.md): exact Origin/Host checks, credential ownership and plugin trust.
- [Frontend plugins](../../docs/develop/frontend.md) and [skin authoring](../../docs/develop/skins.md).

Shared UI components belong in `packages/web-ui`; settings and resource surfaces use the shared renderers. Package-local tests cover transport, rendering and public region contracts. Use a real browser to verify layout, keyboard interaction and downloads for the target release.

Computer Use RPC coordination belongs to Web's internal `src/computer-use-state.ts`. `createComputerUseState` exposes stable, immutable `getSnapshot()` values, `subscribe()` with an unsubscribe function, and the existing status, permission, diagnostic and operation actions. Snapshots contain safe display text, control availability and the last confirmed operation's ID/kind/state/phase. The `src/computer-use.ts` controller keeps the legacy pane and button API by subscribing to this state; a replacement pane receives a fresh owner. `dispose()` retires replies, subscriptions and local polling waits without cancelling backend work. Injected polling waits may accept an optional `AbortSignal` to release their resources. Failed operation submissions remain unconfirmed and require progress refresh before another submission; exhausted or failed polling retains the last confirmed operation. A `not-found` response means no visible record and does not confirm cancellation or completion.
