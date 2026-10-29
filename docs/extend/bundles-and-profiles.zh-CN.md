# 组合包与配置

[English](bundles-and-profiles.md) | 简体中文

[文档](../README.zh-CN.md) · [插件类型](README.zh-CN.md) · [包管理](../guide/packages.zh-CN.md)

部署执行 Profile 从插件装配运行能力；Bundle 把可复用的 profile 补丁和执行配方（Preset）打包成静态数据。应用展示由管理员另行采纳，本期不提供执行 Profile 模板采纳。安装组合包不会执行入口模块，也不会授予权限。安装、完整性校验、信任与启用仍是独立步骤。

## 会话工具可见范围

启用发布组合包的 package 后，其 provider 可供选择。该 package 的工具只向选择其组合包（含继承的组合包）或组合包声明的精确 loop 的会话披露并开放执行。Default 会话保留官方工具和显式启用的通用插件。工具 allow/deny、只读、package 和 MCP 过滤继续生效；工具白名单不能授予其他组合包的工具。

编译后的工具归属范围随 composition 和代码 generation 固定，实时资源沿用现有过滤规则。旧保存绑定保留原范围；新建会话可应用隔离。resolved profile 新增可选的 Host 生成字段 `compositionToolScope`，不属于用户 manifest 设置。

Web 设置 → 模型 → 运行配置 → 技术详情 → 所有对话附加组合 → 技术详情中的会话信息列出实际工具组及启用原因。示例工具明确标注其打包 fixture 来源；工作区问题应使用工作区文件读取工具。

## 格式与选择

在 `package.json` 声明 `agnes.provides: ["bundle"]` 和 `agnes.bundles`。标识为 `<package-id>#<bundle-name>`，名称以小写字母开头，可包含小写字母、数字和连字符。每个文档接受 `extends`、`profile` 和 `presets`。参见 [research 示例](../../examples/bundles/research/README.md)。

```json
{
  "name": "acme/research",
  "version": "1.0.0",
  "agnes": {
    "provides": ["bundle"],
    "bundles": {
      "base": { "profile": { "toolPolicy": { "readOnly": true } } },
      "research": {
        "extends": ["acme/research#base"],
        "profile": {
          "providers": {
            "loop": { "provider": "example.dag", "version": "1.0.0" },
            "compaction": { "provider": "sliding-window" }
          }
        },
        "presets": { "research": { "name": "research", "extends": "standard" } }
      }
    }
  }
}
```

在用户 profile 中选择：

```yaml
bundles: ["@agnes-example/research-bundle#research"]
composition:
  toolPolicy:
    readOnly: true
```

Host 只读取已启用、已信任且完整性校验通过的已安装包。包引用不会自动下载、信任或启用依赖。本版本不支持发现工作区组合包。

编译顺序是父 bundle、子 bundle、直接 profile composition、根 persistence/sandbox 选择、preset、admin、session。每个继承基包只应用一次；循环与未知标识会报错。后选的 bundle 覆盖前面的选择。admin 选择独立保存，带 revision 校验，重启后用于装配。

| 字段 | 含义 |
| --- | --- |
| `providers.loop` | 精确的 `{provider, version}` |
| `providers.model-adapter` | `{provider: id}` 或 `{provider: [ids]}` 选择注册 id；通过包或插件行启用注册；空列表保留默认值 |
| `providers.compaction` | `{provider}`；`null` 关闭压缩 |
| `providers.persistence`、`providers.sandbox` | `{provider}`，使用对应 Host 目录；默认为 `sqlite` 和 `local` |
| `packages` | 按 id 合并包引用；仍受 lock、信任和能力上限约束 |
| `plugins` | 普通插件行 id 对应 `{enabled, config}`；config 整体替换 |
| `toolPolicy` | `readOnly`、精确名称的 `allow` 和 `deny`；deny 优先 |
| `tools` | 模型可见且可调用的工具集合；省略或空数组保留默认集合 |
| `mcp` | MCP server id（也接受 `mcp/<server-id>`）或工具的已认证包 id；省略或空数组保留默认集合 |
| `skills` | Skill resource id、名称或已安装包 id；省略或空数组保留默认集合 |
| `uiModules` | 会话可见的客户端 row id、模块名或包 id |
| `surfaces` | 部署 API：`web`、`acp`、`http`；省略保留默认值，`[]` 为 headless |
| `shell` | `{modules, slots}` 筛选可选客户端模块及其 Web slot；显式空列表不加载模块 |

数组整体替换，包引用按 id 合并，工具策略与各插件行按字段合并。拒绝保留对象键和非 JSON 数据。composition 不能越过包的信任或禁用状态。普通行的 composition 位于部署默认值之后、显式用户/工作区行覆盖之前。

bundle 提供的 preset 使用已有继承规则，并可加入 `bundles`、`composition` 与 `providers` 字段；preset 的 `providers` 表还接受 `tool-runtime` 和 `tool-policy`，它的 `composition` 不再携带 provider 块。这些 preset 加入 profile 的允许列表。新会话选择 preset 后采用其 loop 和调用策略。

## 只为一个会话选择

`session/new` 在 `ai.agnes.harness` 元数据里接受一个有序的组合包列表（SDK 为 `client.session.new({ cwd, bundles })`）。它只对这个会话生效：不改部署 profile 和已保存的 admin 选择，也不需要重启。启动之后才安装、信任并启用的包同样可选。

```json
{ "cwd": "/work/site", "mcpServers": [], "_meta": { "ai.agnes.harness": { "bundles": ["acme/research#research"] } } }
```

