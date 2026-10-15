# Official default tools

English | [简体中文](default-tools.zh-CN.md)

The standard preset advertises these tools from official `defineTool` plugins. Deployment capabilities and filesystem policy still apply. New local-dev and enterprise templates admit the projection capability needed by questions and deliverables; existing managed profiles must explicitly admit it.

The standard preset provides `ui_render`, `ui_update` and `ui_close` up front. `ui_submit` is an internal surface-action target and is excluded from model schemas and discovery. The past-session tools (`session_search`, `session_trace`, `session_event_search`, `session_event_read`, `session_event_trace`) and the MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) load on demand, each family listed as one line. MCP server tools follow their server's tool loading mode (see [MCP](../guide/mcp.md#mcp-工具如何提供给模型)). Deferred tools have a live, name-sorted `available_deferred_tools` prompt catalog with one sentence per tool, or one line per `discoveryGroup` with its tool count; descriptions are capped at 250 characters and the catalog at 8 KiB, with omitted entries routed to `tool_search`. Use `tool_search` to find a matching deferred tool, then `tool_describe` with its exact name to include its full schema in subsequent model requests. Discovery survives compaction and session reopen; the current session catalog, model capabilities, parameter validation and tool authorization still govern every call. `ask_user_question` stays immediately available and renders its form through the ordinary internal tool path. Business Loops may explicitly select tools through `prepareRequest({ tools: [...] })` or execute them through the controlled tool port; the finance pilot uses that execution port and sends prose requests with `tools: []`.

| Tool | Input and behavior |
| --- | --- |
| `read` | Reads confined workspace text, session attachments and originals. Local single-frame PNG/JPEG becomes artifact-backed model image input for a vision-capable model. Input limits: 4 MiB and 16 million pixels. Aspect-preserving downsampling uses the active model/runtime byte, dimension and pixel limits; metadata is stripped. Web uses the existing tool image card. Non-vision models receive an honest text notice without inspecting pixels. Other formats require a suitable tool. |
| `web_search` | `{"queries":["topic"]}`; one to four nonempty queries. A host-owned provider returns titles, URLs and snippets. Without a configured provider/key, returns `WEB_SEARCH_UNAVAILABLE`; use `web_fetch` with a known URL. |
| `ask_user_question` | `{"questions":[{"id":"route","question":"Choose a route","options":["A","B"]}]}`. Omit options for free text; `multiple:true` accepts several labels; `allowFreeText:true` admits an additional answer; optional `label` (up to 32 characters) names a question on its step and in the answer summary. One to four questions with unique ids. The Web shows the questions as a step card above the composer and the submitted answers in the conversation; the tool result tells the model not to restate them. `timeoutMs` defaults to 0 (continue immediately); 1–60000 optionally waits up to a durable deadline. Sibling tools remain allowed; late answers arrive as new input. |
| `present` | `{"files":[{"path":"report.pdf","name":"Report.pdf","description":"Review copy"}]}`. Registers existing readable regular files, copying their bytes into session artifacts. Up to sixteen files, each and the total at most 32 MiB. The surface lists names, descriptions and artifact identities; the tool result retains authorized artifact references. |
| `shell` | `{"command":"npm run build","background":true}` starts a session job. `timeoutMs` controls the foreground wait; when it expires, the same process continues in the background. `timeoutToBackground:false` kills it instead. |
| `job_list` | `{}` lists this session/lane's running and completed jobs. |
| `job_output` | `{"jobId":"RETURNED_ID","waitMs":1000}` reads captured output/status, optionally waiting up to 60 seconds, capped by the tool deadline. Long output spills to a readable artifact. |
| `job_kill` | `{"jobId":"RETURNED_ID"}` stops the owned job and its process group. |
| `schedule_create` | Creates a scheduled task. Pass exactly one of `after_seconds`, `at`, `every_seconds`, `daily`, `weekly`, or `cron`, and a `target`: `new_session` opens a fresh session in this session's workspace for every run (for recurring work); `current_session` sends the prompt into this session, starting a turn if it is idle or joining the running one (for one-off reminders). The result's `runsIn` says where it runs. |
| `schedule_list` | Lists the active tasks this session created or receives, with where each runs, the next run and recent runs. |
| `schedule_update` | Changes a task this session created or receives. `after_seconds` is create-only; omitting `target` keeps it. A prompt, schedule or target change while a run is in flight returns `schedule_conflict`. |
| `schedule_delete` | Archives a task. Unknown and already archived ids return `deleted: false`. A queued message is not retracted. |
| `grep` / `find` | Use the pinned bundled ripgrep executable. Search skips dependencies, build directories, denied paths and symlinks. Outputs beyond the requested row limit spill to `artifact://…?size=…`; pass the complete locator to `read` with `offset`/`limit`. |

A search path may name one file, including a readable file symlink; an explicit file ignores the grep glob. Directory walks do not follow symlinks. When the search executable cannot be launched, a bounded filesystem fallback uses the same workspace policy. Results name unreadable paths with bounded reasons and count binary skips; failure to search any readable text is an error, while an ordinary no-match result succeeds.

Read an existing text file in the same session before using `write` or `edit` on it. A missing observation returns `FS_NOT_OBSERVED`; a successful mutation records the resulting version. New files can be created directly. Observations are bounded and process-local: restarting the Host or evicting an observation requires a fresh read. Binary, failed and artifact reads do not unlock workspace mutation. Existing stale-write and truncation checks remain active. `write` uses CRLF for `.bat`/`.cmd` files and preserves consistent CRLF in existing files. `edit` accepts LF replacement text in a consistently CRLF file. Both preserve an existing UTF-8 BOM; version tracking, byte counts and review receipts describe the actual written bytes.

