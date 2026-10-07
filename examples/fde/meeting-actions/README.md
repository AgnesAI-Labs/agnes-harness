# Meeting actions bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

A delivery lead converts a rollout transcript into accountable follow-up and reviews the notes before team delivery.

**Workflow:** Transcript → summary, decisions, owners/dates → markdown export and panel → approval → simulated send.

The synthetic transcript uses explicit SUMMARY, DECISION and ACTION tags. Morgan/2026-10-09 and Casey/2026-10-12 retain source line numbers. A business formatter prepares markdown; official `write` and `present` create the file and artifact download card. The meeting panel renders action evidence. Official `ask_user_question` waits for the send choice, and backend permission still controls the simulated sender (externalDelivery: false).

## What ships

- Loop: `fde.meeting-actions`, a staged workflow with versioned checkpoints and cancellation. Each independent tarball includes `runtime.mjs`.
- Tools: fixture connectors and transformations registered by `main` through the public author kit.
- Policy: `fde.meeting-actions`, requiring human approval for every decision/send action.
- Skills: packaged `skills/playbook/SKILL.md`, registered and included in model requests.
- Bundle: `agnes.kinds` declares `bundle`; `agnes.bundles.meeting-actions` composes the loop, Skill and preset. The client descriptor mounts the panel through public tool.call.toolview slots.

## Install and run

Use Node 24.10+ and a source-built `agh` from the [installation guide](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. Review source, dependencies and capabilities when installing. A fresh local-dev profile supplies keyless `demo/demo-model`; an existing profile needs that route or the real target below.

From the repository root:

```sh
cd examples/fde/meeting-actions
agh plugins add .
agh run --bundle '@agnes-fde/meeting-actions#meeting-actions' --preset meeting-actions --input fixtures/prompt.txt --json
agh serve
```

Run `npm pack` here to distribute a tarball and install it with `agh plugins add ./NAME.tgz`. Runtime, fixtures, Skill and any panel travel together, without workspace or sibling-example imports.

The draft is presented before the official question parks the workflow. Unattended runs stop for a question or unavailable tool permission. Answer in Web/TUI, then grant the action permission if requested; cancellation records no action receipt.

Web: open the serve URL, use **Admin → Plugins → Bundles**, select `@agnes-fde/meeting-actions#meeting-actions`, save and restart Host as requested. Start a new session with preset `meeting-actions` and Demo model; paste `fixtures/prompt.txt`. Existing sessions keep their pinned loop. Inspect evidence and the trace in the meeting panel.

This workflow uses fixed synthetic input: the prompt starts it, and fixture files define the business data. Built-in Demo does not reason. Tools produce the substantive fixture result; quick tests use scripted model replies. A real model adds draft commentary that never overrides citations, amounts, findings or approvals.

## Real model

Configure an AGH route/model, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to that configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset meeting-actions --input fixtures/prompt.txt --json
```

The loop calls Core’s public `prepareRequest()`; Core resolves the session’s primary model, contracts and hashes. For Web, configure the equivalent preset primary route in profile composition and select that model for a new session. Keep credentials outside the bundle.

## Adapt for a customer

Replace tagged extraction with a customer transcript parser or validated structured model output. Missing owners/dates need follow-up. Add calendar/timezone rules and stable action IDs. Replace the fixture recipient and sender with an idempotent connector that verifies delivery receipts. Keep approval in the backend and the panel a renderer.

Backend plugins are trusted in-process code; declarations support review rather than arbitrary-code isolation. A denied tool or failed model stops the workflow. Pending checkpoints refuse automatic replay: inspect evidence before starting another run. Simulation receipts are not durable customer ledgers.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Before its action, `ask_user_question` presents Proceed/Cancel and parks with a persisted question ID. Only a validated ordinary user answer continues it; invalid answers keep it parked. This business choice does not grant tool permission.

Official `write` creates reports in `fde-output/meeting-actions/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **2.0.0** uses checkpoint codec **2** for pending questions. Start a new session after upgrading; codec 1 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

TODO: adopt official Plan mode after Stream E2 merges; the example keeps its fixed staged/DAG workflow meanwhile.

## Quick test

After installing matching author-package tarballs from this revision into the directory:

```sh
npm run build
npm test
```

Own tests cover public loop/tool/policy contracts, fixture outcomes and the key refusal boundary. The [external harness](../README.md#verification) installs and tests this example outside the repository. These checks do not establish live-model quality, browser interaction or customer-system acceptance.
