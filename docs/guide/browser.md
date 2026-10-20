# Built-in browser

English | [简体中文](browser.zh-CN.md)

[Documentation](../README.md) · [Web workbench](web.md) · [Security](security.md)

The official `@agnes/browser` plugin lets AGH and the workbench use the same web page. The backend runs a dedicated browser; the workbench displays its live pixels. Each conversation has separate cookies and page storage. A second iframe is not used to load another copy of the website.

## Enable and open a page

Use the **Built-in browser** switch on the **Plugins** page. The plugin is enabled by default when permitted by the profile ceiling. Open the workbench's Browser tab yourself; plugin startup, conversation changes and AGH opening a page never expand or switch your panel automatically. There is no separate settings switch. Activation automatically downloads the pinned browser archive into the OS user cache and verifies its exact size and SHA-256. Preparation and errors appear in the panel; toggle the plugin off and on to retry a failed preparation. The obsolete independent off setting is ignored. An explicit disable on the Plugins page persists across restarts.

Enter an absolute `http://` or `https://` address in the Browser workbench panel, or ask AGH to open it. For local projects, ask AGH to start the project with its existing shell or Jobs tools, use the actual port it reports, then inspect and test the page. Localhost refers to the backend computer. Browser shutdown does not stop project Jobs.

AGH can inspect current elements, click, fill, type keys, scroll, navigate, wait for text, take screenshots, read recent console and network errors, and close tabs. The panel follows the page AGH most recently operates or observes in the selected conversation. Manual tab selection lasts until AGH next targets a page; human takeover keeps its page visible. Selecting another tab ends the current input connection. Up to two conversations can own browser contexts, with up to three tabs each; close unused tabs through AGH before opening more. Closing the last tab releases that conversation’s browser slot.

## Human control

Click the displayed page and type directly, including Chinese input, macOS Option characters, Windows AltGr characters and paste. The first click, wheel gesture or navigation action requests human control through the existing authenticated session effect before sending input; **Take control** remains available as an explicit alternative. No input is forwarded while approval is pending or after admission fails. If the document changes during handover, the old click is discarded. Escape returns keyboard focus to the local browser controls. **Return to AGH** ends human control; AGH must observe the current page before writing again.

The panel uses page tabs and one address bar; press Enter to visit an address in the current tab. Tab labels use the host and path. **Browser options** contains display reconnection and recent page errors. Text input uses an invisible focus target within the displayed page, rather than a separate visible editor.

The display fits the panel by default. Choose **Show at 100%** in **Browser options** to read small text at the page's original size, scrolling when needed. Moving pages stream at up to about 30 fps within the existing media limits; an idle page receives a sharp image at twice the pixel dimensions. Input coordinates and AGH screenshots retain the original page dimensions.

Healthy authorized streams push browser status and the selected conversation's pages instead of periodic queries. Disconnections trigger bounded reconnection attempts and recovery queries through the existing validation gates. The display's final retry waits one minute for admission limits to clear; input actions are never replayed automatically. Very long addresses retain the complete query fallback. Recent page errors refresh only while expanded. A successful open returns without waiting for an additional status query. Reload, back and forward wait for DOM content rather than every image or other resource to finish loading.

Closing the panel stops its display, page subscriptions and recovery queries; reopening reconnects to the existing pages. It does not navigate, submit or replay input.

Switching browser tabs reuses the panel's display connection and captures only the selected page. Old-page images are discarded during the switch. View selection stays bound to the authenticated user and conversation; it does not grant input control or increase transport limits.

A temporary status-read failure shows an error while retaining the last page in that conversation. Input still needs a live authorized connection. Switching conversations clears the previous pages.

Human control uses authenticated session effects. Short input leases renew within five minutes; expiry requires another explicit takeover. A broken input connection pauses control. Reloading the workbench does not restore a control grant from history. Known refusals, such as a protected address, report their reason and allow another operation. The **Check previous action** button appears only when a request's result is uncertain and reuses its original ID to retrieve a committed result; it cannot resolve an action whose actual outcome remains unknown. Do not repeat an uncertain website submission in another browser without checking its outcome.

## Off, fallback and artifacts

Turning the plugin switch off rejects new work, revokes input, disconnects the display and closes plugin-owned pages. It cannot undo an action already delivered to a website. If cleanup is unconfirmed the browser stays unavailable until cleanup is reconciled.

When enabled, AGH is instructed to prefer this plugin for web tasks. An explicit request for an existing personal browser, login window or native application uses the appropriate external tool. When off, AGH prefers Computer Use if it is configured and authorized. The plugin does not enable Computer Use permissions or share cookies with desktop browsers.

Producing a file never opens a panel. Clicking a supported artifact of up to 1 MiB opens its existing safe preview for Markdown, HTML, PNG/JPEG, PDF or text. Unsupported formats and larger files download on click, without opening a preview panel. Office presentations continue through the existing download flow for opening in Office or WPS. This plugin does not add an Office or spreadsheet renderer. Conversations pinned before plugin installation or replacement may require the existing migration action or a new conversation.

## Compatibility and boundaries

Reviewed browser payloads are provided for Windows x64, macOS Apple Silicon and macOS Intel. macOS needs native acceptance on both architectures before a release is described as tested there. Windows ARM64 and Linux have no admitted payload in this plugin. Browser system requirements follow pinned Playwright 1.63.0 and its matching browser. Preparation needs network access and enough disk space for the archive and extraction.

The dedicated browser enables Chromium sandboxing, uses no personal browser profile and exposes no browser debugging endpoint to WebUI. Raw JavaScript evaluation, arbitrary executable selection, file URLs, automatic downloads and service workers are not exposed. Known AGH management targets and cloud metadata endpoints are blocked. The plugin is trusted local development functionality; URL routing rules are not an operating-system network sandbox. See [runtime provenance](../../third-party/browser-runtime.md) for exact payloads and licenses.
