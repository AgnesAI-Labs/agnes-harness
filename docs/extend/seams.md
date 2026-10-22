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
import { checkpointKind, type ProviderPluginContext } from '@agnes/extension-api'
import type { CheckpointProvider } from '@agnes/extension-api/seams'

const checkpoint: CheckpointProvider = {
  id: 'object-store',
  version: '1.0.0',
  async create(init, signal) {
    return { snapshot, rewind, list }
  },
}

export const main = {
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(checkpointKind, checkpoint)
  },
}
```

Declare `main` and its `providers` injection once, in `package.json`'s `agnes.plugins` entry (`inject`); the export carries no list of its own. A package can register only under its own name. The Host places its binding rows after every registration row, so a provider is always registered before it is selected.

`create(init, signal)` receives a `SeamInit`: `secrets`, an `adapters` view, a `profile` view that includes the active preset, `log` and `signal`. Bundled packages may receive a wider view; yours never does. The returned object may carry `close()`, which the Host calls when its container is torn down. The Host races `create` against a timer (`seamTimeoutMs`, 30 s by default) without trusting you to honour the signal; an instance that arrives after the timeout is closed at once.

Pinned kinds must be re-openable: after an idle container is reclaimed, `create` runs again and has to find the same durable state (ledger totals, checkpoints, stored artifacts). Do not assume in-process state survives. `principals.resolve` runs on the connection before a session is known, so it always uses the current implementation; `authorize` uses the one pinned for the session.

## Select an implementation

Profiles choose one provider per kind with a single syntax:

```yaml
providers:
  approval:   { provider: local-prompt }
  principals: { provider: local }
  billing:    { provider: budget }
  checkpoint: { provider: object-store, version: 1.0.0 }
  artifacts:  { provider: local }
  verifier:   { provider: t0 }
  repair:     { provider: default }
```

All seven keys are required. A selection that no installed package registers fails assembly with `E_SEAM_MISSING`; a factory that throws or hangs fails it with `E_SEAM_INIT`. Seams are never silently skipped or defaulted. These seven share the `providers` table with every other provider kind. The older package-id string form, the `seams` key (now `providers`), `ledger` (now `billing`) and `harness` (no longer a kind) are configuration errors that name the fix. Workspace configuration cannot write `providers`.

## Pinning, upgrades and resuming

`approval`, `principals`, `billing`, `checkpoint` and `artifacts` are pinned per session. A session records the provider id, version, source package and package integrity it was first bound to (the pin record, which carries a format version), and the generation it runs in records the selections it was built from. Changing `seams.*` or upgrading a provider package therefore reaches new sessions only; an existing session resumes on what it was bound to, even after a restart. `verifier` and `repair` follow the generation.

A session that cannot continue is refused in one of three directions, each with its own code, the session id and where its raw ledger lives:

| Code | Meaning | What you can do |
| --- | --- | --- |
| `E_SESSION_VERSION_NEWER` | Written by a newer AGH | Upgrade AGH |
| `E_SESSION_VERSION_OLDER` | Created with an older AGH, or its pinned provider, version or snapshot is gone (`E_SEAM_PIN_MISMATCH`, `E_GENERATION_INCOMPATIBLE`, ...) | Start a new session; an administrator can switch it to the current version |
| `E_SESSION_CORRUPT` | An integrity check failed | Start a new session; keep the raw ledger |

A refusal never changes the ledger or the pin. Switching a session to the current version is an explicit, audited action: `agh sessions migrate <key> <kind> ...` (or `repin: ["approval"]` on the admin call) lists the pinned kinds to replace; without it a migration that would swap a pinned implementation fails with `E_SEAM_PIN_CHANGE` and the differences.
