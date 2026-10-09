# Test your plugin

English | [简体中文](testing.zh-CN.md)

[Author kit](README.md) · [Quickstart](quickstart.md)

Business agents can ship as plugins with offline, repeatable author tests. Import the helpers from **`@agnes/host/author-testkit`**. The preview SDK is source-only; link matching packages with [the quickstart](quickstart.md) before running tests. No model account or API key is needed for scripted or replay tests.

## Run your package's tests

```sh
npm run build                       # distribution starters; source starters can skip this
agh plugin test .
agh plugin test ./my-plugin -- --test-name-pattern approval
```

`agh plugin test [folder] [-- <runner arguments>]` is a thin wrapper around the package's existing `scripts.test` using installed Node/npm and test dependencies. It propagates the runner's exit code, streams output, uses a temporary home, strips inherited credentials and Node injection options, and disables npm downloads and pre/post test lifecycle scripts. It does not install dependencies or start the backend. Arguments after `--` belong to your runner. The [starters](../../templates/) use Node's test runner; the [knowledge QA](../../examples/fde/knowledge-qa/) and [ops runbook](../../examples/fde/ops-runbook/) examples use Vitest.

## Mount and invoke a tool

```js
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { main } from './dist/index.js'

const fixture = await createPluginTestHost(main)
try {
  const result = await fixture.invoke('plugin_hello_tool', { message: 'hello' })
  console.log(result.structured)
} finally {
  await fixture.dispose()
}
```

This lightweight fixture mounts a verified third-party row through the production Host registration bridge, validates arguments and releases registrations and plugin effects on disposal. Missing I/O refuses access. Pass explicit `context` tool ports or `services` public service doubles when testing a business Loop's dependencies. `invoke(name, args, signal)` supports cooperative cancellation. Duplicate registrations and failed mounts reject creation.

For durable policy, approvals and ledger facts, use the full session fixture below. The lightweight fixture invokes the tool directly and does not manufacture session approvals or ledger events.

## Real sessions, approvals, ledger and upgrades

```js
import assert from 'node:assert/strict'
import { createAuthorTestkit } from '@agnes/host/author-testkit'
import { main as v1 } from './v1.js'
import { main as v2 } from './v2.js'

const kit = await createAuthorTestkit({
  plugin: v1,
  version: '1.0.0',
  approval: async () => 'rejected',
})
try {
  const old = await kit.openSession()
  const pin = old.generation
  await old.invoke('business_write', { value: 'synthetic' })
  await old.assertApproval('rejected')
  await old.assertRefused('business_write')
  console.log(await old.facts(), await old.effects())

  const head = await kit.reload({ plugin: v2, version: '2.0.0' })
  old.assertPinned(pin)
  const fresh = await kit.openSession()
  fresh.assertPinned(head)
  assert.notEqual(head, pin)
} finally {
  await kit.dispose()
}
```

The full fixture assembles a real Host/Core with isolated SQLite ledgers and normal runtime generations. The default `author.invoke` Loop invokes tools through Core's policy, approval and effect path. Approval defaults to `rejected`; supply `allowed-once`, `allowed-session` or another supported verdict explicitly. `assertApproval` reads durable approval facts. `assertRefused` checks the last matching tool call's error result and absence of an execution intent, so a tool that executes and then returns an error is not a refusal.

To exercise your registered business Loop, open `kit.openSession({ loop: { id: 'acme.business', version: '1.0.0' } })`, call `session.enqueue('synthetic request')`, then `session.drive(5)`. This advances at most five public Loop edges and stops at idle, parked or turn-end. You can continue with another `drive(N)` and inspect `facts()`/`effects()`. Pass an AbortSignal for cancellation. Open a separate default session for `invoke`.

`reload` requires a new version and publishes a new production Host generation. Existing sessions retain their code and Loop pin; new sessions adopt the published generation. Test the observed tool results as well as the pin, including a reload while a tool is running. A failed candidate must leave the prior generation usable. The fixture supplies imported author modules through a controlled importer and hashed synthetic snapshot files, including generation archives. It tests registration and pin behavior; source loading, bundling and package installation are separate release checks. The testkit uses test seams for sandbox/network and never provides OS isolation for arbitrary plugin code.

## Record once, replay offline

```js
import { recordModelFixture, replayModelFixture, ScriptedProvider, fakeRequest } from '@agnes/host/author-testkit'

const scripted = new ScriptedProvider({ scripts: [[
  { type: 'text_delta', delta: 'Reviewed the synthetic account.' },
  { type: 'done', reason: 'stop' },
]] })
const recorder = await recordModelFixture(scripted, './model.fixture.json', {
  secrets: ['synthetic-private-value'],
})
try {
  for await (const event of recorder.provider.infer(fakeRequest(), {
    signal: new AbortController().signal, toolNames: [],
  })) console.log(event.type)
} finally {
  await recorder.close()
}

const replay = await replayModelFixture('./model.fixture.json')
for await (const event of replay.provider.infer(fakeRequest(), {
  signal: new AbortController().signal, toolNames: [],
})) console.log(event.type)
replay.assertConsumed()
```

