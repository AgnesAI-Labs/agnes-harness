# Full-stack plugins: show business results in a panel

English | [简体中文](fullstack.zh-CN.md)

<a id="前后端联动让面板读到业务结果"></a>

[Documentation](../README.md) · Prerequisites: [Backend](backend.md) and [frontend](frontend.md)

Run [the approved service panel](../../examples/packages/approved-service-panel/package.json) in the official Web workbench. You will review the application, open its tab in a real session, and see `backend 1.0.0` from a read-only query. The example uses synthetic data and does not need a provider account.

<a id="运行前显式配置能力上限"></a>

## Start an isolated workbench

Build the [local distribution](../guide/install.md#get-the-source). Start Web from the built source checkout with a fresh home and workspace:

```sh
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-service-panel.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
export AGH_DEMO_WORKSPACE="$(mktemp -d /tmp/agh-service-panel-work.XXXXXX)"
printf 'AGH_SOURCE=%s\nAGH_HOME=%s\nWorkspace=%s\n' "$AGH_SOURCE" "$AGH_HOME" "$AGH_DEMO_WORKSPACE"
mise exec -- node agnes.mjs serve --cwd "$AGH_DEMO_WORKSPACE" --port 4198
```

Use the printed loopback URL in a separate browser profile. The stock `local-dev` profile admits `services`. If a custom deployment excludes it, stop rather than widening policy for this tutorial.

## Install, then review the application

1. In a second terminal, replace the two path examples below with the exact printed values, then install from source. The tutorial package is not listed automatically in the market. Keep this terminal for cleanup.

   ```sh
   export AGH_SOURCE='/absolute/path/to/agnes-harness'
   export AGH_HOME='/tmp/agh-service-panel.your-suffix'
   export AGNES_PROFILE=local-dev
   cd "$AGH_SOURCE"
   mise exec -- node agnes.mjs plugins add "$AGH_SOURCE/examples/packages/approved-service-panel"
   ```

2. Review the source, integrity, and capabilities before confirming installation, trust, and enablement. The backend can now run, but the official workbench does not load the native client or show its tab. Package trust is separate from native UI admission.
3. Open the workbench in your isolated browser. In the first-run guide, choose **Demo** and select the temporary workspace you created.
4. Open **Settings → Application**. Preview the tutorial candidate. It uses the official **Agnes Harness** name because it declares no brand. Open **Technical details** and check that `packageId` is `@agnes-examples/approved-service-panel`, the version is `1.0.0`, and the source and integrity match the install review.
5. Check that `declaration.workbench.tabs` contains one `page` tab pointing to `@agnes-examples/approved-service-panel#service-version`. Check that `replacedRoles` is empty. The example does not change the official home, navigation, skin, or default agent. Choose **Adopt** only if the preview matches. This uses the profile's single application selection, so do not try it in a profile with an application you want to keep.

## Read the result in a session

1. In a new conversation, send a harmless prompt such as `Show the service panel tutorial`. Wait for the Demo reply. The session must be created after the package is enabled so its backend generation includes the example.
2. Open **Workbench** on the right and select **Service version**. Look under **More** if the tab is folded. The page displays `backend 1.0.0` after the session becomes ready and the backend answers.
3. Reload the page with the same conversation selected and reopen the tab if needed. Then create a second Demo conversation and switch between the two. The page waits for the selected session and reads again. When a session is not usable, the page must not display a result from another session.

<a id="结构与调用链"></a>
<a id="后端与前端各声明一次"></a>

## Follow the call in the source

- The [package manifest](../../examples/packages/approved-service-panel/package.json) declares one backend Cordis row. `agnes.clientDescriptors` attaches the [profile client descriptor](../../examples/packages/approved-service-panel/client/agnes.client.json) to the same `rowId`. The workbench tab points to the descriptor's `homeEntries` page. It does not declare a global slot or an interface replacement.
- The [backend entry](../../examples/packages/approved-service-panel/index.mjs) registers `approved.panel.version` with `ctx.services.register()`. The session query accepts an empty object, returns a version string in an object, and has a timeout and result size limit. It makes no writes and accesses no external system. `ctx.provide()` alone only publishes a local Cordis dependency.
- The [page](../../examples/packages/approved-service-panel/client/index.js) calls `ctx.agnes.services.call('approved.panel.version', {})` through the same-origin browser relay. Its descriptor allows only that service name. The daemon checks the admitted row and service owner before the Host checks the selected session and invokes the handler. The page receives neither daemon credentials nor a Host grant.
- The page subscribes to session readiness and contribution availability. It only reads in a ready session and only displays a result for the same readiness and availability snapshots. When the tab unmounts, its subscriptions and pending result are discarded.

<a id="失败与清理"></a>

## Restore the official interface

If a ready session reports **Service unavailable**, check that the example is still enabled and adopted. If the session predates installation, start a new session rather than changing the old session's generation.

In the isolated browser, open `/?admin` at the printed origin and choose **Restore official interface**. Return to the conversation and reload if prompted. The tab disappears and the official workbench remains. Clearing removes the application selection and any explicit interface choices in that profile. It neither disables the package nor changes saved sessions. The recovery URL itself grants no permissions.

If Web cannot open, clear from the second terminal. If you already used **Restore official interface**, skip the clear command. Keep the isolated home exported and disable the plugin separately:

```sh
mise exec -- node agnes.mjs app clear --profile local-dev
mise exec -- node agnes.mjs plugins disable @agnes-examples/approved-service-panel
```

Press Ctrl-C in the first terminal to stop `serve`. In the second terminal, stop the isolated daemon with `mise exec -- node agnes.mjs daemon stop`.

If Web startup reports a different daemon origin, stop only this isolated home's daemon and retry the original `serve` command. Do not change trust or edit admission settings to make the example appear. See [application adoption and recovery](../extend/applications.md) for the full contract.

<a id="验证命令"></a>

## Check the legacy service fixtures

The [v1](../../examples/packages/client-service-panel/v1/package.json) and [v2](../../examples/packages/client-service-panel/v2/package.json) packages are separate fixtures for backend versions, session pins, and revocation. They do not supply an adoptable page and ordinary installation does not admit their native UI in the official workbench. Their API and lifecycle tests remain useful:

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/public-docs/examples.test.ts packages/host/test/assemble/dynamic-client-extension.test.ts packages/daemon-admin/test/client-modules.test.ts --maxWorkers=1
```

Those tests exercise fixture registration and authorization. They do not replace the real-browser steps above. For operations outside a conversation, see [profile services and durable notifications](profile-services.md).
