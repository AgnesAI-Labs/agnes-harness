# Contract review bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

A procurement reviewer needs clause evidence and an aggregated risk draft.

**Workflow:** Split clauses → parallel review nodes → aggregate markdown report → model commentary.

This fixed DAG uses LoopContext.tools.batch for independent reviews and a join stage. The policy denies business-source writes even in full-access sessions. The fixture rubric produces a draft for a qualified reviewer.

## What ships

- `main`: author-kit plugin registering business tools, `fde.contract-review` loop and policy, and the packaged Skill.
- `runtime.mjs`: a public-port loop with versioned checkpoints, cancellation and refusal on uncertain recovery. Every independent tarball includes this helper.
- `fixtures/`: synthetic business input; `skills/playbook/SKILL.md`: customer playbook registered and used in model prompts.
- The bundle kind is declared in `agnes.kinds`; `agnes.bundles.contract-review` selects the loop and supplies its preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from [installation](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. A fresh local-dev profile supplies keyless `demo/demo-model`. Existing configured profiles must retain that route or use the real-model configuration below. Review the source, dependencies and capabilities when installing; confirmation installs, trusts and enables the reviewed package.

Start from the repository root:

```sh
cd examples/fde/contract-review
agh plugins add .
agh run --bundle '@agnes-fde/contract-review#contract-review' --preset contract-review --input fixtures/prompt.txt --json
agh serve
```

For a portable package, run `npm pack` here and install the resulting tarball with `agh plugins add ./NAME.tgz`. Runtime, fixtures, playbook and any panel/MCP server travel together. No workspace imports or sibling examples are required.

This read-only workflow completes headlessly. Inspect the report in JSONL tool results and assistant messages.

For Web, open the serve URL, then **Admin → Plugins → Bundles**. Select `@agnes-fde/contract-review#contract-review`, save and restart Host as requested. Start a new session with preset `contract-review` and Demo model; paste `fixtures/prompt.txt`. Existing sessions retain their pinned loop. Inspect the report and trace.

This is a one-turn fixture workflow with fixed identifiers. The built-in Demo route makes no live inference; tools produce deterministic evidence and support/CRM drafts are scripted. Quick tests use scripted model replies. With a real model, tool evidence remains the same and model prose becomes live inference.

## Use a real model

Configure a real route/model in AGH, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to the configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset contract-review --input fixtures/prompt.txt --json
```

The loop uses Core’s public `prepareRequest()`; the session primary model supplies the route, contracts and hashes. For Web, configure the equivalent preset primary route and choose that real model for a new session. Keep keys outside this bundle.

## Adapt for a customer

Replace extraction and the risk rubric with customer terms and jurisdiction; preserve clause IDs and evidence. Add read-only retrieval through the author kit.

Keep facts and approval in the backend. Ordinary plugins are trusted in-process code; declarations are review metadata, not process isolation. Denied tools, model errors and interrupted pending stages stop this example. Reconcile a pending checkpoint before starting a new run; it never automatically repeats an uncertain effect.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Business-source mutation remains denied by the bundle policy.

Official `write` creates reports in `fde-output/contract-review/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **2.0.0** uses checkpoint codec **2** for pending questions. Start a new session after upgrading; codec 1 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

TODO: adopt official Plan mode after Stream E2 merges; the example keeps its fixed staged/DAG workflow meanwhile.

## Quick test

After installing matching author-package tarballs from this source revision into this directory:

```sh
npm run build
npm test
```

Tests drive public loop/tool contracts with fixed model replies and check results and refusal boundaries.  See [external verification](../README.md#verification) for the repository harness command.
