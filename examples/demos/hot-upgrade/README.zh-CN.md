# 热升级不打断业务

[English](README.md) | 简体中文

v1 等待业务审查时发布已审查的 v2，新会话使用 v2；重启 daemon 后恢复 v1，读取、分类和模拟发送各记录一次。

安装依赖并构建本地 CLI 后，在仓库根目录运行：

```sh
node examples/demos/hot-upgrade/run.mjs
node examples/demos/hot-upgrade/run.mjs --check
```

每次运行创建并删除自己的临时 home；`--check` 只批准合成演示中的操作。声明不成立时非零退出。准备步骤、可选真实模型和验证边界见[demo guide](../../../docs/guide/demos.zh-CN.md)。
