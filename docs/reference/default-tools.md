# Official default tools

English | [简体中文](default-tools.zh-CN.md)

The standard preset advertises these tools from official `defineTool` plugins. Deployment capabilities and filesystem policy still apply. New local-dev and enterprise templates admit the projection capability needed by questions and deliverables; existing managed profiles must explicitly admit it.

| Tool | Input and behavior |
| --- | --- |
| `web_search` | `{"queries":["topic"]}`; one to four nonempty queries. A host-owned provider returns titles, URLs and snippets. Without a configured provider/key, returns `WEB_SEARCH_UNAVAILABLE`; use `web_fetch` with a known URL. |
| `ask_user_question` | `{"questions":[{"id":"route","question":"Choose a route","options":["A","B"]}]}`. Omit options for free text; `multiple:true` accepts several labels; `allowFreeText:true` admits an additional answer. One to four questions with unique ids. `timeoutMs` defaults to 0 (continue immediately); 1–60000 optionally waits up to a durable deadline. Sibling tools remain allowed; late answers arrive as new input. |
| `present` | `{"files":[{"path":"report.pdf","name":"Report.pdf","description":"Review copy"}]}`. Registers existing readable regular files, copying their bytes into session artifacts. Up to sixteen files, each and the total at most 32 MiB. The Web card provides Open and Download. |
| `shell` | `{"command":"npm run build","background":true}` starts a session job. `timeoutMs` controls the foreground wait; when it expires, the same process continues in the background. `timeoutToBackground:false` kills it instead. |
| `job_list` | `{}` lists this session/lane's running and completed jobs. |
| `job_output` | `{"jobId":"RETURNED_ID","waitMs":1000}` reads captured output/status, optionally waiting up to 60 seconds, capped by the tool deadline. Long output spills to a readable artifact. |
| `job_kill` | `{"jobId":"RETURNED_ID"}` stops the owned job and its process group. |
| `grep` / `find` | Use the pinned bundled ripgrep executable. Search skips dependencies, build directories, denied paths and symlinks. Outputs beyond the requested row limit spill to `artifact://…?size=…`; pass the complete locator to `read` with `offset`/`limit`. |

Read an existing text file in the same session before using `write` or `edit` on it. A missing observation returns `FS_NOT_OBSERVED`; a successful mutation records the resulting version. New files can be created directly. Observations are bounded and process-local: restarting the Host or evicting an observation requires a fresh read. Binary, failed and artifact reads do not unlock workspace mutation. Existing stale-write and truncation checks remain active.

Web questions use choice controls and free-text fields. The TUI displays a question prompt; a single question accepts a label or option number, and multiple choices accept comma-separated labels/numbers. For several questions, enter a JSON object mapping each id to its answer (arrays for multiple choice). Answers are validated and persisted as ordinary user-message ledger events. Invalid answers leave the question open. The agent continues when the deadline expires. Reloaded projections reconstruct pending questions and accepted answers from the ledger.

Jobs survive turns but not Host restart. Session close kills and drains owned processes. Capture is bounded to 4 MiB per job; the registry retains 128 jobs per session/lane and evicts completed entries first. The selected sandbox provider owns execution; missing interactive support refuses before launch. Tool cancellation kills a foreground job; a successful background call leaves it running.

Set `shell` inputs `persistent:true` and `shell:"bash"`, `"zsh"` or `"pwsh"` to retain cwd, environment and variables across calls. Results include the command's `jobId` and interpreter's `sessionId`. Supply `sessionId` to choose an existing interpreter. Commands serialize; a busy interpreter refuses another command. Killing a persistent command closes its interpreter. Use a PTY for commands that consume interactive stdin.

`pty_open` accepts `shell`, optional `cwd`, `columns` and `rows`; `pty_read` reads captured output with optional `waitMs`; `pty_send` sends exact `text`; `pty_signal` accepts `SIGINT`, `SIGTERM` or `SIGHUP`; `pty_resize` changes dimensions; `pty_list` lists terminals; `pty_close` kills and joins cleanup. Every operation uses the returned `jobId`. `job_*` also controls PTYs, persistent interpreters and child agents; child IDs use `child:<id>`. Completion notices appear in the model's subsequent context and the Web jobs panel.

Local PTY is supported on macOS/Linux after building Host native helpers. Local Windows supports pipe execution; PTY needs a supporting provider. Each selected shell must be installed. Remote/provider execution must supply the optional public process port and never falls back to a local process.

File search limits process capture and accumulated match text to 4 MiB. A capture ceiling is reported as a partial search; spill artifacts contain all captured rows, not uncaptured data. File access remains checked through the public context and confined executor. Distributions copy the pinned platform executable and its license notices beside the runtime; a system `rg` install is unnecessary.

Local artifact stores accept a configured read limit from zero through the 32 MiB hard cap. CLI and daemon use 32 MiB, matching the maximum deliverable and spill-readable artifact size. Ripgrep refuses captured search output above that ceiling with an error asking for a narrower search, before either spill path stores bytes. Computer Use images retain their separate 4 MiB cap, and RPC response chunks retain their own bounds.

Automatic question and deliverable cards attach to existing completed tool nodes. Live updates use journal patches; opening and history fill only their bounded page and account for card bytes. Explicit dynamic projection fills that synthesize additional nodes retain the full-view path.

Deliverable downloads use the existing session/lane-authorized artifact RPC in bounded chunks. The client verifies size and SHA-256 before creating a temporary URL. HTML and other active formats are downloaded as bytes. Presenting a path does not grant access to arbitrary host paths or URLs.

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

The provider owns credentials, transport and vendor selection. The tool receives no key and chooses no vendor. Settings → Web search configures Brave, Tavily, Exa, Perplexity or self-hosted SearXNG. Endpoints, result limits, timeouts and rate limits are stored in the profile data directory. API keys are stored only at `secret://search/<provider>`. With no ready default provider the tool returns `WEB_SEARCH_UNAVAILABLE`. A deployment-supplied `SearchProvider` replaces that registry. Normalized snippets include a Citations list. Provider failures return a generic error without logging credentials.
