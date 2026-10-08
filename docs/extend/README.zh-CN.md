# 插件作者工具包

[English](README.md) | 简体中文

[文档](../README.zh-CN.md) · [五分钟入门](quickstart.zh-CN.md) · [测试指南](testing.zh-CN.md)

[工具运行时与权限策略](tool-runtime.zh-CN.md) · [循环事件](loop-events.zh-CN.md)

选择负责目标行为的最小模板。五个[模板](../../templates/)都是独立包，提供构建与测试脚本，只通过公开包出口导入。SDK 目前仍为源码预览；入门指南提供正式包发布前的本地 SDK 连接方式。

| 类型 | 模板 | 提供的能力 |
| --- | --- | --- |
| 工具 | [tool](../../templates/tool/) | TypeBox 输入和结果 schema、取消信号、卸载清理 |
| 工具与面板 | [tool-with-panel](../../templates/tool-with-panel/) | 相同工具与独立浏览器侧栏插槽 |
| MCP 与 Skills | [mcp-skills](../../templates/mcp-skills/) | MCP 定义与通过 Skills 服务注册的包内 Skill |
| 模型适配器 | [model-adapter](../../templates/model-adapter/) | 通过 `modelAdapters` 注册的结构化适配器 |
| 循环 | [loop](../../templates/loop/) | 独立单轮驱动、checkpoint codec 与 `loops` 注册 |
| 压缩引擎 | [sliding-window](../../examples/compaction/sliding-window/) | 通过 `compactionEngines` 替换上下文；参阅[压缩引擎](compaction-engines.zh-CN.md) |
| 子代理 | [ACP 子代理](../../examples/child-agents/acp/) | 通过 `childAgents` 使用可继续的子代理；参阅[子代理提供者](child-agents.zh-CN.md) |
| 持久化 | [JSONL](../../examples/persistence/) | 无 SQL 的完整 Host 持久化；参见[持久化提供器](persistence.zh-CN.md) |

工具为已有循环增加操作。循环通过 [LoopContext](../../packages/extension-api/src/loop.ts) 端口负责调度与状态。适配器把线协议转换为[模型适配器合同](../../packages/extension-api/src/model-adapter.ts)的事件。前端面板有独立浏览器生命周期，通过客户端描述文件声明插槽。

MCP 包不会自动启动、安装或信任外部服务器。修改定义、启动目标服务器，再按 [MCP 管理](../guide/mcp.zh-CN.md)操作。Skills 提供方法说明而非工具实现，参阅 [Skills](../guide/skills.zh-CN.md)。适配器模板只产生确定性的开发回复，真实推理前必须替换实现。

## 公开 helper

从 `@agnes/plugin-runtime` 导入：

- `defineAgnesPlugin(plugin)` 保留 Cordis 函数、构造器或对象插件。
- `defineTool(def)` 兼容原输入 schema 形式，也支持 `result: TypeBoxSchema`，推导并校验成功结果的 `structured`。
- `toolError(message)` 表达预期业务失败；错误可省略 `structured`。
- `toolCancelled(signal)` 抛出取消原因。取消和意外故障仍通过异常表达。
- `defineLoop(factory)` 和 `defineModelAdapter(adapter)` 保留符合公开合同的声明。

原 `@agnes/extension-api` 输入 schema 版本的 `defineTool` 保持兼容。不要用相同本地名称导入两个版本。

工具插件注入 `extension`，回调使用 `Context`。循环和适配器回调分别使用 `LoopPluginContext`、`ModelAdapterPluginContext` 并声明对应注入。这些类型描述所需服务；类型声明不会安装服务。

注册项和长期资源应绑定插件 fiber 生命周期。每次调用的 I/O 使用取消信号，并在 `finally` 释放资源。工具 metadata 应准确描述副作用、审批与重放行为。

## 运行时采用

Host 必须提供对应注册服务，循环或适配器插件才能加载。安装包与为会话选择循环或适配器是不同操作；已有会话及重启要求遵循 Host 集成与代际支持。

通过[插件管理](../guide/packages.zh-CN.md)检查、安装、信任和启用构建后的包。作者测试使用确定性端口，不能证明真实模型行为、远程 MCP 连通性或浏览器渲染。

## 本地创作

在仓库根目录运行 `pnpm release:external-examples --keep`，打包公开作者 API、测试工具依赖和 Harness，并在仓库外验证作者示例。`--author-only` 跳过 Harness 构建，适合轻量检查。该脚本与 `pnpm release:npx-smoke` 均使用锁定的 tsx。

将源码放入[本地插件目录](local-plugins.zh-CN.md)，或[让 Agent 创建插件](agent-built-plugins.zh-CN.md)。两条路径复用包状态和不可变源码快照。
[组合包与配置](bundles-and-profiles.zh-CN.md)介绍可复用的配置补丁、preset 和选择来源。

[热重载开发指南](hot-reload.zh-CN.md)说明手动重载、会话固定与重启要求。

[Schema 驱动配置界面](configuration-ui.zh-CN.md) · 共享设置表单、校验与受控操作。

[会话工作台面板](workbench-panels.zh-CN.md)介绍右侧和底部停靠面板的注册方式。
