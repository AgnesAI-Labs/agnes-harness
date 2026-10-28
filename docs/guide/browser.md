# Built-in browser

English | [简体中文](browser.zh-CN.md)

[Documentation](../README.md) · [Web workbench](web.md) · [Security](security.md)

The official `@agnes/browser` plugin lets AGH and the workbench use the same web page. The backend runs a dedicated browser; the workbench displays its live pixels. Each conversation has separate cookies and page storage. A second iframe is not used to load another copy of the website.

Workbench visibility is restored only when refreshing the same conversation. A new or different conversation does not inherit the previous conversation's open browser panel; panel size and tab preferences are retained.

## Enable and open a page

Use the **Built-in browser** switch on the **Plugins** page. The plugin is enabled by default when permitted by the profile ceiling. Open the workbench's Browser tab yourself; plugin startup, conversation changes and AGH opening a page never expand or switch your panel automatically. There is no separate settings switch. Activation automatically downloads the pinned browser archive into the OS user cache and verifies its exact size and SHA-256. Preparation and errors appear in the panel; toggle the plugin off and on to retry a failed preparation. The obsolete independent off setting is ignored. An explicit disable on the Plugins page persists across restarts.

Missing browser installer dependencies fail browser preparation and leave the browser unavailable. Other plugins and conversation creation remain available. Repair the installation before retrying preparation.

Enter an absolute `http://` or `https://` address, a workspace file path or a `file://` URL in the Browser panel, or ask AGH to open it. For local projects, ask AGH to start the project with its existing shell or Jobs tools, use the actual port it reports, then inspect and test the page. Localhost refers to the backend computer. Browser shutdown does not stop project Jobs.

AGH can inspect current elements, click, fill, type keys, scroll, navigate, wait for text, take screenshots, read recent console and network errors, and close tabs. Your selected tab stays selected while AGH works in another tab; human takeover keeps its page visible. Background testing never opens a desktop window or expands the panel. Selecting another tab ends the current input connection. Up to two conversations can own browser contexts, with up to three tabs each; close unused tabs with the tab close button or through AGH before opening more. Closing the last tab releases that conversation’s browser slot.

## Human control

Click the displayed page and type directly, including Chinese input, macOS Option characters, Windows AltGr characters and paste. Opening the panel prepares an authenticated session interaction channel without taking page control. The first click, wheel gesture or navigation action takes control over that channel before sending input; **Take control** remains available as an explicit alternative. No input is forwarded while approval is pending or after admission fails. If the document changes during handover, the old click is discarded. Escape returns keyboard focus to the local browser controls. **Return to AGH** ends human control; AGH must observe the current page before writing again.

The panel uses page tabs and one address bar; press Enter to visit an address in the current tab. Tab labels use the host and path. **Browser options** contains display reconnection and recent page errors. Text input uses an invisible focus target within the displayed page, rather than a separate visible editor.

The page has a narrow inset and theme border. By default, a fixed 1280×800 desktop viewport scales proportionally to fit both the panel's width and height. Choose **Adapt page to panel** under **Browser options** to reflow responsive pages to the available space; size changes coalesce while dragging. Closing the panel retains its last viewport; new background tabs start at 1280×800. **Show at 100%** uses the fixed viewport with scrolling. When several windows view one page, the first visible view requesting geometry owns its size; other views scale the same image instead of competing to resize it. Resizing invalidates old coordinates and agent observations, requiring the current image before input.

Live frames use 2x pixels and prefer lossless PNG while scrolling text. Complex scenes adapt JPEG compression to image size while retaining 2x pixels and a quality floor, recovering lossless capture when the scene becomes inexpensive again. Live frames target up to 60 fps within the existing transport allowance and prefer a sharp lossless image after idle. Actual frame rate and latency depend on the page, hardware and network. Pointer coordinates map to the current page dimensions; agent screenshots retain logical page dimensions. Windows line/page wheel events and fractional Mac trackpad deltas are normalized. Execution receipts pace adjacent same-direction scroll batches; reversals, clicks and keys retain their order. Navigation, resizing, refusal and disconnection discard unsent stale input.

Healthy authorized streams push browser status and the selected conversation's pages instead of periodic queries. Disconnections trigger bounded reconnection attempts and recovery queries through the existing validation gates. The display's final retry waits one minute for admission limits to clear; input actions are never replayed automatically. Very long addresses retain the complete query fallback. Recent page errors refresh only while expanded. A successful open returns without waiting for an additional status query. Reload, back and forward wait for DOM content rather than every image or other resource to finish loading.

