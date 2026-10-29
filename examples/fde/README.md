# Developer teaching examples

English | [简体中文](README.zh-CN.md)

Five independently installable teaching plugins cover one mechanism each, using synthetic data. They are not industry products, and the gallery shows no placeholder cards for applications a build does not ship.

| Example | Mechanism | Why retained |
| --- | --- | --- |
| [Knowledge QA](knowledge-qa/README.md) | Tools, citations and refusal without evidence | Small read-only retrieval contract with refusal tests |
| [Finance reconciliation](finance-reconcile/README.md) | Tools and interactive panel | Exact cents, real Host policy, denied data sources and structured action receipts |
| [Support triage](support-triage/README.md) | Approval-gated action | Draft, durable question and simulated send; reused by mechanism demos |
| [Data report](data-report/README.md) | Deliverable/report | Calculated totals, Markdown/HTML charts and official Open/Download cards |
| [Operations inspection](ops-runbook/README.md) | Scheduled automation | Background diagnostic and inspection report; interactive remediation requests separate approval |

## Install and run

Build the CLI using the [installation guide](../../docs/guide/install.md). Run `agh plugins add .` from an example directory, review permissions and enable it. Choose its installed agent on **Agents**, or run `agh --new --agent PACKAGE#NAME -p "task"`. Teaching packages are not promoted in the gallery, empty-session suggestions or onboarding. Developers install these packages by source path; the backend catalog remains complete for inspection. Installation never starts a session.

Every Bundle declares its own `launch` and preset and inherits the deployment's primary model. Launch review shows model, permissions, sources and an editable draft. Confirmation creates an empty session and fills the composer; Send executes it. Keyless Demo is deterministic teaching; each package's `real-model.bundle.json` selects a real model without storing credentials.

## Trust and verification

All five examples use public `defineWorkflowLoop` from `@agnes/plugin-runtime`, without sibling imports. Support sends and interactive restarts use `ask_user_question`; tool authorization remains separate. Finance consumes structured review receipts; unknown effects are never automatically replayed. Official `write` / `present` publish bounded reports. Operations uses `shell` / `job_output`; its README covers inspection mode and scheduling. Knowledge QA keeps refusal without evidence and optional public research; private documents never become public search queries.

Backend plugins are trusted in-process code. Capability declarations support review and policy, not arbitrary-code isolation. Loop 5.0.0 uses official checkpoint codec 1; old checkpoints fail closed, so create new sessions after upgrading. Official `/plan on` approval precedes business execution and does not replace business questions or tool permissions.

From the repository root:

```sh
pnpm exec vitest run --config examples/fde/vitest.config.mjs --maxWorkers=1
pnpm release:external-examples --author-only \
  --example examples/fde/knowledge-qa \
  --example examples/fde/finance-reconcile \
  --example examples/fde/support-triage \
  --example examples/fde/data-report \
  --example examples/fde/ops-runbook
```

Use the pinned repository toolchain entry for development checks. External author tests verify installed dependencies, public imports and each example's own tests. They do not establish real-model quality, production connectors or cross-platform acceptance. Background job tests use fixtures; browser sweep coverage is described in the [demo guide](../../docs/guide/demos.md).
