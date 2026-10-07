# 组合包与配置

[English](bundles-and-profiles.md) | 简体中文

[文档](../README.zh-CN.md) · [插件类型](README.zh-CN.md) · [包管理](../guide/packages.zh-CN.md)

Profile 从插件装配应用；bundle 把可复用的 profile 补丁和 preset 打包成静态数据。安装组合包不会执行入口模块，也不会授予权限。安装、完整性校验、信任与启用仍是独立步骤。

## 格式与选择

在 `package.json` 声明 `agnes.kinds: ["bundle"]` 和 `agnes.bundles`。标识为 `<package-id>#<bundle-name>`，名称以小写字母开头，可包含小写字母、数字和连字符。每个文档接受 `extends`、`profile` 和 `presets`。参见 [research 示例](../../examples/bundles/research/README.md)；英文格式示例可通过页首语言切换查看。

在用户 profile 中选择：

```yaml
bundles: ["@agnes-example/research-bundle#research"]
composition:
  toolPolicy:
    readOnly: true
```

Host 只读取已启用、已信任且完整性校验通过的已安装包。包引用不会自动下载、信任或启用依赖。本版本不支持发现工作区组合包。

编译顺序是父 bundle、子 bundle、直接 profile composition、兼容的顶层选择、preset、admin、session。每个继承基包只应用一次；循环与未知标识会报错。后选的 bundle 覆盖前面的选择。admin 选择独立保存，带 revision 校验，重启后用于装配。

| 字段 | 含义 |
| --- | --- |
| `loop` | 精确的 `{id, version}` |
| `modelAdapters` | 必需的注册 id；通过包或插件行控制注册启用 |
| `compaction` | `{engine}`；`null` 关闭压缩 |
| `persistence`、`sandbox` | `{provider}`，使用对应 Host 目录；默认为 `sqlite` 和 `local` |
| `packages` | 按 id 合并包引用；仍受 lock、信任和能力上限约束 |
| `plugins` | 普通插件行 id 对应 `{enabled, config}`；config 整体替换 |
| `toolPolicy` | `readOnly`、精确名称的 `allow` 和 `deny`；deny 优先 |
| `tools` | 工具调用集合；省略或空数组保留已有集合 |
| `mcp`、`skills` | 必需的已启用包 id；通过包和行开关控制资源激活 |
| `uiModules` | 必需的 UI 模块 id；嵌入方提供目录后校验 |

数组整体替换，包引用按 id 合并，工具策略与各插件行按字段合并。拒绝保留对象键和非 JSON 数据。composition 不能越过包的信任或禁用状态。普通行的 composition 位于部署默认值之后、显式用户/工作区行覆盖之前。

bundle 提供的 preset 使用已有继承规则，并可加入 `bundles` 与 `composition` 字段。这些 preset 加入 profile 的允许列表。新会话选择 preset 后采用其 loop 和调用策略。

## 查看与管理

```sh
agh config dump --profile local-dev --preset research
```

本地命令读取与启动相同的 profile、lock 和已保存配置，不导入插件入口、不调用模型。结果含待启动树、preset、bundle、包选择、稳定 hash 和来源 `sources`。来源层为 `default/profile/preset/admin/session`。任意包/插件配置和凭据不会输出。

插件 admin 页可选择组合包，按覆盖顺序勾选、保存后重启。解释按钮显示默认 preset 的待启动配置。接口沿用精确 Origin/Host 校验：

- `GET /admin/api/bundles`：目录、选择、revision 和重启要求。
- `PUT /admin/api/bundles`：`{revision, bundles}`，需要 `packages.activate` 和可写上下文。
- `GET /admin/api/composition`：默认 preset；`POST` 接受 `{preset}`，需要 `packages.read`。

过期 revision 拒绝写入。dump 标明 `status: "desired"` 和 `validation: "static"`；离线查看不能证明可执行注册有效，也不枚举入口动态创建的注册。Host 在接受组合启动前校验真实 loop、adapter、compaction、persistence 和 sandbox 目录；未知 id 或依赖压缩却未启用引擎会报错。

## 生命周期边界

`resolveComposition(profile, {preset, admin, session, rows, catalog})` 是纯编译器。嵌入方可提供工具、UI 和 provider 目录以校验这些 id。`profileForComposition(profile, tree)` 把树编译为独立且不可变的 Host profile，供按 generation 接入会话。

运行中的 Host 支持按 preset 选择 loop 和工具调用策略。压缩、存储、sandbox 和注册集合属于 Host generation。`Host.createSession` 会拒绝改变这些字段的 preset。自动路由到独立 Host generation、hosted-session 接入，以及按组列表过滤资源/UI 尚待集成；嵌入方可先编译并装配独立 profile 再接入会话。

只读策略在每次调用时检查工具元数据与精确名称，也包括 loop 调度的调用。未知元数据不满足只读条件；策略不会放宽已有审批、sandbox、资源信任或网络权限。配置更改不会重写已有会话绑定的 loop 或重新打开存储。
