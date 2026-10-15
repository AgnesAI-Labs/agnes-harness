# 火星救援

[English](README.md) | 简体中文

11 台虚拟设备、MHS 示例页内的程序化 3D 火星基地，以及救援和采样业务 Agent 的启动声明。所有设备均为模拟器。[设备指南](../../../docs/guide/mhs.zh-CN.md)。

本包面向新插件架构及干净 AGH home，不迁移旧 Mars-world 会话。浏览器资源及许可完整随包，首次打开无需下载模型、纹理或 Draco 解码器。NASA 漫游车、宇航服与 Poly Haven 岩石资源、纹理及署名随包提供，显示使用预转换几何体和材质基色。

**集成状态：**已接入实际 MHS profile 运行时与经审核的浏览器 producer 通道。启用示例会启动 profile 持有的模拟器，11 台设备完成真实 Hub 注册后才显示就绪。GPU、媒体及真实模型浏览器验收仍是独立检查。

## 安装与使用

在已集成 MHS 受管理运行时及审核后示例连接器的 Host 中，打开 **MHS → 示例 → 火星救援**，查看随包能力并显式启用。`exampleOf: @agnes/mhs` 仅为目录关系，不是借用父包服务的授权；父服务连接也必须审核。Start/Retry 等待 11 台 SDK 设备真正注册后才显示 Ready。示例没有内置模型账号或隐藏模型路由，请选择 profile 中已配置的支持图片及工具的模型。

场景就在 MHS 页面内，Start 前可查看离线基地预览。**1–9** 依次选择全景、车库/实验室、跳跃器停机坪、气闸、野外、电力、旗帜、通信及跳跃器跟随视角，**0** 跟随 Monolith。**L** 切换标签，**M** 切换地图。控件归当前组件实例所有，没有全局 DOM ID 或 document 键盘监听。

**Reset simulation** 中断运动并恢复位置、消耗品、货物、分析和救援状态，不替换 11 台设备的注册。**Stop example** 停止运动并断开本示例设备，不关闭父 Hub 或其他设备；Start 可重新连接。进入会话或收起设备工作台只卸载场景视图，profile 运行时及相机渲染继续。关闭浏览器、设备断线、模拟时钟挂起、撤销示例或禁用父包必须停车断开。恢复不会自动重跑旧运动。

**Rescue Agent / Sample Agent** 通过审核后的父包窄接口创建普通、可去重的会话。七工具全部由 MHS 提供，示例只注册业务 Skill。运动仍需原生批准；拒绝即停止该动作，回执未知先核对，启动提示和模拟状态都不是运动授权。

## 设备与任务

| 设备 | 行为 |
| --- | --- |
| habitat-01 | 大气读数，普通、避风、医疗模式 |
| airlock-01 | 气压和门互锁，安全循环 |
| suit-01 | 氧气、位置、头盔图片和救援完成状态 |
| rover-01 | 有界避障路线、采样货物、停靠及手动失联停车 |
| hopper-01 | 火箭跳跃、相机巡查、高度/燃料限制及着陆余量 |
| monolith-01 | 地面移动、跟随、搬运宇航员/样本、手动控制及说话 |
| lab-01 | 仅卸载已停靠车辆的样本，分析队列样本 |
| power-01 | 收放/清洁阵列、负载削减及生命支持优先级 |
| weather-01 | 合成风速、尘埃及风暴读数 |
| comms-01 | 天线指向及有链路/窗口时发送报告 |
| cam-base | 相机视角及缩放声明 |

救援链：巡查西野、将宇航员搬至气闸、准备医疗模式并核对 `suit-01.rescued`。采样链：巡查、按安全路线到 rock-1、采集、停靠、卸载、分析、发送，并核对合成分析及发送结果。

相机渲染独立于可见场景，模型收到实际模拟场景的 PNG。可选 WebCodecs H.264 视频最多同时启用两个源，失败可重试；缺少 WebGL 时相机不可用，不伪造图片。风尘、宇航服消耗、供电和通信窗口随确定性的模拟时钟变化，GPU 视觉仍需真实浏览器验收。

## 扩展接口与本地检查

`MarsRuntime` 接收 `MarsTransport`：`connect(Device, signal)` 返回注册就绪、连接寿命和幂等 close。子示例 profile 模块通过 `createMarsExampleAccess` 注册 `mhsExampleAccess.connect(exampleId, device, signal)`。两个认证同源 producer 通道分别复用传输 11 台设备及相机媒体；后端只按 manifest 明确审核的 managed `requires` grant 转接当前父 MHS 运行时，绑定 child、profile 和 activation。`exampleOf` 本身不授予权限。

