# Evaluation Studio

English | [简体中文](eval-studio.zh-CN.md)

[Documentation](../README.md) · [Headless runs](headless.md) · [Plugin lifecycle](packages.md)

Install **Evaluation Studio** (`@agnes/eval-studio`) from the built-in plugin catalogue. Review, trust and enable it explicitly; it is disabled and uninstalled by default. Select its tools only in evaluation sessions. The plugin adds a profile Evaluation page and a workbench panel through public UI registries.

Use synthetic fixtures first:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx packages/package-manager/bundled-plugins/eval-studio/src/demo.mjs > /tmp/agh-eval-demo.json
```

The source-checkout example runs SDK headless calls against a synthetic in-memory session and scripted model, with disposable workspaces. It does not test a production Loop, daemon or real model. The JSON contains a passing baseline and failing missing-step, wrong-output and unauthorized-tool variants. Select `reports[0]`, paste the complete object into **Evaluation → Baseline**, then import `reports[1]` as Candidate. Choose a case with the keyboard-accessible picker, inspect text/JSON structure, effects and budget and separate judge status, then **Export JSON**. Both bindings and per-case differences are preserved.

Each dataset binds prompt, tools, fixture, model, Loop, Skill and pin hashes plus seed and budget. Compare identical case inputs while changing the environment. Strict replay checks request equivalence; sequence replay only reuses responses in order. The runner never grants business effects: the trusted client factory must supply an explicitly authorized isolated home/workspace and fixture-only tools. Replay alone is not an effect sandbox.

Actual execution counts are retained; zero cases fail. Cancellation stops subsequent cases and waits for cleanup. Missing usage is unknown; a token-limited case cannot pass with unknown usage. An optional caller-supplied judge is a separate possibly charged call with its own cost/usage/uncertainty. No real-model quality claim is made by the offline example.

The page keeps selected reports in memory and runs no model. Disable/uninstall clears it and removes both registrations. Import errors stay visible with retry guidance. The deferred `eval_studio_import` tool accepts bounded v1 dataset/report JSON, or `{baseline,candidate}` comparison JSON, and stores an immutable artifact through the current session's authorized port. A tool may need normal policy authorization; installing this package grants no Host privileges or cross-session access.

Imported reports are unverified evidence. Totals are recomputed, but assertions supplied by a caller do not prove actual execution and do not bypass human candidate review. Inspect outputs before sharing exports. There is no default-home scan, credential import, upload, telemetry or migration from old AGH data. See the [package contract and integration example](../../packages/package-manager/bundled-plugins/eval-studio/README.md) for schemas, limits, factory obligations and the Node runner API.
