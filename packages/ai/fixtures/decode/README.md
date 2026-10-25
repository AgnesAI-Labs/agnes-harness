# Decode chain fixtures

One JSON object per line, one case per object. Each case is a model's output as the adapter handed
it over, plus the exact event list the decode chain must produce from it — so a second
implementation in another language is held to the same bytes rather than to a description of them.

The runner is `src/decode/fixtures.ts` (`loadDecodeFixtures` + `runDecodeFixture`); the test that
drives it is `test/decode-fixtures.test.ts`. Every case is run at five chunk sizes, because where a
chunk boundary falls is not part of what the model said: a case that only decodes correctly when the
whole answer arrives at once is a case that will fail in production.

## Fields

| field | meaning |
|---|---|
| `id` | unique across the whole directory; it is the test name |
| `provenance` | `hand-written` or `captured` — see below |
| `model_hint` | optional. **Nothing reads it today.** It is carried for the captured samples that arrive with the rest of the chain, so a case can say which model produced it; it does not route a fixture to a rule |
| `tool_names` | what the model was offered. A name outside this list is never promoted |
| `input_chunks` | a string (text), `{kind:"thinking",delta}`, or `{kind:"native_toolcall",call}` for a call the wire protocol carried natively |
| `expected_events` | the events, with adjacent deltas of one kind already joined |

## Provenance, and what is still owed

Every case in this directory is `hand-written`: it was written from the syntax each rule is meant to
read, not captured from a model. That makes the corpus a statement of intent, and a rule can be
wrong about a real model's output while every case here stays green.

**The remaining external debt is a redacted captured sample per recovery rule.** `RULES.lock`
records `null` for every rule that still lacks one; the version-lock test rejects any claimed sample
unless it names a `captured` fixture with a non-empty `model_hint`. Until captured data is available,
this file and the lock keep the gap explicit rather than presenting hand-written examples as model
evidence. A captured case says
`"provenance": "captured"` and carries no prompt text, no path from a real machine and no identifier
belonging to anyone.

## Adding a case

Copy a line and change it — no code change is needed. Two rules:

- **Register the file.** `DECODE_FIXTURE_FILES` in `src/decode/fixtures.ts` is the list a runner
  reads; the test asserts it equals what is on disk, so a new file that nobody registered is red.
- **A new rule, or a change to the order of the rules, moves `PARSER_VERSION`.** Every
  `format/deviation` ledger row carries that version, and a row written under one rule set that
  claims another is a row that cannot be read back.
