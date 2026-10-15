# MHS 浏览器客户端

[English](README.md)

MHS 插件通过公开客户端 registry、profile service 和认证 stream 提供设备、地图、活动、接入和示例五个页面，以及设备详情、会话设备工作台和七种工具卡片。页面不持有设备 socket、凭据、持久存储或审批裁决权。

浏览器贡献声明在 [`@agnes/mhs`](../mhs-plugin/agnes.client.json)。`pnpm --filter @agnes/mhs build:client` 把模块打包到该包被 Git 忽略的 `dist/client/`；React 和公开 Host 前端模块由宿主提供。缺少 profile authority、stream 或 primary 入口能力时拒绝激活。

设备声明由 SDK 校验，观测帧由 Hub 的公开 codec 解码。动作、设置、源开关和停止仅展示后端回执；`unknown` 不代表已安全停车。人工控制使用后端批准的设备租约，释放、失焦、隐藏、断流、过期和卸载时归零并请求独立停止接口。设备本地 deadman 仍然必需。

工具参数可用 `tool.ui.params.<参数名>.pick` 声明 `point`、`pose` 或 `polygon` 地图选择；参数本身继续遵循 SDK 的 JSON Schema 子集。输出分别为 `{map,x,y}`、`{map,x,y,yaw}`（角度）和 `{map,points}`，未声明选择提示的对象和路线使用 JSON 输入。

Activity 支持 1–1,000 的条数上限和最多 512 字符的 opaque cursor。当前会话过滤须请求 Host session-read 范围，并按已认证调用者的持久会话所有权校验；缺失或越权会被拒绝。活动采用 Hub 的七天窗口、最早可读时间和有界 cursor 分页。会话设备列表来自当前会话公开 UI 投影，切换立即清空；截断预览保留为文本，不猜测设备 ID。示例启用和启动使用原生 review/launch 合同，安装状态与运行就绪分开显示。

开发者诊断、外部 Hub 设置及示例运行状态通过可选的受审查适配接口接入；缺少时明确显示不可用。实际宿主审批、设备安全、浏览器媒体/GPU 和发行安装流程仍需集成验收。

真实 Host 适配器保留待审批提案的不可变输入和原 operation id，协调时仅重试该提案，直至原生审批完成。运行中、已完成、已拒绝及 unknown 操作只查询回执，不重发。卸载会取消待审批重试，最多保留 1,024 条操作关联。原生批准入口位于 Web 侧栏的操作审批区。
