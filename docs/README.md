# Agnes Harness 文档

**从第一个任务，到你的 Agent 应用。**

用 CLI 和 Web 跑通任务，用插件接入业务能力，用 Skills 积累方法，再为岗位打造自己的界面。从下面选择一条路径开始。

[项目首页](../README.md) · [English overview](../README.en.md) · [为什么选择 AGH](guide/why-agh.md) · [体验示例](guide/demo.md) · [MHS（即将开放）](guide/mhs.md)

## 选择你的起点

| 你想做什么 | 推荐路径 | 完成后你会得到 |
| --- | --- | --- |
| **体验 AGH** | [安装](guide/install.md) → [首次运行](guide/quickstart.md) → [继续会话](guide/sessions.md) | 跑通一个任务，并在 Web 与 CLI 中找到记录 |
| **把业务能力交给 Agent** | [后端插件](develop/backend.md) · [MCP](guide/mcp.md) · [Skills](guide/skills.md) | 接入工具、外部服务或团队任务方法 |
| **做一个业务工作台** | [前端面板](develop/frontend.md) → [前后端联动](develop/fullstack.md) | 为工作台增加界面，读取后端服务结果 |
| **研究与扩展运行时** | [架构](develop/architecture.md) → [源码地图](develop/source-map.md) → [API](reference/api.md) | 看清请求、扩展与持久状态的实现路径 |

还没有选定方向？先看[三个可运行示例](guide/demo.md)，再按[扩展指南](develop/plugins.md)选择入口。

## 使用 AGH

| 主题 | 你会学到 |
| --- | --- |
| [CLI 与 TUI](guide/cli.md) | 运行终端任务、使用交互会话、处理审批 |
| [Web 工作台](guide/web.md) | 创建任务、查看历史、管理模型与扩展 |
| [会话与恢复](guide/sessions.md) | 继续任务、导出记录、处理中断 |
| [插件生命周期](guide/packages.md) | 安装、信任、启用、更新与移除插件 |
| [安全与信任](guide/security.md) | 选择工作目录，理解授权和执行边界 |
| [排错](guide/troubleshooting.md) | 从错误码和运行状态定位下一步 |

## 构建与深入了解

- **场景与方法**：[FDE 与应用场景](guide/why-agh.md) · [MHS 与设备接入](guide/mhs.md)。
- **精确接口**：[命令参考](reference/cli.md) · [配置参考](reference/configuration.md) · [API 与 Schema](reference/api.md)。
- **支持与反馈**：[支持范围](reference/limitations.md) · [反馈与开发协作](develop/contributing.md) · [安全报告](../SECURITY.md)。

- **更多开发主题**：[皮肤开发](develop/skins.md) · [构建恢复](guide/build-recovery.md) · [能力清单](reference/capabilities.md)。

## 阅读约定

当前为 pre-alpha 源码预览。命令默认从源码仓库根目录执行，构建入口为 `node packages/cli/dist/local/agnes.mjs`；`SESSION_ID`、`REVISION` 等大写参数需替换为当前实例返回的值。示例的 `1.0.0` / `2.0.0` 表示示例包版本。

文档随源码维护，请选择与运行产物一致的版本。教程给出前提、步骤与预期结果；检查命令和验收范围见[验证与复现](maintainers/verification.md)，具体版本的执行结果随发布说明记录。

## 维护与许可

[文档维护](maintainers/maintenance.md) · [发布检查](maintainers/release.md) · [版本管理](maintainers/versioning.md) · [验证记录](maintainers/verification.md) · [许可说明](maintainers/provenance.md) · [Apache-2.0](../LICENSE) · [NOTICE](../NOTICE)
