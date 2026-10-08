# Session workbench panels

English | [简体中文](workbench-panels.zh-CN.md)

A workbench panel is a presentation contribution. Import the shared `workbenchPanels` singleton from `@agnes/web-client`; do not bundle another copy. Register translations with the host locale service before rendering.

```tsx
import { workbenchPanels } from '@agnes/web-client'
const dispose = workbenchPanels.register({
  id: 'example.notes', order: 40, edge: 'right',
  titleKey: 'example.notes.title', component: NotesPanel,
})
```

The component receives `{ context }`: a translator, optional session/resources and host-specific `data`. Bind the identity-bound disposer to the module lifetime. IDs must be unique and order finite. `edge` is `right` or `bottom`. The shell owns tabs, keyboard navigation, collapse and size memory. Removing the selected registration falls back to the first remaining panel. Use `@agnes/web-ui` primitives and both English and Chinese catalogs.

Registration grants no filesystem, process or goal permissions. Use supported session APIs on the authenticated host client. The built-in file panel uses `Session.workspaceList(path?)` and `Session.workspaceRead(path)`; paths are workspace-relative. Listing is lazy and honors `.gitignore`/`.aghignore` (wildcards, directory rules and negation). Preview is read-only, capped at 1 MiB and refuses binary files, symlinks and the installation home. Git status badges are best effort. Mention adds a quoted relative path to the composer without submitting it.

The existing `workbench.panel` slot remains mounted inside the right dock for compatibility. A fresh browser starts with closed docks. Desktop widths are 240–480 pixels; smaller screens use a sheet. Resize separators support arrow keys, tabs support arrow/Home/End keys and Escape closes a dock.

The worker runs list/read inside the session workspace invocation using the same filesystem policy as tools. Native reads open canonical paths one component at a time without following links, retaining the verified descriptor for the bounded read. Missing native support refuses the operation. POSIX uses `openat`; Windows holds real directory handles against replacement and rejects reparse points (local drive paths only). List revisions describe the visible listing. Read revisions are SHA-256 of returned bytes, or explicitly `weak:mtime:size` for oversized files. `observedAt` is the server read time, not a promise that a later preview is current. Git timeout/overflow returns `gitStatus: unavailable` rather than a clean badge.

Ignore matching supports comments, `*`, `?`, `**`, directory rules and ordered negation. Escapes, bracket classes, Git global excludes and re-including a hidden parent are unsupported. The viewer states this subset too.

Register optional `fileViewerActions` from `@agnes/web-client` using `{ id, order, component }`. The component receives `{ context, path, revision }`; it can link a file to an independently registered diff/review panel and actual ledger provenance without granting write or restore authority. Bind its disposer to the module scope.
