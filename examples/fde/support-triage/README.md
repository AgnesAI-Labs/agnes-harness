# Support triage bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

A support lead needs consistent incident routing and a reviewable customer reply.

**Workflow:** Ticket lookup → classification → draft → human approval → simulated send receipt.

The triage panel shows ticket, classification and send status in the public tool-result slot. No email is delivered.

## What ships

- `main`: author-kit plugin registering business tools, `fde.support-triage` loop and policy, and the packaged Skill.
- `runtime.mjs`: a public-port loop with versioned checkpoints, cancellation and refusal on uncertain recovery. Every independent tarball includes this helper.
- `fixtures/`: synthetic business input; `skills/playbook/SKILL.md`: customer playbook registered and used in model prompts.
- The bundle kind is declared in `agnes.kinds`; `agnes.bundles.support-triage` selects the loop and supplies its preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from [installation](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. A fresh local-dev profile supplies keyless `demo/demo-model`. Existing configured profiles must retain that route or use the real-model configuration below. Review the source, dependencies and capabilities when installing; confirmation installs, trusts and enables the reviewed package.

Start from the repository root:

```sh
cd examples/fde/support-triage
agh plugins add .
agh run --bundle '@agnes-fde/support-triage#support-triage' --preset support-triage --input fixtures/prompt.txt --json
agh serve
```

For a portable package, run `npm pack` here and install the resulting tarball with `agh plugins add ./NAME.tgz`. Runtime, fixtures, playbook and any panel/MCP server travel together. No workspace imports or sibling examples are required.

Headless agh run rejects permission requests and stops before the write. This is the expected unattended result. Complete the workflow in Web to approve or deny the exact action.

For Web, open the serve URL, then **Admin → Plugins → Bundles**. Select `@agnes-fde/support-triage#support-triage`, save and restart Host as requested. Start a new session with preset `support-triage` and Demo model; paste `fixtures/prompt.txt`. Existing sessions retain their pinned loop. Review the approval card; denial stops without a receipt.

This is a one-turn fixture workflow with fixed identifiers. The built-in Demo route makes no live inference; tools produce deterministic evidence and support/CRM drafts are scripted. Quick tests use scripted model replies. With a real model, tool evidence remains the same and model prose becomes live inference.

## Use a real model

Configure a real route/model in AGH, then edit both the plugin target and preset primary route in [real-model.bundle.json](real-model.bundle.json) to that same pair:

```sh
agh run --bundle ./real-model.bundle.json --preset support-triage --input fixtures/prompt.txt --json
```

The loop uses explicit `target`; client model selection alone does not change it. For Web, apply equivalent target config to this plugin row in the user profile composition and choose that real model for a new session. Keep keys outside this bundle.

## Adapt for a customer

Replace the helpdesk connectors, escalation categories, SLA and templates. Keep the exact draft in approval arguments and verify delivery receipts.

Keep facts and approval in the backend. Ordinary plugins are trusted in-process code; declarations are review metadata, not process isolation. Denied tools, model errors and interrupted pending stages stop this example. Reconcile a pending checkpoint before starting a new run; it never automatically repeats an uncertain effect.

## Quick test

After installing matching author-package tarballs from this source revision into this directory:

```sh
npm run build
npm test
```

Tests drive public loop/tool contracts with fixed model replies and check results and refusal boundaries.  See [external verification](../README.md#verification) for the repository harness command.
