# Knowledge QA bundle

English | [简体中文](README.zh-CN.md) · [FDE examples](../README.md)

A support enablement team answers policy questions over its own local documents with reviewable citations.

**Workflow:** Question → retrieve paragraphs → cited extractive answer or refusal → model commentary.

The input is the actual query. The refund fixture cites refunds.md paragraph 2 and quotes the 30-day window. No matched paragraph produces status refused, empty citations and no model request. This small lexical retriever can return partial evidence that does not cover every part of a question.

## What ships

- Loop: `fde.knowledge-qa`, a staged workflow with versioned checkpoints and cancellation. Each independent tarball includes `runtime.mjs`.
- Tools: fixture connectors and transformations registered by `main` through the public author kit.
- Policy: `fde.knowledge-qa`, denying writes even in full-access sessions.
- Skills: packaged `skills/playbook/SKILL.md`, registered and included in model requests.
- Bundle: `agnes.kinds` declares `bundle`; `agnes.bundles.knowledge-qa` composes the loop, Skill and preset.

## Install and run

Use Node 24.10+ and a source-built `agh` from the [installation guide](../../../docs/guide/install.md). Preview author packages are not promised as public npm releases. Review source, dependencies and capabilities when installing. A fresh local-dev profile supplies keyless `demo/demo-model`; an existing profile needs that route or the real target below.

From the repository root:

```sh
cd examples/fde/knowledge-qa
agh plugins add .
agh run --bundle '@agnes-fde/knowledge-qa#knowledge-qa' --preset knowledge-qa --input fixtures/prompt.txt --json
agh serve
```

Run `npm pack` here to distribute a tarball and install it with `agh plugins add ./NAME.tgz`. Runtime, fixtures, Skill and any panel travel together, without workspace or sibling-example imports.

This read-only workflow completes headlessly. Inspect the report and evidence in JSONL tool results and assistant messages.

Web: open the serve URL, use **Admin → Plugins → Bundles**, select `@agnes-fde/knowledge-qa#knowledge-qa`, save and restart Host as requested. Start a new session with preset `knowledge-qa` and Demo model; paste `fixtures/prompt.txt`. Existing sessions keep their pinned loop. Inspect evidence and the trace.

The query controls retrieval; other tools use packaged fixtures. Built-in Demo does not reason. Tools produce the substantive fixture result; quick tests use scripted model replies. A real model adds draft commentary that never overrides citations, amounts, findings or approvals.

## Real model

Configure an AGH route/model, then edit the preset primary route in [real-model.bundle.json](real-model.bundle.json) to that configured pair:

```sh
agh run --bundle ./real-model.bundle.json --preset knowledge-qa --input fixtures/prompt.txt --json
```

The loop calls Core’s public `prepareRequest()`; Core resolves the session’s primary model, contracts and hashes. For Web, configure the equivalent preset primary route in profile composition and select that model for a new session. Keep credentials outside the bundle.

## Adapt for a customer

Replace the retriever with a registered read-only customer tool and set plugin config workflow.retrieverTool to its name. Contract: { question: string } → { sources: Array<{ quote: string, citation: string }> }; absent evidence returns an empty array. Every source needs a nonempty quote and citation; the policy rejects write-capable retrieval. Keep ACL filtering and stable citation identifiers in the connector. Adapt language tokenization and relevance thresholds for customer QA.

Set retriever config on the plugin row:

```json
{
  "workflow": { "retrieverTool": "customer_retrieve" }
}
```

Register that tool via the public author kit before running. The fixture retriever is the default.

Backend plugins are trusted in-process code; declarations support review rather than arbitrary-code isolation. A denied tool or failed model stops the workflow. Pending checkpoints refuse automatic replay: inspect evidence before starting another run. Simulation receipts are not durable customer ledgers.

## Official tools and outputs

The installed standard preset supplies [official tools](../../../docs/reference/default-tools.md). This bundle registers business connectors and formatters only. Business-source mutation remains denied by the bundle policy.

Official `write` creates reports in `fde-output/knowledge-qa/<run-hash>/`; `present` copies them into session artifacts for the standard Open/Download card. Drafts are presented before questions; completed runs also present the final result. The policy allows report writes only at this bounded path, and the official observation/stale-write guard remains active. All other source writes remain denied in evidence-only workflows. Output paths are relative to the session workspace, and the manifest declares their read/write scope.

Loop version **2.0.0** uses checkpoint codec **2** for pending questions. Start a new session after upgrading; codec 1 checkpoints are refused rather than replayed. Model selection now comes from the preset primary route. Quick tests script the official tool ports, model and artifact receipts; they do not exercise real question projections, downloads, web providers or background process confinement.

TODO: adopt official Plan mode after Stream E2 merges; the example keeps its fixed staged/DAG workflow meanwhile.

Optional public research uses `web_search` only when plugin config `workflow.publicQuery` contains an explicit public query. It never sends the local user question or document text. A missing provider is recorded as unavailable without changing the local cited answer/refusal. Public snippets remain supplemental context, not local evidence. Example workflow config:

```json
{ "retrieverTool": "fde_knowledge_retrieve", "publicQuery": "public support handbook" }
```

## Quick test

After installing matching author-package tarballs from this revision into the directory:

```sh
npm run build
npm test
```

Own tests cover public loop/tool/policy contracts, fixture outcomes and the key refusal boundary. The [external harness](../README.md#verification) installs and tests this example outside the repository. These checks do not establish live-model quality, browser interaction or customer-system acceptance.
