# Observability and issue diagnostics

English | [简体中文](observability.zh-CN.md)

AGH includes an official `observability:otel` plugin in `@agnes/base`, implemented by `@agnes/observability` through the public `observabilityKind` provider contract. Export is **off by default**. Setting a collector endpoint alone does not enable it. Core has no exporter dependency.

## Enable OTLP export

Create private `AGH_HOME/observability.json` (normally `~/.agh/observability.json`):

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:4318",
  "redaction": "metadata",
  "headers": { "authorization": { "secretRef": "env:AGH_COLLECTOR_AUTH" } },
  "batchSize": 256,
  "batchMs": 1000,
  "queueSize": 1024,
  "timeoutMs": 3000,
  "shutdownPolicy": "flush"
}
```

The official plugin reads validated changes within one second. Headers accept only `env:NAME` secret references; put the value in the service process environment, never in configuration. Missing secrets cause safe delivery backoff. Endpoints must be HTTP(S), without user credentials, query or fragment. Optional `tracesEndpoint`, `metricsEndpoint`, `logsEndpoint` are full signal URLs; `endpoint` is a base URL with `/v1/traces`, `/v1/metrics`, `/v1/logs` appended. There is no ambient plaintext OTLP header input. `OTEL_SDK_DISABLED=true` forces export off.

Batch interval and timeout are 10–30000 ms. Queue size is 1–16384 records; batch size is 1–queue size. Delivery is also bounded to 1 MiB including in-flight records. Shutdown policy is `flush` (default) or `discard`; the timeout bounds final flushing. Queue overflow, permanent refusal and partial rejection increment drop counters. Retryable collector failures retain records with exponential backoff. Delivery runs asynchronously and never awaits the collector from an agent turn.

## What is exported

Committed public events generate session → turn → step → model/tool spans and correlated OTLP log records for each ledger event (type, sequence, timestamp). Resources include service/version, hashed workspace/session/pin identities and generation ID when Host supplies them. Child and daemon/worker lifecycle spans and the existing duration/token/tool/queue metrics remain available. Exporters are replaceable through the public `observabilityKind` contract; `bindSession(key, resource)` accepts resource identity and private roots, and optional `health()` exposes delivery health. Core does not perform network export.

`metadata` is the default redaction level. `content` explicitly opts into bounded user/assistant/tool content. Credential fields, recognized secret patterns, referenced header values and content mentioning private state roots are omitted or redacted. Memory-enabled sessions receive structural events only. No exporter reads private files. Content may still include confidential business information; authorize the destination before opting in.

Generation leases in the same process/home share session sequence watermarks, active spans and delivery queues. An overlapping generation switch keeps in-flight requests intact and does not replay accepted events. Queued records retain the destination and capture policy under which they were accepted; disabling stops new capture. Final lease disposal flushes. This is best-effort telemetry: process crashes lose the in-memory queue, and an ambiguous network acknowledgement can cause a collector duplicate on retry. It does not replace the durable ledger or implement feedback-authorized prefix uploads. Separate OS processes have separate pipelines.

## Export a support bundle

```sh
node agnes.mjs diagnostics export --out diagnostics.json
node agnes.mjs diagnostics export --session SESSION_ID --out diagnostics.json
```

The daemon must be reachable through the local owner connection. A selected session is checked against that owner's session authority. The CLI writes the file locally with private permissions and an atomic rename; an output path is never sent to the server.

The versioned bundle contains AGH/Node/platform versions, profile and composition hashes when available, generation states/counts, safe doctor statuses, recent error IDs and the last 100 permitted audit metadata entries. Session exports add only its hash, last sequence and hashed loop/generation pins. It contains no conversation ledger, file contents, credentials, exception messages, stacks or raw audit detail. An unavailable worker is reported explicitly and exporting does not start one.

App Server clients use `_agnes/v1/diagnostics.export` with optional `sessionId`, `limit` (1–500 audit entries) and `diagnosticId`. Errors normalized at the App Server boundary enter a 4096-record process buffer. CLI and production daemon owners persist safe error metadata in `AGH_HOME/diagnostics/errors.jsonl`, including early startup errors. Export merges the journal with the process buffer; an exact `diagnosticId` query filters the retained process buffer and a bounded recent journal window. It does not scan the complete durable history. No exception payload is persisted. Independent SDK embeddings should install a durable sink with the public `observeDiagnostics` contract if they need restart-persistent diagnostics for errors generated in that process. A sink failure marks the error `diagnosticUnavailable`.

The process buffer retains up to 4096 errors. Journal reads clamp record limits to 1–1000 and scan at most `limit × 4096` recent bytes; an exact-ID query uses limit 1. An older ID can therefore be unavailable after restart while its row still exists. Audit files are read within their separate last-1-MiB bound. Deleting the home or its journal removes that history. Review even a redacted bundle before posting it publicly: timestamps, versions, hashes, platform and operational counts can reveal deployment metadata.

See [troubleshooting](troubleshooting.md), [CLI reference](../reference/cli.md) and [App Server](../reference/app-server.md) for related interfaces.

## Web diagnostics

Open **Settings → Diagnostics** to view recent safe error records, copy a diagnostic ID, or find an older record by its exact ID. **Export diagnostic bundle** downloads the redacted JSON bundle; after a search, it selects that error. The page also shows worker health, generation counts and bound session counts. Technical details start collapsed.

The OTLP settings card edits enable, endpoint, content policy, batch/queue limits, timeout, shutdown policy and header secret references. **Test connection** sends synthetic traces, metrics and logs; it does not upload session content or save pending edits. **Save settings** persists a private configuration and applies it within one second. Last success, queue depth, failures and drops describe the App Server and the running session Worker separately. A missing or unreachable Worker is reported explicitly; health reads never start one. The local-owner administration method is `_agnes/v1/admin.observability`. Diagnostic bundles remain content-free.
