# Configuration reference

English | [简体中文](configuration.zh-CN.md)

<a id="配置参考"></a>

[Documentation](../README.md) · [First-time configuration](../guide/quickstart.md)

Find where settings live, which layer applies them, and which fields are managed by a service. For first-time model setup, use the [quickstart](../guide/quickstart.md) without reading every configuration field first.

Configuration files and model credentials are separate. Prefer CLI `config` or Web settings for providers. Do not write keys into YAML or manually edit a configuration-service revision.

<a id="位置与层级"></a>

## Locations and layers

| Location / variable | Meaning |
| --- | --- |
| `AGH_HOME` | Absolute home root, default `~/.agh`; relative paths are rejected |
| `AGNES_HOME` | Legacy compatibility variable with a deprecation warning; AGH_HOME takes precedence, with no automatic migration |
| `AGNES_PROFILE` / `--profile` | Profile selection, usually `local-dev` |
| `AGH_HOME/profiles/NAME/profile.yaml` | User profile layer |
| `AGH_HOME/profiles/NAME/configuration.json` | Accounts, default model, and references managed by the Host configuration service; not a manual configuration template |
| `PROJECT/.agh/profile.local.yaml` | Workspace overrides, subject to trust and permissions |
| `PROJECT/.agh/skills` / `PROJECT/.agh/hooks.json` | Workspace Skill and command-hook resources |
| `AGH_HOME/data`, `cache`, `secrets`, `auth` | Data, cache, credentials, and identity state |
| `AGNES_WEB_ORIGIN` | Exact Web Origin, for example `http://127.0.0.1:4180`, matching the serve port |

Built-in templates provide the base. User profiles and the Host configuration overlay are merged, then the workspace local layer is processed according to trust. Deployment and lockfiles also affect resolution. Configuration-service keys have their own user-layer override rules, rather than arbitrary YAML deep merging. Changing cwd alone does not select another daemon.

## Deployment networking

The official model adapters, MCP HTTP/SSE transports, URL/npm/git package downloads and OTLP HTTP export honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (lower-case names take precedence). HTTPS falls back to the HTTP proxy when no HTTPS proxy is configured. `NO_PROXY` bypasses matching hosts; explicit empty lower-case values override upper-case ones. Restart the daemon after changing its environment. `agnes doctor network` reports only effective proxy hosts/ports and whether exclusions are configured, without userinfo or query strings. Workspace `web_fetch` retains its separate public-network policy.

In **Settings → Models → account details**, keep using Base URL for an account endpoint override. The schema-rendered network fields configure optional `networkTimeouts.requestMs`, `connectMs` and `streamIdleMs` (integer milliseconds, 1–3600000). These fields also exist on configuration save/OAuth commit inputs and `provider.routes[]`. Empty fields use defaults: request 300000 ms, connection 10000 ms, stream idle 60000 ms; existing stricter model/turn deadlines still apply. `{}` resets saved overrides. Changes apply to newly assembled sessions; they do not retarget an in-flight request. Stream idle measures gaps in transport/model output, and cancellation clears timers and aborts pending work. Codex uses SSE transport to apply the same proxy and deadline settings. Custom community adapters own their own transport behavior.

<a id="profile-可配置面"></a>

## Profile fields

| Field | Content and constraints |
| --- | --- |
| `name`, `schemaVersion`, `extends` | Identity, version, inheritance; current templates use schemaVersion 1 |
| `packages` | Sources, enablement, configuration; PackageManager still owns installation and trust |
| `seams` | Ownership of required seam implementations; not an unrestricted plugin registration API |
| `provider` | package/adapters/routes/catalog/contract; route name `default` is a reserved sentinel |
| `adapters` | storage/fs/exec/platform/secrets selection |
| `persistence` | `{ provider: id }`. Default `sqlite`, and that default is omitted from the resolved profile. User profile only. Changing it is restart-required. The profile schema and Host user-layer validation accept this field. |
| `transports` | stdio/unix/ws-tls; remote configuration also needs certificates and authentication |
| `dataDir`, `cacheDir` | Data/cache locations; a running canonical-home daemon rejects incompatible profile/data-directory configuration |
| `presets` | default and allowed; the default must be allowed |
| `approvals.mode` | manual/smart/off/auto-review |
| `reconcile` | immediate/turn/step; maxWaitMs applies only to turn/step |
| `policy.capabilityCeiling` | Capability ceiling; current local-dev and enterprise templates include services |
| `policy.workspacePackages` | deny or require-project-trust |
| `computerUse` | Enablement, application access, capture, and retention limits |
| `extensionIsolation` | Isolation requests and unavailable behavior; declaration alone does not prove enforcement |
| `limits` | Supported dotted keys for daemon/worker/jobs/shutdown and other limits |
| `sandbox.provider` | Startup sandbox provider id, default `local`. Changing it requires a process restart. See [Sandbox providers](../guide/sandbox-providers.md) |