Web questions use one preset surface form with radio, checkbox or free-text controls. The TUI reads the same surfaces: a single question accepts a label or option number, multiple choices accept comma-separated labels/numbers, and several questions accept a JSON object keyed by question id. Both submit through `ui.action` to the ordinary deferred `ui_submit` collector. Invalid/stale answers and ordinary tool-policy refusals leave the form open. Successful answers close it and reach the Agent through SC1 with the authenticated actor and untrusted content. Answering grants no tool permission. `timeoutMs` limits waiting only; late answers remain valid. Reloading reconstructs forms and action receipts from the ledger. Channels display numbered choices and use the authenticated Web link to answer; configure `outbound.webUrl` to the reachable Web base URL.

Five-field cron follows Vixie. A day-of-month or day-of-week field is unrestricted when its text starts with `*`; when both are restricted, a date matches if either field matches. Weekday `7` is Sunday. With a time zone, a local time that does not exist is skipped, and a repeated local time fires once at the earlier instant. After downtime, a recurring reminder delivers only its latest missed occurrence. Deleting a reminder does not retract a message that is already queued. The search horizon is 366 days.

Shell commands receive `PYTHONUNBUFFERED=1` and `PYTHONUTF8=1`. PowerShell uses the Host-selected interpreter; 5.1 receives command text to avoid serialized CLIXML. Invalid UTF-8 output falls back to a supported measured console code page, independently for each line. Timeouts report empty output and repeated attempts without guessing a cause. Measured descendant cleanup appears in shell results.

Jobs survive turns but not Host restart. Session close kills and drains owned processes. Active process handles keep their session resident during idle sweeps. Cleanup failures remain visible and retain the handle for a later close attempt. Capture is bounded to 4 MiB per job; the registry retains 128 jobs per session/lane and evicts completed entries first. The selected sandbox provider owns execution; missing interactive support refuses before launch. Tool cancellation kills a foreground job; a successful background call leaves it running.

Set `shell` inputs `persistent:true` and `shell:"bash"`, `"zsh"` or `"pwsh"` to retain cwd, environment and variables across calls. Results include the command's `jobId` and interpreter's `sessionId`. Supply `sessionId` to choose an existing interpreter. Commands serialize; a busy interpreter refuses another command. Killing a persistent command closes its interpreter. Use a PTY for commands that consume interactive stdin.

`pty_open` accepts `shell`, optional `cwd`, `columns` and `rows`; `pty_read` reads captured output with optional `waitMs`; `pty_send` sends exact `text`; `pty_signal` accepts `SIGINT`, `SIGTERM` or `SIGHUP`; `pty_resize` changes dimensions; `pty_list` lists terminals; `pty_close` kills and joins cleanup. Every operation uses the returned `jobId`. `job_*` also controls PTYs, persistent interpreters and child agents; child IDs use `child:<id>`. Completion notices appear in the model's subsequent context and the Web jobs panel.

Local PTY is supported on macOS/Linux after building Host native helpers. Local Windows supports pipe execution; PTY needs a supporting provider. Each selected shell must be installed. Remote/provider execution must supply the optional public process port and never falls back to a local process.

File search limits process capture and accumulated match text to 4 MiB. A capture ceiling is reported as a partial search; spill artifacts contain all captured rows, not uncaptured data. File access remains checked through the public context and confined executor. Distributions copy the pinned platform executable and its license notices beside the runtime; a system `rg` install is unnecessary.

Local artifact stores accept a configured read limit from zero through the 32 MiB hard cap. CLI and daemon use 32 MiB, matching the maximum deliverable and spill-readable artifact size. Ripgrep refuses captured search output above that ceiling with an error asking for a narrower search, before either spill path stores bytes. Computer Use images retain their separate 4 MiB cap, and RPC response chunks retain their own bounds.

Questions, reminder/workflow tables and deliverable lists use the same Intelligent UI surface projection, rendered inline and in the workbench. They no longer fill dedicated `tool.card.inline` payload formats. Deliverables use the existing text preset; no special download control or component is added.

Artifact consumers use the existing session/lane-authorized artifact RPC in bounded chunks. The client verifies size and SHA-256 before creating a temporary URL. HTML and other active formats are downloaded as bytes. Presenting a path does not grant access to arbitrary host paths or URLs.

A deployment embeds search through the public host dependency:

```ts
import type { SearchProvider } from '@agnes/extension-api'

const searchProvider: SearchProvider = {
  async search(queries, { signal, timeoutMs }) {
    return deploymentSearch.search(queries, { signal, timeoutMs })
  },
}
// Add searchProvider to the existing createHost(profile, dependencies) options.
```

The provider owns credentials, transport and vendor selection. The tool receives no key and chooses no vendor. Settings → Web search configures Brave, Tavily, Exa, Perplexity or self-hosted SearXNG. Endpoints, result limits, timeouts and rate limits are stored in the profile data directory. Tool calls and the settings test share one rate window there. API keys are stored only at `secret://search/<provider>`, in the home secrets directory (`<home>/secrets`) that the file adapter reads when a profile does not pin another path. A store left under `<dataDir>/secrets` is moved there. With no ready default provider the tool returns `WEB_SEARCH_UNAVAILABLE`. A deployment-supplied `SearchProvider` replaces that registry. Normalized snippets include a Citations list. Provider failures return a generic error without logging credentials.

## Persistent goal tools

goal_get {} reads the session goal and its round/credit usage. goal_update accepts status "complete" or "blocked" and a nonempty reason. The model cannot create or resume goals. Use the Web goal card or /goal controls described in [sessions](../guide/sessions.md#persistent-goals).
