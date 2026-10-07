# JSONL persistence provider

`@agnes-examples/persistence-jsonl` demonstrates the public ledger capability behind `definePersistenceProvider`. Its id is `jsonl`. The append-only log is `events.jsonl`; sessions, writer leases and op cells are in `state.json`. It also supports integrity scans.

This example has no metadata/KV, SQLite, durable child-control or crash-reclaim port. The current official Host uses SQL-backed seams and requires those capabilities, so selecting `persistence.provider: jsonl` refuses at startup with an explicit missing-capability message. The demonstration is exercised through the ledger conformance suite; it is not a feature-equivalent replacement for the default provider.

The package exports `persistenceProvider` and `openJsonlStore`, and depends only on `@agnes/extension-api`. Provider changes require a process restart and never migrate another provider's data. The removed in-memory table emulator is superseded by the optional real SQLite port and its separate `persistenceSqliteContract` suite.