Check the full [profile schema](../../packages/protocol/schema/profile.json), [implementation types](../../packages/host-common/src/profile/types.ts), [local-dev template](../../packages/host-common/templates/local-dev.yaml), and [enterprise template](../../packages/host-common/templates/enterprise.yaml). Valid schema is only the first gate; policy and assembly can still refuse a configuration.

<a id="模型与密钥"></a>

## Models and secrets

The configuration service supports account lists, per-account routes, and a default account. Routes may look like `account-...`. Select the route/model returned by the interface; do not assume all accounts for a provider share one route. Catalogs and contracts determine capabilities, and saving validates the selected model. New defaults do not rewrite existing sessions.

Web account settings can save `defaultSettings` for the chosen model: `thinking` uses the levels that its installed adapter advertises, and `contextWindow` is a session context budget in tokens, no larger than catalog capacity. New writes require a safe integer of at least 2,048 tokens (or the full catalog capacity for a smaller model). New sessions snapshot these defaults. Session changes are persisted separately and survive reopening and forking; changing account defaults does not overwrite them. The budget controls Harness context accounting and compaction, independently of `model.max_tokens`, and cannot increase provider capacity. For reduced budgets, reserve is capped at one quarter of the selected budget; neither it nor the recent history is scaled by the ratio to catalog capacity. The recent history kept by a compaction is capped at half of what remains below the threshold after the estimated fixed instructions and tool schemas, so the first request after a compaction lands below the threshold. Automatic sizing retains the preset policy when it fits. A summary uses the compaction model's capacity and output limit rather than inheriting the primary session's reduced budget. Before sending a request or summary, Harness checks that a reduced budget can fit the estimated fixed instructions, tool schemas and reserve; otherwise it stops with a budget error and asks you to increase the budget or restore automatic sizing. Older saved budgets remain readable and can be corrected.

The compaction threshold is the session budget minus reserved tokens. Context can reach this threshold while still below the full budget. When no earlier messages can be safely compacted, the budget approval names this threshold and suggests increasing the budget or restoring automatic sizing. If the summary request itself cannot work (bad credentials, exhausted quota, a misconfigured compaction model), automatic compaction is retried after a growing number of turns, up to eight; once the context is within half the reserve of the budget, the turn stops with `COMPACTION_UNAVAILABLE` and the reason instead of growing past it.

API clients use `_agnes/v1/session.setModel` with optional `thinking` and `contextWindow`. For the same model, omitted fields preserve the session's current values; `thinking: null` resets to provider automatic reasoning, and `contextWindow: null` resets to catalog capacity. `_agnes/v1/config.save` and OAuth `commit` accept `defaultSettings`; omission preserves saved defaults, while `{}` clears them. Capability metadata and saved defaults are returned by configuration and model-list APIs; effective session settings are returned in the usage projection.

Credentials use `secret://namespace/name` references. File, environment, and vault adapters are different deployment options. Do not copy fake demo tokens into real services or expose real values in browser `publicConfig`, tool output, or environment dumps.

An exported [preset definition](../../packages/protocol/schema/preset.json) may set `model.max_tokens` to a positive safe integer, for example `model: { max_tokens: 32768 }`. This sets the primary model's per-request output allowance, independently of catalog capacity; omitting it preserves the provider default. Request hooks may override it, and tree budgets may lower it. Use a value supported by the selected provider. This field belongs to the preset definition, not the profile's `presets` selection or a top-level profile `model` field. Existing sessions retain their resolved preset.

A preset's `tools.output_max_bytes` (integer, 4096 to 1048576, default 32768) sets how much of one tool result the model sees before the output guard cuts it. The guard keeps the first half and the last eighth of that budget; the full text is stored, and the cut result names it by an `artifact://…` path that `read` and `grep` accept, so the rest can be read back. `read` pages by the same limit. A larger value gives the model more per result and puts more into the context and the session ledger until compaction, so raise it deliberately; a smaller one, down to the 4096 floor, keeps results short. Sessions that are already open keep the value they resolved at the start.

