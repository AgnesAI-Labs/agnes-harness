# 配置参考

[English](configuration.md) | 简体中文

[文档导航](../README.zh-CN.md) · [首次配置](../guide/quickstart.zh-CN.md)

用本页查找配置存在哪里、在哪一层生效，以及哪些字段由管理服务维护。首次配置模型可直接走[快速开始](../guide/quickstart.zh-CN.md)，无需先读完整配置表。

配置文件与模型凭据分离。优先使用 CLI `config` 或 Web 设置修改 Provider；不要手写含密钥的 YAML 或自行编辑配置服务的 revision。

## 位置与层级

| 位置/变量 | 含义 |
| --- | --- |
| `AGH_HOME` | 绝对 home 根，缺省 `~/.agh`；相对路径拒绝 |
| `AGNES_HOME` | 旧兼容变量，有弃用警告；AGH_HOME 优先，无自动迁移 |
| `AGNES_PROFILE` / `--profile` | Profile 选择，通常为 `local-dev` |
| `AGH_HOME/profiles/NAME/profile.yaml` | 用户 profile 层 |
| `AGH_HOME/profiles/NAME/configuration.json` | Host 配置服务管理的账号、默认模型与引用，不能当成手工配置模板 |
| `PROJECT/.agh/profile.local.yaml` | 工作区覆盖，按信任/权限规则使用 |
| `PROJECT/.agh/skills` / `PROJECT/.agh/hooks.json` | 工作区 Skill 与命令 hook 资源 |
| `AGH_HOME/data`、`cache`、`secrets`、`auth` | 数据、缓存、凭据与身份状态 |
| `AGNES_WEB_ORIGIN` | 精确 Web Origin，如 `http://127.0.0.1:4180`，与 serve 端口配对 |

builtin 模板是基础，用户 profile 与 Host configuration overlay 合并，再按工作区信任处理 local 层；部署与锁文件也影响最终解析。配置服务负责的键在用户层具有自己的覆盖规则，不是任意 YAML 深合并。只改变 cwd 不选择另一个 daemon。

## Profile 可配置面

| 字段 | 内容与约束 |
| --- | --- |
| `name`、`schemaVersion`、`extends` | 配置身份/版本/继承；现有模板 schemaVersion 为 1 |
| `packages` | 包来源、启用与配置；实际安装/信任仍由 PackageManager 管理 |
| `seams` | 必要接缝实现归属；不是普通插件自由注册的接口 |
| `provider` | package/adapters/routes/catalog/contract；route 名 `default` 是保留 sentinel |
| `adapters` | storage/fs/exec/platform/secrets 选择 |
| `transports` | stdio/unix/ws-tls，远程配置另需证书与认证 |
| `dataDir`、`cacheDir` | 数据/缓存位置；改变它们可能改变共享实例身份 |
| `presets` | default 与 allowed；默认必须在允许集合中 |
| `approvals.mode` | manual/smart/off |
| `reconcile` | immediate/turn/step；maxWaitMs 仅适用 turn/step |
| `policy.capabilityCeiling` | 能力上限；默认不含 services |
| `policy.workspacePackages` | deny 或 require-project-trust |
| `computerUse` | 启用、应用访问范围、捕获与保留限制 |
| `extensionIsolation` | 隔离请求与不可用处置，不能凭声明证明真实保护 |
| `limits` | daemon/worker/jobs/shutdown 等受支持的点分键 |

完整字段以[Profile Schema](../../packages/protocol/schema/profile.json)、[实际类型](../../packages/host/src/profile/types.ts)、[local-dev 模板](../../packages/host/templates/local-dev.yaml)及[enterprise 模板](../../packages/host/templates/enterprise.yaml)核对。Schema 合法只是第一步，策略与装配可能进一步拒绝。

## 模型与密钥

现行配置服务支持账号列表、每账号 route 和默认账号，账号路由可能为 `account-...`。选择界面返回的 route/model，不假设所有 DeepSeek 账号共享同一路由。Provider/模型能力来自目录和合同，保存时还校验所选项；修改默认值不追溯改写旧会话。

凭据形式为 `secret://namespace/name`；文件/env/vault adapter 是不同部署面。不要将演示配置里的假 token 复制到真实服务，也不要在 browser `publicConfig`、工具输出或环境 dump 中暴露真实值。

## Skills 同名优先级覆盖

默认来源优先级为 workspace 500、runtime 450、AGH user 400、agents 300、claude 200、codex 100、package 50。用户可对非 runtime 候选设置 50–500 的整数覆盖，或传 `null` 恢复来源默认；该数据按 profile/resourceId 保存在资源控制 journal，并随 worker control 快照应用。它不是新 profile YAML 字段，不应手改 journal。

保存同时比较内容 `expectedRevision` 与当前 `expectedPriority`，不会自动修改 trust/desired。同名 winner 先按优先级解析，再按自身授权判定可用；没有“高位禁用就自动启用低位”的保证。操作见[Skills](../guide/skills.zh-CN.md#调整同名候选优先级)，合同见[资源 Schema](../../packages/protocol/schema/resource-control.json)。

## 插件配置不是 profile 顶层任意键

普通插件默认配置来自 `agnes.plugins[].config`，由导出的 `Config` 校验。部署/用户/工作区普通行覆盖由装配接口处理；不要猜一个未被当前解析器接受的顶层 `plugins:` 就会生效。包入口、配置与 inject/provide 的精确形状见[插件教程](../develop/plugins.zh-CN.md)。

源码依据：[输入合并](../../packages/host/src/profile/inputs.ts)、[解析](../../packages/host/src/profile/resolve.ts)、[配置存储](../../packages/host/src/configuration.ts)、[后台身份](../../packages/daemon/src/supervisor/scope.ts)、[daemon limits](../../packages/daemon/src/config.ts)。
