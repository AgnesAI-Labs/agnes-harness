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

<a id="profile-可配置面"></a>

## Profile fields

| Field | Content and constraints |
| --- | --- |
| `name`, `schemaVersion`, `extends` | Identity, version, inheritance; current templates use schemaVersion 1 |
| `packages` | Sources, enablement, configuration; PackageManager still owns installation and trust |
| `seams` | Ownership of required seam implementations; not an unrestricted plugin registration API |
| `provider` | package/adapters/routes/catalog/contract; route name `default` is a reserved sentinel |
| `adapters` | storage/fs/exec/platform/secrets selection |
| `transports` | stdio/unix/ws-tls; remote configuration also needs certificates and authentication |
| `dataDir`, `cacheDir` | Data/cache locations; changes may alter shared-instance identity |
| `presets` | default and allowed; the default must be allowed |
| `approvals.mode` | manual/smart/off |
| `reconcile` | immediate/turn/step; maxWaitMs applies only to turn/step |
| `policy.capabilityCeiling` | Capability ceiling; excludes services by default |
| `policy.workspacePackages` | deny or require-project-trust |
| `computerUse` | Enablement, application access, capture, and retention limits |
| `extensionIsolation` | Isolation requests and unavailable behavior; declaration alone does not prove enforcement |
| `limits` | Supported dotted keys for daemon/worker/jobs/shutdown and other limits |

Check the full [profile schema](../../packages/protocol/schema/profile.json), [implementation types](../../packages/host/src/profile/types.ts), [local-dev template](../../packages/host/templates/local-dev.yaml), and [enterprise template](../../packages/host/templates/enterprise.yaml). Valid schema is only the first gate; policy and assembly can still refuse a configuration.

<a id="模型与密钥"></a>

## Models and secrets

The configuration service supports account lists, per-account routes, and a default account. Routes may look like `account-...`. Select the route/model returned by the interface; do not assume all accounts for a provider share one route. Catalogs and contracts determine capabilities, and saving validates the selected model. New defaults do not rewrite existing sessions.

Web account settings can save `defaultSettings` for the chosen model: `thinking` uses the levels that its installed adapter advertises, and `contextWindow` is a session context budget in tokens, no larger than catalog capacity. New writes require a safe integer of at least 2,048 tokens (or the full catalog capacity for a smaller model). New sessions snapshot these defaults. Session changes are persisted separately and survive reopening and forking; changing account defaults does not overwrite them. The budget controls Harness context accounting and compaction, independently of `model.max_tokens`, and cannot increase provider capacity. For reduced budgets, reserve is capped at one quarter of the selected budget, and recent history at half the remaining budget; neither is scaled by the ratio to catalog capacity. Automatic sizing retains the preset policy when it fits. A summary uses the compaction model's capacity and output limit rather than inheriting the primary session's reduced budget. Before sending a request or summary, Harness checks that a reduced budget can fit the estimated fixed instructions, tool schemas and reserve; otherwise it stops with a budget error and asks you to increase the budget or restore automatic sizing. Older saved budgets remain readable and can be corrected.

The compaction threshold is the session budget minus reserved tokens. Context can reach this threshold while still below the full budget. When no earlier messages can be safely compacted, the budget approval names this threshold and suggests increasing the budget or restoring automatic sizing.

API clients use `_agnes/v1/session.setModel` with optional `thinking` and `contextWindow`. For the same model, omitted fields preserve the session's current values; `thinking: null` resets to provider automatic reasoning, and `contextWindow: null` resets to catalog capacity. `_agnes/v1/config.save` and OAuth `commit` accept `defaultSettings`; omission preserves saved defaults, while `{}` clears them. Capability metadata and saved defaults are returned by configuration and model-list APIs; effective session settings are returned in the usage projection.

### JevLoop per-stage model slots

A preset may bind each JevLoop language stage to its own model slot with `model.jev_language_slots` (`parameters`, `arbitration`, `answer`; each a protocol slot name, omitted stages stay on `primary`):

```yaml
model:
  route: { primary: gw, fast: gw, escalation: gw }
  id: { primary: answer-model, fast: param-model, escalation: arb-model }
  thinking: { escalation: high }
  jev_language_slots: { parameters: fast, arbitration: escalation, answer: primary }
```

