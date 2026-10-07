# 五分钟写出第一个插件

[English](quickstart.md) | 简体中文

[作者工具包](README.zh-CN.md) · [测试指南](testing.zh-CN.md)

先写一个返回消息的工具。需要 Node.js 24.10 或更新版本，以及按[安装指南](../guide/install.zh-CN.md)准备的源码仓。作者测试不需要模型账号、原生构建或网络服务。

## 1. 准备预览 SDK

在 AGH 仓库安装一次依赖，构建 SDK 声明：

```sh
pnpm install --frozen-lockfile
nice -n 10 pnpm exec tsc -b packages/plugin-runtime packages/protocol
```

当前预览的 AGH 包尚未发布到 npm。下面使用本地 SDK 连接；匹配版本正式发布后，在生成目录内执行 `npm install`，替代本地连接步骤。

## 2. 创建独立包

仍在 AGH 仓库执行：

```sh
node templates/create-agh-plugin.mjs tool hello-tool ../hello-tool
node templates/link-local.mjs ../hello-tool
npm --prefix ../hello-tool run build
npm --prefix ../hello-tool test
```

脚手架拒绝已有目标目录，接受 `@acme/hello-tool` 等带 scope 的包名。它只复制源码，不运行安装脚本。预览连接器要求新建包目录，提供已构建声明与源码运行时链接，不修改导入路径。

预期一个测试通过：真实 Host 注册、调用 `plugin_hello_tool`、非法输入与取消拒绝、卸载移除工具。生成包位于 workspace 外，不含 `workspace:` 依赖或仓库相对导入。

## 3. 修改业务逻辑

打开生成包的 `src/index.ts`。`parameters` 把 `message` 推导为字符串，`result` 要求成功的 `structured` 与结果 schema 匹配。替换 echo 逻辑，保留简明的模型可见 `content`。

用 `toolError('message')` 表达预期业务拒绝；意外故障直接抛出。调用 `ctx.signal.throwIfAborted()`，并把 `ctx.signal` 传入异步操作。长期客户端或订阅绑定 `ctx.effect()`，每次调用的资源在 `finally` 释放。

模板默认只读、闭世界且可安全重放。增加文件写入、远程调用等副作用时应修改这些声明。编辑后重新构建并运行包内测试。

## 4. 在 AGH 运行

按[插件管理](../guide/packages.zh-CN.md)安装构建目录，检查信任信息并启用 `main`。在配置模型的新会话中请求：

> 调用 plugin_hello_tool，message 为 hello。

工具记录应包含 `{"message":"hello"}`。检查记录确认真实调用；相同文本回复本身不能证明模型使用了插件。

需要侧栏时选择 `tool-with-panel`，其他入口见[插件类型](README.zh-CN.md)。其描述文件声明 `ui:sidebar`，标签通过独立浏览器生命周期渲染。
