# Migration fixtures

One row per line:

```json
{ "id": "...", "target": "migrate", "type": "...", "fromV": 0, "before": {}, "after": {} }
```

`before` is the `data` of an event written at `v = fromV`; `after` is that same `data` once
`normalize()` has carried it forward one version.

The rule this directory exists for: **every `(type, fromV)` pair registered with
`registerMigration` must have at least one fixture here.** `test/migrate-fixtures.test.ts` refuses a
registered migration that has none, so a migration cannot ship without a worked example of what it
does. That gate is what stops a migration from being written, merged, and only discovered to be
wrong on the day someone opens a session recorded a version ago.

While `CURRENT_V` is 1 the real registry is empty — there is no past version to migrate from — so
`example-x-core.jsonl` is a format example under the `x/core/` extension namespace. The conformance
runner skips a fixture whose migration is not registered and counts it as `skipped`, so the example
does not pretend to exercise anything; `test/conformance.test.ts` pins that count.
