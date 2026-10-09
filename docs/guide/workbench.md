# Session workbench

English | [简体中文](workbench.zh-CN.md)

[Documentation](../README.md) · [Web sessions](web.md) · [Execution evidence](fact-chain.md)

Use the session's right and bottom docks to inspect files and execution alongside the conversation. A fresh browser starts with the docks closed. Open a panel, select its tab, resize the separator or collapse it; sizes are remembered locally. On smaller screens panels use a sheet. Tabs support arrow/Home/End keys, resize separators support arrows, and Escape closes a dock.

## Inspect files

The built-in file panel lazily lists the admitted session workspace, honoring the supported `.gitignore`/`.aghignore` subset. Open a file for a read-only preview. Mentioning a file inserts a quoted relative path into the composer without sending a message. Git badges are best effort; an unavailable badge does not mean a clean repository.

Previews are capped at 1 MiB. Binary/oversized files, symlinks and the installation home are refused or labelled without pretending to show their contents. A revision describes the bytes that were read, not a guarantee that a later edit has not changed them. The panel offers no arbitrary filesystem or restore authority.

## Read workflow results

Workflow cards distinguish child-authored reports from backend execution receipts. Worktree outputs remain in the child's workspace; they are not merged into the main workspace automatically. Inspect current member status and receipt availability before claiming integration. See [programmatic workflows](code-workflows.md).

Use [execution evidence](fact-chain.md) to inspect an existing request/tool/artifact relation. File paths and matching digests alone do not prove causality.

Developers can add panels through `workbenchPanels` and file actions through `fileViewerActions` from the host's `@agnes/web-client`. Registrations grant no data or write permissions. The [panel author guide](../extend/workbench-panels.md) owns the SDK contracts, ignore subset and cleanup rules.
