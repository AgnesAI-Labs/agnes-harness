# Operations runbook bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

An operator needs a bounded diagnostic and restart sequence with review before changes.

**Workflow:** Read runbook → diagnostic argv → approved synthetic restart → verify receipt.

The diagnostic uses official `shell` with background:true and follows the returned session-owned job ID with `job_output`. Polling is bounded; failure or incomplete output stops the runbook. A confirmed restart still uses a fixed synthetic argv through ToolContext.exec and the Host-selected sandbox. This bundle selects local; use a registered POSIX backend with argv confinement for background jobs. local/L0 can lack OS isolation. Use job_list/job_output/job_kill for an unfinished owned job; jobs end at session close and do not survive Host restart.

## What ships

- `main`: author-kit plugin registering business tools, `fde.ops-runbook` loop and policy, and the packaged Skill.
- `runtime.mjs`: a public-port loop with versioned checkpoints, cancellation and refusal on uncertain recovery. Every independent tarball includes this helper.
- `fixtures/`: synthetic business input; `skills/playbook/SKILL.md`: customer playbook registered and used in model prompts.
- The bundle kind is declared in `agnes.kinds`; `agnes.bundles.ops-runbook` selects the loop and supplies its preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from [installation](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. A fresh local-dev profile supplies keyless `demo/demo-model`. Existing configured profiles must retain that route or use the real-model configuration below. Review the source, dependencies and capabilities when installing; confirmation installs, trusts and enables the reviewed package.

Start from the repository root:

```sh
cd examples/fde/ops-runbook
agh plugins add .
agh run --bundle '@agnes-fde/ops-runbook#ops-runbook' --preset ops-runbook --input fixtures/prompt.txt --json
agh serve
```

For a portable package, run `npm pack` here and install the resulting tarball with `agh plugins add ./NAME.tgz`. Runtime, fixtures, playbook and any panel/MCP server travel together. No workspace imports or sibling examples are required.

An unattended run stops at the pending official question, or at a tool-permission request. Complete the business choice in the Web/TUI question card; an action still needs backend permission.

For Web, open the serve URL, then **Admin → Plugins → Bundles**. Select `@agnes-fde/ops-runbook#ops-runbook`, save and restart Host as requested. Start a new session with preset `ops-runbook` and Demo model; paste `fixtures/prompt.txt`. Existing sessions retain their pinned loop. Review the deliverable and official question card; cancellation or permission denial stops without a receipt.

This is a fixture workflow that parks for a human answer with fixed identifiers. The built-in Demo route makes no live inference; tools produce deterministic evidence and support/CRM drafts are scripted. Quick tests use scripted model replies. With a real model, tool evidence remains the same and model prose becomes live inference.

## Use a real model

Configure a real route/model in AGH, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to the configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset ops-runbook --input fixtures/prompt.txt --json
```

The loop uses Core’s public `prepareRequest()`; the session primary model supplies the route, contracts and hashes. For Web, configure the equivalent preset primary route and choose that real model for a new session. Keep keys outside this bundle.

## Adapt for a customer

Replace fixed argv with a reviewed service allowlist, diagnostics and receipt checks. Select and validate the sandbox before startup; keep arbitrary model-provided shell commands out.

Keep facts and approval in the backend. Ordinary plugins are trusted in-process code; declarations are review metadata, not process isolation. Denied tools, model errors and interrupted pending stages stop this example. Reconcile a pending checkpoint before starting a new run; it never automatically repeats an uncertain effect.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Before its action, `ask_user_question` presents Proceed/Cancel and parks with a persisted question ID. Only a validated ordinary user answer continues it; invalid answers keep it parked. This business choice does not grant tool permission.

Official `write` creates reports in `fde-output/ops-runbook/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **2.0.0** uses checkpoint codec **2** for pending questions. Start a new session after upgrading; codec 1 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

TODO: adopt official Plan mode after Stream E2 merges; the example keeps its fixed staged/DAG workflow meanwhile.

## Quick test

After installing matching author-package tarballs from this source revision into this directory:

```sh
npm run build
npm test
```

Tests drive public loop/tool contracts with fixed model replies and check results and refusal boundaries. The runbook test supplies a fake exec port; it does not verify OS sandbox confinement. See [external verification](../README.md#verification) for the repository harness command.
