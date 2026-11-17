# @agnes/superagent

A proactive agent for one GitHub repository, run as an Agnes plugin: it listens to GitHub (and optionally Feishu),
assesses requests under a policy, turns authorized ones into tickets, and hands each ticket to its own session.
This package is installed and enabled by default. Until configured, it waits for setup without listening to sources,
starting tasks or calling models. Existing configuration and explicit disable or uninstall choices are preserved.

## Origin

The domain core, policy, deployment checks and SQLite store are ported from
[dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT), commit
`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. That commit is the porting base; an independently held copy of the
prototype at commit `6337fc8` has the same source tree. Copyright (c) 2026 DeepSeek Harness Team. The original license
text is in [`LICENSE-MIT`](./LICENSE-MIT), and each copied file starts with an "Adapted from dsh-superagent (MIT)"
header.

## What is here

| Path | Role |
| --- | --- |
| `src/core/` | Domain model, tickets, evals, engine and the `Repositories` port (synchronous `atomic`). |
| `src/policy.ts`, `src/admission.ts` | Settings schemas, the admission gate and revalidation of mandates. |
| `src/kv.ts`, `src/limits.ts` | Typed key-value keys and shared validation bounds. |
| `src/deployment.ts`, `src/setup.ts` | Machine configuration and startup checks of the agent's GitHub and Feishu CLI identities. |
| `src/navigation.ts` | Opening a known session once the host catalog lists it. |
| `src/app/store.ts`, `src/app/store-read.ts` | SQLite persistence (`openStore`) and its read queries. |
| `src/app/migrations/` | Schema version, the migration registry and one `v<N>.ts` per schema step. |
| `src/app/store-retention.ts` | `archiveExpired`: moves conversations that ended more than 14 days ago into archive tables. |
| `src/app/subprocess.ts` | `runCommand`: child processes without stdin or credential-shaped environment variables. |
| `src/sources/` | The Source contract (`kind.ts`, `host.ts`, `registry.ts`), the GitHub Source and the Feishu Source, which receives, replies and reads through an AGH Feishu channel instance. |
| `src/infra/commands.ts`, `src/infra/health.ts` | `Commands` (the `gh` and `git` calls of the Sources, on `runCommand`) and the health board. |
| `src/app/` (other files) | Effect queue, outbox, notices, passes, assessment, settings, prompts, links and the read models in `views/`. |
| `src/app/skill-files.ts` | Loads the packaged `prompts/`, `skills/` and `locale/` folders. |
| `src/runtime/` | The plugin row `superagentPlugin`: its profile-managed service, which needs the bundled-app grant, the snapshot its `context` and `tool_call` hooks read (`hook-state.ts`) and the narrowing of the grant's SDK client (`sdk.ts`). |
| `src/runtime/services.ts` | The settings and panel services, one per route of the prototype's management API, and their registration on the plugin; `panel-views.ts` is their host contract, `panel-host.ts` the host a running service fills in as its parts start, `panel-api.ts` the types the panel reads. |
| `src/agnes.client.json` | The descriptor of the browser panel (`packages/superagent-ui`): a primary home entry and the services it may call. |
| `docs/setup.md` | How to set Superagent up on AGH with its operator. |

## Differences from the prototype

- The prototype's cordis, schemastery and DSH subprocess dependencies are replaced by zod and `runCommand`;
  its session-controller types are replaced by local types.
- Databases written by the prototype (schema 10) are not imported. A database starts empty at the current schema, and
  the oldest schema this build opens is that same schema; the version mechanism stays for later schema steps.
- The prototype's session, executor, runtime, tool and HTTP files are not ported; the parts of them that the Sources and
  the app glue need are small interfaces (`SessionNotices`, `SettingsSetup`, `ImageSink`) or new files (`messages.ts`,
  `acknowledgement.ts`).
- `prompts/`, `skills/` and `locale/` are the prototype's files (their text is read verbatim, so they carry no per-file
  header); `locale/` words the plugin for the host in the prototype's two languages.
- The plugin ships as the default payload `packages/package-manager/bundled-plugins/superagent`, built from this
  package (`pnpm --filter @agnes/package-manager build:superagent-payload`); `package.json` here declares the same plugin
  row and bundles the payload declares.
- Imports use `.js` suffixes, the code is formatted by Biome, and it compiles with `exactOptionalPropertyTypes`.
