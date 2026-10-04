# @agnes/jev-trace

Pure Jev runtime observation projection, adapted from DeepSeek Harness under MIT.
[UPSTREAM.json](UPSTREAM.json) identifies the exact imported working-tree bytes;
[LICENSE](LICENSE) preserves the original license and copyright.

`projectTrace(entries, throughSeq?)` turns observed runtime records into a
JSON-serializable view of turns, steps, model requests, decisions and actions.
The sequence bound is inclusive. Sequence gaps are valid; duplicate sequences,
missing causal references and conflicting portable identities are rejected.
Projection performs no I/O and never opens, resumes or executes a runtime.

The adapter owns stable event prefixes and session identity. An observed event
is not a persistence receipt. Dispatch, tool outcome, effect and later resolution
remain distinct, and a later resolution does not rewrite the original stop.

Historical request decoders are retained for compatibility. In the imported
legacy global-Binding decoder, valid choices are not checked against the accepted
candidate identity. Its `consumed` status must not be treated as proof of that
association or as execution authority. New producers should use the current
manifest format. This limitation is intentionally retained rather than silently
changing the meaning of existing recordings during the initial port.

Run from the repository root:
`pnpm exec vitest run packages/jev-trace/tests`.
