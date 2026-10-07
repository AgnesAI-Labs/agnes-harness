# Recruiting screen bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

A recruiting coordinator prepares consistent job-skill evidence and visible unknowns for a human reviewer.

**Workflow:** Resume fixtures → minimize data → rubric evidence review → bias-safety notes → human-confirmed follow-up.

The rubric weights API integration (4), incident analysis (3) and technical writing (3). CAND-1 has evidence for 7/10; CAND-2 for 3/10. Missing evidence means unknown, not inability. Name, age, gender and school are stripped before scoring and model prompts. All candidates remain in human follow-up. The simulation never hires or rejects anyone; the score is not a fairness certification or validated hiring predictor.

## What ships

- Loop: `fde.recruiting-screen`, a staged workflow with versioned checkpoints and cancellation. Each independent tarball includes `runtime.mjs`.
- Tools: fixture connectors and transformations registered by `main` through the public author kit.
- Policy: `fde.recruiting-screen`, requiring human approval for every decision/send action.
- Skills: packaged `skills/playbook/SKILL.md`, registered and included in model requests.
- Bundle: `agnes.kinds` declares `bundle`; `agnes.bundles.recruiting-screen` composes the loop, Skill and preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from the [installation guide](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. Review source, dependencies and capabilities when installing. A fresh local-dev profile supplies keyless `demo/demo-model`; an existing profile needs that route or the real target below.

From the repository root:

```sh
cd examples/fde/recruiting-screen
agh plugins add .
agh run --bundle '@agnes-fde/recruiting-screen#recruiting-screen' --preset recruiting-screen --input fixtures/prompt.txt --json
agh serve
```

Run `npm pack` here to distribute a tarball and install it with `agh plugins add ./NAME.tgz`. Runtime, fixtures, Skill and any panel travel together, without workspace or sibling-example imports.

The draft is presented before the official question parks the workflow. Unattended runs stop for a question or unavailable tool permission. Answer in Web/TUI, then grant the action permission if requested; cancellation records no action receipt.

Web: open the serve URL, use **Admin → Plugins → Bundles**, select `@agnes-fde/recruiting-screen#recruiting-screen`, save and restart Host as requested. Start a new session with preset `recruiting-screen` and Demo model; paste `fixtures/prompt.txt`. Existing sessions keep their pinned loop. Inspect evidence and the trace.

This workflow uses fixed synthetic input: the prompt starts it, and fixture files define the business data. Built-in Demo does not reason. Tools produce the substantive fixture result; quick tests use scripted model replies. A real model adds draft commentary that never overrides citations, amounts, findings or approvals.

## Real model

Configure an AGH route/model, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to that configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset recruiting-screen --input fixtures/prompt.txt --json
```

The loop calls Core’s public `prepareRequest()`; Core resolves the session’s primary model, contracts and hashes. For Web, configure the equivalent preset primary route in profile composition and select that model for a new session. Keep credentials outside the bundle.

## Adapt for a customer

Use authorized minimized resumes and a customer-reviewed job-related rubric. Validate evidence quotes and apply consistent accessible follow-up to every candidate. Review feature proxies, retention, consent and the customer hiring process. A person owns final hiring decisions and records rationale through an approved system.

Backend plugins are trusted in-process code; declarations support review rather than arbitrary-code isolation. A denied tool or failed model stops the workflow. Pending checkpoints refuse automatic replay: inspect evidence before starting another run. Simulation receipts are not durable customer ledgers.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Before its action, `ask_user_question` presents Proceed/Cancel and parks with a persisted question ID. Only a validated ordinary user answer continues it; invalid answers keep it parked. This business choice does not grant tool permission.

Official `write` creates reports in `fde-output/recruiting-screen/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **2.0.0** uses checkpoint codec **2** for pending questions. Start a new session after upgrading; codec 1 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

TODO: adopt official Plan mode after Stream E2 merges; the example keeps its fixed staged/DAG workflow meanwhile.

## Quick test

After installing matching author-package tarballs from this revision into the directory:

```sh
npm run build
npm test
```

Own tests cover public loop/tool/policy contracts, fixture outcomes and the key refusal boundary. The [external harness](../README.md#verification) installs and tests this example outside the repository. These checks do not establish live-model quality, browser interaction or customer-system acceptance.
