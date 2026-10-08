# Observability and issue diagnostics

English | [简体中文](observability.zh-CN.md)

AGH includes an official `observability:otel` plugin in `@agnes/base`, implemented by `@agnes/observability` through the public `observabilityKind` provider contract. Export is **off by default**. Setting a collector endpoint alone does not enable it. Core has no exporter dependency.

## Enable OTLP export

An administrator can create `observability.json` in `AGH_HOME` (normally `~/.agh`):

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:4318",
  "includeContent": false,
  "batchMs": 1000,
  "timeoutMs": 3000
}
```

Restart the daemon after changing this file or the environment. The administrator owns the collector destination and its access policy. Keep configuration containing collector headers private. The equivalent environment configuration is:

```sh
export AGH_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
node packages/cli/dist/local/agnes.mjs serve
```

Supported settings:

| Environment | JSON field | Meaning |
| --- | --- | --- |
| `AGH_OTEL_ENABLED` | `enabled` | Explicit opt-in; `true`/`false` or `1`/`0` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` | Base HTTP(S) URL; append `/v1/traces` and `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `tracesEndpoint` | Exact trace URL |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `metricsEndpoint` | Exact metric URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | `headers` | Comma-separated `name=percent-encoded-value`; JSON uses an object |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `timeoutMs` | Request and shutdown deadline in milliseconds, 10–30000 |
| — | `batchMs` | Flush interval in milliseconds, 10–30000 |
| `AGH_OTEL_INCLUDE_CONTENT` | `includeContent` | Explicit risky content opt-in |
| `OTEL_SDK_DISABLED` | — | `true`/`1` disables export even if enabled elsewhere |

Environment settings override the file. Explicit ordinary plugin configuration overrides both. HTTP redirects, URL credentials and invalid enabled settings are refused. This implementation sends [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/) traces and metrics; it does not install global instrumentation or provide a gRPC/protobuf exporter. Signal endpoint behavior follows the [OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/).

## What is exported

Committed public session events produce session, turn, model and tool spans. Public child lifecycle hooks link each child span and its session/turn/model spans to the parent's trace. Supervisor seams emit daemon and worker lifecycle spans. Separate OS processes have separate lifecycle traces; there is no cross-process trace-context propagation on IPC yet.

Metrics are `agh.turn.duration` and `agh.tool.duration` histograms in milliseconds; `agh.tokens.input`, `agh.tokens.output`, `agh.tool.calls`, `agh.tool.errors` and `agh.worker.restarts` delta counters; and `agh.queue.depth`, a gauge of admitted commands including in-flight work. Compute tool error rate from errors/calls. Existing structured execution logs and audit entries gain `traceId` and `spanId` while an observed session runs. Log bodies are not uploaded.

By default, exported attributes contain hashed session/model/tool/call identities, turn numbers, timestamps, counts and success/error status. Prompt, response, tool result and file bodies, raw session identifiers, working directory paths and collector credentials are excluded. Hashes permit correlation; they are not an anonymity guarantee for guessable names.

**Content export is risky.** Setting `includeContent: true` or `AGH_OTEL_INCLUDE_CONTENT=true` includes bounded user/assistant/tool content attributes, capped at 4096 characters. Credential field names and recognized credential strings are scrubbed, but free-form content may still identify people or contain confidential files. Enable only with authorization for that collector and workload. Diagnostics export always excludes content, independently of this switch.

Delivery uses a queue limited to 1024 records or 1 MiB, with one in-flight batch and a bounded 64 KiB collector response. Queue overflow drops telemetry. Network failures and retryable HTTP responses receive at most three attempts; a refused or partially accepted batch is not an execution failure. Shutdown flushes within the configured deadline and aborts remaining requests. Observation is bounded to 512 sessions, 512 children and 256 simultaneous tools per session. This is best-effort telemetry, not an audit ledger; inspect collector health to detect missing data.

## Export a support bundle

```sh
node packages/cli/dist/local/agnes.mjs diagnostics export --out diagnostics.json
node packages/cli/dist/local/agnes.mjs diagnostics export --session SESSION_ID --out diagnostics.json
```

The daemon must be reachable through the local owner connection. A selected session is checked against that owner's session authority. The CLI writes the file locally with private permissions and an atomic rename; an output path is never sent to the server.

The versioned bundle contains AGH/Node/platform versions, profile and composition hashes when available, generation states/counts, safe doctor statuses, recent error IDs and the last 100 permitted audit metadata entries. Session exports add only its hash, last sequence and hashed loop/generation pins. It contains no conversation ledger, file contents, credentials, exception messages, stacks or raw audit detail. An unavailable worker is reported explicitly and exporting does not start one.

App Server clients use `_agnes/v1/diagnostics.export` with optional `sessionId`, `limit` (1–500 audit entries) and `diagnosticId`. Errors normalized at the App Server boundary enter a 4096-record process buffer. CLI and production daemon owners persist safe error metadata in `AGH_HOME/diagnostics/errors.jsonl`, including early startup errors. Export merges the journal with the process buffer; an exact `diagnosticId` query searches historical records even after they leave the buffer. No exception payload is persisted. Independent SDK embeddings should install a durable sink with the public `observeDiagnostics` contract if they need restart-persistent diagnostics for errors generated in that process. A sink failure marks the error `diagnosticUnavailable`.

The default bundle includes the latest 4096 errors and reads at most the last 1 MiB of each audit file. Older errors remain available by exact ID while the journal exists. Deleting the home or its journal removes that history. Review even a redacted bundle before posting it publicly: timestamps, versions, hashes, platform and operational counts can reveal deployment metadata.

See [troubleshooting](troubleshooting.md), [CLI reference](../reference/cli.md) and [App Server](../reference/app-server.md) for related interfaces.
