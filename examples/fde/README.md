# FDE bundles: business delivery with AGH

English | [简体中文](README.zh-CN.md) · [Why AGH](../../docs/guide/why-agh.md)

A forward-deployed engineer ships a workflow, connectors, a reviewed policy and a playbook together. Each directory below is an independent installable **bundle**, using only public contracts and the author kit. The examples use synthetic data and local simulators, so a team can explore the delivery workflow without credentials.

| Bundle | Business result | Control point |
| --- | --- | --- |
| [Support triage](support-triage/README.md) | Ticket lookup → classification → draft → human approval → simulated send receipt. | Human approval before action |
| [Contract review](contract-review/README.md) | Split clauses → parallel review nodes → aggregate markdown report → model commentary. | Read-only policy |
| [Data report](data-report/README.md) | Read CSV → compute totals and margin → markdown/HTML with SVG charts → model commentary. | Read-only policy |
| [Operations runbook](ops-runbook/README.md) | Read runbook → diagnostic argv → approved synthetic restart → verify receipt. | Human approval before action |
| [CRM assistant](crm-assistant/README.md) | Local MCP lookup → Skills renewal playbook → note draft → approval → idempotent simulated note. | Human approval before action |
| [Device inspection](device-inspection/README.md) | Read status → detect anomaly → human confirmation → constrained action → receipt and state verification. | Human approval before action |

## Start a delivery

Build `agh` from the [installation guide](../../docs/guide/install.md). Open an example README, run `agh plugins add .` inside that directory, then select its installed bundle through `agh run --bundle PACKAGE#NAME` or Web’s **Admin → Plugins → Bundles** panel. Each README gives the preset, prompt, model target and expected result. Web bundle changes need a Host restart and a new session.

The keyless Demo route is supplied by a fresh local-dev profile. Tool evidence and support/CRM drafts are fixtures; Demo does not perform real reasoning. An existing deployment needs that route or a configured real model, and each example includes `real-model.bundle.json` to show explicit loop target configuration.

Headless runs deliberately refuse approval requests. Support sending, CRM notes, runbook restarts and device actions reach the approval boundary in CLI; finish them in Web. The own tests exercise both approval and denial without real customer effects. Contract review and data reporting finish headlessly.

## From example to customer

Keep the reusable loop and replace the fixture connectors, business rubric and `SKILL.md`. Decide which data the customer can expose, which actions need a person and which receipts establish success. For operations, select a registered sandbox provider before startup. For devices, keep units, action bounds and physical safety in the validated controller/adapter; the example is MHS-inspired and claims no MHS compatibility.

The small loop helper is included in each tarball so packages have no sibling imports. Ordinary backend plugins are trusted in-process code. Capability declarations support installation review and policy, not arbitrary-code isolation. Checkpoints refuse automatic replay of pending effects; simulation receipts are not a durable production device/CRM ledger.

## Verification

Use the pinned Node/pnpm versions in the repository. The external harness builds author tarballs once, copies selected examples outside the repository, installs real dependencies, checks declared imports, builds and runs each example’s own quick tests:

```sh
node --import tsx tools/release/external-examples.ts --author-only \
  --example examples/fde/contract-review \
  --example examples/fde/data-report
```

Repeat `--example` to include any of the six bundles. `--author-only` skips packaging the full CLI; it verifies author contracts and example workflows, not a browser or complete distribution. The CRM/device quick tests include short actual stdio MCP processes and use the `.e2e.test.mjs` filename. Runbook tests inject a fake execution port and do not prove OS confinement. Each directory’s `npm run build` and `npm test` also work independently when the matching author tarballs are installed.

No real-model quality, customer API, physical device or cross-platform acceptance is implied by these fixtures.
