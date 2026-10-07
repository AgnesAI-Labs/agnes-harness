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
3. Enter a message and click Send or press Cmd/Ctrl+Enter. Messages sent during a run are queued as follow-ups and run in order after the current turn completes. Stopping, a failed turn, or pending approval pauses automatic continuation and preserves unsent input. Sending a new message after a stop or failure resumes preserved input first, then the new message.
4. Queued messages appear above the input with their count and order, including after reopening or reconnecting. **Send now** stops the current turn and executes the selected queued message first; the other messages keep their order and continue after it completes. **Delete** removes only that pending message without stopping the current turn or starting queued work; the remaining messages keep their order. It removes the message from the execution queue, while its original event remains in session history. A message that has already started cannot be deleted or sent twice. If an action fails, its error appears beside the queue and the list refreshes.

5. Inspect tool arguments, results, and errors in their records. Reasoning text, tool state, and usage come from backend projections; the interface does not invent missing information.
6. When approval is requested, check the current choices and scope. After submitting, wait for backend confirmation; a disappearing button alone does not prove execution.
7. After clicking Stop, wait for the actual terminal state. A stop-request message only means cancellation has been requested.

The first message proceeds once the new session is ready; refreshing the sidebar does not block sending. A sidebar refresh failure is reported separately and does not restore an already submitted message as a draft.
Resource updates discovered during startup are prepared while the worker is idle. Updates discovered during a running turn remain deferred until before the next turn. Repeated Skill scans with unchanged resources do not trigger another worker reload.

### Attach files and images

Click the paperclip beside Send, paste files, or drag them onto the composer. All file types are accepted, including empty files, with at most 50 attachments and 100 MiB of decoded attachment bytes in total per message. A text-only model can also receive attachments. PNG and JPEG use native image input when the selected model supports it, with an additional total limit of 8 million pixels. Images are downscaled to a 1456-pixel long edge or the model’s stricter dimensions first, so the byte limit applies after processing. JPEGs that the browser can decode but the strict validator rejects, such as files with trailing data, are re-encoded before validation; ordinary small images stay unchanged. The server validates attachment names, MIME types, canonical Base64 and aggregate bytes; native images also undergo image structure and dimension checks. Attachments travel in JSON, so the 144 MiB WebSocket frame limit also applies.

Files retain their original bytes in the session record. The model receives a reference and metadata instead of the entire Base64 payload in every request. The existing `read` tool reads UTF-8 and BOM-marked UTF-16 text from paths such as `session-file://12/1`, with bounded pages; `session-file://list` lists older attachments. CSV and TSV are read as actual text even with an Excel MIME label. File names and read contents are treated as untrusted data. Attachments are confined to their owning session and lane, and names never become filesystem paths.

The default-enabled `@agnes/document-reader` plugin adds `document_read` for PDF, DOC, DOCX and ZIP. PDF reads a selected page; pages without text use bundled offline Chinese/English OCR. For an incomplete text layer, `ocr: "always"` forces OCR; mixed PDFs are handled page by page. Word extraction returns text, including tables and notes, without reconstructing layout or embedded pictures. ZIP lists entry names first, then reads a selected text file or supported document without extracting onto disk. There is no ZIP-specific entry-count or aggregate expanded-size cap; a large unused member does not block other files. Selected documents share the reader's 100 MiB input budget, and text results are paginated; OCR pixels, execution time and worker concurrency are bounded. Macros, links and document instructions are not executed. Disabling the plugin removes this parsing capability while preserving uploaded files. OCR may misread text; encrypted, damaged or unsupported documents return an explicit error.

For PDF photographs, charts, and layout, `mode: "image"` returns one page image without OCR, along with any embedded text. Default `mode: "auto"` also returns a page image when text/OCR is empty; `mode: "text"` returns text only. Empty OCR does not prove a blank page. Page images use the existing authorized image channel and the selected model's image limits, including history. They are capped at a 1456-pixel long edge and 4 MiB; only the selected page is rendered. A text-only model can read extracted text but needs an available vision route to interpret page images. No new vision service is enabled automatically.

The installed pi-ai chat interface has text and image input only; it does not accept native file/audio/video blocks. Binary Excel and presentation files, audio, video and other unsupported formats can still be uploaded and saved, but a successful upload does not mean the model has read them. The agent must explain reading failures honestly. GIF and other image formats retain their original file bytes rather than being reduced silently to a single frame.

The model catalogue carries pi-ai `inputLimits` without a separate provider limit table; manual models may declare the same fields. Image counts follow the selected model’s declared limits; there is no universal four-image cap. Agnes models that support images accept at most four images in the complete request, including history and tool results. Model image byte limits count Base64 bytes separately from the 100 MiB decoded-byte cap. Images still exceeding limits after processing are rejected without clearing existing attachments; the complete batch is checked again before submission. Pending inputs share one queue record bounded by the 144 MiB transport frame, with 4 KiB reserved for its envelope. If the combined queue exceeds that budget, the new input is refused before storage; wait for a pending message to finish or remove one before retrying.

Attachments can be sent by themselves or with text. While a turn is running, the combination is queued as a follow-up. Images added to a text-only model are saved as file attachments and do not provide visual input. Changing models preserves the draft; native images prepared for an image model still need a compatible model to send. A failed send restores the text and attachments for retry; changing sessions clears staged attachments.

Long conversations keep the originals in the session record. Requests normally include images from the latest three image-bearing user messages, within the selected model’s limits; this is a history window, not a three-image upload limit. New attachments are sent together or rejected with an error. When the agent explicitly reloads older images, the latest reload batch takes priority over older images and screenshots. Omitted images retain references and existing text descriptions, with a warning against guessing unseen details. This also applies during context summarization and adds no separate image-summary model calls.