Closing the panel stops its display, page subscriptions and recovery queries; reopening reconnects to the existing pages. It does not navigate, submit or replay input.

Switching browser tabs reuses the panel's display connection and captures only the selected page. Old-page images are discarded during the switch. Rapid tab changes coalesce to the latest selection on the prepared interaction channel. View selection stays bound to the authenticated user and conversation; it does not grant input control or increase transport limits.

A temporary status-read failure shows an error while retaining the last page in that conversation. Input still needs a live authorized connection. Switching conversations clears the previous pages.

Human control uses authenticated session effects. Short input leases renew within five minutes; expiry requires another explicit takeover. A broken input connection pauses control. Reloading the workbench does not restore a control grant from history. Known refusals, such as a protected address, report their reason and allow another operation. The **Check previous action** button appears only when a request's result is uncertain and reuses its original ID to retrieve a committed result; it cannot resolve an action whose actual outcome remains unknown. Do not repeat an uncertain website submission in another browser without checking its outcome.

## Off, fallback and artifacts

Turning the plugin switch off rejects new work, revokes input, disconnects the display and closes plugin-owned pages. It cannot undo an action already delivered to a website. If cleanup is unconfirmed the browser stays unavailable until cleanup is reconciled.

The model chooses suitable tools according to the task, availability and permissions. Explicit user tool/browser requests take precedence; an unavailable specified tool is reported rather than silently replaced. Local-project testing can run here in the background. Disabled plugins are not automatically enabled. The plugin does not enable Computer Use permissions or share cookies with desktop browsers.

Producing a file never opens a panel. Clicking a supported artifact of up to 1 MiB opens its existing safe preview for Markdown, HTML, PNG/JPEG, PDF or text. Unsupported formats and larger files download on click, without opening a preview panel. Office presentations continue through the existing download flow for opening in Office or WPS. This plugin does not add an Office or spreadsheet renderer. Conversations pinned before plugin installation or replacement may require the existing migration action or a new conversation.

## Compatibility and boundaries

Reviewed browser payloads are provided for Windows x64, macOS Apple Silicon and macOS Intel. macOS needs native acceptance on both architectures before a release is described as tested there. Windows ARM64 and Linux have no admitted payload in this plugin. Browser system requirements follow pinned Playwright 1.63.0 and its matching browser. Preparation needs network access and enough disk space for the archive and extraction.

The dedicated browser enables Chromium sandboxing, uses no personal browser profile and exposes no browser debugging endpoint to WebUI. Raw JavaScript evaluation, arbitrary executable selection, unrestricted filesystem access, automatic downloads and service workers are not exposed. The pinned Chromium PDF viewer and its internal static assets are admitted only for PDF documents. Known AGH management targets and cloud metadata endpoints are blocked. The plugin is trusted local development functionality; URL routing rules are not an operating-system network sandbox. See [runtime provenance](../../third-party/browser-runtime.md) for exact payloads and licenses.

## Workspace file resources

File previews support browser-native content types, including HTML and its CSS/JS/image/font resources, SVG, images, text, JSON, XML, PDF and media formats supported by the pinned Chromium. Office documents are not converted. Unsupported downloads are reported rather than claimed as displayed. Media decoding is browser/platform dependent. Same-origin or CORS-authorized HTML audio/video sound shares the admitted display channel. WebUI starts sound only after a local user gesture and discards queued sound on tab changes, navigation and disconnect. Hidden panels do not forward sound; desktop audio is never captured.

Text previews use a bounded UTF-8 prefix check to supply an encoding hint, preserving BOMs and explicit HTML/CSS encoding declarations. HTML declarations are read from actual `meta` attributes, ignoring examples inside comments, scripts and unrelated attributes. The check does not read the entire file or convert its bytes.

The default preview root is the file's directory. The model's `open` input can specify `previewRoot` within the session workspace for shared assets. Each resource and 256 KiB byte window re-enters current filesystem authority. Private paths such as `.env`, `.git`, `.ssh` and `.agh`, and filesystem aliases are refused. Large resources stream with HTTP byte ranges instead of being buffered in full. Only the owning browser tab supplies the resource admission header; copying its temporary localhost URL does not grant access. Closing the tab/session or disabling the plugin closes its listeners.

The optional `ToolContext.sessionFiles` / `ServiceContext.sessionFiles` port serves delayed read-only resources with fresh workspace invocations. Ordinary `fs` remains call-bound and must not be retained. Older hosts without the port refuse file previews; existing HTTP pages remain available.
