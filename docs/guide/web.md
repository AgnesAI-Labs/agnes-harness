# Web workbench: manage tasks and extensions

English | [简体中文](web.zh-CN.md)

<a id="web-工作台集中管理任务与扩展"></a>

[Documentation](../README.md) · [First-time configuration](quickstart.md)

The Web workbench brings tasks, history, and administration into one local interface. Configure a model using the [quickstart](quickstart.md), then use this guide to understand task state, everyday management, and connections.

<a id="启动与连接"></a>

## Start and connect

```sh
node packages/cli/dist/local/agnes.mjs serve
```

Web listens on loopback. The current page does not accept or store a local connection token; the server checks connections against the Origin and Host fixed at startup. Do not interchange `localhost` and `127.0.0.1`. When changing the port, set a matching origin:

```sh
export AGNES_WEB_ORIGIN=http://127.0.0.1:4180
node packages/cli/dist/local/agnes.mjs serve --port 4180
```

If an existing daemon has a different Origin, startup refuses to reuse it. Check its tasks, explicitly stop that instance, and restart. This entry point is a local workbench; this guide does not provide a public deployment or reverse-proxy login setup.

Session and approval traffic uses the browser SDK's direct WebSocket connection to the daemon. Resource/plugin management and plugin backend services use a same-origin HTTP BFF. Both belong to the local workbench; see the [communication architecture](../develop/architecture.md#the-two-web-communication-paths).

<a id="完成一轮任务"></a>

## Complete a task

1. Create a task from the sidebar and confirm the working directory in the creation dialog. Canceling the dialog does not create a session.
2. Select the current session's route/model in the model picker. Changing a provider default and changing a session's selection are separate operations.
3. Enter a message and click Send or press Cmd/Ctrl+Enter. Messages sent during a run are queued as follow-ups.
4. Inspect tool arguments, results, and errors in their records. Reasoning text, tool state, and usage come from backend projections; the interface does not invent missing information.
5. When approval is requested, check the current choices and scope. After submitting, wait for backend confirmation; a disappearing button alone does not prove execution.
6. After clicking Stop, wait for the actual terminal state. A stop-request message only means cancellation has been requested.

### Inspect the trajectory

Switch from Chat to Trajectory to review a session by turn and step. Select a record for its status, duration, error, and available token usage. The timeline offers four order and duration modes: drag to filter, scroll to zoom, right-drag to pan, and press Escape to clear the range.

Fold turns or tool calls, search the records, or load earlier history as needed. Tool arguments and results in **Projected content** are previews; choose **Full input** or **Full output** to read the recorded detail on demand. **Timing** shows recorded time fields. Missing timing, usage, or history is labeled rather than estimated.

<a id="日常管理"></a>

## Everyday management

Settings manages model accounts, plugins, Skills/MCP, appearance, and Computer Use. Available actions depend on backend capabilities and permissions. Installed plugins still require trust and enablement; see [plugin management](packages.md). Reopen history from the sidebar, or use the archive view for archived tasks. Archiving does not delete session history.

To add MCP, describe the integration in chat and supply a service address or connection details, then inspect it in settings. New services must be trusted and enabled in sequence; see [MCP integration](mcp.md). Use the SecretRef configuration flow for credentials.

The URL's `session` parameter selects the session. After a refresh or brief disconnection, the SDK reloads the projection from the backend without automatically resending business requests. If reconnection fails, inspect `daemon status`. After a daemon restart, open the normal URL printed by the current `serve` process. Local mode does not need to restore a startup token from sessionStorage.

Closing the browser, disconnecting the page, or stopping `serve` affects the client/Web service. Session facts determine whether backend tasks have ended. Run `daemon stop` separately to fully stop a trial instance.

<a id="当前交互边界"></a>

## Current interaction boundaries

Tool results use constrained previews and detail views. They cannot render arbitrary HTML. Do not assume every artifact supports upload, download, or rename, or that every message supports editing and regeneration. The interface exposes actions supported by the current backend. See [verification](../maintainers/verification.md) for the scope of real browser testing.

Implementation: [Web entry](../../packages/web/src/serve-entry.ts), [application](../../packages/web/src/app.ts), [server and origin checks](../../packages/web-server/src/server.ts), [session actions](../../packages/web/src/session-actions.ts).
