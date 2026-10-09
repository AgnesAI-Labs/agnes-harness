# Intelligent UI Web renderer

English | [简体中文](intelligent-ui-web.zh-CN.md)

[Contract](intelligent-ui.md) · [Frontend](frontend.md)

The Web renderer consumes the generated Intelligent UI protocol. Backend methods and the official plugin must be available before real business workflows can use it; mounting a surface never executes a tool. No generated HTML, JavaScript, CSS or remote components are accepted.

Each session has one surface client, shared by compact conversation cards and the **Interactive surfaces** workbench panel. The panel lists open surfaces first and retains recent closed views. Expand opens the same session, surface and revision. Forms and row selections share drafts; changing a revision discards them and requires review of current data. Unsaved drafts live in memory. Refresh restores committed data from the server.

A business action opens a confirmation view. Confirm submits only the declared action id, current revision, form values and row ids. Tool permission is separate: pending approval links to the existing approval UI and its original ticket. Received and executing actions disable new submissions. Success displays the durable summary; the client waits for the Agent's update rather than inventing new rows or revisions. Only failures explicitly marked retryable offer a fresh, confirmed attempt with `retryOf`. An unknown outcome remains locked until backend reconciliation supplies new evidence.

The client listens before reading recovery pages, checks a consistent ledger watermark, and buffers concurrent events. It preserves the conversation's shared event subscription and cursor, rereads on UI events, gaps and reconnect, and fails closed on malformed or missing evidence. Pagination failure restarts the read with a bounded number of attempts. Unsupported methods show unavailable state.

A command id and its immutable request are retained in session-scoped browser storage while unresolved. **Recover submission** reads the original receipt first and, only when absent, resends that exact command. It does not create a fresh decision. A stale or closed refusal displays **Data changed, please re-confirm**. Review current data fetches the latest revision, discards prior drafts and confirmation, and allows a new explicit decision only if the surface is open and unlocked.

The catalog is in `packages/web-ui/src/intelligent-ui`; the client and the two registrations are in `packages/web/src/intelligent-ui`. SVG charts expose their numeric data in a table and do not infer currency units. Renderer controls have English and Simplified Chinese catalogs, native keyboard controls, live receipt announcements and stable test ids. Both Web build paths append the catalog stylesheet to the existing `/style.css` asset.

The unit suites use a fake App Server. `tools/e2e-web/intelligent-ui.spec.ts` starts an isolated browser fixture with the production catalog, shared client, workbench dock and approval component. It covers selection, form edits, shared placements, duplicate clicks, refresh during approval, success followed by an updated revision, and stale re-confirmation. It does not establish backend authorization, business-tool validation or effect recovery; those require integration with the plugin acceptance suite.
