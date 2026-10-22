# Qiongxu Aerospace Programme Quality

English | [简体中文](README.zh-CN.md)

An adoptable AGH application for a **fictional** spacecraft propulsion valve-driver programme,
QV-X27. Qiongxu (穹序), its supply cells, identifiers, measurements and approval archives are synthetic.
The chosen combined programme/organisation name was checked for obvious aerospace-brand collisions;
this is not a real company, customer system, flight programme or certified quality system.

One third-party-style package (`@agnes-showcase/aerospace-quality`, family `showcase`) supplies five
role agents, six profile pages, a light/dark skin, original PNG identity, strict-schema tools,
owner/profile-bound data, evidence cards, reports and a deployment-time weekly automation.
`aero_briefing` publishes a real data-only Intelligent UI chart/table surface in the conversation and workbench; keyed tool cards remain separate recorded-result views. Only public author APIs are consumed. Installation does not adopt presentation or grant execution rights.

The dataset contains 39 hierarchical requirements, 32 verification cases, six campaigns (four with
484 telemetry samples / 1,452 channel measurements, two pending without invented measurements),
18 NCRs, 12 ECRs, four baselines, 24 controlled parts and ten closure criteria. The frozen snapshot
is 20 October 2026. NCR aging uses that snapshot date; audit timestamps use actual execution time.

## Run from a matching source checkout

