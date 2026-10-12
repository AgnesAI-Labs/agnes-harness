# Runtime capability providers (seams)

English | [简体中文](seams.zh-CN.md)

[Author kit](README.md) · [Compaction engines](compaction-engines.md) · [Plugin boundaries](../develop/plugins.md)

A seam is a required runtime capability the kernel consumes as one typed object: approval delivery, principals, billing, checkpoints, artifacts, the verifier and the repair policy. Each is an ordinary provider kind. There is one way to supply one and one way to choose one.

| Kind | Contract | Pinned per session |
| --- | --- | --- |
| `approval` | `ApprovalSeam` | yes |
| `principals` | `PrincipalsSeam` | yes |
| `billing` | `BillingSeam` | yes |
| `checkpoint` | `CheckpointSeam` | yes |
| `artifacts` | `ArtifactsSeam` | yes |
| `verifier` | `VerifierSeam` | no |
| `repair` | `RepairSeam` | no |

The contracts live in `@agnes/extension-api/seams`. `sandbox` is the existing [sandbox provider](../develop/architecture-plugins.md) kind and `platform` belongs to the Host.

## Register an implementation

Register from an ordinary Cordis plugin that injects `providers`, exactly like any other provider:

```ts
import type { ProviderPluginContext } from '@agnes/extension-api'
import type { CheckpointProvider } from '@agnes/extension-api/seams'

const checkpoint: CheckpointProvider = {
  id: 'object-store',
  version: '1.0.0',
  async create(init, signal) {
    return { snapshot, rewind, list }
  },
}

export const main = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(checkpointKind, '@example/checkpoint', checkpoint)
  },
}
```

Declare `main` and its `providers` injection in `package.json`'s `agnes.plugins`. A package can register only under its own name. The Host places its binding rows after every registration row, so a provider is always registered before it is selected.

`create(init, signal)` receives a `SeamInit`: `secrets`, an `adapters` view, a `profile` view that includes the active preset, `log` and `signal`. Bundled packages may receive a wider view; yours never does. The returned object may carry `close()`, which the Host calls when its container is torn down. The Host races `create` against a timer (`seamTimeoutMs`, 30 s by default) without trusting you to honour the signal; an instance that arrives after the timeout is closed at once.

Pinned kinds must be re-openable: after an idle container is reclaimed, `create` runs again and has to find the same durable state (ledger totals, checkpoints, stored artifacts). Do not assume in-process state survives. `principals.resolve` runs on the connection before a session is known, so it always uses the current implementation; `authorize` uses the one pinned for the session.

## Select an implementation

Profiles choose one provider per kind with a single syntax:

```yaml
seams:
  approval:   { provider: local-prompt }
  principals: { provider: local }
  billing:    { provider: budget }
  checkpoint: { provider: object-store, version: 1.0.0 }
  artifacts:  { provider: local }
  verifier:   { provider: t0 }
  repair:     { provider: default }
```

All seven keys are required. A selection that no installed package registers fails assembly with `E_SEAM_MISSING`; a factory that throws or hangs fails it with `E_SEAM_INIT`. Seams are never silently skipped or defaulted. The older package-id string form, `seams.ledger` (now `seams.billing`) and `seams.harness` (no longer a seam) are configuration errors that name the fix. Workspace configuration cannot write `seams`.
