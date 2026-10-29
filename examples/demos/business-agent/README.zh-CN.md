# 业务 Agent 即插件

[English](README.md) | 简体中文

安装现有 support-triage bundle，验证其 Loop 和工具与默认 Agent 隔离；禁用后旧会话继续运行。

安装依赖并构建本地 CLI 后，在仓库根目录运行：

```sh
node examples/demos/business-agent/run.mjs
node examples/demos/business-agent/run.mjs --check
```

每次运行创建并删除自己的临时 home；`--check` 只批准合成演示中的操作。声明不成立时非零退出。准备步骤、可选真实模型和验证边界见[demo guide](../../../docs/guide/demos.zh-CN.md)。
