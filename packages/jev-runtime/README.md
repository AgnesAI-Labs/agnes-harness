# @agnes/jev-runtime

Portable Jev/Laya decision runtime, adapted from DeepSeek Harness under MIT.
The exact imported working-tree bytes and local adaptations are recorded in
[UPSTREAM.json](UPSTREAM.json); [LICENSE](LICENSE) preserves the upstream notice.

`openJevRuntime(ports, config)` opens a committed record prefix and returns
`run`, `cancel`, `close` and `resolveUnknown`. The host supplies the ledger,
model transports, tool catalog and execution, artifacts, decision context,
identifiers and lifecycle. Core source has no filesystem, network, Node or
Cordis dependency. Runtime versions and persisted record formats are unchanged
from the imported baseline.

The adapter owns exclusive writing, persistence guarantees, input admission,
permissions and sandbox enforcement. A recorded dispatch is not evidence of
tool success. An uncertain mutation blocks further decisions until explicitly
resolved; reopening never automatically dispatches that action again. A failed
commit invalidates the runtime instance. Host durability guarantees must be
described accurately; this library cannot strengthen a storage engine's commit.

The Jev view and LLM view remain separate projections of the same records.
For `jev.skill-catalog.v1`, the host may record a `retrieval` string naming its
actual catalog-loading operation. The decision projection preserves that value;
when absent, it makes no assumption about the host's tool names. Catalog entries
remain evidence, not automatically loaded instructions or execution authority.

The imported tests cover decisions, candidate evidence, gates, context budgets,
recovery, answer adoption, progress and action lifecycles. Run from the repository
root: `pnpm exec vitest run packages/jev-runtime/tests`.

This port preserves the reference protocol; it does not claim that host-side
causal commit validation, tool permissions or end-to-end recovery have been
implemented by installing this package. Those require adapter acceptance tests.


Language arbitration may produce `{kind: "calls", calls: [{kind: "call", name, arguments}]}`
with 1–32 entries. Legacy `kind: "call"` remains supported; parameter binding stays single-call.
All entries pass tool/schema preflight before the first side effect, then execute sequentially
through independent authorization and dispatch barriers. Each selected decision records its
`callIndex` into the settled response; replay rejects duplicate or mismatched indices. Any
failure, cancellation, unknown effect, new input or conclusion abandons the remaining plan.
Recovery never auto-dispatches its tail, and durably concluded actions retain completion.
One step may contain several actions; progress retains all observed outcomes without charging
multiple step-budget units. This is an intentional extension beyond the upstream single-call rule.