To compare older pictures, ask the agent to inspect those originals. The existing `read` tool can list saved images with `session-image://list`, then reload a reference such as `session-image://12/1` or a batch such as `session-image://12/1,34/2`. The originals remain readable after context summarization. Reload batches must fit both the model and runtime media limits; compare large sets in smaller batches or select a model supporting the required simultaneous image count.

Before dispatch, the executing model is checked against the selected current, historical and tool-result images. Changing models preserves draft images; switch back or remove incompatible images before sending. Request bytes are checked in pi-ai’s provider payload callback and, for fetch transports, against the final HTTP body. Subsequent SDK wrapping can still trigger provider limits.

Files and images are inline content in user messages and session events, retained with session history. Files add a `file` content block without changing text or image blocks; ACP submission and replay use standard embedded resources, with `embeddedContext` enabled. Inline text and blob resources are saved as attachments; their URIs are labels and are never fetched or opened as disk paths. File attachments require matching updated clients and backend. Web requests a history projection read budget of 144 MiB minus 4 KiB reserved for the transport envelope; the protocol's default read budget remains 256 KiB. Worker history reads that exceed one frame are split into smaller sequence ranges, preserving the requested order and complete page. Reopened messages rebuild image previews and file cards. Older clients requesting smaller read budgets may be unable to recover large attachment messages. This is not an artifact upload flow, and `artifact.read` does not upload browser files. Diagnostics and default exports omit encoded attachment data, as they already do for images and audio.

Open the model picker beside the composer. Pointing at a model shows that model's session settings next to the list: its capacity, the reasoning level, and the context window. The reasoning levels are the ones that model declares. Open the context window to pick a preset, or type a full token count, or use an explicit `K`/`M` suffix: `100K` means 100,000 tokens, while `100` means 100 tokens and is too small for ordinary models. Clear the field to restore automatic sizing. A choice applies immediately and closes the menu; a typed budget is committed when you press Enter or leave the field. Choosing a value for a model other than the current one switches to that model first. The settings apply to later requests and survive reopening. Account settings provide defaults for new sessions. Existing sessions keep their saved settings when those defaults change.

In Settings → Appearance, choose English or Simplified Chinese. Automatic titles use the language the model identifies in your first message: sending “Hi” produces an English title even in the Chinese interface. If the language is unclear, including mixed languages without a clear primary language or input consisting only of code, identifiers, numbers, or emoji, the model uses the interface language captured when that message was submitted. These language rules are prompt instructions; output is checked for format, without replacing its language or making another model request. Switching the interface language does not translate existing titles or overwrite manual names.

Failed turns show the recorded error code and message below their status, even when the process is collapsed. These details remain available after reopening the session. Older records without error details are labeled explicitly.

### Inspect the trajectory

Switch from Chat to Trajectory to review a session by turn and step. Select a record for its status, duration, error, and available token usage. The timeline offers four order and duration modes: drag to filter, scroll to zoom, right-drag to pan, and press Escape to clear the range.

Fold turns or tool calls, search the records, or load earlier history as needed. Tool arguments and results in **Projected content** are previews; choose **Full input** or **Full output** to read the recorded detail on demand. **Timing** shows recorded time fields. Missing timing, usage, or history is labeled rather than estimated.

<a id="日常管理"></a>

## Everyday management

Settings manages model accounts, plugins, Skills/MCP, appearance, and Computer Use. Available actions depend on backend capabilities and permissions. Installed plugins still require trust and enablement; see [plugin management](packages.md). Reopen history from the sidebar, or use the archive view for archived tasks. Archiving does not delete session history.

Computer Use shows driver status, system permissions, diagnostics, and maintenance progress. Switching settings pages keeps progress monitoring active. When the pane is replaced or reloaded, it reads the latest operation without resubmitting it. Removing the pane stops local monitoring; use Cancel explicitly to request backend cancellation and wait for confirmation. A connection error or a long wait does not confirm completion or cancellation.

To add MCP, describe the integration in chat and supply a service address or connection details, then inspect it in settings. New services must be trusted and enabled in sequence; see [MCP integration](mcp.md). Use the SecretRef configuration flow for credentials.

The URL's `session` parameter selects the session. After a refresh or brief disconnection, the SDK reloads the projection from the backend without automatically resending business requests. If reconnection fails, inspect `daemon status`. After a daemon restart, open the normal URL printed by the current `serve` process. Local mode does not need to restore a startup token from sessionStorage.

Closing the browser, disconnecting the page, or stopping `serve` affects the client/Web service. Session facts determine whether backend tasks have ended. Run `daemon stop` separately to fully stop a trial instance.

<a id="当前交互边界"></a>

## Current interaction boundaries

The built-in right-side document preview supports text, code, Markdown, filtered HTML, and images or PDFs delivered by the session resource service. A resource read failure displays a generic unavailable message; a reclaimed screenshot displays the retention-policy message. Replacing or closing the preview releases its acquired resource URLs and ignores late replies. Closing a preview does not cancel backend work. The workbench CSP permits local Blob URLs for images and frames; remote sources remain blocked, and PDF frames keep their sandbox. Other pages retain their existing CSP. Some browsers block their native PDF viewer inside a sandboxed frame; inline PDF preview is unavailable in those browsers.

Tool results use constrained previews and detail views. They cannot render arbitrary HTML. Do not assume every artifact supports upload, download, or rename, or that every message supports editing and regeneration. The interface exposes actions supported by the current backend. See [verification](../maintainers/verification.md) for the scope of real browser testing.

Implementation: [Web entry](../../packages/web/src/serve-entry.ts), [application](../../packages/web/src/app.ts), [server and origin checks](../../packages/web-server/src/server.ts), [session actions](../../packages/web/src/session-actions.ts).
