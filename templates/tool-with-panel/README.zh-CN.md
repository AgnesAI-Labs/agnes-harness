# __PACKAGE_NAME__

[English](README.md) | 简体中文

AGH 工具与面板模板：完整的 profile 待办清单，包含工具、query/effect 服务和 React 页面。需要 Node.js 24.10 或更新版本及匹配的 AGH 包构建。

__SETUP_GUIDE__

让新会话调用 `__TOOL_NAME__`：`{"action":"add","text":"First item"}`、`{"action":"list"}` 或 `{"action":"toggle","id":"<item id>"}`。工具和页面共享绑定 owner/profile 的公开 `OwnedStore`；须审阅 `capabilities.store: true`。数据独立于工作区，重启后保留。最多 100 项，每项 200 字符。

打开 AGH 输出的 Web 地址及侧栏追加的 `__PACKAGE_NAME__` 页面；无需选择会话。添加一项、切换完成状态并刷新，失败请求显示提醒。普通 JavaScript 从 Host import map 导入 React，使用 `React.createElement`，无需前端构建或全局 React/h。`apply(ctx, config)` 捕获客户端上下文，页面 props 是展示上下文，不提供工具执行 API。

描述符在 `client.services` 声明 `__SERVICE_NAME__.list` 和 `__SERVICE_NAME__.change`；后端以 `scope: 'profile'` 登记。浏览器调用 `ctx.profile.services.query/effect/readOperation`，没有浏览器 `ctx.tools.invoke`。待决 operation 身份保存在标签页会话存储，按 profile activation 和客户端版本隔离。重开或刷新先读取原回执，再允许新变更；终态清除，存储失败不派发。需要审批时在 Host 审批页确认并查询同一操作。运行中或结果未知时先核对原操作，不用新身份盲目重试。授权仍由 Host 决定。

两个随模板提供的测试会被候选继承：后端通过 `createPluginTestHost` 和隔离 `storeDir` 调用工具及服务，重建 Host 检查数据保留。DOM 测试使用 `@agnes/web-client/testkit`，只替换 `profileCaller`，保留真实客户端 facade、描述符白名单及登记生命周期，覆盖中英文加载、列表、添加／切换、回执查询与错误。通过 `agh plugin test <folder>`（候选用 `plugin_test`）运行；这些测试不证明安装或真实浏览器外观。

使用[版本匹配的作者参考](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/reference/plugin-author-api.zh-CN.md)和模板，不要搜索私有 Host／安装源码猜 API；私有安装目录按设计拒绝访问。交付完整候选，用 `agh plugins pack <folder> <output.tgz>` 打包，再向 `present` 传入工作区 `.tgz` 文件系统路径，不能传 `artifact://`。安装发布仍须绑定精确测试候选的权限裁决：完全访问自动允许，其他权限保留人工审核。