会话会得到组合包的 `profile` 补丁和它的 `presets`，这些 preset 只对该会话开放。所选组合包恰好提供一个 preset、请求又没有指定时，会话直接使用它；组合包里的 `tool-policy` 选择就是这样作用到会话上的。提供多个时保持部署默认 preset，除非请求用 `preset` 指定其中一个。composition、preset 与策略随会话固定，重新打开时恢复。

组合包可能指定了部署里没有的模型路由，例如示例包的免密钥 demo 路由。以这种方式带入的 preset 会保留它的策略，模型路由改为沿用它继承的设置，和普通新会话一样，而不是被拒绝。在 profile 或 admin 里选择的组合包仍然严格：路由必须存在。

组合包未安装、未启用或未信任时，请求以 `SEMANTIC_REJECTED`、`data.code: "BUNDLE_UNAVAILABLE"` 拒绝。部署和所选组合包都不允许的 preset 以 `PRESET_SWITCH_REJECTED` 拒绝。

## 查看与管理

```sh
agh config dump --profile local-dev --preset research
```

本地命令读取与启动相同的 profile、lock 和已保存配置，不导入插件入口、不调用模型。结果含待启动树、preset、bundle、包选择、稳定 hash 和来源 `sources`。来源层为 `default/profile/preset/admin/session`。`sessions` 另外报告活动会话的 key、generation id、composition hash、preset、bundle 和 provider 选择。任意包/插件配置和凭据不会输出。

插件 admin 页可选择组合包，按覆盖顺序勾选、保存后重启。解释按钮显示默认 preset 的待启动配置。接口沿用精确 Origin/Host 校验：

- `GET /admin/api/bundles`：目录、选择、revision 和重启要求。
- `PUT /admin/api/bundles`：`{revision, bundles}`，需要 `packages.activate` 和可写上下文。
- `GET /admin/api/composition`：默认 preset；`POST` 接受 `{preset}`，需要 `packages.read`。

过期 revision 拒绝写入。有活动会话时 dump 标明 `status: "live"`，否则为 `"desired"`。`validation: "static"` 仍描述待启动树：离线查看不能证明可执行注册有效。活动记录只在 worker 的进程身份仍匹配时显示；身份查询不可用时省略活动状态，不阻止会话运行。Host 校验真实 loop、adapter、compaction、persistence 和 sandbox 目录；未知 id 或依赖压缩却未启用引擎会报错。

## 生命周期边界

`resolveComposition(profile, {preset, admin, session, rows, catalog})` 是纯编译器。嵌入方可提供工具、UI 和 provider 目录以校验这些 id。`profileForComposition(profile, tree)` 把树编译为独立且不可变的 Host profile，供按 generation 接入会话。

`createHost` 自动把选定 preset 编译成对应的 composition 容器。`Host.createSession` 与 hosted-session 接入将会话绑定到该容器的插件 generation，不同 bundle 可在同一 daemon 并行运行。关闭和休眠保留绑定，重开沿用原 composition 与 generation，删除会话才释放两者。子会话继承父会话的 composition。运行中切换 preset 若改变 generation 所属选择会被拒绝；需要另一种 composition 时创建新会话。

工具在模型请求、发现和调用时均受筛选；Skills 的发现、提示词预载、文档与文件读取也受筛选。MCP 工具按 server 前缀或已认证包身份筛选。客户端模块名册及 service 接入结合会话保留的 generation 和模块/slot 选择；只有模块全部声明的 slot 均被选中时才加载。Web 内建对话控件仍由 Web host 提供，`shell` 选择可选插件面板和 slot。

Surface listener 根据默认 preset 在部署启动时选择。`surfaces: []` 让 `agh start` 仅启动 daemon，不创建 Web listener 或静态 Web server，本地 headless SDK 仍可使用。`web` 启用本地 Web，`http` 启用远程 API 传输及包 HTTP surface，`acp` 允许本地 stdio ACP。修改这些选项需要重启。headless 会话不加载可选 Web 模块，也不会停止为其他会话服务的 listener。

完整 runtime target 仍由 generation runtime 管理。composition 将目录投影为各容器的树，并保留 resource-owned 行；全部容器收敛后才确认 delivery，旧会话继续使用固定 generation。`Host.compositionSessions()` 和本地查看接口提供活动 provider 元数据。

只读策略在每次调用时检查工具元数据与精确名称，也包括 loop 调度的调用。未知元数据不满足只读条件；策略不会放宽已有审批、sandbox、资源信任或网络权限。配置更改不会重写已有会话绑定的 loop 或重新打开存储。

## 智能体审阅启动回执

普通智能体启动和受限的示例管理 facade 使用有效期为 300 秒的审阅票据。响应不确定时，重试须保留相同的 `operationId` 和请求内容：在回执保留窗口内，已完成操作返回原回执；不同内容会被拒绝，failed 或 unknown 操作不会再次执行。

回执自进入终态起保留七天，且至少保留到审阅票据失效。中断的 running 操作在票据失效后转为 unknown，再保留七天。没有完成时间的已有终态记录从首次观察起获得七天窗口。prepare/start 写入和读取回执时的机会性清理沿用已有状态锁，每次最多扫描 10,000 条操作。启动或激活持有写锁期间，智能体和示例回执仍可读取。若保留时间戳会让日志超过 16 MiB，则将时间戳写入上限 2 MiB 的 `.dates` 伴随文件，并绑定各条记录的精确内容；复制存储时应同时保留伴随文件。写入中断最多保守延长保留期，不会套用不匹配的时间戳。10,000 条操作的准入上限保持不变；保留记录占满存储时仍以 `OVERLOADED` 拒绝新操作。回执清理后，重试对应的过期票据会被拒绝；新操作需要重新审阅。

开发者示例见[五个机制教学包](../../examples/fde/README.zh-CN.md)。本仓库不提供产品应用，平台机制见[演示脚本](../guide/demos.zh-CN.md)。
