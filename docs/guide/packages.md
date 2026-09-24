# 插件安装、信任、更新与清理

[文档导航](../README.md) · [开发插件](../develop/plugins.md)

本页带你走完一个插件从检查、安装到更新和卸载的过程。先使用仓库自带的文本统计插件，跑通后再换成自己的包。

## 开箱可用的助手插件

AGH 默认提供三个官方助手插件。新建本地配置，以及已有配置首次升级到支持默认助手的版本时，会自动安装、信任并启用尚未安装的助手，无需联网下载：

| 插件 | 用途 |
| --- | --- |
| `@agnes/skill-helper` | 在会话中创建、导入和安装 Skill |
| `@agnes/mcp-helper` | 在会话中准备和接入 MCP，查询真实连接状态 |
| `@agnes/plugin-helper` | 在会话中创建工具或 Skill 插件、检查包，并在确认后安装启用 |

三个助手出现在“设置 → 插件管理 → 已安装”，可以禁用或卸载。后续启动与升级尊重你的选择，不自动恢复；移除助手插件不会删除它先前创建或接入的插件、Skill 或 MCP。安装第三方能力仍需要相应确认。

从只有 Skill/MCP Helper 的版本升级时，只补装新增的 Plugin Helper，不恢复此前已移除的两个助手。已有同名插件保留原版本和启用/信任状态。首次默认安装完成后，主动移除的助手可在“发现”中重新安装。首次初始化受部署策略约束，失败时保留记录，恢复后继续处理，不把失败标记为已启用。

## 管理其他插件

| 阶段 | 你要确认什么 |
| --- | --- |
| 检查与安装 | 来源、版本、内容摘要与能力声明是否符合预期 |
| 信任与启用 | 是否允许这一版代码在当前实例中提供能力 |
| 核对实际状态 | 相关后端行是否 ready，前端贡献是否在页面加载 |
| 更新或移除 | 新版本是否生效，旧能力是否正确撤下 |

安装成功默认仍为 untrusted、installed-disabled。`desired` 表示期望启用状态，`actual` 表示实际运行状态；分别查看它们，才能区分“已提出请求”和“已经可用”。

## 安装后端示例

建议先按[安装指南](install.md)建立临时 AGH_HOME，从仓库根启动该实例。`file:` 相对路径由后台的工作区来源解析；复用不同 cwd 启动的 daemon 时应核对来源，最简单的是在隔离实例的启动目录操作。

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/hot-tool-plugin
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/hot-tool-plugin
```

安装命令展示预览并要求交互确认。检查 package ID、版本、来源、integrity、capabilityHash、警告与 blockers；不能给有 blocker 的包直接授权。然后使用预览实际值：

```sh
node packages/cli/dist/local/agnes.mjs package trust @agnes-examples/hot-tool-plugin INTEGRITY CAPABILITY_HASH
node packages/cli/dist/local/agnes.mjs package enable @agnes-examples/hot-tool-plugin
node packages/cli/dist/local/agnes.mjs package status
```

Web 对应“设置 → 插件 → 从来源安装 → 检查/安装 → 信任 → 启用”。包状态和逐行 actual 要一起看；存在服务依赖、浏览器未打开、策略拒绝或候选加载失败时，启用状态与实际可用状态可能不同。

## 更新与回滚

当前 shell `package` 没有 `update` 子命令；请在 Web 插件页选已安装包的“从新来源更新”，或先检查来源后用 TUI `/package update <id> <source> <integrity>` 提交操作（该命令不提供安装式交互确认），程序调用则用 Node SDK `client.packages.update`。

可以用 `hot-service/v1` 与 `v2`，或 `client-panel/v1` 与 `v2` 演练。先安装、信任、启用 v1；更新时选择同 ID 的 v2 来源，核对新摘要和能力变化，按界面提示确认信任与激活。观察 actual 和界面/服务值，而不只看操作进度为 100%。

```sh
node packages/cli/dist/local/agnes.mjs package rollback PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package operation OPERATION_ID
```

不携带 activation 的普通回滚会把目标设为未信任、禁用；shell 回滚后重新检查目标摘要，执行 trust、enable，再核对实际服务或界面。SDK 可携带当前安装/活动摘要与明确的目标信任决策进行 activation，不能省略相应校验。

回滚依赖保留的上一版本和当前许可，不是任意历史版本管理。当前上一版本槽有界；已撤信任、被删除或无法核验的快照不能被回滚自动复活。失败候选可能自动回退，但必须读取真实 operation 状态和 actual，不能从“已请求”推断成功。

## 禁用、撤信任与删除

```sh
node packages/cli/dist/local/agnes.mjs package disable PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package remove PACKAGE_ID
node packages/cli/dist/local/agnes.mjs package cancel OPERATION_ID
node packages/cli/dist/local/agnes.mjs packages pins inspect
```

撤信任使用 Web 中相应动作或 Node SDK；shell 没有通用 `package untrust` 命令。禁用撤下能力，删除处理安装状态与自有文件；正在被使用的快照可能有 pin，不能手动删除引用中的目录。`packages pins release PIN_ID` 是针对核验过的孤儿 pin 的显式清理动作，不用它绕开运行安全门。已有隔离演示验证禁用后三个示例包均可删除；仍需以目标平台和最终发行构建复验，具体基线见[验证记录](../maintainers/verification.md)。

取消是请求，收到回执后继续查 operation；部分有副作用操作不能当作从未发生。工具、事件监听、Cordis 服务与前端槽位应随所属 fiber 清理，外部业务数据不因插件卸载自动撤销。

## 更新为何不总是立即切换

Runtime target 带完整身份/修订信息。Host 已有受限活树事务和增量调和；合格变更可以复用未改变行，不能承诺任何插件都无中断热更新。依赖、身份变更、超时、事务补偿失败和污染树都可能触发拒绝或整体重建。浏览器再根据自己的名册更新和清理，Host active 不等于浏览器已加载。

实现依据：[shell 命令](../../packages/cli/src/commands/package.ts)、[SDK](../../packages/sdk/src/package-admin.node.ts)、[Web 管理](../../packages/web/src/admin/plugins/admin.ts)、[EntryTree](../../packages/cordis-loader/src/entry-tree.ts)、[Host 发布](../../packages/host/src/runtime-target-publisher.ts)。
