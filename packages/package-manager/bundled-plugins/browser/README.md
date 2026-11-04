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
click, fill, hover, drag, select, upload, key, scroll, wait, back, forward, reload and close. Inspect returns
element refs and pageEpoch; mutations must use current observations. Page console
and network summaries are bounded; HTTP failures and network failures are separate.

A visible panel watches the session's existing pages; it does not launch a browser.
Pages opened by the model appear automatically, with no load button. Only a nonempty
page list prepares a native authorized interaction channel. Clicking,
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
sent to a website. Browser shutdown does not stop project Jobs. Restoring the panel waits for the conversation to connect, then reads existing pages. An empty session shows a normal empty state without preparing input, audio or frame connections. A failed page read is reported as unavailable, not as an empty result or a guessed version mismatch. Existing read recovery remains automatic. Closing the panel stops its subscriptions and polling; reopening reconnects without replaying input. Closing the last tab releases the conversation’s browser slot.
Input-channel admission also records the native grant in the current plugin runtime.
Re-enabling the plugin cannot reuse a previous runtime's connection grant, even if
its native lease and the client-module revision are still valid. Renewals within
the same runtime keep working; the native broker still checks actor, session,
permission and expiry. Records belong to the shared managed runtime, so session
services and profile streams see the same admissions even with separate module
copies. They prune expired grants and use the same 1,024-record bound as native
session service control.

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
bounded live frames retain the existing media budget. Chromium acknowledgements are paced at the source, with faster feedback during input; no every-Nth-paint sampling drops the final change. Input retains CSS
coordinates. Input receipts pace and coalesce adjacent same-direction scrolling
without crossing reversals, clicks or keys; stale or failed buffered actions are
discarded, never retried. Manual tab selection does not follow model activity.

## Observation, interaction and upload

`inspect` uses the pinned Playwright AI JSON snapshot, including accessible controls
in child frames. Returned refs are plugin-owned handles, invalidated on frame
navigation/detachment, human edits and mutations. Raw engine refs are never reused
as durable targets. The text preserves hierarchy, current values, link destinations
and accessible state. Each ref appears next to its node; page strings are JSON-escaped.
Results return at most 100 refs and 20,000 characters of text. `hasMore` and `cursor`
page through snapshot nodes (including static text), with their ancestor context.
Keep the same filters when using the returned cursor. Each read takes a fresh
snapshot, invalidating earlier refs; pagination is not a frozen view of a changing page.

Optional `query` searches literal text case-insensitively, including names, text,
roles, URLs and placeholders; it is not a regular expression. It searches beyond
the first output window and returns matches with ancestors, not unrelated siblings.
`matchCount` counts matching snapshot nodes, not occurrences or DOM elements.
Optional `ref` plus the current `pageEpoch` reads only that node's native snapshot.
Use the returned `scopeRef` for subsequent local reads, including query pagination;
old refs expire. A missing/replaced region is refused, never replaced by a similar
element. Optional `depth` (0–20, root is 0) limits returned levels relative to the
selected region; omit it to include all levels. It can be combined with `query`.
Depth-limited reads without a query ask the native snapshot for one extra level, preserving
`depthLimited` without passing native `depth: 0` (which means unlimited).
Plugin filtering remains authoritative for iframe depth. This reduces snapshot
transfer, not all DOM traversal; global searches still capture the whole page.
Prefer a current region ref for genuinely smaller reads. No stale snapshot cache
or private Playwright selector state is introduced. Native shallow output may
retain accessible table/row names from folded descendants; search uses full-snapshot
naming before filtering so its match scope and counts remain consistent.

For example, start with `{"action":"inspect","pageId":"…","query":"Order 42"}`,
then use a returned region ref in `{"action":"inspect","pageId":"…","pageEpoch":1,"ref":"…"}`.
Always use the actual current epoch/ref from the result, not these placeholders.
`truncated` reports omitted output or clipped strings; `depthLimited` reports
deeper nodes, and `scanLimited` reports the 50,000-node plugin processing limit.
Search snippets center on the matching text when a long value is clipped.
An empty search with `scanLimited: true` does not establish absence from the page.
Narrow the region/query or increase depth when appropriate. Canvas and unloaded
content still need screenshots or scrolling. These options use the existing
cross-platform Playwright runtime without new dependencies or Host/Core changes.

`hover` takes `ref`; `drag` takes `ref` and `targetRef` in the same frame;
`select` takes native option `values` (custom menus use clicks/keys).
An optional `dialog` object binds `type`, exact `message`, `response` (`accept`
or `dismiss`), and optional prompt `text` to one mutation. Unknown dialogs retain
the default dismiss behavior; no delayed response is queued behind a blocked click.
Human pointer movement works after input control is established; dragging also
requests control. Cancellation, viewport changes and disconnect release held input
in queue order. Older pages without `pointerInput` retain click/key/scroll controls.

