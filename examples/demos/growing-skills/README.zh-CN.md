# Agent 自己长技能

[English](README.md) | 简体中文

让 Agent 创建可复用的文本统计插件，审查源码，批准原生安装与信任，然后验证新会话调用它，来源记录 installer=agent。

安装依赖并构建本地 CLI 后，在仓库根目录运行：

```sh
node examples/demos/growing-skills/run.mjs
node examples/demos/growing-skills/run.mjs --check
```

每次运行创建并删除自己的临时 home；`--check` 只批准合成演示中的操作。声明不成立时非零退出。准备步骤、可选真实模型和验证边界见[demo guide](../../../docs/guide/demos.zh-CN.md)。