Every stage then resolves route, model, thinking and context window through its bound slot: an authorized `session.setModel` on that slot moves only the stages bound to it, and per-slot thinking levels apply independently. The mapping itself is only the deployment default — `_agnes/v1/session.setJevStages` binds a stage directly to a route/model (plus an optional thinking level) for one session, or clears it back to the preset slot with `null`; the binding is audited, survives reopening and takes effect for that stage's next request, with no preset edit involved. The read-only `_agnes/v1/session.modelSlots` RPC returns the live resolved slot state, the effective stage mapping (defaults included) and any direct stage bindings without opening or resuming a session. `_agnes/v1/comparison.create` accepts the same bindings as `jevStages` on a JevLoop lane (`left`/`right`), refused on any other runtime. Cost note: stages on different models no longer share one prompt-cache namespace, so each cold stage pays its own full-prefix reads — the split pays off when arbitration is the rare path, not the common one. See [Runtime loops](../guide/runtime-loops.md#jevloop).

Credentials use `secret://namespace/name` references. File, environment, and vault adapters are different deployment options. Do not copy fake demo tokens into real services or expose real values in browser `publicConfig`, tool output, or environment dumps.

An exported [preset definition](../../packages/protocol/schema/preset.json) may set `model.max_tokens` to a positive safe integer, for example `model: { max_tokens: 32768 }`. This sets the primary model's per-request output allowance, independently of catalog capacity; omitting it preserves the provider default. Request hooks may override it, and tree budgets may lower it. Use a value supported by the selected provider. This field belongs to the preset definition, not the profile's `presets` selection or a top-level profile `model` field. Existing sessions retain their resolved preset.

A preset's `tools.output_max_bytes` (integer, 4096 to 1048576, default 32768) sets how much of one tool result the model sees before the output guard cuts it. The guard keeps the first half and the last eighth of that budget; the full text is stored, and the cut result names it by an `artifact://…` path that `read` and `grep` accept, so the rest can be read back. `read` pages by the same limit. A larger value gives the model more per result and puts more into the context and the session ledger until compaction, so raise it deliberately; a smaller one, down to the 4096 floor, keeps results short. Sessions that are already open keep the value they resolved at the start.

For the official Agnes China gateway, the adapter explicitly sends the built-in models' catalog allowance of 65536 as `max_tokens` when no request override is present. Official specifications list 65536 for [3.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-30-flash), [2.5 Pro](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro), and [Pro Alpha](https://agnes-ai.com/zh-Hans/docs/agnes-25-pro-alpha). [Pro Beta](https://agnes-ai.com/en/docs/agnes-25-pro-beta) uses the Pro family allowance of 65536; its gateway capacity has not been independently verified. The [2.5 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-25-flash) and [2.0 Flash](https://agnes-ai.com/zh-Hans/docs/agnes-20-flash) docs publish a rounded 65.5K, interpreted here as 65536. Deprecated models remain registered for configuration compatibility; gateway availability still applies. Explicit request allowances take precedence. Catalog metadata alone does not set the raw OpenAI-compatible stream's request allowance. Large generated files should still be built across multiple small write/edit calls; the default is an allowance, not a guarantee that an arbitrarily large call completes.

The preset's `subagent.tree_budget_credits` distinguishes three policies: omit it or write `default`
to retain the existing 20-credit default for a newly delegated tree, use a number for a finite cap,
or explicitly write `unlimited` to add no new tree cap. Raw `null` is invalid; the internal legacy
nullable view retains default behavior. Inheritance preserves an omitted field, while `default` and
`unlimited` explicitly override an inherited preset value. Neither changes finite caps already
persisted on ancestor scopes or explicit positive-integer `subagent_spawn.budget` child caps.
Zero is not unlimited; it cannot admit a tree-credit reservation. Credits are accounting units and
must not be presented as dollars. Ordinary `standard` sets both policies to `null` / `unlimited`, so
a normal task never needs a price estimate; `standard-no-credit-cap` remains a compatibility name for
that policy. A custom preset that writes a positive cap opts back into the monetary checks.

## Custom OpenAI-compatible accounts

