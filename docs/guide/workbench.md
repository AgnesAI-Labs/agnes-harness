# Session workbench

English | [简体中文](workbench.zh-CN.md)

[Documentation](../README.md) · [Web sessions](web.md) · [Execution evidence](fact-chain.md)

Open **Workbench** in the session header to inspect **Files**, **Changes**, the **Activity record** and **Terminal** alongside the conversation. Goals and business views appear when the session has that content; additional panels are in **More**. A fresh browser starts with the workbench closed. Its default side width is 720px, limited by the available space so the conversation keeps at least 420px; saved width choices are preserved. Select a tab, resize the separator or expand to 60% of the window; size and tab selection are remembered locally. On narrow screens it fills the screen. Tabs support arrow/Home/End keys, resize separators support arrows, and Escape closes the workbench and returns focus. F6 and Shift+F6 cycle the task regions. Opening the terminal panel does not start a process; choose **New terminal** to start one. The terminal uses a theme-following xterm.js screen. Use the guide chevron or the **+** context menu to choose a shell or attach an Agent job. Tab menus (right-click or Shift+F10) expose rename, interrupt, details and kill; double-click a human tab name to rename. Human **×** ends the process and closes its tab; Agent **×** stops following. Closing the workbench leaves processes running. See [Terminal and background jobs](web.md#terminal-and-background-jobs) for input, refresh and output limits.

If the terminal screen fails to load, use **Retry** inside its tab. Workbench tabs, expand and close remain available when panel content fails.

Changes and Terminal pause UI polling while the browser page is hidden and catch up when you return. Background jobs and terminal processes continue running.

For adopted business applications, object buttons and composer quick actions open a reviewed task with a removable context chip. Edit the request as ordinary text; remove the chip to stop attaching that context to later requests. Submitted messages retain their context chips after reload. The assistant's turn header shows the internal role handling the work. Current object, signatures and evidence tabs use the application's declared views; tools and Host decisions remain authoritative. Confirm a pending signature in its conversation card; the signatures tab shows its status and a jump to that card. Evidence tabs list declared evidence objects and output files, with the producing tool available in details.

Base tool titles follow the interface language in steps, approval cards, receipts and trace views. Tool cards start collapsed. Expand a command step to read the command once, labelled output streams and its exit status; exact argument previews are in **Raw arguments**. While a confirmation card is active, one compact conversation line links to it.

## Inspect files

The built-in file panel lazily lists the admitted session workspace, honoring the supported `.gitignore`/`.aghignore` subset. The tree fills the panel until you open a file for a read-only preview. The A/M badges explain session-created and session-modified files in their tooltips. Open **… → File visibility rules** in the panel header to inspect the supported ignore rules. Mentioning a file inserts a quoted relative path into the composer without sending a message. Git badges are best effort; an unavailable badge does not mean a clean repository. Ordinary repositories, linked worktrees and submodules with a valid `.git` pointer file are supported. Symlinked or malformed Git metadata is unavailable. This status read disables repository hooks and external content filters; files that rely on those filters may have different badges from a manual Git command.

Previews are capped at 1 MiB. Binary/oversized files, symlinks and the installation home are refused or labelled without pretending to show their contents. A revision describes the bytes that were read, not a guarantee that a later edit has not changed them. The panel offers no arbitrary filesystem or restore authority.

Opening a file adds a tab above the preview, and the tree stays beside it. Selecting a row or a file mention switches to that file's tab instead of replacing the preview; closing the current tab activates the tab to its right, then the one to its left. Each tab keeps its own source/preview choice and source scroll position, and the open list is remembered per session in this browser, so switching workbench panels, closing the workbench or reloading the page still shows the same files. A background refresh keeps the current file visible while reading; an unchanged revision preserves the preview. Only the current tab re-reads on refresh, retry or a ledger update; other tabs re-read when selected and keep showing their last text meanwhile. A failed read clears only that tab's content and shows its error, and the tab stays so the error can be retried or the tab closed. Arrow/Home/End keys move between tabs and Delete closes the active one. At most 20 files can be open at once; close one to open another. Losing read access clears that tab's content on its next read; the remembered list itself grants no access.

## Read workflow results

Workflow cards distinguish child-authored reports from backend execution receipts. Worktree outputs remain in the child's workspace; they are not merged into the main workspace automatically. Inspect current member status and receipt availability before claiming integration. See [programmatic workflows](code-workflows.md).

Use [execution evidence](fact-chain.md) to inspect an existing request/tool/artifact relation. File paths and matching digests alone do not prove causality.

Developers can add panels through `workbenchPanels` and file actions through `fileViewerActions` from the host's `@agnes/web-client`. Registrations grant no data or write permissions. The [panel author guide](../extend/workbench-panels.md) owns the SDK contracts, ignore subset and cleanup rules.
