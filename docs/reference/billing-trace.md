# Billing and optional trace providers

English | [简体中文](billing-trace.zh-CN.md)

[Documentation](../README.md) · [API](api.md)

The Host includes factory implementations for `agh.billing` and `agh.trace`, with independent reference providers and public contract scenarios. These factories are available for runtime assembly work; the current session and CLI startup path does not select them yet.

The factories advertise `post`, `refund`, `reconcile`, and `record`, `export` respectively. They do not implement or advertise authority transfer methods.

Trace `record` is a bounded local notification. It never receives an external effect port. Batch identity is stable: an identical batch returns its original accepted/dropped counts, and a changed batch with the same identity is refused. Owner diagnostics expose cumulative drops, the committed cursor, and the replay boundary. Capacity exhaustion refuses new batches without weakening mandatory Host audit.

Trace `export` is a leaf action. It checks the session's persisted consent and current deployment authorization before using its restricted `agh.network.request` port. DISABLED and LOCAL send nothing; ANON removes content from structured spans; FULL requires verified explicit consent. A separately configured trajectory projection uses the same export action and session receipt chain. Arbitrary bytes and schemas cannot obtain an anonymous upload permission. Export does not instrument its own request.

Billing fixes the account, usage references, original quote and price version before sending. A stable charge/refund key cannot be reused for changed input. Refunds require a posted charge, the same currency, and sufficient refundable balance. Pending and unknown refunds continue to hold that balance. Unknown prices, duplicate usage, foreign currency and contradictory receipts are refused. Reconciliation evidence must be verified by the trusted deployment port.

Both providers persist outbound intent before sending. A completed retry returns the original receipt; an interrupted or uncertain request is not sent again automatically. Cancellation and disposal close new operations and leave already sent requests available for reconciliation. This is not a claim of exactly-once delivery across external systems.

The acceptance fixtures run an OTLP/HTTP JSON receiver and a billing receipt endpoint in real processes, through the managed Network implementation. The public suites cover selection, normal operation, refusal, cancellation, process restart and disposal. Their restricted effect fixture does not establish production Budget/Usage/Effects integration. Session assembly, authoritative price/usage consumption, and existing trajectory uploader migration remain separate integration work.

Sources: [Host Trace](../../packages/host/src/runtime/providers/trace.ts), [Host Billing](../../packages/host/src/runtime/providers/billing.ts), [Trace contracts](../../packages/extension-api/testkit/runtime/contracts/trace.ts), [Billing contracts](../../packages/extension-api/testkit/runtime/contracts/billing.ts).