In Web **Settings → Models and accounts → Add account**, select **Custom OpenAI-compatible service** (`custom-openai`). Enter the service's Base URL, API key and manual model ID; choose Chat Completions or Responses. Declare context capacity, maximum output, text/image inputs, reasoning and native OpenAI tool calling explicitly. Maximum output cannot exceed capacity. A model listing is not evidence for these capabilities. The connection test uses the runtime adapter for bounded streaming inference on the selected ID and works without `/models`; it does not verify tool calling or image support. Unknown prices remain unknown, not zero-cost estimates. On save, a verified custom account also attempts a bounded authenticated GET of `<Base URL>/model/info`. LiteLLM-style USD-per-token prices from an HTTPS metadata source are matched by exact model ID and converted to per-million-token estimates. All deployments for that ID must agree; conditional/tiered or other unrecognized charges remain unknown. Missing rates stay unknown and explicit zero rates remain zero. A denied, unsupported, malformed or timed-out metadata request does not block saving. Sanitized rates and their source/date are persisted per account and model; runtime loading performs no price fetch. Re-saving refreshes this snapshot, and unavailable metadata clears its estimates rather than silently retaining stale prices. Calls freeze their own quote at admission; new prices never rewrite historical quotes or gateway invoices. For an existing custom API-key account, `config.account({accountId, action: "refresh-prices", expectedRevision})` refreshes only its price snapshot using the saved endpoint and credential. It preserves model declarations, defaults, credentials and other accounts, and performs no inference or capability verification; ordinary saves still run the full connection checks.

Use **Get model list** to read the service's bounded authenticated `/models` directory, select a default ID, and **Import model IDs** to add the returned IDs to this account. Imported models share the capability and capacity declarations you explicitly set on the page; the directory supplies no capability or price evidence. Saving verifies inference for the selected default model, not every imported ID. Services without `/models` still support manual IDs. The SDK's `config.discover` returns directory-only evidence with `verified: false`; it uses `config.test` with `catalogueOnly: true` and does not persist anything.

For Chat Completions, testing reports ordinary inference and acceptance of `system → user → assistant → system → user` separately. The result identifies the tested endpoint, protocol and model; changing connection or model declarations invalidates the page's result. A failed system-history check does not block saving an ordinary account unless that capability is declared.

For JevLoop language calls, explicitly declare that the service preserves **mid-conversation system message order**. New custom accounts leave this declaration off. Successful inference verifies acceptance, not whether a gateway internally merges, drops or reorders messages; the test never enables the declaration automatically. Confirm ordering from the service's contract or implementation evidence. Saving re-runs the checks against the current configuration and requires the system-history check to pass when declared. Responses skips this check and does not support this Jev history path. The optional `config.test.customVerification` result uses fixed failure reasons and always reports `ordering: unverified`; it never returns raw upstream errors or credentials. Cloudflare Jev reuses the configured System One estimate (input 0.042 USD, output 0 per million tokens, charged as total input) under operator policy; it is a configured estimate, not a Cloudflare bill. Monetary caps are opt-in, so ordinary tasks run without price evidence.

Non-secret declarations are saved with the account in `configuration.json`; keys remain in the current home's credential store and are not returned by configuration reads. Changing the target or protocol requires an explicitly entered key; editing declarations invalidates the page's previous test result. New account defaults do not change existing sessions.

## Jev decision service

Use Web **Settings → Jev decision service**, or the Jev plugin's **Configure Jev** shortcut. This public setting is available without installing that plugin. Select the decision backend **Jev** or **Local Laya (experimental)**, then test and save. Jev supports native HTTP or Cloudflare Workers AI. Cloudflare requires a 32-character lowercase hexadecimal Account ID, Bearer token and the fixed `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run` endpoint; its default model is `typesafe/jev`. Do not use a supplier's test account in production. Native HTTP supports explicit Bearer or no authentication.

