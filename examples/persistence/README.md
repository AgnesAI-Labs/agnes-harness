# JSONL persistence provider

`@agnes-examples/persistence-jsonl` is a second session store behind `definePersistenceProvider`. Its id is `jsonl`. The event log is append-only `events.jsonl`. Sessions, writer leases, and op cells are in `state.json`. Package tables accept `CREATE TABLE`, `CREATE INDEX`, `INSERT`, and `SELECT`, and they live in the process.

Host selects it with `persistence.provider: jsonl` in the user profile. The running process keeps the store it opened. The provider's `state.effect` is `restart-required`. It does not read or migrate a SQLite ledger. Child control and crash reclaim stay on the built-in `sqlite` provider.

The package exports `persistenceProvider` and `openJsonlStore`. It depends only on `@agnes/extension-api`.
