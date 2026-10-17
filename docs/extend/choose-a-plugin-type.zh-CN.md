# 按角色选择插件类型

[English](choose-a-plugin-type.md) | 简体中文

[插件作者工具包](README.zh-CN.md) · [五分钟入门](quickstart.zh-CN.md) · [插件用途元数据](plugin-metadata.zh-CN.md)

一个插件就是一个包。包是用户安装、升级、信任和卸载的唯一单位。包里有什么，就是它的类型，在 `package.json` 的 `agnes.provides` 里声明；一个包可以声明多个。先想清楚你要交付什么，再选能承载它的最小类型。

| 你是 | 声明 | 你要写的 | 用户在哪里看到 |
| --- | --- | --- | --- |
| 工具作者 | `tool` | Agent 可以调用的操作，带输入和结果的 schema | 插件 → 已安装、市场（类型「工具」）；Agent 调用时出现在对话里 |
| 技能作者 | `skills`，或者不打包 | `SKILL.md` 说明，随包发布，或直接放进技能文件夹 | 插件 → 技能，每行标「来自 <插件名>」或「我添加的」 |
| 集成作者 | `mcp` | 通过 MCP 连接外部系统 | 插件 → MCP，每行标来源 |
| Agent 架构研究者 | `loop`、`model-adapter`，或某个服务商 | 一轮对话如何调度、如何调用模型，或者压缩、记忆这类运行时服务 | 设置 → 高级 → 运行配置，作为对应槽位的一个选项 |
| 行业方案作者（FDE） | `bundle` | 直接能用的业务 Agent：把 Loop、工具、技能和预设一起选好 | 首页 → 业务 Agent；在插件 → 已安装里是一行，带「业务 Agent」标签 |
| 界面作者 | `ui` | 面板、皮肤或浏览器端控件 | 面板声明的工作台槽位；皮肤在设置 → 通用；市场（类型「界面与皮肤」） |
| 企业方案作者（例如报表方案） | 不是新类型：seam 服务商加首页入口 | 审批、身份、计费、审计这类全组织规则，以及你自己的页面 | 首页侧栏里你注册的入口；设置 → 权限与安全 |

## 每种选择的含义

**工具。** Agent 只是缺一个操作，现有 Loop 能决定何时调用它，就写工具。从 [tool 模板](../../templates/tool/)开始，阅读[工具运行时与权限策略](tool-runtime.zh-CN.md)。结果值得单独一个面板时，加上 `ui`，改用 [tool-with-panel](../../templates/tool-with-panel/)。

**技能。** 技能是写下来的做法，不是代码：它告诉 Agent 你的团队怎么完成一件事。自己用，一个文件夹就够了，见[技能](../guide/skills.zh-CN.md)。要让别人安装并收到更新，就用 [mcp-skills 模板](../../templates/mcp-skills/)打成包。

**MCP。** 能力已经在别的系统或进程里时用 MCP。包可以带上连接定义，用户也可以手动添加服务。两种方式都不会自动启动或信任外部服务，见 [MCP 管理](../guide/mcp.zh-CN.md)。

**Loop、模型适配器和服务商。** 这几类是替换运行时的一部分，不是往上加东西。Loop 负责一轮对话的调度和状态（[业务工作流](workflow-loops.zh-CN.md)、[循环事件](loop-events.zh-CN.md)）。模型适配器翻译一种线上协议（[model-adapter 模板](../../templates/model-adapter/)）。其他服务商各占一个槽位：[压缩](compaction-engines.zh-CN.md)、[持久化](persistence.zh-CN.md)、[记忆](memory.zh-CN.md)、[子 Agent](child-agents.zh-CN.md)，以及沙箱、工具运行时和工具策略。安装后，它们在运行配置里与内置实现并列，成为一个选项；安装本身不会切换正在运行的会话。

**Bundle。** Bundle 是可复用配置；声明自身完整的 `launch` 块并显式选择 preset，才成为智能体。仅提供 Loop 的插件不必声明 Bundle。参见[Bundle 与 Profile](bundles-and-profiles.zh-CN.md)和[插件元数据](plugin-metadata.zh-CN.md)。

**界面。** 浏览器代码有自己的生命周期，从不在 Agent 进程里运行。通过客户端描述文件声明面板和皮肤，见[工作台面板](workbench-panels.zh-CN.md)和[配置界面](configuration-ui.zh-CN.md)。

**企业方案。** 没有「企业」这个类型。为你的规则需要的 [seam](seams.zh-CN.md) 注册服务商，再通过[首页入口注册表](../develop/ui-extension-registries.zh-CN.md)注册一个页面。负责安全的 seam 服务商在会话存续期间固定不变，所以规则不会在任务运行中途改变。报表方案可以组合审核规则与自己的报表页面。

## 一组声明能力

`agnes.provides` 说明包里有什么，市场的类型筛选和每行的「包含」标签都由它推导。

市场的类型筛选由 kinds 推导：

| 筛选项 | kinds |
| --- | --- |
| 业务 Agent | `bundle` |
| 工具 | `tool` |
| 技能包 | `skills` |
| MCP 连接 | `mcp` |
| 界面与皮肤 | `ui` |
| 执行方式与服务商 | `loop`、`model-adapter` |

「包含」标签读取 `PackagePresentation.includes`，由后端推导，不运行你的代码。想让某个类型旁边显示数量，就把数量写进包数据：在插件的 `capabilities.tools.names` 里列出工具名，把技能声明为 `skill` 贡献，把 bundle 写在 `agnes.bundles` 下。没有写明数量的类型只显示名称。见[插件用途元数据](plugin-metadata.zh-CN.md#what-a-package-includes)。

「内置」只有一个含义：随产品附带、不能卸载。你发布的包无论包含什么，都不是内置。