Local Laya uses native HTTP only. Start its independent service first, then use `http://127.0.0.1:8791/v1/systemone`, model `multilingual`, and explicitly select no authentication for an anonymous service. A protected Laya service requires its own Bearer key; switching backends cannot reuse a saved Jev key implicitly. The language model account remains unchanged, and the runtime is still JevLoop. Laya never inherits `TYPESAFE_API_KEY` or falls back to a cloud decision endpoint. See [local startup and current limits](../guide/runtime-loops.md#local-laya).

Both targets can be saved side by side: saving one backend never overwrites the other target or its credential reference. After a restart the runtime catalog publishes which decision backends booted, the default, and each backend's unavailability; a configured default that cannot boot resolves once, at boot, to the remaining assembled target. Each turn may override the default: the composer's per-round decision selector (JevLoop sessions and the JevLoop side of a comparison) submits the choice with the input, the durable queue binds it to that input, and a retry of the same command id must repeat the same choice. A running turn never switches mid-flight — steering cannot change the current turn's backend. Choosing an unavailable backend is rejected before the input is consumed; there is no fallback to the other backend. The decision graph and request viewer label every recorded request with its actual backend (Jev, Laya, or the language model) from the ledger, not from current UI state.

The profile-scoped `jev-configuration.json` contains revisioned settings and a credential reference only. Reads never return tokens. Optional positive per-request credits are separate from token usage and control admission only. Tests send one synthetic scoring request without saving or starting an agent. Conflicting revisions require refreshing the page before another save.

Save feedback is shown in the fixed action footer rather than hidden below the scrolling form. A successful save refreshes the runtime list: an unavailable Jev worker reports that its configuration is saved and a daemon restart is required, without being marked available. An active environment override instead instructs you to check that configuration before restarting.

**Manually restart the daemon after saving Jev.** A running daemon freezes its configuration for all worker generations; old credential references remain valid for its running workers. Saving neither restarts processes nor changes active sessions. Embedded Hosts freeze at creation. Startup precedence is explicit Host options, then explicit Jev environment configuration, then saved profile settings. A partial environment configuration makes Jev unavailable instead of mixing it with a saved token; the HTTP/2 toggle alone is not a target override. Configuration errors disable Jev without disabling Native.

## Task step limits

Normal tasks have no cumulative step ceiling. The Core default and the shipped `base`, `standard`, and `claw` presets use `budget.max_steps: null`; they no longer stop after 50, 80, or 200 steps. A step is one primary model iteration and may contain multiple tool calls. Completion, cancellation, provider failures, per-request timeouts, loop-hygiene checks, and any explicitly configured monetary cap still apply. The frozen `minimal-rl` evaluation preset retains its explicit 100-step ceiling.

In an exported preset definition, `budget: { max_steps: null }` disables the ceiling, including an inherited ceiling. A positive integer such as `budget: { max_steps: 80 }` opts into a per-turn ceiling and still ends with `max_steps` when exhausted. Zero, negative numbers, fractions, and strings are invalid. Omission inherits the parent's setting; without an inherited setting, the default is no ceiling. This is a preset field, not a profile `limits` key.

Already-open sessions keep their in-memory resolved preset. Restart the service and reopen the session, or start a new session, to resolve the updated defaults. Custom presets with explicit numeric ceilings keep those ceilings. Extensions replacing the Budget segment must handle `maxSteps: null` as an absent step ceiling. The internal run-loop guard bounds consecutive edges without a committed program-counter change rather than total task steps, so a progressing task does not spend its allowance.

<a id="skills-同名优先级覆盖"></a>

## Same-name Skill priority overrides

Default source priorities are workspace 500, runtime 450, AGH user 400, agents 300, claude 200, codex 100, and package 50. Users can set integer overrides from 50 to 500 for non-runtime candidates, or `null` to restore the source default. This data is stored by profile/resourceId in the resource-control journal and applied through worker control snapshots. It is not a new profile YAML field; do not edit the journal manually.

Saving compares content `expectedRevision` and current `expectedPriority`, without changing trust/desired. Name resolution selects a winner by priority, then evaluates its own authorization. Disabling a higher-priority item does not automatically activate a lower-priority one. See [Skills](../guide/skills.md#change-same-name-candidate-priority) and the [resource schema](../../packages/protocol/schema/resource-control.json).

<a id="插件配置不是-profile-顶层任意键"></a>

## Plugin configuration has its own contract

Ordinary plugin defaults come from `agnes.plugins[].config` and are validated by the exported `Config`. Assembly interfaces handle deployment/user/workspace row overrides. Do not invent a top-level `plugins:` key that the parser does not support. See the [plugin tutorial](../develop/plugins.md) for package entry points, configuration, and inject/provide shapes.

Source: [input merging](../../packages/host/src/profile/inputs.ts), [resolution](../../packages/host/src/profile/resolve.ts), [configuration store](../../packages/host/src/configuration.ts), [daemon identity](../../packages/daemon/src/supervisor/scope.ts), [daemon limits](../../packages/daemon/src/config.ts).
