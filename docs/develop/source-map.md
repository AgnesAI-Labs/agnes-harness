# Source map

English | [简体中文](source-map.zh-CN.md)

<a id="源码导航"></a>

[Documentation](../README.md) · [Architecture](architecture.md)

Start with the behavior you want to change, then inspect the tests in the same row for its contract. To follow your first request, read CLI/Web → SDK → daemon/worker → Host/Core. Plugin authors can begin with Cordis, package governance, and frontend slots.

Links point to source at the same revision as this document. See [verification](../maintainers/verification.md) for reproduction steps and coverage. Whether a path is enabled also depends on configuration, caller, and relevant tests.

| Behavior | Main source | Verification starting point |
| --- | --- | --- |
| Arguments / startup / runtime directory | [cli](../../packages/cli/src), [launch resources](../../packages/cli/launch/resources.ts) | [CLI arguments](../../packages/cli/test/args.test.ts), [shared local acceptance](../../tools/acceptance/shared-local-delivery.test.ts) |
| TUI | [cli-tui](../../packages/cli-tui/src) | [Tests](../../packages/cli-tui/test) |
| Web presentation and connections | [web](../../packages/web/src), [web-server](../../packages/web-server/src) | [Web tests](../../packages/web/test) |
| Web appearance and locale foundation | [web-foundation](../../packages/web-foundation/src) | [Foundation tests](../../packages/web-foundation/test) |
| Web conversation presentation | [web-conversation](../../packages/web-conversation/src) | [Module tests](../../packages/web-conversation/test) |
| Web administration and settings | [web-admin](../../packages/web-admin/src) | [Module tests](../../packages/web-admin/test) |
| Frontend plugins and slots | [web-client](../../packages/web-client/src), [web-slots](../../packages/web-slots/src), [web-units](../../packages/web-units/src) | [Roster reconciliation](../../packages/web/test/client-modules.reconcile.test.ts) |
| Protocol / validation | [protocol schema](../../packages/protocol/schema), [method table](../../packages/protocol/src/methods.ts), [protocol-validation](../../packages/protocol-validation/src) | [Protocol tests](../../packages/protocol/test) |
| SDK sessions / transports | [sdk](../../packages/sdk/src), [Node resources](../../packages/sdk/src/resource-control.node.ts), [Node package client](../../packages/sdk/src/package-admin.node.ts) | [SDK tests](../../packages/sdk/test) |
| daemon / worker | [daemon-foundation](../../packages/daemon-foundation/src), [daemon-surfaces](../../packages/daemon-surfaces/src), [daemon-admin](../../packages/daemon-admin/src), [daemon-rpc](../../packages/daemon-rpc/src), [daemon-supervisor](../../packages/daemon-supervisor/src), [daemon](../../packages/daemon/src), [worker-runtime](../../packages/worker-runtime/src) | [Daemon tests](../../packages/daemon/test) |
| Observability / safe diagnostics | [observability](../../packages/observability/src), [provider kind](../../packages/extension-api/src/observability.ts), [diagnostics RPC](../../packages/daemon-rpc/src/local/methods/diagnostics.ts) | [Tests](../../packages/observability/test/provider.test.ts) |
| Execution loop / recovery | [core-common](../../packages/core-common/src), [core-child-control](../../packages/core-child-control/src), [core-ledger](../../packages/core-ledger/src), [core-effects](../../packages/core-effects/src), [Core artifacts](../../packages/core/src/artifacts), [core](../../packages/core/src) | [Core tests](../../packages/core/test) |
| Provider kinds / shared lifecycle / combined catalog | [kind contract](../../packages/extension-api/src/provider-kind.ts), [registry](../../packages/host-common/src/assemble/provider-registry.ts), [selection](../../packages/host-providers/src/assemble/provider-selection.ts), [provider architecture](architecture-plugins.md) | [Registry and selection tests](../../packages/host/test/owners/host-common/test/assemble/provider-registry.test.ts), [Host assembly](../../packages/host/test/assemble/tool-providers.test.ts) |
| Configuration / assembly / credentials / platforms | [host-common](../../packages/host-common/src), [host-infrastructure](../../packages/host-infrastructure/src), [host-computer-use](../../packages/host-computer-use/src), [host-artifacts](../../packages/host-artifacts/src), [host-extensions](../../packages/host-extensions/src), [host-providers](../../packages/host-providers/src), [host-runtime](../../packages/host-runtime/src), [host](../../packages/host/src), [system-node](../../packages/system-node/src) | [Host tests](../../packages/host/test) |
| Models / stream parsing | [ai](../../packages/ai/src) | [AI tests](../../packages/ai/test) |
| Standard tools / seams | [base extensions](../../packages/base/extensions), [base](../../packages/base/src) | [Base tests](../../packages/base/test) |
| Code workflows | [code](../../packages/code/src) | [Code tests](../../packages/code/test) |
| Cordis lifecycle | [cordis](../../packages/cordis/src), [cordis-loader](../../packages/cordis-loader/src), [plugin-runtime](../../packages/plugin-runtime/src) | [Incremental reconciliation](../../packages/host/test/assemble/incremental-apply.slow.test.ts) |
| Package governance | [package-manager](../../packages/package-manager/src), [package-isolation](../../packages/package-isolation/src) | [Package-manager tests](../../packages/package-manager/test) |
| Resource governance | [resource-control-store](../../packages/resource-control-store/src), [resource-control-runtime](../../packages/resource-control-runtime/src), [resource-control-worker](../../packages/resource-control-worker/src) | [Skills Cordis](../../packages/resource-control-runtime/test/skills-cordis.test.ts) |
| Resource CLI/Web | [resource-control-cli](../../packages/resource-control-cli/src), [resource-control-web](../../packages/resource-control-web/src) | [Resource CLI tests](../../packages/resource-control-cli/test) |
| External channels / format conversion | [channels](../../packages/channels/src), [bridges](../../packages/bridges/src) | [Channels tests](../../packages/channels/test), [bridges tests](../../packages/bridges/test) |
| Engineering constraints | [guards](../../tools/guards) | [Ratchet](../../tools/guards/ratchet.json) |

