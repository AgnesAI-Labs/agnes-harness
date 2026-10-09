# Persistence providers

English | [简体中文](persistence.zh-CN.md)

[Author kit](README.md) · [Security](../guide/security.md) · [Sessions](../guide/sessions.md)

A complete provider can replace SQLite for the entire Host. Export a `persistenceProvider` created with `definePersistenceProvider` from `@agnes/extension-api`. Declare `state: { effect: 'restart-required' }` and capabilities `{ ledger: true, metadata: true, childControl: true, reclaim: true, integrity: true }`. Supply the corresponding store methods and ports; missing capabilities refuse startup and close the candidate store. SQL remains optional (`sqlite: { dialect: 'sqlite', tables(owner) }`) for extensions that specifically require it.

The [JSONL example](../../examples/persistence/) implements all required ports using Node built-ins. Install and enable the package before selecting `persistence: { provider: jsonl }` in the user profile. Omitted selection stays on SQLite. Settings → Providers displays the selected backend and capabilities. Selection takes effect after restart; existing sessions and files stay with their provider.

Providers may return optional `open().recovery: { diagnosticId, quarantineFile, validThroughSeq }` only after durably quarantining damaged bytes and preserving the valid prefix. Persist a no-replay cancellation/failure fence in the same recovery transaction: a crash before Host handles the report must not make pending effects replayable. Host closes outstanding effects and records a localized recovery diagnostic. Never discard checksum-valid successors or use this path for format migration.

## Package storage and compatibility

Default usage accounting, refinement proposals, MCP indexing, approval grants and locked-package receipts use owner-scoped metadata. A package seam receives `adapters.storage.namespace(name)`; the Host binds the owner, so packages cannot choose another owner through that handle. Values must be JSON serializable and reads return detached values. `transaction(fn)` is synchronous and atomic; throwing or returning a Promise rolls back its writes. Child identity and tree budget accounting remain on `childControl`, while expired leases and operation-state inspection remain on `reclaim`.

For legacy SQL extensions, `adapters.storage.table(name)` remains available only with SQL support; a non-SQL backend refuses that operation explicitly. Legacy seam embedders that only supply tables still work, but the official Host defaults choose metadata. The built-in SQLite provider keeps ledger/child storage compatible and copies old owner-local KV into separate metadata files once. Default usage/refine data migrate once; MCP indexes rebuild at startup. Host grants and locked-package receipts pass their existing strict schema and row validation before a transactional copy. Existing SQL files are retained as rollback evidence; new KV changes are not written back to the old tables, so downgrade requires an explicit data migration.

Run `persistenceContract` and `persistenceHostContract` from `@agnes/extension-api/testkit/persistence-contract`. Run `persistenceSqliteContract` only when declaring SQL. Also use `persistenceConformance` through a real Host registration port and verify a complete Host turn and fresh-process resume. Persistence methods have no `AbortSignal`; report cancellation as unsupported and still verify draining unload.

## Move sessions between providers

Migration transfers session history through supported export/import. It does not copy provider files or grant authority to the destination. Quiesce the source, retain a backup of its complete home, and export each desired session with the source provider selected:

```sh
AGH_HOME=/path/to/source-home node agnes.mjs export SESSION_ID --format agnes -o session.jsonl
```

Stop the source process. Prepare a separate destination home, enable the target provider and configure it there. Import with a previously unused key:

```sh
AGH_HOME=/path/to/destination-home node agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:migrated
```

Open the imported session, inspect its messages and import warnings, run a synthetic follow-up, stop and restart the destination, then verify that history persists. Keep the original export and source home until acceptance. To roll back, stop the destination and restart the retained source home with its original provider/configuration. Switching an id in the same directory is not migration.

Native session import records its source and creates a new session. It does not recreate live writers, approvals, permanent grants, child budget/reservation identities, plugin generation pins, or workspace ownership. Export child sessions separately if their history is needed. Copy required artifact bytes through the supported artifact workflow; a transcript export alone is not an attachment backup. Reauthorize operations at the destination. A byte-for-byte full-provider migration needs a provider-specific offline converter covering those domains; the example does not claim such a converter.
