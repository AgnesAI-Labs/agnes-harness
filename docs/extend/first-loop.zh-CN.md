# 四步编写首个 Loop

[English](first-loop.md) | 简体中文

[作者工具包](README.zh-CN.md) · [首个工具](quickstart.zh-CN.md) · [工作流](workflow-loops.zh-CN.md)

需要 Node.js 24.10+ 和[已构建的源码环境](../guide/install.zh-CN.md)。Loop 插件只提供运行方式，不必声明 Bundle、智能体或应用。以下四步使用免密钥 Demo，不调用真实模型。

## 1. 创建本地 Loop

```sh
export AGH_SOURCE="/absolute/path/to/agnes-harness"
export AGH_HOME="$(mktemp -d /tmp/agh-loop.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-loop-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
mkdir -p .agh/plugins
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" loop hello-loop .agh/plugins/hello-loop --local
```

## 2. 启动并检查登记

保持同一工作区、home 和 profile。`dev` 激活后，`tools` 检查共享后台；`package status` 应包含已就绪的 `hello-loop` 版本 `0.1.0`。第 3 步验证指定 Loop 能实际运行。

```sh
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-loop --profile local-dev
node "$AGH_SOURCE/agnes.mjs" tools
node "$AGH_SOURCE/agnes.mjs" package status --json
```

## 3. 显式选择运行方式

```sh
node "$AGH_SOURCE/agnes.mjs" --new --loop hello-loop@0.1.0 -p 'hello'
```

应获得带本地 Demo 标记的回复。`--loop` 在新会话创建时绑定运行方式；不要求创建智能体。模板的 `defineWorkflowLoop` 负责 checkpoint、取消与恢复；新增业务副作用时仍须声明能力并通过工具授权。

## 4. 检查结果并清理

确认第 3 步输出带 Demo 标记的 `answer`，记录终端打印的会话标识，然后停止本次隔离后台。保留临时 home 可继续查看运行记录；只删除自己创建的临时目录。

```sh
node "$AGH_SOURCE/agnes.mjs" sessions --json
node "$AGH_SOURCE/agnes.mjs" daemon stop
```

需要修改业务阶段时，阅读[工作流指南](workflow-loops.zh-CN.md)，并在改变 checkpoint 含义时递增 Loop 版本。需要可启动的智能体时，再添加带显式 `launch.preset` 的 [Bundle](bundles-and-profiles.zh-CN.md)。可选编译与作者测试使用[工具教程第 5 步](quickstart.zh-CN.md#5-可选的构建和测试)相同命令。