A package's `package.json` `exports` defines its public entry points. These source links help explain the implementation; applications and plugins should not deep-import another package's private src. Python runtime and the Python thin client are not currently usable public integration paths.

Production, tests and shared testkits use separate TypeScript projects in the runtime packages; root `typecheck` includes all three and their tool scripts.

Local RPC authenticates and dispatches settings operations through `@agnes/daemon-admin/app-server`; daemon-admin owns composition, context, plan-mode and history implementations. Runtime doctor composition lives in `@agnes/daemon-admin/runtime-doctor`; local RPC retains authentication and dispatch. The RPC factory export remains compatible. The only Base import allowed in local RPC is the named `ScheduleRejected` public refusal marker. MCP names use the portable `sha256Hex` export from protocol: UTF-8 encoding (including replacement of unpaired surrogates) and existing suffixes remain unchanged.

Learned preferences: `packages/memory-file` owns the official file provider; `packages/extension-api/src/memory.ts` owns its public SPI, `packages/web-admin/src/settings/memory.tsx` its editor, and `packages/base/src/memory` the remembering Skill.

MCP transport health: [implementation](../../packages/base/src/mcp/transport-health.ts) · [tests](../../packages/base/test/mcp/transport-health.test.ts)

Dismissible dialog DOM bindings: [web-ui](../../packages/web-ui/src/dom/dialog-binding.ts) · [tests](../../packages/web-ui/test/dialog-binding.test.ts)

Host assembly contract tests: [owner suites](../../packages/host/test/owners)

Private paths under daemon, Host and Web use their owning packages directly; obsolete one-line forwarding paths have been removed. Plugin author registration is explicitly supplied from `@agnes/host/testkit`.

Large frontend entries retain their original exports while delegating to domain modules:

| Entry | Owning modules |
| --- | --- |
| Trace view | [pure trace model](../../packages/web-units/src/trace-model.ts), [React view](../../packages/web-units/src/trace.ts) |
| Plugin administration | [page lifecycle and operations](../../packages/web-admin/src/admin/plugins/admin/page.tsx), [views](../../packages/web-admin/src/admin/plugins/admin/views.tsx), [control panels](../../packages/web-admin/src/admin/plugins/control-panel.tsx) |
| Settings and model picker | [dialog helpers](../../packages/web-admin/src/settings/dialog.ts), [model picker helpers](../../packages/web/src/model-picker), [settings catalogs](../../packages/web-admin/src/settings/locales), [plugin catalogs](../../packages/web-admin/src/admin/plugins/locales/admin) |
| Resource administration | [MCP form](../../packages/resource-control-web/src/mcp-form.ts), [page](../../packages/resource-control-web/src/admin.tsx) |
| Client services and slots | [service contracts](../../packages/web-client/src/service-contracts.ts), [service entry](../../packages/web-client/src/services.ts), [slot core](../../packages/web-slots/src/core.ts), [slot contracts](../../packages/web-slots/src/types.ts) |
| Static Web server | [options](../../packages/web-server/src/server-types.ts), [assets](../../packages/web-server/src/server-assets.ts), [security](../../packages/web-server/src/server-security.ts), [HTTP helpers](../../packages/web-server/src/server-http.ts) |
| Web styles | [ordered manifest](../../packages/web/public/style.css), [domain fragments](../../packages/web/public/styles), [source composer](../../tools/web-style-source.mjs) |

CSS fragments remain in their original cascade order, including later overrides for the same domain. Both build paths compose them into the existing `/style.css` asset before appending conversation styles. Source-style tests and theme-token generation read the same composed source; development watches every fragment.

`RemoteTransport` is a pure author contract in [extension-api](../../packages/extension-api/src/remote-transport.ts); Core re-exports the same type. Ledger test helpers live in [core-ledger/testkit](../../packages/core-ledger/testkit).

Session presentation is organized under [Web controllers](../../packages/web/src/app), [region mounts](../../packages/web/src/regions), [timeline entries](../../packages/web/src/timeline), [composer](../../packages/web-units/src/composer), [conversation messages](../../packages/web-ui/src/conversation/messages) and [client reconciliation](../../packages/web/src/client-modules/reconcile). Existing entry modules retain their exports.
