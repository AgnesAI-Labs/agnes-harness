# Finance reconciliation bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

A finance operator compares bank and book ledgers and reviews proposed adjusting entries before recording them.

**Workflow:** Two CSV ledgers → exact-cent matching → mismatches and proposals → approval → simulated balanced entries.

TX-1 matches; TX-2 differs by 5000 cents; bank-only TX-3 is 7525 cents; book-only TX-4 stays unresolved. Book-only and date-mismatched transactions get no automatic proposal. Duplicate IDs refuse reconciliation. The intentionally narrow CSV format requires unquoted fields, ISO dates and USD amounts with two decimals. Approved proposals have opposite signed cash/review-suspense legs and posted: false. Real accounts are never changed.

## What ships

- Loop: `fde.finance-reconcile`, a staged workflow with versioned checkpoints and cancellation. Each independent tarball includes `runtime.mjs`.
- Tools: fixture connectors and transformations registered by `main` through the public author kit.
- Policy: `fde.finance-reconcile`, requiring human approval for every decision/send action.
- Skills: packaged `skills/playbook/SKILL.md`, registered and included in model requests.
- Bundle: `agnes.kinds` declares `bundle`; `agnes.bundles.finance-reconcile` composes the loop, Skill and preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from the [installation guide](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. Review source, dependencies and capabilities when installing. A fresh local-dev profile supplies keyless `demo/demo-model`; an existing profile needs that route or the real target below.

From the repository root:

```sh
cd examples/fde/finance-reconcile
agh plugins add .
agh run --bundle '@agnes-fde/finance-reconcile#finance-reconcile' --preset finance-reconcile --input fixtures/prompt.txt --json
agh serve
```

Run `npm pack` here to distribute a tarball and install it with `agh plugins add ./NAME.tgz`. Runtime, fixtures, Skill and any panel travel together, without workspace or sibling-example imports.

The draft appears as one preset surface in both the conversation and workbench: a differences table, amount chart and adjustment form. Review and choose **确认调整**; the backend then requests permission for the simulated adjustment tool. Refresh restores the same review and pending receipt. Unattended runs stop at this interactive boundary. TUI/channel users receive a text summary and workbench link.

Web: open the serve URL, use **Admin → Plugins → Bundles**, select `@agnes-fde/finance-reconcile#finance-reconcile`, save and restart Host as requested. Start a new session with preset `finance-reconcile` and Demo model; paste `fixtures/prompt.txt`. Existing sessions keep their pinned loop. Inspect evidence and the trace.

This workflow uses fixed synthetic input: the prompt starts it, and fixture files define the business data. Built-in Demo does not reason. Tools produce the substantive fixture result; quick tests use scripted model replies. A real model adds draft commentary that never overrides citations, amounts, findings or approvals.

## Real model

Configure an AGH route/model, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to that configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset finance-reconcile --input fixtures/prompt.txt --json
```

The loop calls Core’s public `prepareRequest()`; Core resolves the session’s primary model, contracts and hashes. For Web, configure the equivalent preset primary route in profile composition and select that model for a new session. Keep credentials outside the bundle.

## Adapt for a customer

Replace fixtures with authorized ledger connectors. Agree on keys, signs, currencies and tolerances with the customer accountant. Use a real CSV parser for quoted fields and validated precision for other currencies. Resolve ambiguous matches and account mappings before posting. An approved idempotent connector must verify the ledger receipt; model prose never determines amounts.

Backend plugins are trusted in-process code; declarations support review rather than arbitrary-code isolation. A denied tool or failed model stops the workflow. Pending checkpoints refuse automatic replay: inspect evidence before starting another run. Simulation receipts are not durable customer ledgers.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md) and `agnes/intelligent-ui`. The business plugin declares the review with `ui_render`. Its button maps to `fde_finance_approve`; the UI confirmation grants no tool permission. Both the default Loop and finance Loop drain the same public deferred-invocation contract. Terminal results arrive through SC1, then the Agent calls `ui_update` to mark processed rows while keeping unresolved transactions visible.

Official `write` creates reports in `fde-output/finance-reconcile/<run-hash>/`; `present` copies final outputs into session artifacts for the standard Open/Download card. The policy allows report writes only at this bounded path, retaining the observation/stale-write guard. Output paths are relative to the session workspace, with declared manifest read/write scope.

Loop version **4.0.0** uses checkpoint codec **4** for business evidence, SC1 input and processed transaction ids. Start a new session after upgrading; older codecs are refused. Business validation checks committed proposals, exact amounts, unique ids and already processed rows before tool dispatch. Model selection comes from the preset primary route. The written scripted-model tests use the real isolated Host, approval path and UI plugin; they have not been run during this development window.

Enable official Plan mode with `/plan on` in Web/TUI **before submitting a fresh task**. The loop detects the public plan-mode prompt section and submits its fixed business steps with `exit_plan_mode`. The official approval card must be approved before connectors, reports or commands run. A denied plan stops the workflow; an inactive plan mode skips this gate. The example policy preserves the shipped default policy's plan-mode denials. Plan approval does not replace a later UI confirmation or tool permission. Native single-call tickets resume through public continuation ports and the original invocation receipt; an unknown receipt blocks replay.

## Quick test

After installing matching author-package tarballs from this revision into the directory:

```sh
npm run build
npm test
```

Own tests cover public loop/tool/policy contracts, fixture outcomes and the key refusal boundary. The [external harness](../README.md#verification) installs and tests this example outside the repository. These checks do not establish live-model quality, browser interaction or customer-system acceptance.
