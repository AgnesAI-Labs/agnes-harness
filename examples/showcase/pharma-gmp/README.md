# Sableleaf GMP Quality Hub

[简体中文](README.zh-CN.md) · [Demo](DEMO.md) · [Domain notes](DOMAIN-NOTES.md)

An installable, explicitly adopted pharmaceutical quality application, `@agnes-showcase/pharma-gmp`. Sableleaf OSD, people, products, signatures and evidence are fictional and synthetic. A public name search found no obvious namesake pharmaceutical plant; this is not trademark clearance. This unvalidated teaching system models nonsterile tablets/capsules and must not be used for real batch release or regulatory submissions.

The fixed scenario date is **2024-10-20**: 36 batches, 240 EM samples, nine equipment records and 12 deviations. Six pages cover overview, batches/records, deviation/CAPA, environmental monitoring, QA release and audit. Five localized agents provide Hub, BPR review, investigation, EM analysis and release assistance.

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

`pharma_report` creates Markdown and print HTML and calls `present`. The EM agent creates an ordinary nightly schedule. Growth uses the platform candidate helper: create, test, submit for review, then human-publish the exact hash. Host code pins retain running session versions across upgrades.

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

Quality records and batch release are business acts. Tools use the public decision port with `business.confirm`, bind the exact target, revision, evidence and meaning, and verify the Host-recorded human answer. System/agent answers, rejection, cancellation and invalidation cannot mutate quality state. Full access still asks for a human signature. Ordinary tool permissions follow the selected preset; automatic full-access permission is no business signature. Page effects retain Host human confirmation and revision checks.

For the real-model investor demo, run `exec node --import tsx examples/showcase/scripts/presentation.mjs pharma-gmp --real` through the repository toolchain entry under heavy-lock and web-gate-lock, injecting the key per command from the designated keychain item. The runner saves screenshots and costs under its isolated run directory; set `AGH_SHOWCASE_SHOTS` to choose an external report directory and `AGH_SHOWCASE_PRIOR_USD` to include previous paid attempts in the $3 application cap. The older acceptance script's `--real` also delegates to this natural conversation flow.

For an explicit test-operator source review, set `AGH_SHOWCASE_REQUIRE_REVIEW=1`: the runner writes `candidate-review.json` and waits for `review-approved.json` in the isolated run directory, containing the same `candidateHash` and `reviewHash`. This test fixture never grants production consent.
