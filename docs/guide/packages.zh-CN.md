# 插件安装、启用、更新与清理

[English](packages.md) | 简体中文

[文档导航](../README.zh-CN.md) · [开发插件](../develop/plugins.zh-CN.md)

本页带你走完一个插件从检查、安装到更新和卸载的过程。先使用仓库自带的文本统计插件，跑通后再换成自己的包。

## 开箱可用的助手插件

AGH 默认提供四个官方助手插件。新建本地配置，以及已有配置首次升级到支持默认助手的版本时，会自动安装、信任并启用尚未安装的助手，无需联网下载：

| 插件 | 用途 |
| --- | --- |
| `@agnes/skill-helper` | 在会话中创建、导入和安装 Skill |
| `@agnes/mcp-helper` | 在会话中准备和接入 MCP，查询真实连接状态 |
| `@agnes/plugin-helper` | 在会话中创建工具或 Skill 插件、检查包，并在确认后安装启用 |
| `@agnes/document-reader` | 读取 PDF 文字与页面图片、扫描 PDF、DOC、DOCX 和 ZIP 中选定的文件；OCR 在本地离线运行 |

已安装的插件使用固定快照，重新构建或重启应用不会覆盖旧快照。要使用 `@agnes/document-reader` 0.1.2 的 PDF 按页看图和改进后的 ZIP 读取能力，请在 Web 插件管理中选择该包的“从新来源更新”，来源填写新构建应用的 `file:./bundled-plugins/document-reader`，核对预览后按正常更新和激活流程完成。

四个助手出现在“设置 → 插件管理 → 已安装”，可以禁用或卸载。后续启动与升级尊重你的选择，不自动恢复；移除助手插件不会删除它先前创建或接入的插件、Skill 或 MCP。安装第三方能力仍需要相应确认。

从只有 Skill/MCP Helper 的版本升级时，补装 Plugin Helper 和 Document Reader，不恢复此前已移除的旧助手。从三个助手的版本升级时，只补装 Document Reader。已有同名插件保留原版本和启用/信任状态。首次默认安装完成后，主动移除的助手可在“发现”中重新安装。首次初始化受部署策略约束，失败时保留记录，恢复后继续处理，不把失败标记为已启用。

## 管理其他插件

| 阶段 | 你要确认什么 |
| --- | --- |
| 检查与安装 | 来源、版本、内容摘要与能力声明是否符合预期 |
| 审核与启用 | 是否允许这一版代码在当前实例中提供能力 |
| 核对实际状态 | 相关后端行是否 ready，前端贡献是否在页面加载 |
| 更新或移除 | 新版本是否生效，旧能力是否正确撤下 |

安装成功后默认保持停用。AGH 仍会在内部记录审核通过的版本和能力范围，再进入激活流程。`desired` 表示期望启用状态，`actual` 表示实际运行状态；分别查看它们，才能区分“已提出请求”和“已经可用”。

## 插件类型、状态与会话默认配置

包可在 `package.json` 中声明可选的多值字段：

```json
{ "agnes": { "kinds": ["tool", "loop", "model-adapter", "mcp", "skills", "ui"] } }
```

只声明包实际提供的类型。管理列表和详情展示类型徽标，类型筛选匹配声明值。未声明字段的旧包仍显示在“全部类型”中。

状态徽标分别报告已安装、期望启用、后台确认运行中、排干中、需要重启与失败。只有后台明确报告旧会话绑定时才显示排干中，待清理资源本身不能证明排干。前端失败与后端状态同时保留，支持时可重试界面加载。

“新会话默认配置”读取后台目录，使用配置 revision 保存确切的 Loop/适配器版本及模型 ID。已有会话保留原绑定。已失效的选择须替换或清除，保存冲突时须重新加载目录。本地 daemon 从持有 Host 的共享 worker 查询目录，启动器通过私有 Unix 连接转发。在工作台，新任务在现有模型选择器旁预选保存的 Loop 和模型；首条消息发送前可以修改 Loop，已有会话保留原绑定。会话 Trace 从会话元数据展示记录的 Loop ID/版本，重新打开后同样可见。