实际 `@agnes/mhs-ui` 示例标签渲染已注册页面，经页面现有 context 传入 `ExampleSceneHost`。示例只绑定一次 profile 运行状态与 Stop；宿主展示真实连接数，不持有模拟器。离开再进入场景保留该绑定。救援与采样按钮请求父模块的启动 review，由宿主调用真实 owner-bound prepare/start；设备就绪前禁用启动。场景内同样展示 review，结果未知时保留 ticket 与 operation ID，父页面重新加载后仍复用请求。示例不提供启动权限或包管理 admin 客户端。

设备传输使用公开 `@agnes/mhs-device` TypeScript SDK；Python 设备使用 `packages/mhs-device/python` 独立发行包。两者均不经 MCP。协议校验和准入由 SDK 与 Hub 拥有，不向本包复制 wire schema。两种 SDK 都必须保留设备本地断线停车及手动 deadman。本浏览器模拟器不是硬件安全控制器，也不证明 MHS 认证。

工作区具备 MHS SDK 后运行：

```sh
pnpm exec tsc -b examples/mhs/mars-rescue/tsconfig.json
pnpm exec vitest run examples/mhs/mars-rescue/test --project fast --maxWorkers=1
node examples/mhs/mars-rescue/tools/build.mjs
```

构建使用 esbuild 0.28.2，浏览器产物随源码提交供离线安装。资源清单记录字节、SHA-256 和许可，源码变化后重建；AGH 发行包应完整携带 `client`、`assets`、`skills`、`LICENSE` 和 `NOTICE`。浏览器、受管理运行时和批准的完整检查属于集成验收，单测不能替代。[仓库 README](../../../README.zh-CN.md) 提供原版 Mars World 视频入口；视频记录旧场景，不代表本包已经验收。当前仍以源码及视角控制供审阅，等待集成预览验收。

导出的 `createMarsHubTransport` 使用真实公开 Hub/DeviceLink 合同接入受管理的嵌入式模拟器，要求显式审核后的 current-link 检查，并拒绝接管在线设备。实际浏览器路径使用认证 producer bridge；Agent 启动已接入实际 Examples 宿主。

受管理运行时检查使用真实 `@agnes/sdk/managed-service`、SQLite owned store 和 `startManagedMhsHub`，父服务停用会让 11 台设备全部停止并离线。模拟器不另建 Hub，也不假造 singleton。已合入的 `registerMhsStreams` 提供 North 事件、媒体和控制通道；已安装运行时另行注册经审核的 producer 接入，人工控制继续保留原生运动批准，示例启动已接入 Examples 宿主。

权限与 wake 检查使用真实 `createProfileServiceRuntime`、`createMhsNativeProfileAdapter`、`mhsOwnedStore`、Host SQLite persistence、`ProfileWakeBindings` 及 `BoundWakeService`/`JobsRepo`。Mars 运动由真实 AR1 回答批准或拒绝，误用 fake approval seam 会令测试失败。真实 watch 将通知写入原 session/lane/generation 的持久任务，重建队列适配器后重复入队保持同一 job，撤销后拒绝投递。测试中的包清单、本地身份与原会话事实为合成 fixture；真实 worker/session 输入投递仍须集成检查。

Producer 心跳在通道停滞后两秒内停止本地设备。页面从挂起恢复时也会停止物理更新，不补算运动；Retry 不重放先前动作。

场景离线包含 NASA 毅力号、Mark III 宇航服以及 Poly Haven 岩石的原始模型、纹理和署名，详见 `NOTICE` 与 `assets/third-party.json`。显示使用预转换的几何体和材质基色，无需运行时下载 Draco。R 重置视角，拖动环绕、滚轮缩放；可调画质、时间、高度遮蔽与高亮泛光，`?stats` 显示 FPS。GPU 视觉和真实浏览器 H.264 仍需集成验收。

漫游车提供只读 `plan_route`、激光雷达与占用 PNG；Monolith 区分步行和滚动，滚动路线保持更大岩石间距并拒绝靠近宇航员；跳跃器按移动与上升耗能，区分两个着陆垫。风尘、氧气、电量、供电和通信窗口随模拟时钟变化。
