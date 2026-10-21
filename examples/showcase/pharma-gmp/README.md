# Sableleaf GMP Quality Hub

[简体中文](README.zh-CN.md) · [Demo](DEMO.md) · [Domain notes](DOMAIN-NOTES.md)

An installable, explicitly adopted pharmaceutical quality application, `@agnes-showcase/pharma-gmp`. Sableleaf OSD, people, products, signatures and evidence are fictional and synthetic. A public name search found no obvious namesake pharmaceutical plant; this is not trademark clearance. This unvalidated teaching system models nonsterile tablets/capsules and must not be used for real batch release or regulatory submissions.

The fixed scenario date is **2024-10-20**: 36 batches, 240 EM samples, nine equipment records and 12 deviations. The workbench combines overview, tasks/signatures, live object dossiers and the batch/record, deviation/CAPA, EM, QA release and audit modules. The Quality Assistant is the single entry. It delegates fresh investigation, review, EM and pre-release checks to four declared role subagents; delegation cards and completion notices retain their localized role attribution after reload. The hub summarizes their findings and performs requested signed records, advancement and release in the main conversation.

From the source repository root, after preparing the local CLI using the installation guide:

```sh
mise exec -- node tools/toolchain/run.mjs --filter @agnes-showcase/pharma-gmp build
export AGH_HOME="$(mktemp -d /tmp/agh-pharma.XXXXXX)"
export AGNES_PROFILE=local-dev
node agnes.mjs plugins inspect "file:$PWD/examples/showcase/pharma-gmp"
node agnes.mjs plugins install "file:$PWD/examples/showcase/pharma-gmp"
node agnes.mjs serve --port 4319
```

Review exact capabilities/integrity, trust and enable in Plugins; preview and adopt Sableleaf in **Settings → Application**. Installation never adopts implicitly. Demo accepts exact tool prompts such as `call pharma_inspect {"batch":"B-2410-017"}`; use a real model for the reasoning stages in DEMO. Recovery remains available through `/?admin` and `agh app clear`. Use an isolated home.

Profile pages use only declared `pharma.snapshot`, `pharma.change` and `pharma.release` services. Host-bound owner/profile storage persists across restart; no browser database or private filesystem access. Transactions bind monotonic revisions to audit entries. Originals are retained. The page saves operation IDs and inspects pending/unknown receipts before resuming. Release requires the entire checklist, exact revision, exact meaning and backend-injected human approval. Signer identity comes from that proof.

`pharma_report` creates Markdown and print HTML and calls `present`. The main Quality Assistant can create an ordinary nightly EM schedule. Growth uses the platform candidate helper: create, test, submit for review, then human-publish the exact hash. Host code pins retain running session versions across upgrades.

Focused checks from the root (under the repository toolchain and heavy-lock rules):

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run examples/showcase/pharma-gmp/test --project fast --maxWorkers=1
mise exec -- node tools/toolchain/run.mjs --filter @agnes-showcase/pharma-gmp typecheck
```

Isolated acceptance scripts live in `scripts/`; use a dedicated home/port and explicit real-model budget. No account or key ships in the package. EU GMP Annex 1/11, 21 CFR Part 11, ICH Q9/Q10 and ALCOA+ are reference frameworks, not compliance certification.

Role presets select an application-owned policy through the public tool-policy SPI, preserving default tool-permission behavior. Quality writes and release separately request a human business signature bound to the exact arguments/revision, including full-access sessions. A direct domain write without human proof refuses.

Only the exact nightly EM export (`kind=em` plus a supported locale) may run unattended: it reads quality state and writes new report files inside `pharma-output/`. Other report shapes retain the default decision; quality records and release always require a human.

Release dossier tools return the original findings together with current blockers and the deviation, retest, EM and equipment evidence. A certificate binds the reviewed pre-signature dossier revision; signing advances the state revision by one.

## Business signatures

Quality records and batch release are business acts. Tools request `business.confirm`, binding exact arguments, business object, revision, evidence and signature meaning. Under full access, Host automatically submits the declared approving response for the session's human principal, without a pending card. Receipts, audit records and release/closure records say **auto-confirmed under full access**; this is never a manual click or a model signature. Other permission levels retain manual sign/reject/cancel/expiry behavior. Host consumes each decision once; the private admission checks the same live epoch, cancellation and deadline inside the store transaction, so narrowing away from full access before commit blocks the write. Ambiguous or incomplete approving contracts still ask a person. Page effects retain Host human confirmation and revision checks.

For the real-model investor demo, run `exec node --import tsx examples/showcase/scripts/presentation.mjs pharma-gmp --real` through the repository toolchain entry under heavy-lock and web-gate-lock, injecting the key per command from the designated keychain item. The runner saves screenshots and costs under its isolated run directory; set `AGH_SHOWCASE_SHOTS` to choose an external report directory and `AGH_SHOWCASE_PRIOR_USD` to include previous paid attempts in the $3 application cap. The older acceptance script's `--real` also delegates to this natural conversation flow.

For an explicit test-operator source review, set `AGH_SHOWCASE_REQUIRE_REVIEW=1`: the runner writes `candidate-review.json` and waits for `review-approved.json` in the isolated run directory, containing the same `candidateHash` and `reviewHash`. This test fixture never grants production consent.

The signature card shows the object, reviewed revision, exact meaning and evidence in the current UI language. The human answer must return that view’s bound meaning unchanged; receipts and audit records preserve it. A legacy null answer cannot complete these new signatures.

Version 1.2.0 adds role subagents and the single Quality Assistant entry; existing installations can review the bundled update on the Plugins page. Installation and application adoption remain separate.

The workbench offers Current object, Pending signatures and Evidence & reports. Start deviation, CAPA, EM, batch review or QA release work from object buttons or composer actions; the hub delegates to four specialist roles and records their attribution. Overview and Tasks & signatures form the primary navigation; all other modules remain under More and overview links.

Role children capture a spawn-time intersection of role and parent tools, file/network scope, sandbox and read-only limits. They cannot obtain approvals or business signatures, even from a Full access parent. A refused action returns to the main Quality Assistant. Their persistent persona comes from the role recipe, independently of the editable launch draft.
