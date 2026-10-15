# Session workbench

English | [简体中文](workbench.zh-CN.md)

[Documentation](../README.md) · [Web sessions](web.md) · [Execution evidence](fact-chain.md)

Open **Workbench** in the session header to inspect **Files**, **Changes**, the **Activity record** and **Terminal** alongside the conversation. Goals and business views appear when the session has that content; additional panels are in **More**. A fresh browser starts with the workbench closed. Select a tab, resize the separator or expand to 60% of the window; size and tab selection are remembered locally. On narrow screens it fills the screen. Tabs support arrow/Home/End keys, resize separators support arrows, and Escape closes the workbench and returns focus. F6 and Shift+F6 cycle the task regions. Opening the terminal panel does not start a process; choose **New terminal** to start one. The terminal uses a theme-following xterm.js screen. Use the guide chevron or the **+** context menu to choose a shell or attach an Agent job. Tab menus (right-click or Shift+F10) expose rename, interrupt, details and kill; double-click a human tab name to rename. Human **×** ends the process and closes its tab; Agent **×** stops following. Closing the workbench leaves processes running. See [Terminal and background jobs](web.md#terminal-and-background-jobs) for input, refresh and output limits.

If the terminal screen fails to load, use **Retry** inside its tab. Workbench tabs, expand and close remain available when panel content fails.

## Inspect files

The built-in file panel lazily lists the admitted session workspace, honoring the supported `.gitignore`/`.aghignore` subset. Open a file for a read-only preview. Mentioning a file inserts a quoted relative path into the composer without sending a message. Git badges are best effort; an unavailable badge does not mean a clean repository.

Previews are capped at 1 MiB. Binary/oversized files, symlinks and the installation home are refused or labelled without pretending to show their contents. A revision describes the bytes that were read, not a guarantee that a later edit has not changed them. The panel offers no arbitrary filesystem or restore authority.

## Read workflow results

Workflow cards distinguish child-authored reports from backend execution receipts. Worktree outputs remain in the child's workspace; they are not merged into the main workspace automatically. Inspect current member status and receipt availability before claiming integration. See [programmatic workflows](code-workflows.md).

Use [execution evidence](fact-chain.md) to inspect an existing request/tool/artifact relation. File paths and matching digests alone do not prove causality.

Developers can add panels through `workbenchPanels` and file actions through `fileViewerActions` from the host's `@agnes/web-client`. Registrations grant no data or write permissions. The [panel author guide](../extend/workbench-panels.md) owns the SDK contracts, ignore subset and cleanup rules.