Prepare the pinned runtime with `mise trust` and `mise install`. Replace `pnpm` below with
`mise exec -- node tools/toolchain/run.mjs` from the repository root. Use the development machine's
heavy-lock wrapper for build, tsc and Vitest commands. Build this package before a direct source installation. The local runtime builder also compiles
declared `src/index.ts` → `dist/index.js` entries for every example family and includes declared Markdown.

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes-showcase/aerospace-quality build
pnpm --filter @agnes/cli build:local
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-aero.XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs plugins add "$AGH_SOURCE/examples/showcase/aerospace-quality" --yes
node agnes.mjs daemon stop
node agnes.mjs serve --port 4296
```

Use the same home/profile in each terminal. Review installation capabilities and trust; `--yes` is
for the unattended synthetic trial. Open **Settings → Application**, preview Qiongxu and explicitly
adopt it. The brand, skin, dashboard, industry navigation and five agents become effective. The
host's settings, Agents, Automation, conversation and `/?admin` recovery remain accessible.

Optional SDK preview/adoption, from the same environment:

```sh
pnpm --filter @agnes-showcase/aerospace-quality exec node --import tsx adopt.mjs
pnpm --filter @agnes-showcase/aerospace-quality exec node --import tsx adopt.mjs --adopt
node agnes.mjs --new --agent '@agnes-showcase/aerospace-quality#investigator' -p 'Read aero_playbook, then investigate AN-027 and cite evidence. Do not claim a confirmed cause.'
```

The default Demo model supports explicit tool-call prompts such as
`call aero_investigate {"anomalyId":"AN-027"}`. Use a configured real model for investigative reasoning;
the [demo script](DEMO.md) gives exact deterministic calls and real-model prompts.

## Workflow and authority

- Requirements: requirement ↔ design ↔ verification, status colouring plus textual gap/orphan filters.
- Tests: current/temperature/vacuum evidence, current limit, highlighted 66–70 minute anomaly window,
  run logs, correlated lot/configuration/NCR evidence and alternative mechanisms.
- MRB: compare all five dispositions; save a rationale; request Host human approval. Every formal
  disposition, including use-as-is, requires approval. `dispositioned` means **approved for execution**,
  not physically reworked, inspected, closed or released. Parts/configurations stay on hold.
- Configuration: baseline register, ECR requirement/interface/test impact graph, preferred parts,
  obsolescence and counterfeit-risk flags. Approved changes invalidate affected verification and
  hold the destination baseline; a reviewed screening rule adds a pending verification case.
- Zeroing: all ten double-five criteria and evidence. Incomplete evidence refuses closure, even with
  approval. The report remains a draft. This demonstration does not invent completed reproduction.
- Growth: `aero_rule_propose` creates an inactive domain skill candidate. `aero_skill_candidate`
  prepares/commits an actual Host Skill installation proposal; commit requires native human approval
  and the installed Skill becomes effective next turn. Separately approve the bounded programme
  screening policy with `aero_decide(kind=rule)`; subsequent change analysis identifies rule v1.

Pages use declared profile services and durable operation IDs, retaining uncertain receipts in
session storage scoped to profile/activation/client revision. Reopening reads the original receipt;
no unknown operation is retried under a new identity. Revision drift refuses stale decisions.
Each role preset selects the package’s public `aero-human-review` tool policy. It preserves ordinary tool permission. Business operations separately request a human, one-time signature bound to the target and programme revision; session/permanent tool grants do not replace that decision. Full access auto-confirms eligible business signatures through Host for the main session’s human principal; other permissions ask the human. The tool verifies the Host proof and the transaction checks the current revision. Neither UI labels nor caller-supplied approval/owner selectors grant authority. Browser storage
failure prevents mutation dispatch. Trusted JS is not a sandbox.

`aero_report` creates unique Markdown and print-styled HTML files under the authorised workspace
`aero-output/`, then invokes the public `present` tool. AGH copies them to durable session deliverables.
It never writes arbitrary paths or uses `present` with artifact URLs. Generated HTML escapes content.
Use the execution record/provenance view for tool inputs, approvals, effects, package integrity and
session pins. In-flight sessions keep pinned backend code after an upgrade; current profile pages
follow the active package. Application adoption does not change execution identity.

## Weekly automation

With the same home/profile and a registered isolated workspace:

```sh
export AERO_WORKSPACE=/absolute/path/to/isolated/workspace
pnpm --filter @agnes-showcase/aerospace-quality exec node --import tsx automation.mjs
```

This explicitly creates a Monday 09:00 Asia/Shanghai schedule for the quality agent. It freezes the
agent target at creation and refuses unattended approvals. Use **Automation → Run now** to demonstrate
one run. The prompt calls `aero_report(kind=digest)`, producing the same Markdown/HTML deliverables.
No job is installed as a package-load side effect. Configure a model for unattended reasoning;
review/disable the schedule in Automation when finished.

## Validation and recovery

```sh
pnpm --filter @agnes-showcase/aerospace-quality typecheck
pnpm exec vitest run examples/showcase/aerospace-quality/test --project fast --maxWorkers=1
pnpm exec vitest run tools/guards/src --project fast --maxWorkers=1
pnpm gen:check
```

Host tests verify shared store/restart, refusal, cancellation, stale revisions, approval facts and
pins; public panel tests verify bilingual pages, filters and original-operation recovery. The explicit
`test/acceptance.e2e.mjs` script performs install/inspect/adopt, browser screenshots, real-model steps
and automation on an isolated home; it is opt-in, not part of the fast suite. Follow its header before
running paid mode. Never print or store API keys. See [domain notes](DOMAIN-NOTES.md) for standards
references and modelling limits. Open `/?admin` or use `agh app clear` to recover host presentation;
only stop this trial's daemon. No customer data, private traces or credentials belong in the package.

The selected domain policy permits `aero_report` as a bounded evidence export: only allowlisted report kinds/locales and new files under `aero-output/`, followed by `present`. This allows scheduled, source-tainted prompts to produce deliverables without unattended hardware/configuration approval. MRB, configuration, rule enablement and zeroing closure still require an exact business decision each time, with eligible full-access requests auto-confirmed by Host.

## Business signatures

MRB disposition, configuration changes, rule enablement and zeroing closure are business acts. Tools request `business.confirm`, binding exact arguments, business object, revision, evidence and signature meaning. Under full access, Host automatically submits the declared approving response for the session's human principal, without a pending card. Receipts, audit records and release/closure records say **auto-confirmed under full access**; this is never a manual click or a model signature. Other permission levels retain manual sign/reject/cancel/expiry behavior. Host consumes each decision once; the private admission checks the same live epoch, cancellation and deadline inside the store transaction, so narrowing away from full access before commit blocks the write. Ambiguous or incomplete approving contracts still ask a person. Page effects retain Host human confirmation and revision checks.

For the optional real-model acceptance, run `exec node --import tsx examples/showcase/scripts/presentation.mjs aerospace-quality --real` through the repository toolchain entry under heavy-lock and web-gate-lock, supplying `AGH_DEMO_API_KEY` securely for that command only. The runner saves screenshots/costs under the isolated run directory; `AGH_SHOWCASE_SHOTS` selects an external report directory and `AGH_SHOWCASE_PRIOR_USD` includes prior attempts in the $3 application cap. The older acceptance script's `--real` also delegates to this natural conversation flow.

The signature card shows the object, reviewed revision, exact meaning and evidence in the current UI language. The human answer must return that view’s bound meaning unchanged; receipts and audit records preserve it. A legacy null answer cannot complete these new signatures.

## One business workbench

After adoption, **Programme overview** and **Tasks & signatures** are the primary navigation.
The overview links to every original module. Choose Investigate on AN-027, Draft disposition on an
NCR, Start review on an ECR or Generate report on a closure item. The host reviews the existing agent
launch, then opens an editable request and focuses **Current object**. Composer chips route work to
the existing roles; this is launch-time routing, without new delegation behavior. The transcript
attributes the reviewed launch. Optional browser session memory restores that display context; the
submitted JSON request and business records retain their normal backend ownership.

**Current object** refreshes from the profile service on session projection invalidation.
**Pending signatures** shares the host decision actions with the conversation card. Standard and
workspace-write levels ask the human; full access auto-confirms through the Host and records that mode
without a pending card.
**Evidence & reports** shows session receipts with provenance and report-file links. Approval still
means implementing a disposition with hardware held for verification; it does not claim a passing test.

Scripted browser acceptance: `pnpm exec node --import tsx examples/showcase/scripts/workbench.mjs` from the repository
root, through the documented toolchain and browser locks. It creates fresh isolated homes and invokes
no paid model.

Version 1.1.0 updates the conversation workbench; existing 1.0.0 installations can review the bundled update on the Plugins page. Installation and application adoption remain separate.

Version 1.1.1 declares report tools as history attestations. Report generation waits for the session's background history verification; ordinary work can proceed meanwhile. See [session integrity](../../../docs/guide/sessions.md).
