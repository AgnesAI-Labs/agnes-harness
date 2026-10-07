# CRM assistant bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

An account owner needs renewal follow-up grounded in CRM health and open tickets.

**Workflow:** Local MCP lookup → Skills renewal playbook → note draft → approval → idempotent simulated note.

The connector lazily starts the bundled stdio MCP server, forwards cancellation and closes it on unload. Notes are process-local. No external CRM is contacted. The packaged Skill is registered and included in model prompts.

## What ships

- `main`: author-kit plugin registering business tools, `fde.crm-assistant` loop and policy, and the packaged Skill.
- `runtime.mjs`: a public-port loop with versioned checkpoints, cancellation and refusal on uncertain recovery. Every independent tarball includes this helper.
- `fixtures/`: synthetic business input; `skills/playbook/SKILL.md`: customer playbook registered and used in model prompts.
- The bundle kind is declared in `agnes.kinds`; `agnes.bundles.crm-assistant` selects the loop and supplies its preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from [installation](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. A fresh local-dev profile supplies keyless `demo/demo-model`. Existing configured profiles must retain that route or use the real-model configuration below. Review the source, dependencies and capabilities when installing; confirmation installs, trusts and enables the reviewed package.

Start from the repository root:

```sh
cd examples/fde/crm-assistant
agh plugins add .
agh run --bundle '@agnes-fde/crm-assistant#crm-assistant' --preset crm-assistant --input fixtures/prompt.txt --json
agh serve
```

For a portable package, run `npm pack` here and install the resulting tarball with `agh plugins add ./NAME.tgz`. Runtime, fixtures, playbook and any panel/MCP server travel together. No workspace imports or sibling examples are required.

An unattended run stops at the pending official question, or at a tool-permission request. Complete the business choice in the Web/TUI question card; an action still needs backend permission.

For Web, open the serve URL, then **Admin → Plugins → Bundles**. Select `@agnes-fde/crm-assistant#crm-assistant`, save and restart Host as requested. Start a new session with preset `crm-assistant` and Demo model; paste `fixtures/prompt.txt`. Existing sessions retain their pinned loop. Review the deliverable and official question card; cancellation or permission denial stops without a receipt.

This is a fixture workflow that parks for a human answer with fixed identifiers. The built-in Demo route makes no live inference; tools produce deterministic evidence and support/CRM drafts are scripted. Quick tests use scripted model replies. With a real model, tool evidence remains the same and model prose becomes live inference.

## Use a real model

Configure a real route/model in AGH, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to the configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset crm-assistant --input fixtures/prompt.txt --json
```

The loop uses Core’s public `prepareRequest()`; the session primary model supplies the route, contracts and hashes. For Web, configure the equivalent preset primary route and choose that real model for a new session. Keep keys outside this bundle.

## Adapt for a customer

Replace the MCP endpoint and account fields, revise the playbook and retain secrets in deployment bindings. Add durable idempotency and receipt lookup before real writes.

Keep facts and approval in the backend. Ordinary plugins are trusted in-process code; declarations are review metadata, not process isolation. Denied tools, model errors and interrupted pending stages stop this example. Reconcile a pending checkpoint before starting a new run; it never automatically repeats an uncertain effect.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Before its action, `ask_user_question` presents Proceed/Cancel and parks with a persisted question ID. Only a validated ordinary user answer continues it; invalid answers keep it parked. This business choice does not grant tool permission.

Official `write` creates reports in `fde-output/crm-assistant/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **3.0.0** uses checkpoint codec **3** for pending questions. Start a new session after upgrading; codec 1/2 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

Enable official Plan mode with `/plan on` in Web/TUI **before submitting a fresh task**. The loop detects the public plan-mode prompt section and submits its fixed business steps with `exit_plan_mode`. The official approval card must be approved before connectors, reports or commands run. A denied plan stops the workflow; an inactive plan mode skips this gate. The example policy preserves the shipped default policy's plan-mode denials. Plan approval does not replace a later business question or tool permission. Native single-call tickets resume through public continuation ports and the original invocation receipt; an unknown receipt blocks replay.

The bundled SDK connector calls raw MCP server tool names (lookup / note). These are not Host aliases. When adapting to a Host-configured server with ID `crm`, use the canonical public names `mcp__crm__lookup`, `mcp__crm__note` in loop calls and allowlists; inspect the catalog for sanitized/collision-suffixed names. Do not carry old hashed `mcp_...` aliases into a new customer integration. Official `list_mcp_resources` / `read_mcp_resource` are available for servers exposing resources; this fixture exposes tools only.

## Quick test

After installing matching author-package tarballs from this source revision into this directory:

```sh
npm run build
npm test
```

Tests drive public loop/tool contracts with fixed model replies and check results and refusal boundaries. The short .e2e.test.mjs test also starts and closes the actual local MCP stdio fixture. See [external verification](../README.md#verification) for the repository harness command.