A preset's `tools.timeout_ms` (integer, at least 1000, default 120000) bounds ordinary tool calls; `tools.timeouts` overrides that bound by tool name. The shipped base preset allows `shell` up to 600000 ms. The shell's `timeoutMs` selects its foreground wait within the admitted deadline. By default a command that outlasts that wait becomes a background job; `background: true` starts one immediately, and `timeoutToBackground: false` requests termination instead. Inspect the returned job identity and actual state with `job_output`; a tool response is not proof that a background process finished. Cancellation and session close kill owned processes. Existing sessions retain their resolved preset. See [default tools](default-tools.md).

For the official Agnes China gateway, the adapter explicitly sends the built-in models' catalog allowance of 65536 as `max_tokens` when no request override is present. Official specifications list 65536 for [3.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-30-flash), [2.5 Pro](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro), and [Pro Alpha](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro-alpha). [Pro Beta](https://agnes-ai.com/en/docs/agnes-25-pro-beta) uses the Pro family allowance of 65536; its gateway capacity has not been independently verified. The [2.5 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-25-flash) and [2.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-20-flash) docs publish a rounded 65.5K, interpreted here as 65536. Deprecated models remain registered for configuration compatibility; gateway availability still applies. Explicit request allowances take precedence. Catalog metadata alone does not set the raw OpenAI-compatible stream's request allowance. Large generated files should still be built across multiple small write/edit calls; the default is an allowance, not a guarantee that an arbitrarily large call completes.

## Task step limits

Normal tasks have no cumulative step ceiling. The Core default and the shipped `base`, `standard`, and `claw` presets use `budget.max_steps: null`; they no longer stop after 50, 80, or 200 steps. A step is one primary model iteration and may contain multiple tool calls. Completion, cancellation, provider failures, per-request timeouts, credit checks, and loop-hygiene checks still apply. The frozen `minimal-rl` evaluation preset retains its explicit 100-step ceiling.

In an exported preset definition, `budget: { max_steps: null }` disables the ceiling, including an inherited ceiling. A positive integer such as `budget: { max_steps: 80 }` opts into a per-turn ceiling and still ends with `max_steps` when exhausted. Zero, negative numbers, fractions, and strings are invalid. Omission inherits the parent's setting; without an inherited setting, the default is no ceiling. This is a preset field, not a profile `limits` key.

Already-open sessions keep their in-memory resolved preset. Restart the service and reopen the session, or start a new session, to resolve the updated defaults. Custom presets with explicit numeric ceilings keep those ceilings. Extensions replacing the Budget segment must handle `maxSteps: null` as an absent step ceiling. The internal run-loop guard bounds consecutive edges without a committed program-counter change rather than total task steps, so a progressing task does not spend its allowance.

<a id="skills-同名优先级覆盖"></a>

## Same-name Skill priority overrides

Default source priorities are workspace 500, runtime 450, AGH user 400, agents 300, claude 200, codex 100, and package 50. Users can set integer overrides from 50 to 500 for non-runtime candidates, or `null` to restore the source default. This data is stored by profile/resourceId in the resource-control journal and applied through worker control snapshots. It is not a new profile YAML field; do not edit the journal manually.

Saving compares content `expectedRevision` and current `expectedPriority`, without changing trust/desired. Name resolution selects a winner by priority, then evaluates its own authorization. Disabling a higher-priority item does not automatically activate a lower-priority one. See [Skills](../guide/skills.md#change-same-name-candidate-priority) and the [resource schema](../../packages/protocol/schema/resource-control.json).

<a id="插件配置不是-profile-顶层任意键"></a>

## Plugin configuration has its own contract

Ordinary plugin defaults come from `agnes.plugins[].config` and are validated by the exported `Config`. Assembly interfaces handle deployment/user/workspace row overrides. Do not invent a top-level `plugins:` key that the parser does not support. See the [plugin tutorial](../develop/plugins.md) for package entry points, configuration, and inject/provide shapes.

Source: [input merging](../../packages/host/src/runtime/profile/inputs.ts), [resolution](../../packages/host-common/src/profile/resolve.ts), [configuration store](../../packages/host-infrastructure/src/configuration.ts), [daemon identity](../../packages/daemon/src/supervisor/scope.ts), [daemon limits](../../packages/daemon/src/supervisor/config.ts).
