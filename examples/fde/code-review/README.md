# Code review bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

An engineering team needs a reproducible first-pass patch review before a maintainer decides whether to merge.

**Workflow:** Git diff fixture → parallel lint-ish and risk nodes → DAG join → read-only report → model commentary.

fixtures/repo contains the pre-change synthetic source tree; change.patch is its standard unified git diff. No embedded .git directory is needed. tools.batch runs debug-log and dynamic-eval nodes independently, then joins src/handler.js:2 (low) and :3 (high) into needs-review. Added lines are inspected as text without executing code. The narrow scans are not a complete linter or security assessment.

## What ships

- Loop: `fde.code-review`, a staged workflow with versioned checkpoints and cancellation. Each independent tarball includes `runtime.mjs`.
- Tools: fixture connectors and transformations registered by `main` through the public author kit.
- Policy: `fde.code-review`, denying business-source writes even in full-access sessions.
- Skills: packaged `skills/playbook/SKILL.md`, registered and included in model requests.
- Bundle: `agnes.kinds` declares `bundle`; `agnes.bundles.code-review` composes the loop, Skill and preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from the [installation guide](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. Review source, dependencies and capabilities when installing. A fresh local-dev profile supplies keyless `demo/demo-model`; an existing profile needs that route or the real target below.

From the repository root:

```sh
cd examples/fde/code-review
agh plugins add .
agh run --bundle '@agnes-fde/code-review#code-review' --preset code-review --input fixtures/prompt.txt --json
agh serve
```

Run `npm pack` here to distribute a tarball and install it with `agh plugins add ./NAME.tgz`. Runtime, fixtures, Skill and any panel travel together, without workspace or sibling-example imports.

This read-only workflow completes headlessly. Inspect the report and evidence in JSONL tool results and assistant messages.

Web: open the serve URL, use **Admin → Plugins → Bundles**, select `@agnes-fde/code-review#code-review`, save and restart Host as requested. Start a new session with preset `code-review` and Demo model; paste `fixtures/prompt.txt`. Existing sessions keep their pinned loop. Inspect evidence and the trace.

This one-turn workflow uses fixed synthetic input: the prompt starts it, and fixture files define the business data. Built-in Demo does not reason. Tools produce the substantive fixture result; quick tests use scripted model replies. A real model adds draft commentary that never overrides citations, amounts, findings or approvals.

## Real model

Configure an AGH route/model, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to that configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset code-review --input fixtures/prompt.txt --json
```

The loop calls Core’s public `prepareRequest()`; Core resolves the session’s primary model, contracts and hashes. For Web, configure the equivalent preset primary route in profile composition and select that model for a new session. Keep credentials outside the bundle.

## Adapt for a customer

Replace fixture loading with an authorized repository reader. Preserve base/head revisions and exact file/line evidence. Add language-aware checks as independent DAG nodes, then join structured findings. Select a sandbox if customer checks need processes. A maintainer owns changes and merging; patch text must never change workflow policy.

Backend plugins are trusted in-process code; declarations support review rather than arbitrary-code isolation. A denied tool or failed model stops the workflow. Pending checkpoints refuse automatic replay: inspect evidence before starting another run. Simulation receipts are not durable customer ledgers.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Business-source mutation remains denied by the bundle policy.

Official `write` creates reports in `fde-output/code-review/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **2.0.0** uses checkpoint codec **2** for pending questions. Start a new session after upgrading; codec 1 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

TODO: adopt official Plan mode after Stream E2 merges; the example keeps its fixed staged/DAG workflow meanwhile.

## Quick test

After installing matching author-package tarballs from this revision into the directory:

```sh
npm run build
npm test
```

Own tests cover public loop/tool/policy contracts, fixture outcomes and the key refusal boundary. The [external harness](../README.md#verification) installs and tests this example outside the repository. These checks do not establish live-model quality, browser interaction or customer-system acceptance.
