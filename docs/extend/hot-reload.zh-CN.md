# 用热重载开发插件

[English](hot-reload.md) | 简体中文

[作者指南](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [包管理](../guide/packages.zh-CN.md)

对 daemon 启动工作区下的包目录，在 `package.json` 声明源码入口后运行：

```sh
agh dev ./my-plugin --profile local-dev
# 修改源码后：
agh plugins reload my-plugin --profile local-dev
# 或重载所有已启用的本地/file 包：
agh plugins reload --profile local-dev
```

`dev` 检查包，必要时安装，然后信任已检查的版本并启用它。这表示你明确授权执行该本地包。file 来源仍相对于 daemon 启动工作区；CLI 也接受该工作区内的绝对路径。请在同一工作区启动 daemon 和执行命令。身份冲突与检查阻断仍会报错。file 包需要 `package.json`；只有 `plugin.ts` / `plugin.js` 的目录请放到[本地插件目录](local-plugins.zh-CN.md)。

自动重载使用现有的 `<AGNES_HOME>/plugins/<name>` 或 `<workspace>/.agh/plugins/<name>` watcher。它复制修改后的源码，并调用 daemon 的 generation 发布适配器；手动命令也支持这些自动发现的包。删除源目录会停止未来绑定。重载保留禁用选择；启用禁用包请使用 `dev` 或管理页启用操作。

## 会话如何变化

成功激活会发布不可变 generation，包含启用包版本、可执行源码和客户端 bundle。新会话使用新 generation；已有会话保持可执行工具、loop/adapter 选择和前端 bundle URL，休眠、冷恢复以及 daemon/worker 重启后也一样。MCP 定义与 Skills 是实时资源，受会话 composition 与信任过滤；修改在下一轮可见，当前轮保留其快照。禁用或删除 MCP server 后，保留会话的后续轮次也不再提供它。修改源码无需修改版本号。

浏览器按会话获取客户端模块，使用 `/plugins/generations/<generationId>/…` URL；切换到新会话时加载匹配 bundle。重载不会替换运行中会话的 UI，也不在下一轮自动切换其代码。

只要还有持久会话引用，旧 generation 就保留。关闭或休眠不会释放 pin。禁用/卸载停止新绑定，仅回收无引用 generation。管理页显示“排干中 (N)”，也显示已从安装清单移除但仍有绑定的包。`boundSessions` 是所有绑定数，`drainingSessions` 是当前 generation 之外的绑定数。目前没有公开的会话删除命令；后端删除入口必须在实际删除会话后释放 pin。

## 声明实时资源消费

扩展 row 通过公开的 `agnes.extension.json` manifest 声明消费实时 Skills：

```json
{ "liveResources": ["skills"] }
```

可选数组目前支持 `skills`，重复或未知种类会被拒绝。省略或空数组表示资源变化不触发该 row 刷新。声明后，扩展工厂上下文会获得按 composition 过滤、按工作区限定的 Skill 输入；声明不会额外授予 capability，也不会绕过资源信任或读取授权。

Host 刷新所有声明该种类的 row，包括替代插件和第三方扩展 row，同时保留固定代码、配置和禁用状态。代码与实时资源修订使用独立身份；有效修订相同会跳过重新挂载，但全局目录未变的新工作区限定来源仍会替换读取来源。所有受影响 row 一起发布，失败恢复原 row 和资源视图。保留的代码 generation 和冷恢复会使用当前实时资源。

## 哪些需要重启

persistence/storage provider、sandbox 及其他进程基础后端仍标记 `restart-required`，不能被包重载替换。恢复检查部署兼容性与会话已持久化的 loop id/version。代码快照缺失、固定包目录被修改或部署不兼容会产生明确的 `E_GENERATION_*` 错误，不会替换为当前代码。

冷恢复从当前资源取得 MCP 定义、revision 与 SecretRef，连接时才解析密钥，部署 transport 策略继续生效。恢复使用固定代码和当前 Skills，并在初始 MCP 目录同步时有界等待（目前 20 秒）。历史资源归档只作证据，不作为实时读取来源。不变的有效 MCP 配置可在同一 worker 与 opener/policy/credential 边界内共享连接，不跨 worker 或凭据范围共享。

## 恢复边界

稳定 invocation identity 为不确定发送设置栅栏并恢复已有回执，不保证外部副作用的 exactly-once，也不与外部工具组成原子事务。模型已发送但缺少持久完整回执时仍属不确定，必须先协调结果再重放。checkpoint 关联不是外部副作用提交。原子 ledger 提交也不代表每种后端或文件系统都保证断电持久性；这需要后端 fsync 和平台专项验收。详见[合同](../develop/contracts-v0.1.zh-CN.md)。

对于具有 Core 绑定 Loop invocation 身份的工具调用，Core 将 version-1 `x/core/tool-response` 与 `tool/result` 放在同一次 ledger 提交中，保留作者响应的 content（含 artifact 引用）以及可选的 `isError`、`structured`、`details`、`terminate`。驱动回执缺失时优先恢复该表示。旧行只能恢复已持久化的 ledger content、`isError` 和 `structured`，无法重建缺失的作者元数据。Loop invocation 回执必须来自受信 Core 并匹配固定 loop id/version；缺少此绑定的旧回执以 `E_RELATION` 拒绝协调，不会重新发送不确定操作。

Loop `events.emit` 仅接受非保留的 `x/*` 事件，并记录不受信插件来源。助手消息与控制操作应使用 `events.assistant(message, checkpoint)` 等专用端口；直接发射 ledger/control 类型或 `x/core/*` 会被拒绝。

## 嵌入与状态查询

```ts
const result = await host.reloadPlugin?.('my-plugin', '/absolute/source/folder')
// { generationId, changed }；后续可省略目录。
// 也可配置 HostOptions.developmentPluginDirectories 后调用 reloadPlugin(id)。
const status = host.pluginGenerationStatus?.()
// currentGenerationId, generations[{ id, state, boundSessions, packages }],
// plugins[{ id, state, boundSessions, drainingSessions }]
```

`reloadPlugin(id, directory?)` 检查受信的开发包并发布完整目标，包括 client rows；调用者负责授权目录。保留配置与禁用 row；相同源码返回 `changed: false`，失败重载保留原 head。

生产 daemon 通过持久化包/目标协调路径发布。嵌入者将 PackageManager 的 `bindLocalPluginReload({ async reloadPlugin(id) { … } })` 绑定到自己的发布入口；已完成源快照准备时可等待 `host.reloadPlugin(id)`。恢复当前 head 时也要持久化 desired state，不能只保存会话 pin。

Node 管理客户端可调用 `client.packages.generations({ profile })`；只读 RPC 为 `_agnes/v1/plugins.generations`，本地 BFF 路由为 `POST /admin/plugins/api/generations`，均要求 `packages.read`。`packages.list` 也可返回 generation 状态和包计数。状态错误仅公开稳定错误码；不会返回源码、Skills 正文或已解析密钥。
