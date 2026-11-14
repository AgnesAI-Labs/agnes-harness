# @agnes/superagent

A proactive agent for one GitHub repository, run as an Agnes plugin: it listens to GitHub (and optionally Feishu),
assesses requests under a policy, turns authorized ones into tickets, and hands each ticket to its own session.
This package is not installed or enabled by default.

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

## Differences from the prototype

- The prototype's cordis, schemastery and DSH subprocess dependencies are replaced by zod and `runCommand`;
  its session-controller types are replaced by local types.
- Databases written by the prototype (schema 10) are not imported. A database starts empty at the current schema, and
  the oldest schema this build opens is that same schema; the version mechanism stays for later schema steps.
- Imports use `.js` suffixes, the code is formatted by Biome, and it compiles with `exactOptionalPropertyTypes`.
