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

Credentials use `secret://namespace/name` references. File, environment, and vault adapters are different deployment options. Do not copy fake demo tokens into real services or expose real values in browser `publicConfig`, tool output, or environment dumps.

<a id="skills-同名优先级覆盖"></a>

## Same-name Skill priority overrides

Default source priorities are workspace 500, runtime 450, AGH user 400, agents 300, claude 200, codex 100, and package 50. Users can set integer overrides from 50 to 500 for non-runtime candidates, or `null` to restore the source default. This data is stored by profile/resourceId in the resource-control journal and applied through worker control snapshots. It is not a new profile YAML field; do not edit the journal manually.

Saving compares content `expectedRevision` and current `expectedPriority`, without changing trust/desired. Name resolution selects a winner by priority, then evaluates its own authorization. Disabling a higher-priority item does not automatically activate a lower-priority one. See [Skills](../guide/skills.md#change-same-name-candidate-priority) and the [resource schema](../../packages/protocol/schema/resource-control.json).

<a id="插件配置不是-profile-顶层任意键"></a>

## Plugin configuration has its own contract

Ordinary plugin defaults come from `agnes.plugins[].config` and are validated by the exported `Config`. Assembly interfaces handle deployment/user/workspace row overrides. Do not invent a top-level `plugins:` key that the parser does not support. See the [plugin tutorial](../develop/plugins.md) for package entry points, configuration, and inject/provide shapes.

Source: [input merging](../../packages/host/src/profile/inputs.ts), [resolution](../../packages/host/src/profile/resolve.ts), [configuration store](../../packages/host/src/configuration.ts), [daemon identity](../../packages/daemon/src/supervisor/scope.ts), [daemon limits](../../packages/daemon/src/config.ts).
