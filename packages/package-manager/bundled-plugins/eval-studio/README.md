# Evaluation Studio

English | [简体中文](README.zh-CN.md)

`@agnes/eval-studio` is an optional official plugin. Install from the built-in catalogue, review its permissions, trust and enable it explicitly. It is never installed or enabled by default. Its deferred `eval_studio_import` tool appears only in selected compositions. [Guide](../../../../docs/guide/eval-studio.md).

The profile **Evaluation** page and workbench panel accept explicitly pasted reports, compare cases and export JSON. They use shared UI controls and keep imported text only in memory until disable/uninstall. Opening a page runs no evaluation. Imported reports are **unverified evidence**, not approval or proof of execution from a trusted signer. Session tools can save validated datasets, reports and comparisons as immutable artifacts through the normal authorized artifact port.

From a source checkout, Node 24.10+ and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx packages/package-manager/bundled-plugins/eval-studio/src/demo.mjs > /tmp/agh-eval-demo.json
```

This small example runs an offline runner, uses the public SDK `runHeadless` and scripted model adapter against an in-memory synthetic SDK session, and creates private temporary workspaces. It does not start a daemon or exercise a production Loop. `reports[0]` passes; missing-step, wrong-output and unauthorized business-tool attempts fail. Paste a report object into the page as Baseline or Candidate. Export both as a comparison. No model keys, business tools or network calls are used.

The Node entry `./runner` exports `runEvaluation(dataset, {variant, openCase, signal?, judge?})` and `digest(value)`. `./offline` exports `syntheticDataset`, `offlineFactory` and `demo` for reproducible examples. Consumers bundle the Node entry with the existing SDK/model-adapters peers; it is not a standalone installed CLI. The backend entry does not load these peers or run the Node runner.

`openCase({case, dataset, signal})` is a **trusted caller-owned integration**, not input supplied by an agent or browser. It must provision an explicitly authorized isolated home/workspace, fixture-only tools, selected model/Loop/Skills/pins, enforce the declared token budget in its runtime and return:

```js
{
  client, cwd, components, replay, seed,
  effectPolicy: 'fixture-only',
  observe: async () => ({ output: 'ready', tools: ['fixture.lookup'], effects: [] }),
  close: async () => { /* dispose the client and temporary resources */ }
}
```

The runner checks actual component hashes before calling the SDK; the factory is responsible for honestly reporting actual configuration and refusing business effects. It never discovers profiles, connects to a default home, reads a database or grants unattended permissions. Arbitrary plugin JS/factory code is trusted code, not sandboxed by this library. A signal is passed to setup, model execution and judge; the factory/judge must cooperate with cancellation. Cleanup is awaited before scheduling another case. A cleanup failure fails the case.

The v1 dataset has `schemaVersion: 1`, `id`, `replay` (`scripted`, `strict`, `sequence`), explicit `seed` (integer or null), `hashes`, `budget: {wallMs, tokens}` (tokens may be null), and up to 100 unique cases. `hashes` binds canonical SHA-256 of `prompt`, `tools`, `fixture`, `model`, `loop`, `skills`, `pins`. Include fixture bytes, tool schemas, model adapter configuration/transcripts, Loop code and Skill revisions in these component snapshots, not just friendly names. Unsupported seeds must be null; do not claim determinism from a seed a provider ignores.

Each case supplies `id`, `input`, and `expected: {output, requiredTools, allowedTools, effects}`. Output accepts exact text or `{json: value}` for canonical JSON structure equality; required steps must occur; attempted unauthorized tools or differing fixture effects fail independently. A report records executed (0/1), structure/effects/budget outcomes, tokens, output, attempted tools, fixture effects and separate judge results. Zero cases never pass. Missing usage remains null/unknown; a token-limited case with unknown usage cannot pass. Token accounting is parent input+output, not an aggregate bill for child agents. This MVP accepts only a bounded one-turn fixture integration.

The dataset input hash binds case inputs/assertions; the full binding hash and embedded dataset retain the environment, replay, seed and budget. Comparison requires identical case inputs/assertions and preserves both environment bindings. Strict replay matches canonical requests; sequence replay reuses responses in order and does not prove request equivalence. Replay substitutes model responses only: production replay can still execute real tools. Use the fixture-only integration; do not point it at a normal business session.

Judge is optional and explicitly supplied by the caller as a separate, possibly charged call returning `{status: 'pass'|'fail'|'unknown', tokens: number|null, cost: number|null}`. It is skipped by default. Unknown/malformed/failed judge results cannot turn a case into a pass. No LLM judge model, billing estimate or real-model win rate is bundled. Imported totals are recomputed, but case claims remain unverified; publishing gates must use a separately reviewed evidence verification contract.

Import tool input: `{kind: 'dataset'|'report'|'comparison', json: '...'}`; comparison JSON contains `{baseline, candidate}`. Import accepts at most 1 MiB and does not execute data or read file paths. Report exports contain synthetic or explicitly selected outputs; review them before sharing. No telemetry/upload or global session scan is added. Version 1 is a new plugin format with no migration from old AGH homes. Missing/incompatible fields fail readably; existing backend session pins and current frontend activation semantics remain unchanged.
