# Compliance audit bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

An internal policy owner checks local checklist evidence and prioritizes follow-up gaps.

**Workflow:** Checklist → parallel evidence checks → severity and source links → audit markdown → model commentary.

CTRL-1 cites access-review.md line 3 as evidenced. CTRL-2 is a medium gap because restore-drill.md lacks the required completed-recovery phrase. CTRL-3 is high/missing; its link is the expected evidence path rather than an existing source. Missing files and insufficient evidence are distinct. Filename checks reject traversal. Phrase matching demonstrates evidence handling, not compliance certification.

## What ships

- Loop: `fde.compliance-audit`, a staged workflow with versioned checkpoints and cancellation. Each independent tarball includes `runtime.mjs`.
- Tools: fixture connectors and transformations registered by `main` through the public author kit.
- Policy: `fde.compliance-audit`, denying writes even in full-access sessions.
- Skills: packaged `skills/playbook/SKILL.md`, registered and included in model requests.
- Bundle: `agnes.kinds` declares `bundle`; `agnes.bundles.compliance-audit` composes the loop, Skill and preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from the [installation guide](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. Review source, dependencies and capabilities when installing. A fresh local-dev profile supplies keyless `demo/demo-model`; an existing profile needs that route or the real target below.

From the repository root:

```sh
cd examples/fde/compliance-audit
agh plugins add .
agh run --bundle '@agnes-fde/compliance-audit#compliance-audit' --preset compliance-audit --input fixtures/prompt.txt --json
agh serve
```

Run `npm pack` here to distribute a tarball and install it with `agh plugins add ./NAME.tgz`. Runtime, fixtures, Skill and any panel travel together, without workspace or sibling-example imports.

This read-only workflow completes headlessly. Inspect the report and evidence in JSONL tool results and assistant messages.

Web: open the serve URL, use **Admin → Plugins → Bundles**, select `@agnes-fde/compliance-audit#compliance-audit`, save and restart Host as requested. Start a new session with preset `compliance-audit` and Demo model; paste `fixtures/prompt.txt`. Existing sessions keep their pinned loop. Inspect evidence and the trace.

This one-turn workflow uses fixed synthetic input: the prompt starts it, and fixture files define the business data. Built-in Demo does not reason. Tools produce the substantive fixture result; quick tests use scripted model replies. A real model adds draft commentary that never overrides citations, amounts, findings or approvals.

## Real model

Configure an AGH route/model, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to that configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset compliance-audit --input fixtures/prompt.txt --json
```

The loop calls Core’s public `prepareRequest()`; Core resolves the session’s primary model, contracts and hashes. For Web, configure the equivalent preset primary route in profile composition and select that model for a new session. Keep credentials outside the bundle.

## Adapt for a customer

Map customer controls to authorized sources with stable evidence links. Add freshness, scope and reviewer criteria; phrase matches alone cannot establish control effectiveness. Keep retrieval read-only and distinguish missing/inconclusive states. A qualified policy owner reviews remediation and sign-off. Commentary cannot change the evidence verdict.

Backend plugins are trusted in-process code; declarations support review rather than arbitrary-code isolation. A denied tool or failed model stops the workflow. Pending checkpoints refuse automatic replay: inspect evidence before starting another run. Simulation receipts are not durable customer ledgers.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Business-source mutation remains denied by the bundle policy.

Official `write` creates reports in `fde-output/compliance-audit/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **3.0.0** uses checkpoint codec **3** for pending questions. Start a new session after upgrading; codec 1/2 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

Enable official Plan mode with `/plan on` in Web/TUI **before submitting a fresh task**. The loop detects the public plan-mode prompt section and submits its fixed business steps with `exit_plan_mode`. The official approval card must be approved before connectors, reports or commands run. A denied plan stops the workflow; an inactive plan mode skips this gate. The example policy preserves the shipped default policy's plan-mode denials. Plan approval does not replace a later business question or tool permission. Native single-call tickets resume through public continuation ports and the original invocation receipt; an unknown receipt blocks replay.

## Quick test

After installing matching author-package tarballs from this revision into the directory:

```sh
npm run build
npm test
```

Own tests cover public loop/tool/policy contracts, fixture outcomes and the key refusal boundary. The [external harness](../README.md#verification) installs and tests this example outside the repository. These checks do not establish live-model quality, browser interaction or customer-system acceptance.
