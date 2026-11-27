# Try AGH: a tool, a panel, and a connected application

English | [简体中文](demo.zh-CN.md)

<a id="体验-agh一个工具一个面板一套联动"></a>

[Project home](../../README.md) · [Documentation](../README.md) · [Installation](install.md)

Build up from one business function to a workbench. This guide introduces three examples included in the repository: let an agent call your tool, add a panel, then connect that panel to a backend service.

[Demo 1: tool](#demo-1-give-an-agent-a-new-capability) · [Demo 2: panel](#demo-2-adapt-the-workbench-to-a-role) · [Demo 3: integration](#demo-3-connect-the-interface-to-a-backend-service)

<a id="选择体验方式"></a>

## Choose how to try it

| Method | Best for | Environment and result |
| --- | --- | --- |
| Web / CLI | Exploring the interface and model interaction | Complete the [quickstart](quickstart.md), then choose an example below; model calls may incur charges |
| Automated local demo | Exploring execution without a model account | A complete macOS local build and permission to listen on loopback; a local simulated model drives the flow and prints individual checks |
| Example component tests | Changing plugin code | Installed source dependencies; checks registration, results, mounting, and cleanup without starting the full workbench |

The automated demo uses a simulated local model to drive real product processes. Use Web / CLI to explore the interface and real model behavior.

<a id="演示一给-agent-增加一项能力"></a>

## Demo 1: give an agent a new capability

Follow the [backend plugin tutorial](../develop/backend.md) to install, trust, and enable `hot-tool-plugin`. In a new session created after enable, with a configured model, ask it to call `demo_text_stats` on `hello world`.

Expected structured tool result:

```json
{ "characters": 11, "words": 2 }
```

Expand the tool record and check the name, input, and structured output of `demo_text_stats`. This confirms that the request reached your plugin. The automated demo also checks this execution path.

**Build on it:** Keep the registration and package governance structure, replace the counting logic with your business query, and redefine inputs, permissions, and effects accordingly.

<a id="演示二让工作台适配一个岗位"></a>

## Demo 2: adapt the workbench to a role

Follow the [frontend tutorial](../develop/frontend.md) to install, trust, and enable `client-panel/v1`. This is a legacy workbench slot fixture. The official Web workbench reports that its native UI is not admitted, does not show `Agnes client module demo · v1`, and keeps its built-in interface.

For a positive example, follow [Build a presentation plugin](../extend/presentations.md). Preview the exact interface role and approve it explicitly; ordinary plugin installation does not replace a role.

**Build on it:** Use a scoped, approved entry for the role's information and actions. Test cleanup and revocation as well as display.

<a id="演示三把界面接到后端服务"></a>

## Demo 3: connect the interface to a backend service

Follow the [full-stack tutorial](../develop/fullstack.md) in an isolated `local-dev` profile. Install, trust, and enable the tutorial package from source. Then preview and explicitly adopt its application. Installation alone does not admit the native page.

Open **Service version** in a new session's workbench. The page shows `backend 1.0.0` when it receives the read-only query result. Clear the application to remove the tab and keep the official workbench. The tutorial describes the separate versioned fixtures for update and rollback tests.

**Build on it:** Start with a read-only status page and gradually connect your business services. Writes need their own effects, command identity, and authorization design; do not reuse a read-only query declaration for them.

<a id="不配置模型账号先跑通本地链路"></a>

## Run locally without a model account

Complete the [build prerequisites](install.md). Use the three browser tutorials above for current offline acceptance. Use the [hot-upgrade demo](../../examples/demos/hot-upgrade/README.md) to check retained sessions.

The optional process probe below includes legacy profile-roster expectations that predate native UI admission. It is not a pass criterion for this tutorial or for session-pinned upgrades.

```sh
pnpm --filter @agnes/cli build:local
node --import tsx tools/public-docs/smoke.mjs
```

The script creates an isolated home with a short temporary path and a demo workspace, installs repository examples, and runs tasks through a loopback model. It stops the Web service and daemon it started, then prints the directory containing `result.json`. It does not use your everyday instance or a real model account. Dependency installation and the initial build still require the preparation in the installation guide; “local” describes the demo runtime.

The following are expected check labels. Use the actual exit code and `result.json` to determine the result of your run:

```text
PASS page-advertised WebSocket connects directly to daemon and reads session projection
PASS installed backend tool invoked through CLI/daemon/worker
PASS real HTTP BFF query and wrong-Origin refusal
PASS linked service update v1 → v2
PASS rollback denies calls until explicit trust/enable restores v1
PASS disable/remove clears roster and denies stale service calls
```

If a step fails, preserve logs and the result directory, then use [troubleshooting](troubleshooting.md). The script uses `/tmp` and Unix sockets; recorded process verification ran on macOS, so this is not a Windows acceptance command. Do not manually remove snapshots or release pins still in use.

If you built to a separate output directory, retain `AGH_BUILD_ROOT` in the same shell and supply that entry point:

```sh
node --import tsx tools/public-docs/smoke.mjs --entry "$AGH_BUILD_ROOT/runtime/agnes.mjs"
```

See [verification](../maintainers/verification.md) for the full stages and baseline, and the [demo script](../../tools/public-docs/smoke.mjs) for implementation.

<a id="开发者的快速验证"></a>

## Quick checks for developers

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts --maxWorkers=1
```

These tests load the actual example modules and cover backend results, frontend mounting/cleanup, service integration, and refusal when a session or permission is missing. They give quick feedback after an example change. Full process tests and real browser acceptance remain separate checks.

Next: [Build your own plugin](../develop/plugins.md) · [Apply the examples to FDE](why-agh.md) · [Feedback and development](../develop/contributing.md).
