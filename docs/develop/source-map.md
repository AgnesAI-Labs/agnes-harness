# Source map

English | [简体中文](source-map.zh-CN.md)

<a id="源码导航"></a>

[Documentation](../README.md) · [Architecture](architecture.md)

Start with the behavior you want to change, then inspect the tests in the same row for its contract. To follow your first request, read CLI/Web → SDK → daemon/worker → Host/Core. Plugin authors can begin with Cordis, package governance, and frontend slots.

Links point to source at the same revision as this document. See [verification](../maintainers/verification.md) for reproduction steps and coverage. Whether a path is enabled also depends on configuration, caller, and relevant tests.

| Behavior | Main source | Verification starting point |
| --- | --- | --- |
| Arguments / startup / runtime directory | [cli](../../packages/cli/src), [cli-launch](../../packages/cli-launch/src) | [CLI arguments](../../packages/cli/test/args.test.ts), [shared local acceptance](../../tools/acceptance/shared-local-delivery.test.ts) |
| TUI | [cli-tui](../../packages/cli-tui/src) | [Tests](../../packages/cli-tui/test) |
| Web presentation and connections | [web](../../packages/web/src), [web-server](../../packages/web-server/src) | [Web tests](../../packages/web/test) |
| Frontend plugins and slots | [web-client](../../packages/web-client/src), [web-slots](../../packages/web-slots/src), [web-units](../../packages/web-units/src) | [Roster reconciliation](../../packages/web/test/client-modules.reconcile.test.ts) |
| Protocol / validation | [protocol schema](../../packages/protocol/schema), [method table](../../packages/protocol/src/methods.ts), [protocol-validation](../../packages/protocol-validation/src) | [Protocol tests](../../packages/protocol/test) |
| SDK sessions / transports | [sdk](../../packages/sdk/src) | [SDK tests](../../packages/sdk/test) |
| daemon / worker | [daemon](../../packages/daemon/src), [worker-runtime](../../packages/worker-runtime/src) | [Daemon tests](../../packages/daemon/test) |
| Execution loop / recovery | [core](../../packages/core/src) | [Core tests](../../packages/core/test) |
| Configuration / assembly / credentials / platforms | [host](../../packages/host/src), [system-node](../../packages/system-node/src) | [Host tests](../../packages/host/test) |
| Models / stream parsing | [ai](../../packages/ai/src) | [AI tests](../../packages/ai/test) |
| Standard tools / seams | [base extensions](../../packages/base/extensions), [base](../../packages/base/src) | [Base tests](../../packages/base/test) |
| Code workflows | [code](../../packages/code/src) | [Code tests](../../packages/code/test) |
| Cordis lifecycle | [cordis](../../packages/cordis/src), [cordis-loader](../../packages/cordis-loader/src), [plugin-runtime](../../packages/plugin-runtime/src) | [Incremental reconciliation](../../packages/host/test/assemble/incremental-apply.test.ts) |
| Package governance | [package-manager](../../packages/package-manager/src), [package-isolation](../../packages/package-isolation/src) | [Package-manager tests](../../packages/package-manager/test) |
| Resource governance | [resource-control-store](../../packages/resource-control-store/src), [resource-control-runtime](../../packages/resource-control-runtime/src), [resource-control-worker](../../packages/resource-control-worker/src) | [Skills Cordis](../../packages/resource-control-runtime/test/skills-cordis.test.ts) |
| Resource CLI/Web | [resource-control-cli](../../packages/resource-control-cli/src), [resource-control-web](../../packages/resource-control-web/src) | [Resource CLI tests](../../packages/resource-control-cli/test) |
| External channels / format conversion | [channels](../../packages/channels/src), [bridges](../../packages/bridges/src) | [Channels tests](../../packages/channels/test), [bridges tests](../../packages/bridges/test) |
| Engineering constraints | [guards](../../tools/guards) | [Ratchet](../../tools/guards/ratchet.json) |

A package's `package.json` `exports` defines its public entry points. These source links help explain the implementation; applications and plugins should not deep-import another package's private src. Python runtime and the Python thin client are not currently usable public integration paths.
