# 体验 AGH：一个工具、一个面板、一套联动

[English](demo.md) | 简体中文

[项目首页](../../README.zh-CN.md) · [文档导航](../README.zh-CN.md) · [安装指南](install.zh-CN.md)

从一个业务函数到一个工作台，AGH 的扩展能力可以逐步组合。本页带你体验三个仓库自带的示例：让 Agent 调用自己的工具，为界面增加面板，再让面板读取后端服务。

[演示一：工具](#演示一给-agent-增加一项能力) · [演示二：面板](#演示二让工作台适配一个岗位) · [演示三：联动](#演示三把界面接到后端服务)

## 选择体验方式

| 方式 | 适合谁 | 环境与结果 |
| --- | --- | --- |
| Web / CLI 体验 | 想查看界面和模型交互 | 完成[首次运行](quickstart.zh-CN.md)后，选择下方示例；模型调用可能计费 |
| 本地自动演示 | 没有模型账号，想先跑通执行流程 | 构建好的 macOS 本地分发与回环监听权限；使用本地模拟模型，输出逐项检查结果 |
| 示例组件测试 | 准备修改插件代码 | 已安装源码依赖；检查示例注册、返回值、挂载与清理，不启动完整工作台 |

自动演示通过本地模拟模型驱动真实产品进程，适合检查执行流程；查看界面和模型效果请选择 Web / CLI 体验。

## 演示一：给 Agent 增加一项能力

跟随[后端插件教程](../develop/backend.zh-CN.md)，安装、信任并启用 `hot-tool-plugin`。在已配置模型的会话中要求调用 `demo_text_stats` 统计 `hello world`。

工具的预期结构化结果：

```json
{ "characters": 11, "words": 2 }
```

展开工具记录，核对 `demo_text_stats` 的名称、输入和结构化输出，确认请求经过了自己的插件。自动演示也会检查这条实际执行路径。

**可以怎样扩展：** 保留注册与包治理结构，把统计逻辑替换为你的业务查询，同时重新定义输入、权限与效果。

## 演示二：让工作台适配一个岗位

跟随[前端面板教程](../develop/frontend.zh-CN.md)加载 `client-panel/v1`。在 Web 中应看到 `Agnes client module demo · v1`；更新到 v2 后检查版本文字，停用后检查内置侧栏是否恢复。

该示例占用单实例侧栏槽，会替换内置侧栏。操作前保留终端，以便需要时禁用示例包。自动演示验证名册，组件测试验证挂载/卸载；界面外观由你在手动浏览器体验中检查。

**可以怎样扩展：** 用岗位真正关心的数据和操作替换版本文字，遵循声明的槽位与前端生命周期。

## 演示三：把界面接到后端服务

跟随[前后端联动教程](../develop/fullstack.zh-CN.md)，在独立实验 profile 中配置服务能力、安装联动包，并先选择一个会话。

面板显示 `backend 1.0.0`，说明它拿到了后端查询结果。升级时同时核对前端与后端版本；普通回滚后先观察调用被拒绝，再核对摘要、重新信任并启用。卸载后旧服务调用应失效。

**可以怎样扩展：** 从只读状态页开始，逐步接入实际业务服务。写操作需要对应的 effect、命令身份与授权设计，不能直接沿用只读查询声明。

## 不配置模型账号，先跑通本地链路

先完成[构建前提](install.zh-CN.md)。在源码仓库根运行；已有完整构建时可直接运行第二条。已有独立构建通过包括插件删除在内的自动演示，具体版本与结果见[验证记录](../maintainers/verification.zh-CN.md)。后续源码变化需要重新构建和验证。

```sh
pnpm --filter @agnes/cli build:local
node --import tsx tools/public-docs/smoke.mjs
```

脚本创建独立短路径临时 home 和演示工作区，安装本仓示例，通过回环模型执行任务；结束时停止自己启动的 Web 和 daemon，并打印 `result.json` 所在目录。它不接入日常实例或真实模型账号。依赖安装与首次构建仍需按安装指南准备；这里的“本地”指演示运行阶段。

运行输出中应看到以下阶段。下面列的是预期检查标签，实际结果以本次进程退出码和 `result.json` 为准：

```text
PASS page-advertised WebSocket connects directly to daemon and reads session projection
PASS installed backend tool invoked through CLI/daemon/worker
PASS real HTTP BFF query and wrong-Origin refusal
PASS linked service update v1 → v2
PASS rollback denies calls until explicit trust/enable restores v1
PASS disable/remove clears roster and denies stale service calls
```

任一步失败时，保留日志与结果目录，按[排错](troubleshooting.zh-CN.md)定位。当前脚本使用 `/tmp` 与 Unix socket；已有进程验证在 macOS 执行，不作为 Windows 验收命令。不要手工移除快照或强行释放仍被引用的 pin。

若按安装指南构建到了独立输出目录，保持同一个 shell 中的 `AGH_BUILD_ROOT`，指定刚构建的入口：

```sh
node --import tsx tools/public-docs/smoke.mjs --entry "$AGH_BUILD_ROOT/runtime/agnes.mjs"
```

完整阶段与基线见[验证记录](../maintainers/verification.zh-CN.md)，可读代码见[演示脚本](../../tools/public-docs/smoke.mjs)。

## 开发者的快速验证

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts --maxWorkers=1
```

这组测试加载实际示例模块，覆盖后端结果、前端挂载与清理、服务联动以及缺少会话/权限时的拒绝。它适合修改示例后的快速反馈；完整进程和真实浏览器仍是不同验证层级。

下一步：[开发你自己的插件](../develop/plugins.zh-CN.md) · [把示例带到 FDE 场景](why-agh.zh-CN.md) · [反馈问题与开发协作](../develop/contributing.zh-CN.md)。
