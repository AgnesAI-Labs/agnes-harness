# Memory and Retrieval providers

`createMemoryService` and `createRetrievalService` create separate workspace/tenant
domains using explicitly injected narrow MemoryStorage/RetrievalStorage ports.
Core imports no Node persistence APIs. Host's memory-storage adapter owns separate
SQLite files and FTS5; reference owns an independent snapshot store. They implement the public service lifecycle, query SPI and action factories.
They do not use the session ledger. Existing harness/refine readers and startup
assembly keep their current behavior; assembly must explicitly select these providers.

Configure `identity`, `authorize` and `sourceAvailable` from the owning backend.
The caller's principal must match the current authenticated identity and tenant.
Authorization callbacks must check current source versions, revocation and permitted
trust levels. A missing source filters a read; a failed source check fails the request.
The same policy must be supplied to Memory and Retrieval. Callbacks receive copies of
records, so they cannot mutate the stored item or its source references.

Memory writes use `expectedRevision` and a stable delivery identity (the action id on
the public action SPI). An identical delivery returns its original result; changing
the request under that identity conflicts. Reads never expose deleted or expired
items, including reads at an old revision. An empty `get.ids` selects the authorized
set. Mutations, tombstones, delivery results and deletion outbox entries commit in
one atomic storage transaction. Host persists it with SQLite WAL and FULL synchronization.
Storage handles are exclusively owned by a provider and close with it; reopening
verifies immutable workspace/tenant ownership. Storage ports expose domain reads,
revision writes and deletion operations, never arbitrary SQL or session storage.

Index ingestion is a trusted backend operation, `replaceIndex`. It accepts existing
finite vectors and query vectors, validates every dimension before commit and rejects
documents absent from the current authorized Memory set. It does not generate
embeddings or create an Embedding `vectorsRef`. Default indexing uses FTS5 plus vector
candidates; Core derives the keyword terms before the storage write, and Host only
persists them and queries FTS5. The independent reference uses persisted inverted postings. Both apply
current Memory authorization before returning hits. Scores combine the fraction of
matched query terms and nonnegative cosine similarity equally. Zero vectors contribute
no vector similarity. Unknown query vectors use keyword candidates only.

Index refs include a revision. Cursors bind the query, principal, authorization,
index and current authorized Memory snapshot. Rebuild or deletion changes the index
revision. `propagateMemoryDeletions` removes a receipt from each index durably before
acknowledging the Memory outbox; failed or interrupted propagation stays retryable.
Redelivery does not increment the index revision; a changed receipt conflicts.
Search filters tombstones even before propagation succeeds.

`searchRemote` is a composite action. Supply the selected State binding and a current
resource-to-binding resolver that checks the exact ResourceRef version/digest. The
composite prepares one explicit mandatory child, waits for a published ready result
view through `agh.state.probeActionResult`, and resumes without reissuing the child.
Pending and unknown results never become a fabricated successful response. Current
source authorization is checked again on the result. The remote implementation must
return the official Retrieval result schema. Embedding routes are explicitly refused
until the fixed Embedding matrix schema and model/usage services are available.

Inline inputs/outputs use the official method schemas and digest/byte checks. Blob
method inputs require the selected Blob reader and currently fail explicitly; no
implicit reader is created. Large outputs fail with `output_budget`. The service's
direct `call` API is intended for backend domain adapters; the public query/action
SPI is used at the runtime boundary. Closing an action does not close its parent
service. Closing Retrieval interrupts pending dependency reads.

The conformance binder exercises both providers through public queries and actions,
real cold processes and a restricted HTTP child fixture. That fixture supplies
published result views; it is not evidence of production State/Hook or startup wiring.
