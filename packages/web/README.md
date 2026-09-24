# AGH Web workbench

The browser workbench connects to AGH's shared daemon through the browser SDK. It provides tasks, conversation history, streaming output, approvals, model accounts and plugin settings.

## Run locally

From the repository root, follow the [source installation guide](../../docs/guide/install.md). A complete local build includes CLI, daemon, worker and Web assets:

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs serve
```

Open the printed loopback URL. Configure a model account, create a task and confirm its working directory. `AGH_HOME` and `AGNES_PROFILE` select the same instance used by the CLI; closing the Web server does not stop the shared daemon.

## Guides and contracts

- [Web operations](../../docs/guide/web.md) and [first task](../../docs/guide/quickstart.md).
- [Model and account configuration](../../docs/reference/configuration.md).
- [Sessions and recovery](../../docs/guide/sessions.md).
- [Security and trust](../../docs/guide/security.md): exact Origin/Host checks, credential ownership and plugin trust.
- [Frontend plugins](../../docs/develop/frontend.md) and [skin authoring](../../docs/develop/skins.md).

Shared UI components belong in `packages/web-ui`; settings and resource surfaces use the shared renderers. Package-local tests cover transport, rendering and public region contracts. Use a real browser to verify layout, keyboard interaction and downloads for the target release.
