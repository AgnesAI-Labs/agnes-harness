# UI 作者示例

[English](README.md) | 简体中文

UI 是插件能力。按意图选择页面、视图位置、工具结果卡片、交互卡片、设置分区、接管，参见[作者指南](../../docs/develop/ui-author-guide.zh-CN.md)。

| 示例 | 公开合同 | 自动验收 |
| --- | --- | --- |
| [组件库](component-library/) | 两个 pinned、有界 `intelligentComponents`、结构化 surface、支持 deferred 的 Loop | 真包 inspect、HTML 只作文本、正常工具授权、认证动作成功和重复命令回执 |
| [交互呈现接管](interaction-renderer/) | 应用显式选择 `interaction`、scoped 子 context、SDK UI 读取/动作和共享 `IntelligentSurface` | inspect、角色选择与回收、冷挂载和 epoch 变化后忽略旧结果 |
| [工具结果卡片](tool-result-card/) | `ctx.conversationCards` 呈现 `ui_example_ack` 已记录工具事实 | inspect、匹配工具和卸载回收 |

使用 Node 24 和仓库固定 pnpm，从仓库根运行：

```sh
pnpm install --frozen-lockfile
node agnes.mjs package inspect file:./examples/ui/component-library
node agnes.mjs install file:./examples/ui/component-library
```

使用隔离的 AGH home，按[插件管理](../../docs/guide/packages.zh-CN.md)完成审阅、信任和启用。组件库交付 Loop 与合成只读确认工具，不必声明智能体。会话还需要启用官方 Intelligent UI 后台（`ui_render`）。新会话选择 `example.ui-review@1.0.0`，例如 `node agnes.mjs -p "审阅合成示例" --loop example.ui-review@1.0.0`，也可在 Web 选择该运行方式。点击 Confirm 并确认业务动作后，结果通过认证 `action-result` 输入返回 Loop；伪造 prompt 和重复 commandId（包括 checkpoint 恢复后）不会重复推进。不会自动提交用户草稿或发送业务消息。

同样安装交互呈现包，在“设置 → 应用”显式采纳，选择其 `interaction` 接管角色。仅安装不会抢占当前产品；清除展示选择可恢复官方呈现。示例通过公开 UI 协议呈现已记录 surface、表单、确认、回执和审批导航。回执不确定时重用原 commandId，不将缺失回执视为成功。没有自有审核 renderer 的自定义组件保留纯文本 fallback。工具结果卡片可独立启用。

组件代码是审阅过的包代码；模型/Loop 只发布结构化数据，不执行生成的 HTML/JS。schema、大小/频率上限、pinned 版本和 CSP 保持原合同。卸载只回收呈现登记和订阅，不取消后台会话。懒加载页面只交付页面，角色、设置分区和 dock 视图应拆到独立 eager descriptor。

聚焦自动验收位于 `packages/package-manager/test/client-module-example.test.ts`、`packages/web-client/test/web-client.test.ts`、`packages/web/test/plugin-ui-wiring.test.tsx`、`packages/base/extensions/intelligent-ui/test/service.test.ts`。使用合成端口和内存账本，不依赖真实模型或外部账号；完整浏览器/发行验证属于集成门。