Wrap a configured real `Provider` in the same way when you deliberately record a live exchange. The recorder does not obtain or persist keys. Files are exclusive (existing fixtures are never overwritten) and private (`0600`). Request/response headers, sensitive fields, common credential text and binary payloads are removed or redacted; session/tool/request IDs become deterministic aliases. Pass `secrets` and/or `redactText` for private values in free text, and inspect the fixture before sharing it. Use the same redaction options when replay input contains those private values.

Replay matches normalized input, preserves event order and failure prefixes, and regenerates `sent` stamps for live requests. It refuses changed requests, exhausted scripts, extra sessions, invalid schemas and abandoned recordings. Each new live session claims the next recorded session script at its first model call. `assertConsumed()` checks every script and invocation. It performs no model network calls. Supply `replay.provider` to `createAuthorTestkit({ plugin, version, provider: replay.provider })` to drive a business Loop against the recording. The full fixture uses the supplied provider's catalogue and selects its first model by default; empty catalogues are refused.

## Program HTTP/SSE faults

```js
import { startModelFaultServer } from '@agnes/host/author-testkit'

const server = await startModelFaultServer([
  { kind: 'http', status: 429, retryAfterMs: 1000 },
  { kind: 'http', status: 503, latencyMs: 20 },
  { kind: 'truncated', chunks: [{ choices: [{ delta: { content: 'partial' } }] }] },
  { kind: 'malformed', raw: 'data: {broken-json\n\n' },
  { kind: 'sse', chunks: [{ choices: [{ delta: { content: 'recovered' } }] }], chunkDelayMs: 5 },
])
try {
  // Point your adapter at server.baseUrl + '/v1'; each HTTP attempt consumes an entry.
  // Drive your adapter, assert its errors/recovery and then:
  server.assertConsumed()
} finally {
  await server.close()
}
```

The server binds only `127.0.0.1` on an ephemeral port. `latencyMs` delays headers; `chunkDelayMs` paces SSE data. Successful SSE ends with `[DONE]`, truncated SSE omits it (`reset: true` destroys the connection), and malformed SSE sends raw text. HTTP status/body and Retry-After are programmable. No request headers or bodies are retained. Script exhaustion returns HTTP 500 with `FIXTURE_EXHAUSTED`; consumption assertions catch extra or missing attempts. `close()` aborts delays and closes active connections, and is safe to repeat.

## Smaller Loop and adapter contracts

`driveLoop`, `scriptedModel` and `runModelAdapter` remain available from the same author entry. `driveLoop(factory, { inputs, replies, checkpoint, maxSteps })` creates/resumes a driver and captures requests, emitted events and checkpoints, then disposes it. `maxSteps` exhaustion fails. Missing controlled ledger ports refuse access; use the full session fixture for approvals, recovery and durable effects. `scriptedModel` exposes `requests` and `remaining`.

`runModelAdapter` creates a real adapter instance, captures catalog/events and disposes it in `finally`. The [adapter starter](../../templates/model-adapter/test/adapter.test.mjs) tests this contract. Add provider-specific fixtures and fault scripts when replacing its deterministic reply. Browser mounting, MCP connectivity, real providers and platform sandboxes need their corresponding integration checks.

## Provider conformance against Host

`@agnes/extension-api/testkit` and `@agnes/plugin-runtime/testkit` export `loopConformance`, `modelAdapterConformance`, `compactionConformance`, `toolRuntimeConformance`, `toolPolicyConformance`, `persistenceConformance`, `sandboxConformance` and `childAgentConformance`. `runProviderConformance(kind, options)` is their common runner.

Capture `ctx.providers` inside an isolated ordinary Host plugin. Pass that port, the owner package name, a fresh provider declaration and `open(provider)`. The probe uses the Host's public service/session path and returns `start(signal)`, `close()` and, for loop/persistence, `coldResume()`. Each started operation returns `{ ready, result }`: `ready` settles once the controlled operation reaches the provider, and `result` settles after it drains. If the native API returns a cancelled outcome instead of rejecting with AbortError, supply `isCancelledResult(result)` to validate that outcome. The suite refuses unload that returns before the admitted operation settles.

The [Host conformance test](../../packages/host/test/assemble/provider-conformance.test.ts) demonstrates the model/compaction/runtime/policy suites with real assembly and registration. The [owned-resource probes](../../packages/host/test/assemble/provider-owned-conformance.test.ts) cover loop, persistence, sandbox and child-agent, including fresh Host assemblies for loop and persistence cold resume. Together they exercise all eight kinds against Host.

Persistence store operations have no `AbortSignal` parameter. A persistence probe may declare `cancellation: 'unsupported'`; the suite reports `cancel-unsupported` rather than claiming cancellation was verified. Its admitted calls must still drain on unload. Use `unloadStarted()` to release a controlled non-cancellable call after unregister starts, and assert that the store remains open until that call finishes. Other kinds must pass the cancellation check. A loop probe can use public `Session.step()` to observe the admitted driver call, then `Session.run()` in its cold-resume probe to verify the resumed turn and persisted checkpoint.

These suites check the lifecycle contract; use provider-specific observable assertions in cold-resume probes and separate generation tests for publication or upgrades.

The optional Vitest persistence suites are exported separately from `@agnes/extension-api/testkit/persistence-contract`. The general testkit can be imported by Node's test runner without Vitest.