固定本地管理路由为 `GET /admin/api/loops`（Loop 目录和默认值/revision）、`GET /admin/api/model-adapters`、`GET /admin/api/defaults` 与 `PUT /admin/api/defaults`，保存参数为 `{ revision, defaults: { loop?, modelAdapter? } }`。Loop 选择包含 `id` 和 `version`，适配器选择还包含 `model`。写入需要插件激活权限和同源管理上下文。可信启动器提供通往 daemon 的 `AdminSessionSelection` relay，Host 通过 `createAdminSessionSelection` 组合真实目录与现有配置存储。适配器模型在可用时包含已配置的 `route`，供工作台选择实际运行时模型。端点不导入插件工厂，也不接收凭据。

## 安装后端示例

建议先按[安装指南](install.zh-CN.md)建立临时 AGH_HOME，从仓库根启动该实例。`file:` 相对路径由后台的工作区来源解析；复用不同 cwd 启动的 daemon 时应核对来源，最简单的是在隔离实例的启动目录操作。

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

Web 对应“设置 → 插件 → 从来源安装 → 检查/安装 → 启用”。确认启用时会审核并绑定当前完整性摘要和能力摘要，校验成功后才继续激活；普通 Web 流程不再单独显示信任动作。已安装列表的开关只在插件实际运行时打开。服务依赖、策略拒绝或候选加载失败时，开关保持关闭，失败原因显示在当前行，可直接再次点击启用重试。

## 更新与回滚

当前 shell `package` 没有 `update` 子命令；请在 Web 插件页选已安装包的“从新来源更新”，或先检查来源后用 TUI `/package update <id> <source> <integrity>` 提交操作（该命令不提供安装式交互确认），程序调用则用 Node SDK `client.packages.update`。

可以用 `hot-service/v1` 与 `v2`，或 `client-panel/v1` 与 `v2` 演练。先安装并启用 v1；更新时选择同 ID 的 v2 来源，核对新摘要和能力变化，按界面提示完成审核与激活。观察 actual 和界面/服务值，而不只看操作进度为 100%。

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

撤信任保留在 Node SDK 中，供管理和恢复流程使用；普通 Web 页面不再显示这一动作，shell 也没有通用 `package untrust` 命令。禁用停止向新会话提供能力，已有会话保留其 generation 直到删除；删除处理安装状态与自有文件；正在被使用的快照可能有 pin，不能手动删除引用中的目录。`packages pins release PIN_ID` 是针对核验过的孤儿 pin 的显式清理动作，不用它绕开运行安全门。已有隔离演示验证禁用后三个示例包均可删除；仍需以目标平台和最终发行构建复验，具体基线见[验证记录](../maintainers/verification.zh-CN.md)。

取消是请求，收到回执后继续查 operation；部分有副作用操作不能当作从未发生。工具、事件监听、Cordis 服务与前端槽位应随所属 fiber 清理，外部业务数据不因插件卸载自动撤销。

## 更新为何不总是立即切换

每次包激活生成不可变的插件 generation。新会话绑定当前 generation；已有会话在休眠和 worker 重启后仍保留原包、版本、loop 与前端 bundle。禁用或卸载停止新的绑定，已有会话继续排空。关闭连接不会释放持久会话的 generation；会话删除后，由 Host 所有者调用 `releaseSessionGeneration(sessionKey)`，不再被会话引用的 generation 才会销毁并回收。

存储、文件系统、sandbox 和平台后端仍需要重启。恢复时若固定快照缺失、包文件发生变化，或部署的 loop/adapter 配置不兼容，会明确失败，不会替换成当前 generation。私有 MCP 工厂或 Skills 视图也必须能够重建；原视图缺失时拒绝冷恢复。`Host.pluginGenerationStatus()` 和内部 worker 命令 `pluginGenerations.status` 向管理端提供 generation 引用数及 active/draining/restart-required/failed 插件状态。浏览器名册请求可携带 `sessionId`，加载该会话固定的 generation，资源通过不可变的 generation 路径提供。

候选加载、依赖与激活超时仍可能导致激活失败，旧 generation 继续服务已绑定的会话。浏览器自行加载 bundle 名册，Host active 不等于浏览器已加载。

实现依据：[shell 命令](../../packages/cli/src/commands/package.ts)、[SDK](../../packages/sdk/src/package-admin.node.ts)、[Web 管理](../../packages/web/src/admin/plugins/admin.tsx)、[EntryTree](../../packages/cordis-loader/src/entry-tree.ts)、[Host 发布](../../packages/host/src/runtime-target-publisher.ts)。