`upload` takes a current file-input `ref` and a workspace `path`. Files must be
smaller than 8 MiB and readable through the host's session file port. A separate
user question identifies the name, size and destination site and binds the exact
bytes; full-access tool approval cannot answer that content question. Refusal,
cancellation, expired confirmation or a changed target prevents dispatch. File
permission is rechecked before supplying the confirmed in-memory bytes. Selection
may immediately upload the file; the destination website controls it afterwards.
No system file dialog, raw browser file path or persisted upload buffer is used.

HTTP redirect hops are checked before dispatch, including new pages, cross-process
frames, dedicated workers and SharedWorkers. The guard is installed through public CDP on the plugin's
owned Chromium, before targets resume. Existing preview authorization and browser
sandboxing remain in force. This is not an operating-system egress firewall.
The same CDP request pause now owns first-hop and redirect checks, file-preview
headers and PDF-resource admission; no second blanket Playwright HTTP route is
installed. File ownership comes from browser frame IDs and document ancestry,
not page-provided names or Referer. Subresources also bind to the initiating
document recorded by Chromium, so a new remote iframe cannot borrow its old
blank document's file authority. Recording starts before targets resume;
blank-document ancestry is reconciled with the public frame-tree API.
Missing or mismatched document identity is refused. Active request records are
released on completion or target closure. PDF privileged
resources require the current PDF document and the committed viewer frame;
late navigation events are reconciled with the public frame-tree API. WebSocket
checks remain separate, service workers remain blocked, and HTTP cache stays disabled.

Current full-density PNG frames avoid redundant idle screenshots. Missing frames,
JPEG/legacy display and new input retain their existing fallback paths. A new PNG
capture gets one compositor interval before its first fallback screenshot.
Native acceptance keeps the existing pixel-verified latency limits, labels the
small viewport sample as a maximum, and reports frame arrival/input receipt
separately from image decoding. These are backend measurements, not end-to-end
workbench/network latency guarantees.

For native acceptance, run `mise exec -- node tools/toolchain/run.mjs exec node tools/browser-prepare.mjs`, then set `AGH_BROWSER_TEST_CACHED=1` and run the browser
runtime/capability E2E files through the same toolchain entry. The browser workflow
runs Windows x64, macOS arm64 and macOS x64 explicitly. It provisions verified plugin
payloads and fails on preparation errors; missing runtimes must not count as passing
tests. The owned Chromium uses `--disable-audio-output` for software output,
including on ordinary HTTP pages. On Windows it also uses `--enable-exclusive-audio`
solely to select the pinned engine's fixed 48 kHz/256-frame output parameters.
These flags must remain paired: the output stream is still fake, not an exclusive
hardware stream. Without the fixed-parameter path, Windows shared-device discovery
can exceed Chromium's own authorization deadline and leave a running AudioContext
whose clock never advances. macOS keeps its existing launch parameters.
This does not change OS audio settings, microphone permission or the browser sandbox.
Audio taps are refreshed after viewport changes as well as frame changes, retaining
the rejection of stale-epoch packets. Audible playback still needs the workbench's user
gesture and an output device. Passing Windows does not establish Mac acceptance.

The workbench opens its output AudioContext only after a local user gesture and
the first valid PCM packet. Ordinary clicks, typing and tab switching on text-only
pages must not acquire an audio device. Invalid packets and packets before the
gesture cannot initialize playback; a thrown device-initialization error waits
for another gesture before retrying. The existing PCM queue bounds and epoch
checks still apply. This avoids a reproduced Chrome 156/Windows failure where
AudioContext construction blocked the workbench's main thread even on a one-button
page. It does not repair that browser/device failure for actual audio playback:
on affected devices a valid audio packet can still reach the blocking constructor.
Do not treat software-output tests as proof of audible playback or hide this
acceptance gap with longer timeouts.

