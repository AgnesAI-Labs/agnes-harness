# 前后端联动：让面板读到业务结果

[English](fullstack.md) | 简体中文

[文档导航](../README.zh-CN.md) · 前提：[后端](backend.zh-CN.md)与[前端](frontend.zh-CN.md)

这一步把界面和后端连起来。完成后，面板会显示后端返回的版本；你还会验证更新、回滚和撤权后的变化。它可以作为只读业务状态面板的起点。

复用 [client-service-panel/v1](../../examples/packages/client-service-panel/v1/package.json)。当前示例由**同一个受信 Cordis 行注册 query service，并声明对应的浏览器模块**；浏览器通过同源 BFF 发起受限调用。

## 结构与调用链

```text
package.json
  agnes.plugins → runtime 命名导出（后端 Cordis 行）
  agnes.clientDescriptors → 同 rowId 的 agnes.client.json
extensions/main/index.mjs
  runtime.apply(ctx) → ctx.services.register(panel.version)
extensions/main/client/index.js
  ctx.agnes.services.call('panel.version', {}) → 显示版本
```

浏览器 Context → 当前 client row 的 service allow-list → 本地同源 BFF → daemon 的身份/状态校验 → worker/Host 的行服务授权 → handler。

`ctx.provide()` 只在本端 Context 发布 Cordis 依赖，不会自动成为远程服务。后端行应通过 `ctx.services.register()` 注册受 Host 约束的服务；`ctx.extension().registerService()` 仍被拒绝。不要创建第二个浏览器 SDK/daemon socket 来绕过 BFF。

## 运行前显式配置能力上限

默认 local-dev 的 capabilityCeiling 不含 `services`。因此该示例在未配置时应出现 policy blocker，不能把 blocker 当成文档失败而跳过。

在**独立实验 home** 的 `profiles/local-dev/profile.yaml` 中使用下面覆盖；它保留当前默认能力集合，只额外加入 `services`，不应用到日常实例：

```yaml
name: local-dev
policy:
  capabilityCeiling:
    - tools
    - hooks
    - slots
    - events
    - resources
    - ui
    - services
    - network
    - network.publicRead
    - tools.invoke
    - artifacts
    - subagent
```

profile 必须在该实例启动前写好；若已运行，结束实验任务后显式停止并重启该实验实例。不要编辑现有用户 profile 来做教程。启动后 inspect、install、trust、enable：

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-service-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-service-panel/v1
```

后续 trust/enable 使用实际预览摘要，流程见[插件管理](../guide/packages.zh-CN.md)。

## 后端与前端各声明一次

[包声明](../../examples/packages/client-service-panel/v1/package.json)中的 `agnes.plugins` 声明后端行，`agnes.clientDescriptors` 将[客户端描述](../../examples/packages/client-service-panel/v1/extensions/main/agnes.client.json)绑定到同一行。描述文件的 `client.services` 只列出浏览器可调用的服务名；Host 仍核对服务是否由该行真实注册并允许当前会话访问。

[后端入口](../../examples/packages/client-service-panel/v1/extensions/main/index.mjs)通过 `ctx.services.register` 定义 `panel.version` 的 `kind: query`、输入/输出 Schema、超时和最大结果字节；handler 返回当前示例版本。[浏览器入口](../../examples/packages/client-service-panel/v1/extensions/main/client/index.js)使用 `ctx.agnes.services.call('panel.version', {})`；不会收到 Host grant 或 daemon 凭据。

调用要求当前会话。先在 Web 配置模型并创建/选择会话，再启用插件或刷新页面，让 apply 在会话就绪后执行。示例在 apply 时只查询一次；无会话时显示 `unavailable`，不会在后来选会话后自动重试。这是最小样例的限制，正式应用应围绕当前会话生命周期安排刷新。

成功显示 `backend 1.0.0`；更新到 v2 后重新核对前后端均为 `2.0.0`。只显示前端 v2 不能证明后端已切换。

## 失败与清理

移除后端行、关闭对应浏览器行、撤信任、缺少 allow-list 或当前会话，都应拒绝服务调用；前端会显示 unavailable。普通插件的安装代码不能自行授予 `services`。

禁用后端与前端贡献后旧句柄不应继续生效。回滚需要保留的受信快照和当前策略；不自动回滚外部业务数据。不要把该 query 样例改成写操作却保留 `kind: query`；有副作用服务另需 effect/命令身份与授权合同。

## 验证命令

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host/test/assemble/dynamic-client-extension.test.ts packages/daemon/test/client-modules.test.ts --maxWorkers=1
```

该组合覆盖示例模块、Host 装配撤权和 daemon 浏览器调用边界；完整 browser → BFF → daemon → worker → Host 的可选验收程序为 [web-workbench.mjs](../../tools/acceptance/web-workbench.mjs)，实际运行版本与覆盖范围单列于[验证记录](../maintainers/verification.zh-CN.md)。

事实源：[Host 动态 client 扩展](../../packages/host/src/assemble.ts)、[动态装配测试](../../packages/host/test/assemble/dynamic-client-extension.test.ts)、[ClientContext 的服务门控](../../packages/web-client/src/client-module.ts)。
