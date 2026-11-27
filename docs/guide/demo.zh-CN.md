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

跟随[前端教程](../develop/frontend.zh-CN.md)安装、信任并启用 `client-panel/v1`。这是旧工作台槽位测试样本。官方 Web 工作台显示其原生界面未获准入，不显示 `Agnes client module demo · v1`，并保留内置界面。

要实际替换标准角色，请运行[界面呈现插件教程](../extend/presentations.zh-CN.md)。先预览具体角色再显式批准；普通安装不会替换角色。

**可以怎样扩展：** 用明确获准的入口展示该岗位需要的信息和操作，同时验证展示、清理和撤销。

## 演示三：把界面接到后端服务

在隔离的 `local-dev` 配置中跟随[前后端联动教程](../develop/fullstack.zh-CN.md)。从源码安装、信任并启用教程包，再预览并显式采用应用。仅安装不会让原生页面获得准入。

在新会话的工作台打开**服务版本**。收到只读查询结果后，页面显示 `backend 1.0.0`。清除应用选择会移除页签，保留官方工作台。升级与回滚测试使用教程中另行介绍的版本化样本。

**可以怎样扩展：** 从只读状态页开始，逐步接入实际业务服务。写操作需要对应的 effect、命令身份与授权设计，不能直接沿用只读查询声明。

## 不配置模型账号，先跑通本地链路

先完成[构建前提](install.zh-CN.md)。当前的离线验收请运行上面三个浏览器教程；保留会话行为请运行[热升级演示](../../examples/demos/hot-upgrade/README.zh-CN.md)。

下面的可选进程探针包含原生界面准入之前的 profile 名册预期，不作为本教程或会话版本固定的通过标准。

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
