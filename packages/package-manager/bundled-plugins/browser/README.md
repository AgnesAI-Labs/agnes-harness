# Built-in browser

An official AGH plugin. The model tools, workbench display and human input use the
same Playwright Page. BrowserContext storage is isolated per session; IDs do not
grant access. Ordinary plugin approval, trust and session boundaries still apply.

## Enable and use

Use the **Built-in browser** switch in **Plugins**. It is enabled by default under
the profile ceiling. Open the workbench's Browser tab manually; activation, ordinary
chat and page updates never expand or switch the panel. Activation prepares the
reviewed Chromium archive in the OS user cache, verifying its size and SHA-256.
There is no independent settings switch. Preparation errors appear in the panel;
toggle the plugin off and on to retry. The install lock records a process ID and owner
token. A confirmed dead process is recovered automatically; a live or unknown owner
is refused. The error names the exact lock path and process when readable. For an
old directory lock or unreadable owner, confirm no installer is running before
manually removing only the named lock and retrying. Lock age never permits takeover.
Legacy browser.enabled values are ignored, while an explicit package disable remains
disabled across restart.

Use the Browser panel or ask AGH to open an http(s) URL, workspace path or file URL. Start local
projects with the existing shell/Jobs tools first. A URL's localhost belongs to the
AGH backend machine, which may differ from the machine displaying WebUI.

The model's browser tool provides status, tabs, open, inspect, screenshot, events,
click, fill, key, scroll, wait, back, forward, reload and close. Inspect returns
element refs and pageEpoch; mutations must use current observations. Page console
and network summaries are bounded; HTTP failures and network failures are separate.

Opening the panel prepares a native authorized interaction channel. Clicking,
scrolling and typing work directly; there is no manual take/return toggle. Admission
remains bound to the actor, session, page and original request.
The page's existing queue serializes website actions. Model writes wait until human
input has been idle for 600 ms, outside the queue so typing and other tabs continue.
After human input, the model must inspect or screenshot the page again. Human gestures
captured before an agent action or document change are discarded rather than retargeted.
Typing and IME input stay within the page display; there is no separate visible editor.
Thirty-second input leases renew within a five-minute control session. Disconnect
stops human input without permanently reserving the page; uncertain actions still need
inspection and are never replayed. Legacy explicit control services remain compatible.

Turning off immediately rejects new operations and queued input, disconnects
views and closes only plugin-owned resources. It cannot undo an action already
sent to a website. Browser shutdown does not stop project Jobs. Closing the panel stops its subscriptions and polling; reopening reconnects without replaying input. Closing the last tab releases the conversation’s browser slot.

## Fallback and existing conversations

The model chooses tools according to the task, availability and permissions. Explicit user
browser/tool requests take precedence; unavailable specified tools are reported rather than
silently substituted. Existing computer_use is an option **if configured and authorized**. The plugin does not enable the Computer Use driver or grant OS
permissions. Explicit requests for a personal browser/window/login or native app
continue to use the appropriate external tools. The two browsers do not share
cookies, login or unsent form state.

Existing conversations retain their plugin generation. A conversation without
this plugin, or with an incompatible older version, needs the existing session
migration action or a new conversation. The plugin switch is the only enable/disable control.

## Runtime and security

The supported payloads are Windows x64, macOS arm64 and macOS x64, with the system
requirements of pinned Playwright 1.63.0 / Chromium revision 1243. Windows ARM64 and
Linux are not admitted by this plugin. macOS must be verified on actual hardware
before claiming a release tested there; archive availability is not a runtime test.

The dedicated browser uses Chromium sandboxing and an allowlist of environment
variables, has no personal browser profile, and exposes no CDP endpoint to WebUI.
Service workers, automatic downloads, raw evaluate, arbitrary executable paths,
unrestricted file access and user browser extensions are not exposed. The pinned built-in
PDF viewer and its internal static assets are admitted for PDF documents only. Known AGH management targets
and metadata endpoints are blocked. Application routing is not an OS-level egress
sandbox; this is a trusted local development browser, not a VM for hostile code.

Frames are ephemeral and shared among viewers; screenshots are saved only when
requested through the artifact port. Event summaries omit authentication headers
and response bodies. No browser login state is restored after Host restart.

Only clicking a previewable artifact opens its existing deliverable viewer; new output never opens a panel. Unsupported formats and files above the viewer’s size limit download on click.

Static HTML/Markdown/PDF/image previews keep the existing deliverable viewers and
their CSP. Office files retain the existing download/local application workflow.

## Build and maintain

- tools/browser-manifest.mjs owns the static package and client declarations.
- tools/build-feature-clients.mjs builds the UI from browser/src/browser.tsx through the shared presentation pipeline.
- cli/tools/browser.ts copies the complete licensed playwright-core runtime into
  dist/runtime/playwright; dynamic files must not be bundled away.
- src/browser-artifacts.json pins OS/architecture, URL, revision, SHA-256, size and
  executable layout. Update it only after downloading and checking each archive.
- Keep playwright-core and Chromium aligned; retain their licenses and notices.

The normal CLI build performs runtime preparation. An independently packed copy
must also contain the prepared dist runtime; packing does not execute install scripts.
The plugin never installs an npm @latest package on a user's machine.

## Authorized file previews and display quality

Workspace paths and file URLs open through tab-owned authenticated loopback resources.
The default asset root is the file directory; `previewRoot` can select a wider directory
inside the workspace. Every bounded byte read reacquires current session authority.
Private paths and aliases are denied. HTTP byte ranges stream large media without
whole-file buffering; close/disable releases the owned listeners. Chromium chooses
rendering from native content types; unsupported downloads are reported. Same-origin/CORS-authorized HTML media sound shares the admitted display channel,
starts after a local user gesture and stops on navigation, disconnect or panel closure.
No desktop audio is captured.

A narrow inset and theme border frame the page. Visible pages reflow to the panel's
available size; a fixed 1280x800 desktop mode remains available and background tabs
start at that size. The first owned view
requesting geometry controls it until it switches page or disconnects. Resizing
uses the existing authorized view channel and page queue, invalidates old targets,
and does not grant website input. Capture and input bounds use that page's viewport.

Both the dedicated native display and page context use 2x raster density. Live
text scrolls prefer lossless PNG; complex scenes adapt bounded JPEG compression and
recover lossless capture when inexpensive again. Full-resolution idle images and
up to 60 fps live frames retain the existing media budget. Input retains CSS
coordinates. Input receipts pace and coalesce adjacent same-direction scrolling
without crossing reversals, clicks or keys; stale or failed buffered actions are
discarded, never retried. Manual tab selection does not follow model activity.