The fixed-version upstream paths are
[Windows parameter selection](https://github.com/chromium/chromium/blob/153.0.8010.12/media/audio/win/audio_manager_win.cc),
[software output selection](https://github.com/chromium/chromium/blob/153.0.8010.12/media/audio/audio_manager_base.cc)
and [renderer device authorization](https://github.com/chromium/chromium/blob/153.0.8010.12/media/audio/audio_output_device.cc).
Recheck this pairing when updating Chromium. Native acceptance measures real nonzero
PCM within the existing 5-second bound, including initialization; it must not be
replaced with a check of AudioContext.state alone or a longer timeout.

### macOS acceptance (Apple Silicon and Intel separately)

Use a native terminal on each architecture, the same uncommitted source snapshot,
and synthetic files/accounts. Do not reuse a production AGH home or personal browser
profile. Run from the repository root with Xcode Command Line Tools and mise available:

```sh
mise trust
mise install
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile --ignore-scripts
mise exec -- node tools/toolchain/run.mjs --filter @agnes/system-node build:native
# Apple Silicon: arm64. On an Intel Mac, replace arm64 with x64.
AGH_BROWSER_EXPECT_ARCH=arm64 mise exec -- node tools/toolchain/run.mjs exec node tools/browser-prepare.mjs
AGH_BROWSER_TEST_CACHED=1 mise exec -- node tools/toolchain/run.mjs exec vitest run \
  packages/package-manager/test/browser-runtime.test.ts \
  packages/package-manager/test/browser-files.test.ts \
  packages/package-manager/test/browser-capabilities.e2e.test.ts \
  packages/package-manager/test/browser-runtime.e2e.test.ts \
  packages/web/test/browser-screen.test.tsx \
  packages/web/test/browser-pointer.test.tsx \
  packages/web/test/browser-interaction.test.ts \
  packages/web/test/browser-client.test.ts \
  packages/web/test/browser-panel.test.tsx \
  packages/web/test/browser-panel-selection.test.tsx \
  packages/web/test/browser-audio.test.ts --maxWorkers=1
mise exec -- node tools/toolchain/run.mjs typecheck
```

All selected tests must execute; skipped native tests or a failed download are not
acceptance. Record the commit plus uncommitted diff, macOS version, hardware/Node
architecture, printed Node version, test totals and complete failure output.

For the manual workbench pass, build and start a separate instance using the
[installation guide](../../../../docs/guide/install.md). Keep its short temporary
`AGH_HOME` and `AGNES_PROFILE=local-dev` in that terminal only; stop only this owned
instance when finished. Use a local synthetic page and verify:

- Leave the browser panel selected in an old conversation, then refresh or restart
  the isolated instance. No load button should appear. Existing pages display
  automatically; an empty session has no input/frame connection or error banner.
  Ask AGH to open a page: it appears without another click. Repeat after switching
  conversations, closing/reopening the panel and reconnecting the same conversation.
  History-only conversations wait for connection. Failed reads show an unavailable
  state and recover automatically; actual preparation/action failures remain visible.
- Chinese IME composition/commit, Cmd+A/C/V, long Chinese paste followed by a key,
  trackpad small-delta scrolling and direction reversal.
- Drag-select only part of an input's text, then immediately type English and
  commit Chinese IME text. Only the selected text should be replaced, including
  when the drag is the first gesture that requests human control. Repeat with a
  mouse and trackpad. No second click should be needed or collapse the selection.
- Cancel a drag before control admission completes, then allow admission: no
  delayed drag should reach the page. Focus the chat editor during a drag or
  pending admission; completion must not pull keyboard focus back into the page.
- Hover menus, drag/drop, release outside the canvas, window blur during a drag,
  panel resizing and tab changes; no held mouse button or delayed replay.
- Open three text-only tabs (small, 100 buttons and 10,000 buttons) with a changing
  heading, repeatedly switch tabs, click, scroll and type in the chat editor.
  The workbench must stay responsive without opening an audio output device.
  Run this in the normal browser without fake-output flags as well as the pinned
  automated browser; record the actual browser version and output-device setup.
- Native select, matching/mismatching dialogs, same-page human/agent handover;
  controls in cross-origin frames and refusal of stale refs after navigation.
- Inspect a page containing two named regions with identical button labels;
  confirm hierarchy, Chinese/case-insensitive search, local reads and pagination.
  Read a child-frame region, then navigate/remove it and confirm the old ref is
  refused. Verify long-text truncation is explicit and searched text remains visible.
- Upload denial/acceptance, permission revocation or navigation while confirmation
  is open, and a Chinese/space filename. Confirm the exact selected bytes; no OS picker.
- HTML/image/PDF/video previews. Audio starts after a workbench gesture, respects
  mute/zero volume/pause, continues after child-frame changes, stops forwarding
  when the panel closes and resumes on reopening. Check actual audible playback
  on both Mac architectures; automated PCM checks do not replace listening.
- No login/session crossover, downloads remain blocked, and the automated redirect
  fixture reports zero protected requests for pages, frames and both worker kinds.

A blocked manual item remains an explicit acceptance gap; do not mark it passed
because the automated suite succeeded.
