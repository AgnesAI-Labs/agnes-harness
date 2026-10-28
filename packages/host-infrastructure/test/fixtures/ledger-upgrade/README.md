# Ledger upgrade fixtures

These SQL dumps contain only synthetic messages. They were written by the real
`SessionLogImpl` and SQLite adapter at these plugin-core revisions, using Node v24.20.0:

- `before.sql`: `253796909eda603025694f37f5774309a6776548` (before the integrity admission change).
- `after.sql`: `e648a46f9ba5efd78360edbabfefb77145636bec` (after the integrity admission change).

Each writer opened `upgrade-parent`, appended two `user/message` events, closed it,
created `upgrade-child` at parent sequence 2, appended one child message and closed
both log and storage. The dumps preserve the builds' actual integrity metadata and
checkpoints, including the older checkpoint's zero verification timestamp and the
absence/presence of the corruption-seal table. `PRAGMA user_version = 1` preserves
the data-directory stamp, which SQLite's text dump omits.

Data-directory version 2 changed schedule tables, not the ledger. The test checks that
the version 1 stamp is refused, then restamps the loaded fixture to the current version
so it keeps testing ledger continuity.

The adapter test opens both with the current implementation, verifies history,
continues the parent and child, and verifies them again after reopening. It must
not rewrite historical digests or discard the checkpoint to make a fixture pass.
