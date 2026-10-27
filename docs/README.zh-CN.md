# Agnes Harness 文档

[English](README.md) | 简体中文

**AGH 把业务能力交付为可安装的插件、可启动的智能体和可采纳的应用。**

- **插件**是安装、分发与信任单位，可以提供工具、运行方式（Loop）、模型、界面、技能、连接或服务。
- **智能体**是带显式 `launch` 的 Bundle，引用为 `package#bundle`；它选择运行方式和预设，开始一个任务。
- **应用**在插件中声明品牌、展示默认值与默认／可见智能体，由部署管理员预览后显式采纳。安装不会自动切换应用。

**FDE（前线部署工程）就是为企业构建应用**：把业务工具、智能体和工作界面交付给实际使用者。会话执行与授权仍由原有后端维护。

最小工具插件：从已构建的源码仓运行以下命令，把一个回显工具加入隔离环境；无需声明智能体或应用。

```sh
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-hello.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-hello-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
mkdir -p .agh/plugins
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" tool hello-tool .agh/plugins/hello-tool --local
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-tool
node "$AGH_SOURCE/agnes.mjs" --new -p 'call plugin_hello_tool {"message":"hello"}'
```

[五步工具教程](extend/quickstart.zh-CN.md) · [四步 Loop 教程](extend/first-loop.zh-CN.md) · [Acme 参考应用](../examples/acme/README.zh-CN.md)

[产品演示](guide/demos.zh-CN.md)

## 选择你的起点

| 角色 | 从这里开始 | 目标 |
| --- | --- | --- |
| **使用者** | [安装](guide/install.zh-CN.md) → [首次运行](guide/getting-started.zh-CN.md) → [会话](guide/sessions.zh-CN.md) | 选择智能体、完成任务、查看记录 |
| **部署管理员** | [部署](guide/deployment.zh-CN.md) · [安全](guide/security.zh-CN.md) · [插件管理](guide/packages.zh-CN.md) · [应用](extend/applications.zh-CN.md) | 审阅能力、配置模型、采纳应用并掌握恢复 |
| **插件作者** | [首个工具](extend/quickstart.zh-CN.md) → [首个 Loop](extend/first-loop.zh-CN.md) → [能力选择](extend/choose-a-plugin-type.zh-CN.md) | 通过公开合同交付可安装能力 |
| **应用构建者** | [Acme](../examples/acme/README.zh-CN.md) → [应用合同](extend/applications.zh-CN.md) → [界面作者指南](develop/ui-author-guide.zh-CN.md) | 组合智能体、品牌、页面与导航 |

<a id="使用-agh"></a>

## 使用者

