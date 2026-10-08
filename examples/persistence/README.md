# JSONL persistence provider

[English author guide](../../docs/extend/persistence.md) · [中文指南](../../docs/extend/persistence.zh-CN.md)

`@agnes-examples/persistence-jsonl` exports `persistenceProvider` (`jsonl`) and `openJsonlStore`. It depends only on `@agnes/extension-api` and Node built-ins. It supplies the full Host contract: ledger, integrity, owner-scoped metadata, child identity and workspace control, exact bigint budget accounting, and expired-writer reclaim. It implements no SQL interpreter and creates no SQLite database.

Build from the repository root:

```sh
pnpm exec tsc -b examples/persistence
pnpm exec vitest run examples/persistence/test/contract.test.ts packages/host/test/assemble/provider-owned-conformance.test.ts
```

For a built package, point its root export to `./dist/src/index.js`, then install, inspect, trust and enable it using [package management](../../docs/guide/packages.md). The source example points to TypeScript for workspace development. Add this to the user profile, then restart:

```yaml
persistence:
  provider: jsonl
```

Settings → Providers shows the selected provider, its capabilities and the restart requirement. The Host smoke uses a scripted model, the default accounting/refinement factories and real session creation, a complete turn, pinned-generation restoration and cold resume. The public conformance runner also verifies admission, catalog immutability and unload draining; cancellation is explicitly unsupported by the persistence contract.

## Storage and recovery

`store.jsonl` is a transaction journal. Each checksummed, newline-terminated record contains the mutations for one transaction. A ledger batch, integrity rows, register cells and lease renewal commit together. Metadata, child creation, reservation/settlement and reclaim use the same journal. A successful mutation returns after fsync; failed synchronous transactions write nothing. Returned values are detached copies. The journal loads into memory, so this example targets small local deployments, not large archives. It has no zstd codec or journal compaction.

A torn or checksum-invalid tail is durably quarantined to a private sidecar before atomic replacement with the valid prefix, a recovery audit and no-replay operation fences. A checksum-valid final record without a newline is preserved. Valid transactions after damage and chain mismatches refuse truncation; unknown future versions refuse startup. After an uncertain write failure, the store refuses further use until reopened; recovery may observe the complete transaction, so callers reconcile before retrying. The journal format is versioned. It refuses the earlier ledger-only `events.jsonl` / `state.json` layout; export those sessions with the older provider first.

`writer.json` excludes live competing processes; Hosts restoring plugin generations within one process share the process resource and close it after the last Host releases it. A dead PID can be reclaimed under the exclusive `open.lock` directory gate. If a process dies while holding that short startup gate, first verify that no opener is running and remove only the stale `open.lock` directory. Do not remove a live `writer.json`. Use a local filesystem with working exclusive creation and fsync; network filesystems and Windows durability need separate acceptance.

Changing the configured provider never reads or converts another provider’s files. Follow [export/import migration](../../docs/extend/persistence.md#move-sessions-between-providers) using an isolated destination and retained source backup.
