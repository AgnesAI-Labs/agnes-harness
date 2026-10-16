# MHS 浏览器客户端

[English](README.md)

MHS 插件通过公开客户端 registry、profile service 和认证 stream 提供设备、地图、活动、接入和示例五个页面，以及设备详情、会话设备工作台和七种工具卡片。页面不持有设备 socket、凭据、持久存储或审批裁决权。

浏览器贡献声明在 [`@agnes/mhs`](../mhs-plugin/agnes.client.json)。`pnpm --filter @agnes/mhs build:client` 把模块打包到该包被 Git 忽略的 `dist/client/`；React 和公开 Host 前端模块由宿主提供。缺少 profile authority、stream 或 primary 入口能力时拒绝激活。

设备声明由 SDK 校验，观测帧由 Hub 的公开 codec 解码。动作、设置、源开关和停止仅展示后端回执；`unknown` 不代表已安全停车。人工控制使用后端批准的设备租约，释放、失焦、隐藏、断流、过期和卸载时归零并请求独立停止接口。设备本地 deadman 仍然必需。

工具参数可用 `tool.ui.params.<参数名>.pick` 声明 `point`、`pose` 或 `polygon` 地图选择；参数本身继续遵循 SDK 的 JSON Schema 子集。输出分别为 `{map,x,y}`、`{map,x,y,yaw}`（角度）和 `{map,points}`，未声明选择提示的对象和路线使用 JSON 输入。

Activity 支持 1–1,000 的条数上限和最多 512 字符的 opaque cursor。当前会话过滤须请求 Host session-read 范围，并按已认证调用者的持久会话所有权校验；缺失或越权会被拒绝。活动采用 Hub 的七天窗口、最早可读时间和有界 cursor 分页。会话设备列表来自当前会话公开 UI 投影，切换立即清空；截断预览保留为文本，不猜测设备 ID。示例启用和启动使用原生 review/launch 合同，安装状态与运行就绪分开显示。

安装模块将开发诊断绑定到通用受管理服务接口，将示例状态和 Stop 绑定到原生示例 facade；未注册运行资源的子示例仅显示已安装。实际宿主审批、设备安全、浏览器媒体/GPU 和发行安装流程仍需集成验收。

真实 Host 适配器保留待审批提案的不可变输入和原 operation id，协调时仅重试该提案，直至原生审批完成。运行中、已完成、已拒绝及 unknown 操作只查询回执，不重发。卸载会取消待审批重试，最多保留 1,024 条操作关联。原生批准入口位于 Web 侧栏的操作审批区。

本地场景模块可读取既有 `context.data` 中的 `ExampleSceneHost`，须核对 kind 为 `agnes.mhs-example-scene/v1` 且 exampleId 匹配。用子模块 profile 寿命 signal 绑定 `ExampleRuntime`，视图卸载不释放运行时。宿主投影状态与连接数、去重订阅，在父模块撤销时停止，并拒绝重复绑定；这些事实不赋予后端批准。标签与场景中的各个 launch 选项使用相同父级 review。结果未知时，在 profile/activation 隔离的 session storage 保留 ticket 与 operation ID，父页面重载后也不换新请求。


观测控件覆盖 MOS 所有类型，包括 float32 点云、占用 PNG、朝向轨迹、IMU 向量、GNSS 精度和检测框。声明驱动源分组、字段标签/角色/单位/阈值/隐藏和量表；轴 keys 覆盖角色默认键，箭头优先控制已声明的 pitch/yaw，否则控制 forward/turn。接入页高级配置把精确远端地址及白名单提交原生审批，浏览器不直接访问外部 Hub。

Hub 状态使用当前界面语言。恢复操作集中在页头：上次未正常关闭时通过受管 reconcile 操作执行**确认并恢复**。设备、地图、活动与示例会解释 Hub 尚未就绪并链接到恢复操作；独立请求失败保留本地重试。技术状态码和错误码放在详情中。示例卡片使用声明的本地化元数据（火星示例可回退到 MHS 语言目录），窄屏操作自动换行。
