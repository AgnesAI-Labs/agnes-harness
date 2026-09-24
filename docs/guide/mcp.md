# MCP: connect external tools

English | [简体中文](mcp.zh-CN.md)

<a id="mcp连接外部工具"></a>

[Documentation](../README.md) · [Security](security.md)

Connect an existing MCP tool service to AGH's task flow. This guide covers adding a service, reviewing its tool scope, connecting, and checking actual state after configuration changes.

Definitions, trust, desired enablement, and actual connection state are managed separately. Complete the flow, inspect the catalog, then verify a real tool call.

**Current implementation:** Session MCP services run as individual Host rows. OAuth bindings are still skipped on this session path; see [runtime behavior and versions](#runtime-behavior-and-versions). See [verification](../maintainers/verification.md) for versioned results.

<a id="在会话中接入"></a>

## Add a service in a session

In a local AGH session, ask to connect an MCP service and provide its project URL or connection details. The helper targets the current AGH instance by default. After confirming the configuration, inspect registration and connection state under **Settings → MCP**. Connections and tool lists update at turn boundaries; you can use the service in the next turn of the same session.

This entry point is provided by `@agnes/mcp-helper`, installed and enabled by default. The first upgrade of an existing configuration also installs missing default helpers. If you disabled or removed it, inspect or install it through [plugin management](packages.md). Disabling the helper removes its session management tools; existing MCP services remain independently managed.

The session helper currently supports credential-free stdio, HTTP, and SSE definitions. For credentials, use the SecretRef command-line flow below rather than pasting secrets into chat. Hosts without session management tools can also use the CLI. For applications such as Blender, installing the application plugin, starting the application, and connecting MCP are separate steps. Verify availability with an actual tool call.

Confirmation for a local stdio service authorizes startup of that specific configuration. An explicit deployment allowlist remains binding; sessions cannot override administrator restrictions. Updating the definition or revoking trust invalidates the previous local startup approval and requires review again.

<a id="配置并验证"></a>

## Configure and verify

The MCP settings page shows services, connection state, and tool catalogs. Use the CLI to configure stdio, HTTP, or SSE manually. `MCP_URL` must be a reviewed, reachable MCP endpoint, rather than a normal webpage or model Base URL:

```sh
node packages/cli/dist/local/agnes.mjs mcp add docs-tools --name docs-tools --http "$MCP_URL"
node packages/cli/dist/local/agnes.mjs mcp get docs-tools
```

New services start untrusted and disabled. Record the current revision, review the endpoint/process, secret references, and tool scope, then confirm interactively:

```sh
node packages/cli/dist/local/agnes.mjs mcp trust docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp get docs-tools
node packages/cli/dist/local/agnes.mjs mcp enable docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp status docs-tools
node packages/cli/dist/local/agnes.mjs mcp tools docs-tools
```

Before each write, obtain the latest revision with `get`. Do not assume the previous operation left it unchanged. A revision conflict indicates a concurrent or in-flight change; read again instead of retrying blindly.

For stdio, use `--stdio EXECUTABLE` and repeat `--arg VALUE` as needed. Do not pass a complete shell command as the executable or bypass the policy through `--arg -c`. Deployment policy also controls allowed executables. Host policy constrains HTTP/SSE addresses, redirects, and loopback reachability.

Use existing secret references: `--secret-env NAME=secret://namespace/name` for stdio, or `--bearer-ref secret://namespace/name` and `--header-ref x-api-key=secret://namespace/name` for HTTP/SSE. Keep real keys out of command lines, screenshots, and documentation. Repeat `--allow-tool TOOL_NAME` to restrict allowed tools.

<a id="调试变更与清理"></a>

## Diagnose, change, and clean up

```sh
node packages/cli/dist/local/agnes.mjs mcp test docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp reconnect docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp disable docs-tools --expected-revision REVISION
node packages/cli/dist/local/agnes.mjs mcp remove docs-tools --expected-revision REVISION
```

`test/reconnect` actually connects to the target. Reading a catalog does not verify every tool's effects. Use `mcp update` with the latest revision and the complete new definition, then review trust again. Operations return an operation ID. After a timeout, query `resources operation OPERATION_ID`; request cancellation with `resources cancel OPERATION_ID` if applicable.

The model can search and invoke tools from enabled catalogs, but server content remains external input. On disconnection, credential failure, or tool-list changes, inspect connection state, observed revision, catalog revision, and safe error details in `status`. Reinstalling a package is not a substitute for diagnosis.

<a id="运行方式与版本"></a>

## Runtime behavior and versions

At session-worker startup and turn boundaries after resource changes, the runner created by `createMcpRowRuntime()` calls `apply()`. It derives one Host `ext:` row per trusted and enabled server from a snapshot. Each row owns its connection; management commands run through the shared worker. See [verification](../maintainers/verification.md) for methods and scope.

Changing a definition changes the row's revision, while unchanged servers can retain their connections. Disabling or removing a server withdraws its row. Each definition is checked before derivation; invalid ones are skipped with a reason. Initial connection waiting is bounded, so a mounted row does not prove a successful remote connection. `agnes/mcp-search` and the catalog hub provide cross-server tool discovery. The legacy aggregate `agnes/mcp-client` extension has been removed from this mainline.

**OAuth limitation:** The current per-server row path skips definitions with `secretBinding.kind === 'oauth'`. The dedicated resource-management service worker retains the manager path. Successful connection/testing in the management interface therefore does not establish session tool availability. Verify an actual call in the target session; management status alone does not prove OAuth session support.

The runner's source and tests are linked below. Check [verification](../maintainers/verification.md) for the actual runtime version and external-service coverage.

Source: [management commands](../../packages/resource-control-cli/src/resources.ts), [schema](../../packages/protocol/schema/resource-control.json), [resource bootstrap](../../packages/resource-control-worker/src/runtime-bootstrap.ts), [worker startup](../../packages/worker-runtime/src/main.ts), [turn reload](../../packages/worker-runtime/src/commands.ts), [per-server runner](../../packages/worker-runtime/src/mcp-row-runtime.ts), and [row derivation](../../packages/worker-runtime/src/mcp-server-rows.ts). Verified anchors are recorded in the [source-check manifest](../../tools/public-docs/source-checks.json).
