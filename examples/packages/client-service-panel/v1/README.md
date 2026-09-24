# Client Service Panel v1

最小的同包浏览器模块 + 后端 query service 示例。

- `capabilities.services` 声明并由后端 `registerService()` 注册 `panel.version`；
- `contributes.client.services` 仅把同名服务加入该 client row 的浏览器 allow-list；
- client entry 只能使用 `ctx.agnes.services.call('panel.version', {})`。它不会拿到 daemon socket、Host grant、extension 选择器或 effect command id；
- 服务经本地 Web 的同源 BFF 调用。未声明、停用、撤信任或不再 ready 时调用会 fail-closed。

此包由 `tools/acceptance/web-workbench.mjs` 用于真实 browser → BFF → daemon → worker → Host 验收；它不是把后端服务开放成通用浏览器 RPC 的模板。
