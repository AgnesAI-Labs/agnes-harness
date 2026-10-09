# Three runnable demos

English | [简体中文](demos.zh-CN.md)

See business agents as plugins, upgrades that preserve work, and an agent that builds a reusable capability. Each script runs a real daemon and workers against synthetic data in a fresh temporary `AGH_HOME`. No model account or browser is required.

## Run from a clone

Use Node.js 24.10+ and pnpm 10.34.5 with your platform's native build prerequisites ([installation](install.md)). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/cli build:local
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

## Headless smoke

`--check` replaces terminal confirmations with explicit approval of this synthetic demonstration, including the generated template. It runs the same real backend and assertions, with no test retries or Playwright:

```sh
node examples/demos/business-agent/run.mjs --check
node examples/demos/hot-upgrade/run.mjs --check
node examples/demos/growing-skills/run.mjs --check
pnpm exec vitest run examples/demos/test/demos.e2e.test.ts --maxWorkers=1
```

The test file belongs to the heavy tier because it starts real processes; `pnpm test:heavy` includes it. Build the local CLI before running it.
