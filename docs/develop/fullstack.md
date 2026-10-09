# Full-stack plugins: show business results in a panel

English | [简体中文](fullstack.zh-CN.md)

<a id="前后端联动让面板读到业务结果"></a>

[Documentation](../README.md) · Prerequisites: [Backend](backend.md) and [frontend](frontend.md)

Connect the interface and backend so a panel displays the version returned by a service. Then verify updates, rollback, and revoked access. This provides a starting point for a read-only business status panel.

Reuse [client-service-panel/v1](../../examples/packages/client-service-panel/v1/package.json). **The same trusted Cordis row registers a query service and declares its browser module.** The browser makes a constrained call through a same-origin BFF.

<a id="结构与调用链"></a>

## Structure and call chain

```text
package.json
  agnes.plugins → runtime named export (backend Cordis row)
  agnes.clientDescriptors → agnes.client.json with the same rowId
extensions/main/index.mjs
  runtime.apply(ctx) → ctx.services.register(panel.version)
extensions/main/client/index.js
  ctx.agnes.services.call('panel.version', {}) → display the version
```

Browser Context → current client row's service allow-list → local same-origin BFF → daemon identity/state checks → worker/Host row-service authorization → handler.

`ctx.provide()` publishes a Cordis dependency only in its local Context; it does not automatically become a remote service. Backend rows register Host-constrained services through `ctx.services.register()`. `ctx.extension().registerService()` remains forbidden. Do not create a second browser SDK/daemon socket to bypass the BFF.

<a id="运行前显式配置能力上限"></a>

## Configure the capability ceiling before running

Current local-dev and enterprise templates include `services`. Older or custom profiles must admit it explicitly in `policy.capabilityCeiling`; preserve their other entries and deployment restrictions. Package trust does not grant this capability. In an isolated instance, verify the resolved ceiling before installing the example. If you change startup profile policy, stop and restart that instance after its tasks finish.

After startup, inspect, install, trust, and enable:

```sh
node agnes.mjs package inspect file:./examples/packages/client-service-panel/v1
node agnes.mjs install file:./examples/packages/client-service-panel/v1
```

Use the actual preview hashes for trust/enable, following [plugin management](../guide/packages.md).

<a id="后端与前端各声明一次"></a>

## Declare both sides

In the [package manifest](../../examples/packages/client-service-panel/v1/package.json), `agnes.plugins` declares the backend row and `agnes.clientDescriptors` binds the [client descriptor](../../examples/packages/client-service-panel/v1/extensions/main/agnes.client.json) to the same row. `client.services` lists only the service names the browser may call. Host still verifies that the row actually registered the service and permits access from the current session.

The [backend entry](../../examples/packages/client-service-panel/v1/extensions/main/index.mjs) defines `panel.version` using `ctx.services.register`, with `kind: query`, input/output schemas, timeout, and maximum result bytes. Its handler returns the example version. The [browser entry](../../examples/packages/client-service-panel/v1/extensions/main/client/index.js) calls `ctx.agnes.services.call('panel.version', {})` without receiving a Host grant or daemon credentials.

Calls require a current session. After enabling the plugin, configure a model in Web and create a new session bound to the published version. Refresh the page with that session selected so apply runs with a session ready. The example queries only once during apply. Without a session it displays `unavailable` and does not automatically retry when a session is later selected. This is a limitation of the minimal example; real applications should refresh according to the session lifecycle.

Success displays `backend 1.0.0`. After updating, trusting, and enabling v2, create a new session and check that both frontend and backend report `2.0.0`; the v1 session retains its original code. A frontend v2 label alone does not prove a backend switch.

<a id="失败与清理"></a>

## Failure and cleanup

A missing backend row in the selected generation, a closed browser row, denied current authorization, or a missing allow-list entry or current session must refuse service calls. The frontend displays unavailable. Ordinary plugin installation code cannot grant itself `services`.

Disable/remove stops new sessions from binding the contribution; retained sessions keep their backend code and matching browser modules. This does not bypass current authorization checks. After rollback, verify the preview hashes and explicitly trust/enable the restored version, then use a new session to check it. Rollback does not undo external business data changes. See [hot reload](../extend/hot-reload.md) for explicit migration and snapshot retention. Do not turn this query into a write while retaining `kind: query`. Services with side effects need separate effect, command-identity, and authorization contracts.

<a id="验证命令"></a>

## Verification commands

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host/test/assemble/dynamic-client-extension.test.ts packages/daemon-admin/test/client-modules.test.ts --maxWorkers=1
```

This combination covers example modules, Host assembly/revocation, and daemon browser-call boundaries. [web-workbench.mjs](../../tools/acceptance/web-workbench.mjs) is an optional acceptance program for the full browser → BFF → daemon → worker → Host path. Recorded versions and coverage are listed separately in [verification](../maintainers/verification.md).

Source: [Host dynamic client extensions](../../packages/host/src/runtime/assemble/assemble.ts), [dynamic assembly tests](../../packages/host/test/assemble/dynamic-client-extension.test.ts), [ClientContext service gates](../../packages/web-client/src/client-module.ts).
