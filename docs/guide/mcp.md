# MCP: connect external tools

English | [简体中文](mcp.zh-CN.md)

<a id="mcp连接外部工具"></a>

[Documentation](../README.md) · [Security](security.md)

Connect an existing MCP tool service to AGH's task flow. This guide covers adding a service, reviewing its tool scope, connecting, and checking actual state after configuration changes.

Definitions, security approval, desired enablement, and actual connection state remain separate in the control plane. In Web, users review the definition and choose Enable once; AGH completes the approval check before enabling. Inspect the catalog, then verify a real tool call.

In Web, choose **Add MCP service**, then **Local command** or **Remote service**. Enter a name and the command or URL. Commands retain quoted arguments; they are not run through a shell. Select an existing saved credential when authentication is required. For a local command, set its required token environment variable in **Advanced options**; the initial name is `TOKEN`. Web currently selects existing credentials and does not create new ones.

**Advanced options** contains the service ID, workspace, sandbox profile, allowed tools and custom credential bindings. Local stdio, HTTP and legacy SSE remain supported. For an existing service, choose **Edit** in its row menu or details. Saving preserves the confirmation step and leaves a new service disabled until you enable it. Choose **Test connection**, then inspect connection status and the tool catalog to verify actual availability.

**Current implementation:** Session MCP services run as individual Host rows. OAuth bindings are still skipped on this session path; see [runtime behavior and versions](#runtime-behavior-and-versions). Supported and unsupported MCP and Skill behavior, including resources, prompt templates, and OAuth, is listed in [MCP and Skills support](mcp-skills-support.md). See [verification](../maintainers/verification.md) for versioned results.

<a id="在会话中接入"></a>

Each remote tool has one local name, `mcp__<server>__<tool>`. Names changed by sanitization, length limits or collisions carry a hash and stay within 64 characters. Each server receives only its own prefix grant; execution still sends the original remote tool name. Per-server resource bridge tools use the same naming rule.

## Add a service in a session

Under full access, helper requests to register, trust, enable and start MCP servers are allowed automatically without approval prompts. Evidence retains the exact configuration and reason `full-access`. Human management-page edits still require administration authority; hard deployment refusals and connection failures remain effective.

Automatic registration/start authority is bound to the exact configuration, session, actor and expiry. Switching away from Full access, cancelling or closing the session stops remaining effects, including queued writes; restart cannot revive an unfinished automatic authorization. Already completed management changes are not rolled back. Re-read the definition and operation receipt before continuing; ordinary administrator review remains available.

`tool_search` searches all session-visible tools, including tools already provided to the model, by name, description and parameter keywords. Deferred and eager tools share ranking and appear once; ready Skills retain their discovery slots. Use `tool_describe` to load a deferred schema. Search-provider names such as Tavily refer to the configured provider behind `web_search`, not a separate tool. Discovery is not a connectivity test; invoke the tool or use the settings test to verify readiness. Provider examples in the description are static, so configuration changes do not rewrite tool schemas.

In a local AGH session, ask to connect an MCP service and provide its project URL or connection details. The helper targets the current AGH instance by default. After confirming the configuration, inspect registration and connection state under **Plugins → Connections (MCP)**. Connections and tool lists update at turn boundaries; you can use the service in the next turn of the same session.

This entry point is provided by `@agnes/mcp-helper`, installed and enabled by default. The first upgrade of an existing configuration also installs missing default helpers. If you disabled or removed it, inspect or install it through [plugin management](packages.md). Disabling the helper removes its session management tools; existing MCP services remain independently managed.

The session helper currently supports credential-free stdio, HTTP, and SSE definitions. For credentials, use the SecretRef command-line flow below rather than pasting secrets into chat. Hosts without session management tools can also use the CLI. For applications such as Blender, installing the application plugin, starting the application, and connecting MCP are separate steps. Verify availability with an actual tool call.

Confirmation for a local stdio service authorizes startup of that specific configuration. An explicit deployment allowlist remains binding; sessions cannot override administrator restrictions. Updating the definition or revoking trust invalidates the previous local startup approval and requires review again.

## Browser automation: Playwright MCP or Computer Use?

Use **Playwright MCP** for business websites with accessible page controls: navigating a CRM, filling forms, reading tables or checking a workflow. It uses the browser's accessibility tree and can run headless without occupying the desktop. Use **Computer Use** (`agnes/computer-use`, Cua driver) for native desktop applications, visual/canvas controls, or workflows that require screenshots and pixel clicks on the real screen. Choose according to the target interface; Playwright MCP remains an ordinary live MCP resource.

In **Plugins → Connections (MCP) → Add preset**, select **Playwright MCP**. AGH prefills the existing editable form with `npx --yes @playwright/mcp@0.0.83 --headless --isolated` and the `network` sandbox profile. The package and flags were checked against the [npm package](https://www.npmjs.com/package/@playwright/mcp/v/0.0.83) and [upstream documentation](https://github.com/microsoft/playwright-mcp#configuration). Review the command, workspace, sandbox and tool scope, then save through the normal confirmation. The resource remains **untrusted and disabled**. Choose **Enable** and confirm to trust that revision and request activation. Selecting or saving a preset does not install or launch anything.

The matching CLI command uses the existing `mcp` command shape:

```sh
node agnes.mjs mcp add --preset playwright
# Optional independent server ID and explicit workspace on the daemon machine:
node agnes.mjs mcp add billing-browser --preset playwright --sandbox-workspace /workspace/billing
node agnes.mjs mcp get playwright
node agnes.mjs mcp trust playwright --expected-revision REVISION
node agnes.mjs mcp get playwright
node agnes.mjs mcp enable playwright --expected-revision REVISION
```

Non-interactive callers must explicitly supply `--yes` to each mutation. CLI preset creation does not grant trust or enablement. Edit a saved definition through the normal complete-definition `mcp update` flow; changing it requires review again.

`--isolated` keeps each browser connection's profile in memory; it does not reuse the user's browser login and does not preserve login state across browser closure. Automatic outputs use upstream's hidden `.playwright-mcp` directory in a writable workspace. The existing `network` sandbox makes the workspace read-only, so upstream falls back to `.playwright-mcp` under the server's private `TMPDIR` (`<profile-data>/mcp/<server-id>`). An explicitly named file resolves against the workspace instead and can be refused by the sandbox. The preset deliberately leaves `--output-dir` unset to retain this writable fallback; it does not widen sandbox permissions.

AGH does not bundle or install browsers. Prepare a compatible browser in the daemon's execution environment before use; inspect upstream's browser setup instructions and any `--browser` / `--executable-path` edits before trusting the definition. After explicit enablement (or a confirmed connection test), npx may download the pinned package into the server environment. Deployment executable restrictions, network access and available sandbox enforcement still apply. Check `mcp status playwright` and verify an actual browser tool call; this preset is a configuration convenience, not a claim that browser launch works on every platform.

## Try a local stdio server

From the source repository after building the CLI, this example needs only Node and no network dependency or API key. It uses a fresh AGH_HOME and the local-dev profile. The daemon launches the server after trust and enable; do not start it separately.

```sh
export AGNES_PROFILE=local-dev
export AGH_HOME="$(mktemp -d)"
cat > "$AGH_HOME/hello-mcp.mjs" <<'JS'
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'hello-local', version: '1.0.0' },
  };
  if (request.method === 'tools/list') result = { tools: [{
    name: 'hello', description: 'Return a local greeting',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }] };
  if (request.method === 'tools/call') result = {
    content: [{ type: 'text', text: 'Hello from local MCP' }],
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
JS
node agnes.mjs mcp add hello-local --name hello-local --stdio node --arg "$AGH_HOME/hello-mcp.mjs" --yes
MCP_REVISION=$(node agnes.mjs mcp get hello-local | sed -n 's/.*revision=\([a-f0-9]*\).*/\1/p')
node agnes.mjs mcp trust hello-local --expected-revision "$MCP_REVISION" --yes
MCP_REVISION=$(node agnes.mjs mcp get hello-local | sed -n 's/.*revision=\([a-f0-9]*\).*/\1/p')
node agnes.mjs mcp enable hello-local --expected-revision "$MCP_REVISION" --yes
node agnes.mjs mcp status hello-local
node agnes.mjs mcp tools hello-local
node agnes.mjs mcp test hello-local --expected-revision "$MCP_REVISION" --yes
```

Expect `connection=ready`, a `hello` tool, and a succeeded test. In a configured session ask the agent to call `hello` on `hello-local`.

Local-dev permits stdio `node`, `npx`, `python`, and `python3` on PATH, plus HTTP on loopback (`127.0.0.1`, `localhost`, `[::1]`) by default. These are deployment defaults, not trust grants: definitions still need review and enablement. Set `AGNES_MCP_LOCAL_DEV_DEFAULTS=0` before daemon startup to disable both defaults. `AGNES_MCP_STDIO_ALLOWLIST` (comma-separated exact executable names/paths, including an empty value) replaces the default executable list; `AGNES_MCP_ALLOW_LOOPBACK_HTTP=0` disables loopback HTTP (`1` explicitly enables it). Restart the daemon when changing deployment settings. Enterprise and other production profiles keep their existing policy. Non-TTY mutations require `--yes`; `agh mcp --help` is safe to run without starting the backend. Enable/test failures include the concrete safe status reason.

<a id="配置并验证"></a>

## Configure and verify

AGH normalizes empty input schemas and object-like schemas without `type` to `type: "object"`. A genuinely non-object or invalid root is skipped with an `invalid-schema` reason in the catalog; other tools from that server remain available.

The MCP settings page shows services, connection state, and tool catalogs. Use the CLI to configure stdio, HTTP, or SSE manually. `MCP_URL` must be a reviewed, reachable MCP endpoint, rather than a normal webpage or model Base URL:

```sh
node agnes.mjs mcp add docs-tools --name docs-tools --http "$MCP_URL"
node agnes.mjs mcp get docs-tools
```

New services start disabled. In Web, review the endpoint/process, secret references, and tool scope, then choose Enable; there is no separate trust action. The switch follows your enable request: it stays on once you have asked for it, even when the connection or policy check fails, and the error code and reason appear in the same row. Turning it off withdraws the request, and is required before the server can be removed. The CLI exposes the underlying approval and enablement steps separately, so record the current revision and run:

```sh
node agnes.mjs mcp trust docs-tools --expected-revision REVISION
node agnes.mjs mcp get docs-tools
node agnes.mjs mcp enable docs-tools --expected-revision REVISION
node agnes.mjs mcp status docs-tools
node agnes.mjs mcp tools docs-tools
```

Before each write, obtain the latest revision with `get`. Do not assume the previous operation left it unchanged. A revision conflict indicates a concurrent or in-flight change; read again instead of retrying blindly.

For stdio, use `--stdio EXECUTABLE` and repeat `--arg VALUE` as needed. Do not pass a complete shell command as the executable or bypass the policy through `--arg -c`. Deployment policy also controls allowed executables. Host policy constrains HTTP/SSE addresses, redirects, and loopback reachability. A GET SSE connection stays open when it is quiet. The deployment idle timer and request deadline apply to ordinary responses and POST streams, not to a GET `text/event-stream`, and the deployment client disables undici's five-minute body timeout.

Use existing secret references: `--secret-env NAME=secret://namespace/name` for stdio, or `--bearer-ref secret://namespace/name` and `--header-ref x-api-key=secret://namespace/name` for HTTP/SSE. Keep real keys out of command lines, screenshots, and documentation. Repeat `--allow-tool TOOL_NAME` to restrict allowed tools.

<a id="mcp-工具如何提供给模型"></a>

## How MCP tools reach the model

Every tool schema the model can call is sent with every request, so a large MCP catalog costs context and money on every turn. Measured with the official tool set: one server with 15 typical tools adds about 2,750 tokens per request, ten such servers about 27,500.

You do not have to choose anything. Each server's tool loading mode is **Automatic** by default: while the session holds at most 15 automatic tools whose schemas stay under about 4,000 tokens, they are sent as usual. Past either limit, all automatic tools move behind `tool_search`, and the model sees one line per server instead: its name, how many tools it has and a few of their names. The model searches by task or server name, loads a tool with `tool_describe`, and that tool stays loaded for the rest of the session, including after compaction and reopening. Loading grants nothing: argument validation, policy and approvals are the same as for any other call.

With advanced settings shown, the server's detail page has a **Tool loading** control: Automatic, Always visible (the schemas are always sent) or On demand (always behind `tool_search`). It is the definition's `toolDisclosure` field (`auto`, `always` or `on-demand`; omitted means `auto`), saved through the normal `mcp update` path. Changing only this mode keeps the server trusted and enabled, because nothing that runs or connects changes; any other edit still asks for review again. The session runtime dialog marks the tools that load on demand.

<a id="调试变更与清理"></a>

## Diagnose, change, and clean up

```sh
node agnes.mjs mcp test docs-tools --expected-revision REVISION
node agnes.mjs mcp reconnect docs-tools --expected-revision REVISION
node agnes.mjs mcp disable docs-tools --expected-revision REVISION
node agnes.mjs mcp remove docs-tools --expected-revision REVISION
```

`test/reconnect` actually connects to the target. Reading a catalog does not verify every tool's effects. Use `mcp update` with the latest revision and the complete new definition, then review trust again. Operations return an operation ID. After a timeout, query `resources operation OPERATION_ID`; request cancellation with `resources cancel OPERATION_ID` if applicable.

The model can search and invoke tools from enabled catalogs, but server content remains external input. On disconnection, credential failure, or tool-list changes, inspect connection state, observed revision, catalog revision, and safe error details in `status`. Reinstalling a package is not a substitute for diagnosis.

<a id="运行方式与版本"></a>

## Runtime behavior and versions

At session-worker startup and turn boundaries after resource changes, the runner created by `createMcpRowRuntime()` calls `apply()`. It derives one Host `ext:` row per trusted and enabled server from a snapshot. Each row owns its connection; management commands run through the shared worker. See [verification](../maintainers/verification.md) for methods and scope.

Changing a definition changes the row's revision, while unchanged servers can retain their connections. Disabling or removing a server withdraws its row. Each definition is checked before derivation; invalid ones are skipped with a reason. A turn waits at most 10 seconds for a newly enabled server's first connection. A server still connecting after that starts the turn without its tools, and the conversation shows a quiet notice such as "Docs Tools is still connecting; this turn runs without it." Its tools join a later turn once connected. A mounted row therefore does not prove a successful remote connection. `agnes/mcp-search` and the catalog hub provide cross-server tool discovery. The legacy aggregate `agnes/mcp-client` extension has been removed from this mainline.

**Large results:** A tool result is cut by the same output guard as built-in tools (see `tools.output_max_bytes`): the model sees a head and a tail, and the text is stored under an `artifact://…?size=…` path that `read` and `grep` accept. When a call returns many blocks that together pass four times that limit, the model sees the first ones and the full text set is stored the same way, one `=== text block N of M ===` line before each block. At most 4 MiB of text per call is kept. Past that the result is cut at a character boundary, later text blocks are dropped, and a note at the top of the result says how many bytes the server returned and how many were kept; the rest is not stored and cannot be read back. The MCP client reads a whole response into memory before any of this applies, so the limit bounds what is copied and stored, not that first buffer.

A successfully applied MCP set remains effective if the independent Skills refresh fails, so a disabled or removed server cannot be restored by that failure. If MCP application leaves an uncertain state, the worker refuses further turns until recovery.

**OAuth limitation:** The current per-server row path skips definitions with `secretBinding.kind === 'oauth'`. The dedicated resource-management service worker retains the manager path. Successful connection/testing in the management interface therefore does not establish session tool availability. Verify an actual call in the target session; management status alone does not prove OAuth session support.

The runner's source and tests are linked below. Check [verification](../maintainers/verification.md) for the actual runtime version and external-service coverage.

Source: [management commands](../../packages/resource-control-cli/src/resources.ts), [schema](../../packages/protocol/schema/resource-control.json), [resource bootstrap](../../packages/resource-control-worker/src/runtime-bootstrap.ts), [worker startup](../../packages/worker-runtime/src/main.ts), [turn reload](../../packages/worker-runtime/src/commands.ts), [per-server runner](../../packages/worker-runtime/src/mcp-row-runtime.ts), and [row derivation](../../packages/worker-runtime/src/mcp-server-rows.ts). Verified anchors are recorded in the [source-check manifest](../../tools/public-docs/source-checks.json).

## Sandboxing local community servers

Managed community stdio servers default to `strict`. Choose `sandboxProfile` in MCP settings before trusting that definition:

| Profile | Workspace | Own MCP data | Network |
| --- | --- | --- | --- |
| `strict` | Read | Read/write | Denied |
| `workspace-write` | Read/write | Read/write | Denied |
| `network` | Read | Read/write | Allowed |
| `off-with-warning` | Full host access | Full host access | Allowed |

The profile is part of the revision approved in the trust dialog. Editing it requires a new trust decision and reconnects the server. Only an exact definition verified by the administrator's signed official catalog defaults to off; manual/local definitions remain community definitions.

Sandboxed children read the workspace, their own data directory and necessary read-only executable/system files. Their `HOME` and `TMPDIR` point to `<profile-data>/mcp/<server-id>`; they cannot read the user's home secrets or write arbitrary outside paths. Keep server runtime dependencies in the workspace or package its entry point as a self-contained file. Declare an optional absolute `workspacePath` in the server settings (CLI: `--sandbox-workspace /workspace/project`), alongside `--sandbox-profile strict`. This directory is part of the reviewed definition, so editing it revokes the prior trust decision. Without a declared workspace, shared workers grant only the server data directory; the connection never silently adopts a different session’s workspace.

The connection owner uses the existing command sandbox probe and compiler (macOS Seatbelt or Linux bubblewrap when it actually runs). Host supplies the actual installation home and any configured file-secret directory. All confined profiles exclude workspace `.agh/secrets`, legacy data secrets, and the installation's secrets, authentication and profile configuration directories, including canonical and bind aliases. A writable workspace grant never overrides these exclusions. Before confinement, Host may reserve empty protected directories with mode `0700` where read-only mounts need existing mountpoints; if preparation fails, the connection is refused. Renaming a protected ancestor must not expose its contents.

Missing actual home information or unusable enforcement refuses the connection with `E_MCP_SANDBOX_UNAVAILABLE`, shown in MCP diagnostics; it never silently starts unconfined. Windows currently requires explicitly approving `off-with-warning`. That profile grants the child full host access; review the executable before confirming. HTTP/SSE servers are remote and retain their existing URL, credential and tool policies.

## Manage generic credentials

Use the [credential management contract](credentials.md) to create a write-only key, then use its returned `secret://generic/<UUID>` id in the existing MCP secret binding.
