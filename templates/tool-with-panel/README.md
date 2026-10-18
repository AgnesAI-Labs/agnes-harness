# __PACKAGE_NAME__

AGH tool-with-panel starter: a working profile to-do list with a tool, query/effect services and a React page. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Ask a new session to call `__TOOL_NAME__` with `{"action":"add","text":"First item"}`, `{"action":"list"}` or `{"action":"toggle","id":"<item id>"}`. The tool and page share the public owner/profile-bound `OwnedStore`; review `capabilities.store: true`. This is profile data, independent of the workspace and retained across restart. The example limits the list to 100 items of 200 characters.

Open the printed AGH Web URL and the additional `__PACKAGE_NAME__` sidebar page. It works without a selected conversation. Add an item, toggle its checkbox and refresh; a failed request shows an alert. The plain JavaScript imports React from the Host import map and uses `React.createElement`, with no frontend build step or global React/h injection. `apply(ctx, config)` captures the client context; page props contain presentation context, not tool execution APIs.

The descriptor declares `__SERVICE_NAME__.list` and `__SERVICE_NAME__.change` in `client.services`. The backend registers these with `scope: 'profile'`. The browser uses `ctx.profile.services.query/effect/readOperation`; there is no browser `ctx.tools.invoke`. Keep an effect's operation id for receipt lookup. For approval-required receipts, approve in the Host Approvals page and check the same operation. For running/unknown results, inspect or reconcile that operation before starting another mutation. Host authorization remains authoritative.

Both shipped tests are inherited by authored candidates: the backend test uses `createPluginTestHost` with an isolated `storeDir`, invokes the tool and services and recreates the Host to check persisted data. `invokeProfileService` tests registered handler contracts; it does not simulate native approvals or the operation journal. The DOM test uses `@agnes/web-client/testkit` and replaces only `profileCaller`, keeping the real client facade, descriptor allowlist and registration lifecycle. It exercises loading, list rendering, add/toggle, receipt lookup and errors in English and Chinese. Run these through `agh plugin test <folder>` (or `plugin_test` for a candidate). They do not prove installation or real-browser appearance.

Use the [version-matched author reference](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/reference/plugin-author-api.md) and template instead of searching Host/installed source to guess APIs; private install directories are denied by design. For delivery, assemble the complete candidate, pack it with `agh plugins pack <folder> <output.tgz>`, then call `present` with the workspace `.tgz` filesystem path. An `artifact://` reference is not a workspace path. Installation and publication still require human review.

中文：这是可读写的待办示例，工具与 React 页面共享宿主绑定的 profile 存储，须审阅 store 能力。页面无需选中会话，通过描述符声明的 profile query/effect 服务读写，使用正常 ESM React 导入，不存在浏览器 ctx.tools.invoke、全局 React 或 h 注入。保留写操作的 operationId；审批由宿主审批页完成，未知结果先查询核对，不盲目用新 id 重试。模板测试覆盖真实登记、工具与服务读写、Host 重建后保留数据，以及中英文 DOM 交互、加载与错误；不等于安装或真实浏览器外观验收。请用本版本作者参考和模板，不翻查私有安装源码猜 API；交付时打包完整候选，将工作区 .tgz 路径传给 present，不能传 artifact:// 引用，安装发布仍需人工审阅。