| 主题 | 你会学到 |
| --- | --- |
| [CLI 与 TUI](guide/cli.zh-CN.md) | 运行终端任务、使用交互会话、处理审批 |
| [输入框引用](extend/references.zh-CN.md) | 选择工作区文件和可读历史会话，注入有界上下文 |
| [默认上下文](guide/context.zh-CN.md) | 查看实时仓库规则、时间上下文与自定义 Skill 目录 |
| [反馈与人工评审成长](guide/feedback.zh-CN.md) | 评价消息并起草待人工评审的 Skill |
| [学习记忆](guide/memory.zh-CN.md) | 管理文件偏好、审批与隐私 |
| [官方默认工具](reference/default-tools.zh-CN.md) | 搜索、问答、交付文件、管理后台任务及修改已读取文件 |
| [Web 工作台](guide/web.zh-CN.md) | 创建任务、查看历史、管理模型与扩展 |
| [内置浏览器](guide/browser.zh-CN.md) | 与 AGH 共用网页、测试本地项目和人工接管 |
| [程序化工具与工作流](guide/code-workflows.zh-CN.md) | TypeScript cell 与持久并行子任务工作流 |
| [代码诊断（LSP）](guide/lsp.zh-CN.md) | 编辑后的语言服务器错误；需要安装的服务器与安全限制 |
| [会话与恢复](guide/sessions.zh-CN.md) | 继续任务、导出记录、处理中断 |
| [插件生命周期](guide/packages.zh-CN.md) | 安装、信任、启用、更新与移除插件 |
| [通用凭据](guide/credentials.zh-CN.md) | 保存只写 API key 并管理配置引用 |
| [Webhook 触发器](guide/webhooks.zh-CN.md) | 通过认证的业务事件创建普通业务 Agent 会话 |
| [无界面运行与回放](guide/headless.zh-CN.md) | JSONL 事件、固定模型回复比较和批量输入 |
| [使用本地模型](guide/local-model.zh-CN.md) | 本地 OpenAI-compatible endpoint 和模型发现 |
| [使用 TypeSafe Jev 做旁路模型调用](guide/typesafe-jev.zh-CN.md) | 配置内置的只接受 payload 的适配器，供循环插件在对话之外调用 |
| [使用 Jev Agent Loop](guide/jev-loop.zh-CN.md) | 安装并配置由 TypeSafe Jev 选择每一步的可选循环 |
| [和智能体说话](guide/voice.zh-CN.md) | 通过旁路模型里的语音账户，用话筒听写、进行语音对话并让回复被朗读出来 |
| [安全与信任](guide/security.zh-CN.md) | 选择工作目录，理解授权和执行边界 |
| [沙箱提供者](guide/sandbox-providers.zh-CN.md) | 在启动时选择进程沙箱，并阅读声明的能力 |
| [可观测性与诊断](guide/observability.zh-CN.md) | 开启 OTLP 遥测并导出脱敏问题包 |
| [系统提示词与请求轨迹](guide/system-prompt-trace.zh-CN.md) | 自定义角色并查看本地模型请求 |
| [执行证据](guide/fact-chain.zh-CN.md) | 从请求、工具、产物与起草来源检查事实及缺口 |
| [会话工作台](guide/workbench.zh-CN.md) | 文件面板、工作流回执与停靠面板 |
| [候选审阅](extend/agent-built-plugins.zh-CN.md) | 核对 Agent 草稿、测试与权限后发布 |
| [来源与 MCP 隔离](guide/security.zh-CN.md#package-provenance-and-source-policy) | 安装来源、完整性与本地 MCP 进程边界 |
| [网络部署与 Linux](guide/deployment.zh-CN.md) | 出站代理、超时与 Linux 准备 |
| [App Server stdio](reference/app-server.zh-CN.md) | 通过共享后台集成自己的客户端 |
| [排错](guide/troubleshooting.zh-CN.md) | 从错误码和运行状态定位下一步 |

## 部署管理员

[数据格式恢复](guide/install.zh-CN.md#数据格式与升级) · [应用与界面选择](extend/applications.zh-CN.md) · [有状态作者测试](extend/testing.zh-CN.md)

[插件生命周期](guide/packages.zh-CN.md) · [模型与账号](guide/getting-started.zh-CN.md) · [网络部署](guide/deployment.zh-CN.md) · [安全与信任](guide/security.zh-CN.md) · [应用采纳与恢复](extend/applications.zh-CN.md)

## 插件作者

[工具五步](extend/quickstart.zh-CN.md) → [Loop 四步](extend/first-loop.zh-CN.md) → [作者工具包](extend/README.zh-CN.md) · [测试](extend/testing.zh-CN.md) · [公开导入](extend/imports.zh-CN.md)

## 应用构建者

[Acme 参考应用](../examples/acme/README.zh-CN.md) → [应用合同](extend/applications.zh-CN.md) · [智能体与组合](extend/bundles-and-profiles.zh-CN.md) · [界面作者指南](develop/ui-author-guide.zh-CN.md) · [工作台面板](extend/workbench-panels.zh-CN.md)

## 构建与深入了解

- **场景与方法**：[FDE 与应用场景](guide/why-agh.zh-CN.md)。
- **精确接口**：[命令参考](reference/cli.zh-CN.md) · [配置参考](reference/configuration.zh-CN.md) · [API 与 Schema](reference/api.zh-CN.md)。
- **旁路模型调用**：[TypeSafe Jev 适配器](guide/typesafe-jev.zh-CN.md) · [Jev Agent Loop](guide/jev-loop.zh-CN.md) · [语音输入与朗读](guide/voice.zh-CN.md) · [编写循环插件](develop/plugins.zh-CN.md)。
- **支持与反馈**：[支持范围](reference/limitations.zh-CN.md) · [反馈与开发协作](develop/contributing.zh-CN.md) · [安全报告](../SECURITY.md)。
- **更多开发主题**：[皮肤开发](develop/skins.zh-CN.md) · [主题](develop/ui-theme.zh-CN.md) · [构建恢复](guide/build-recovery.zh-CN.md) · [能力清单](reference/capabilities.zh-CN.md)。

## 阅读约定

当前为 pre-alpha 源码预览。命令默认从源码仓库根目录执行，构建入口为 `node agnes.mjs`；`SESSION_ID`、`REVISION` 等大写参数需替换为当前实例返回的值。示例的 `1.0.0` / `2.0.0` 表示示例包版本。

文档随源码维护，请选择与运行产物一致的版本。教程给出前提、步骤与预期结果；检查命令和验收范围见[验证与复现](maintainers/verification.zh-CN.md)，具体版本的执行结果随发布说明记录。

`docs/` 下每篇文档都提供英文与简体中文版本。通过页首语言切换可进入同一主题的另一种语言；源码文件与包内生成参考由两种语言共用。

## 维护与许可

[文档维护](maintainers/maintenance.zh-CN.md) · [发布检查](maintainers/release.zh-CN.md) · [版本管理](maintainers/versioning.zh-CN.md) · [验证记录](maintainers/verification.zh-CN.md) · [许可说明](maintainers/provenance.zh-CN.md) · [Apache-2.0](../LICENSE) · [NOTICE](../NOTICE)

前端维护：[UI 一致性](develop/ui-consistency.zh-CN.md)、[UI 注册接口](develop/ui-extension-registries.zh-CN.md)、[UI 能力覆盖](develop/ui-coverage.zh-CN.md)、[术语表](develop/ui-glossary.zh-CN.md)。

开发者合同（待实现）：[Intelligent UI 合同](develop/intelligent-ui.zh-CN.md)，其中包括 [UI 数据源](develop/ui-data-source.zh-CN.md)。
