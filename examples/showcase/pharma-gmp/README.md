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

Role presets select an application-owned policy through the public tool-policy SPI. It preserves the default policy’s refusals and requires a human, once, bound to the exact arguments/revision for quality writes and release, including full-access sessions. A direct call without that proof refuses.
