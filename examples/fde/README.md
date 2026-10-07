# FDE bundles: business delivery with AGH

English | [简体中文](README.zh-CN.md) · [Why AGH](../../docs/guide/why-agh.md)

A forward-deployed engineer ships a workflow, connectors, a reviewed policy and a playbook together. Each directory below is an independent installable **bundle**, using only public contracts and the author kit. The examples use synthetic data and local simulators, so a team can explore the delivery workflow without credentials.

| Bundle | Business result | Control point |
| --- | --- | --- |
| [Support triage](support-triage/README.md) | Ticket lookup → classification → draft → human approval → simulated send receipt. | Human approval before action |
| [Contract review](contract-review/README.md) | Split clauses → parallel review nodes → aggregate markdown report → model commentary. | Read-only policy |
| [Data report](data-report/README.md) | Read CSV → compute totals and margin → markdown/HTML with SVG charts → model commentary. | Read-only policy |
| [Operations runbook](ops-runbook/README.md) | Read runbook → official background diagnostic job → question → authorized synthetic restart → verify receipt. | Business choice and tool permission |
| [CRM assistant](crm-assistant/README.md) | Local MCP lookup → Skills renewal playbook → note draft → approval → idempotent simulated note. | Human approval before action |
| [Device inspection](device-inspection/README.md) | Read status → detect anomaly → human confirmation → constrained action → receipt and state verification. | Human approval before action |
| [Knowledge QA](knowledge-qa/README.md) | Local documents → retrieved quotes → cited answer or refusal → model commentary. | No source means refusal; read-only retrieval |
| [Meeting actions](meeting-actions/README.md) | Transcript → summary, decisions, owners/dates → markdown and panel → simulated send. | Human approval before sending |
| [Code review](code-review/README.md) | Git diff fixture → parallel lint-ish/risk checks → joined review report. | Read-only DAG |
| [Finance reconciliation](finance-reconcile/README.md) | Bank/book CSV → exact-cent mismatches → adjusting-entry drafts. | Human approval; unresolved evidence stays open |
| [Recruiting screen](recruiting-screen/README.md) | Minimized resumes → rubric evidence and unknowns → human follow-up. | Human decision; job-skill evidence only |
| [Compliance audit](compliance-audit/README.md) | Checklist → evidence checks → findings with severity and source links. | Read-only; missing evidence stays a gap |

## Start a delivery

Build `agh` from the [installation guide](../../docs/guide/install.md). Open an example README, run `agh plugins add .` inside that directory, then select its installed bundle through `agh run --bundle PACKAGE#NAME` or Web’s **Admin → Plugins → Bundles** panel. Each README gives the preset, prompt, model target and expected result. Web bundle changes need a Host restart and a new session.

The keyless Demo route is supplied by a fresh local-dev profile. Tool evidence and support/CRM drafts are fixtures; Demo does not perform real reasoning. An existing deployment needs that route or a configured real model. Every example uses Core-prepared requests and the session primary model; `real-model.bundle.json` configures the preset primary route.

Sending, CRM notes, runbook restarts, device actions, adjusting entries and recruiting follow-up present a draft and call official `ask_user_question`. A persisted Proceed/Cancel question parks the workflow; a validated user answer resumes it. Tool authorization remains separate, and unavailable permissions still refuse actions. Use Web/TUI for the business choice. Evidence-only bundles complete headlessly, allowing generated output writes while denying source mutation. Demo outputs remain deterministic; real-model commentary is a review draft.

All twelve bundles use official `write` and `present` for bounded report files and standard artifact Open/Download cards. The meeting panel renders action evidence without a custom download path. Knowledge QA optionally uses `web_search` for an explicitly configured public query; private questions/documents remain local. Operations use official `shell` background jobs and `job_output`; operators can inspect/stop owned jobs with `job_list`/`job_kill`. See [official default tools](../../docs/reference/default-tools.md) for deployment capabilities and limits. Existing profiles must admit the question/deliverable projection capability.

Loop version 3.0.0/checkpoint codec 3 stores pending questions and native single-call approval continuations; use a new session after upgrading. Old checkpoints fail closed.

Enable official Plan mode with `/plan on` in Web/TUI **before submitting a fresh task**. The loop detects the public plan-mode prompt section and submits its fixed business steps with `exit_plan_mode`. The official approval card must be approved before connectors, reports or commands run. A denied plan stops the workflow; an inactive plan mode skips this gate. The example policy preserves the shipped default policy's plan-mode denials. Plan approval does not replace a later business question or tool permission. Native single-call tickets resume through public continuation ports and the original invocation receipt; an unknown receipt blocks replay.

## From example to customer

Keep the reusable loop and replace the fixture connectors, business rubric and `SKILL.md`. Decide which data the customer can expose, which actions need a person and which receipts establish success. For operations, select a registered sandbox provider before startup. For devices, keep units, action bounds and physical safety in the validated controller/adapter; the example is MHS-inspired and claims no MHS compatibility.

The small loop helper is included in each tarball so packages have no sibling imports. Ordinary backend plugins are trusted in-process code. Capability declarations support installation review and policy, not arbitrary-code isolation. Checkpoints refuse automatic replay of pending effects; simulation receipts are not a durable production device/CRM ledger.

## Verification

Use the pinned Node/pnpm versions in the repository. The external harness builds author tarballs once, copies selected examples outside the repository, installs real dependencies, checks declared imports, builds and runs each example’s own quick tests:

```sh
node --import tsx tools/release/external-examples.ts --author-only \
  --example examples/fde/knowledge-qa \
  --example examples/fde/meeting-actions \
  --example examples/fde/code-review \
  --example examples/fde/finance-reconcile \
  --example examples/fde/recruiting-screen \
  --example examples/fde/compliance-audit
```

Repeat `--example` to include any of the twelve bundles. `--author-only` skips packaging the full CLI; it verifies author contracts and example workflows, not a browser or complete distribution. Quick tests use scripted official tool ports, model replies and artifact receipts; they cover pending/invalid/cancelled answers and retained tool-permission denial. The CRM/device tests include short actual stdio MCP processes and use `.e2e.test.mjs`. Runbook job ports and its restart executor are fixtures, so they do not prove OS confinement or real background cleanup. Each directory’s `npm run build` and `npm test` work independently with matching author tarballs. Vitest is a test-only dependency required by the public conformance testkit.

No real-model quality, customer API, physical device or cross-platform acceptance is implied by these fixtures.
