# Product demos and developer mechanism examples

English | [简体中文](demos.zh-CN.md)

The gallery features three shipped showcase applications: [DevBoard 3.7.2](../../examples/showcase/devboard/README.md), [Pharma GMP](../../examples/showcase/pharma-gmp/README.md) and [Aerospace quality](../../examples/showcase/aerospace-quality/README.md). DevBoard is a rail door-system R&D and quality workbench with project gates, traceability, trials, service-quality feedback and an R&D Coordinator. All three use fictional data. Only these flagships are promoted; missing packages produce no placeholders or teaching-example fallback. The [five teaching examples](../../examples/fde/README.md) remain available for deliberate installation. The three scripts below demonstrate platform mechanisms.

See business agents as plugins, upgrades that preserve work, and an agent that builds a reusable capability. Each script runs a real daemon and workers against synthetic data in a fresh temporary `AGH_HOME`. No model account or browser is required.

## Run from a clone

Use Node.js 24.10+ and pnpm 10.34.5 with your platform's native build prerequisites ([installation](install.md)). From the repository root:

```sh
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
node examples/demos/business-agent/run.mjs
node examples/demos/hot-upgrade/run.mjs
node examples/demos/growing-skills/run.mjs
```

Read the printed source, capability review and business draft. Type `yes` to approve a synthetic action; refusal ends the demo with a nonzero exit. The scripts narrate each step, verify persisted backend results, and print `PASS` only when the claim holds. They stop their daemon and remove the temporary home and workspace when done.

| Demo | Observable proof |
| --- | --- |
| [Business agent as a plugin](../../examples/demos/business-agent/README.md) | Install the existing support-triage bundle; its session selects the business Loop and tools while a parallel default Agent has none of those tools. Disable it: new sessions lose the bundle, the existing session completes with pinned code. |
| [Hot upgrade without interrupting work](../../examples/demos/hot-upgrade/README.md) | Park a multi-step workflow at a durable review question, publish a reviewed new package version, and finish a new session with v2. Restart the daemon mid-task: the old session retains v1, its prior tool results and its pending review; exactly one read, classification and simulated send are recorded. |
| [Agent grows its own skills](../../examples/demos/growing-skills/README.md) | The default Agent uses `plugin-helper` to write a text statistics plugin. Review its source and passing tests, then publish the exact reviewed candidate hash; a new session calls the actual tool and provenance reports `installer=agent`. |

The default demo model makes deterministic teaching decisions; it performs no reasoning. The support action is a **simulated send**, with no external message. The restart demo proves recovery at a persisted review boundary and committed tool results. It does not establish exactly-once behavior for arbitrary external side effects interrupted during execution: unknown effects remain blocked for inspection. See [sessions](sessions.md), [packages](packages.md), [security](security.md) and [plugin code versus live resources](../develop/architecture-plugins.md#pinned-code-live-resources).

## Optional real model

Set `AGH_DEMO_MODEL` to a configured provider id and model, for example `deepseek/deepseek-flash`, and supply `AGH_DEMO_API_KEY` through your shell's secret handling. `AGH_DEMO_BASE_URL` optionally selects an endpoint supported by that provider. The scripts save the account through the public configuration API into the temporary home, then explicitly select it for their sessions. They do not read your normal AGH home or print the credential. Model inference may incur charges. Tool decisions and generated source can vary; an unsupported or incorrect result fails the same assertions.

Do not put credentials in command arguments, committed files or shared transcripts. Real-model acceptance is separate from the offline CI gate.

## Agent gallery browser acceptance

After building the local CLI and provisioning Playwright Chromium, run the heavy browser acceptance:

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/e2e-web/agent-sweep.e2e.test.ts --maxWorkers=1
```

It enumerates all example Bundle declarations with `launch`, deliberately installs/trusts/enables teaching packages through plugin source review in the Web UI, checks the model/permissions/package sources/draft review, confirms without sending, then explicitly submits each sample prompt. The default uses the offline Demo model. It checks durable tool results, completion and report cards, and answers synthetic business questions and tool approvals through their normal controls.

Real inference requires explicit `AGH_REAL_AGENT_SWEEP=1` plus `AGH_DEMO_API_KEY` supplied through secure shell secret handling. It saves a DeepSeek account (`deepseek-flash`) through the public configuration API. Real homes are retained under `~/agh-real-eval/sweep-*`; ports are allocated on loopback. Each agent has a six-minute run cap; the sweep cancels/stops when AGH-recorded cost exceeds $5. `AGH_AGENT_FILTER` optionally selects comma-separated agent reference substrings for a focused rerun. Use `AGH_WEB_TEST_OUTPUT` to retain reports separately for each run. The JSON evidence and screenshots are test artifacts, not source files; protect them like other runtime evidence. A scripted pass does not establish real-model answer quality.

## Headless smoke

`--check` replaces terminal confirmations with explicit approval of this synthetic demonstration, including the generated template. It runs the same real backend and assertions, with no test retries or Playwright:

```sh
node examples/demos/business-agent/run.mjs --check
node examples/demos/hot-upgrade/run.mjs --check
node examples/demos/growing-skills/run.mjs --check
mise exec -- node tools/toolchain/run.mjs exec vitest run examples/demos/test/demos.e2e.test.ts --maxWorkers=1
```

The test file belongs to the heavy tier because it starts real processes; `pnpm test:heavy` includes it. Build the local CLI before running it.
