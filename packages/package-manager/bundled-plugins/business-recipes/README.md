# Business recipes

English | [简体中文](README.zh-CN.md)

`@agnes/business-recipes` is an official **optional, disabled-by-default** discovery plugin. It contributes a profile home entry and no session tools. Install, review, trust and enable it in the built-in Plugins catalogue. Agent FDE then offers a **Business recipes** link; the sidebar opens the same page. Removing or disabling the plugin releases its entry, locale registrations and subscriptions.

The page curates three independently installed and pinned packages:

| Recipe | Synthetic input | Output example |
| --- | --- | --- |
| `@agnes-recipe/support-intake` | `ticket-104` | P2 support routing and a reply draft |
| `@agnes-recipe/invoice-review` | `invoice-207` | Invoice 120 versus ledger 100; discrepancy 20 |
| `@agnes-recipe/meeting-brief` | `meeting-309` | Morgan reviews the pilot checklist, due 2026-11-02 |

Choose a listed fixture and English or Simplified Chinese. Inputs map to immutable `metadata.launches` declarations; no free-text interpolation selects a source, model, permission or arbitrary bundle. Each recipe needs the configured `standard` primary model route, adds one read-only fixture tool and a Skill only to its bundle, and produces a conversation draft. There are no customer-system connectors, filesystem writes, uploads, message sends or task creation. Model responses are review drafts, not evidence that business actions happened.

1. Open the page; check **Not installed**, **Installed · not trusted**, **Trusted · disabled**, or **Ready**. Older servers without a trust field show **Trust unknown · review required**.
2. Select **Review package**. Read the version, integrity, declared permissions and capability hash. Only **Confirm install, trust and enable** changes package state.
3. Select the input and language, then **Review launch**. Read the exact bundle, preset and JSON prompt returned by the backend.
4. Select **Start this reviewed run**. Normal model admission and charges apply. Open the resulting session to inspect the draft and trace.
5. If a reply is lost, **Check operation receipt** before retrying. Retries retain the same ticket and operation ID. Unknown outcomes are never automatically replayed. Closing a review detaches it; it does not cancel an already admitted session.

The host's existing example facade owns review expiry, parent dependency/trust checks, bundle/preset validation, session and durable input idempotency. No administration transport or new registry is introduced. Missing model/configuration requires fixing Models & accounts or Plugins and preparing a fresh review. Disabled dependencies invalidate launch authority immediately; refresh shows the current child state. Previously saved sessions retain their backend snapshot across upgrades; current UI does not replace their code. No G0 contract is needed.

See the [guide](../../../../docs/guide/business-recipes.md). Offline unit fixtures cover validation, fake model success/failure, cancellation, lost replies and cleanup; real-model quality, browser layout and release packaging remain separate integration checks.

Run the synthetic walkthrough from the repository root, without model accounts or keys:

```sh
pnpm exec vitest run packages/package-manager/bundled-plugins/business-recipes/test/recipes.test.ts --project fast --maxWorkers=1
```
