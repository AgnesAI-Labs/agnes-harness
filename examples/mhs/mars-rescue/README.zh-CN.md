# 火星救援

[English](README.md) | 简体中文

11 台虚拟设备、MHS 示例页内的程序化 3D 火星基地，以及救援和采样业务 Agent 的启动声明。所有设备均为模拟器。[设备指南](../../../docs/guide/mhs.zh-CN.md)。

本包面向新插件架构及干净 AGH home，不迁移旧 Mars-world 会话。浏览器资源及许可完整随包，首次打开无需下载模型、纹理或 Draco 解码器。原创程序化场景替代旧版下载模型，并未重新分发旧模型。

**集成状态：**模拟器、profile 运行时、场景和 SDK 合同测试已经实现；仍需父 MHS 的经审核设备传输及启动适配器。缺少适配器时，Start 明确显示连接不可用，设备不冒充在线，Agent 启动不可用。这不代表生产启用或端到端验收已经完成。

## 安装与使用

在已集成 MHS 受管理运行时及审核后示例连接器的 Host 中，打开 **MHS → 示例 → 火星救援**，查看随包能力并显式启用。`exampleOf: @agnes/mhs` 仅为目录关系，不是借用父包服务的授权；父服务连接也必须审核。Start/Retry 等待 11 台 SDK 设备真正注册后才显示 Ready。示例没有内置模型账号或隐藏模型路由，请选择 profile 中已配置的支持图片及工具的模型。

场景就在 MHS 页面内。**1–9** 依次选择全景、车库/实验室、跳跃器停机坪、气闸、野外、电力、旗帜、通信及跳跃器跟随视角，**0** 跟随 Monolith。**L** 切换标签，**M** 切换地图。控件归当前组件实例所有，没有全局 DOM ID 或 document 键盘监听。

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

相机渲染独立于可见场景，模型收到实际模拟场景的 PNG。可选 WebCodecs H.264 视频最多同时启用两个源，失败可重试；缺少 WebGL 时相机不可用，不伪造图片。这个小示例没有复刻旧火星世界的视觉精度或全部自主环境变化。

## 扩展接口与本地检查

`MarsRuntime` 接收 `MarsTransport`：`connect(Device, signal)` 返回注册就绪、连接寿命和幂等 close。就绪必须覆盖 SDK 双通道，不能以 socket 打开代替。父 MHS 客户端须在经审核的 Cordis profile 作用域提供 `mhsExampleAccess`，仅开放 `connect(exampleId, device, signal)` 与 `launch(exampleId, launchId, operationId)`；绑定当前 profile、精确示例包、审核后的跨 owner grant 和当前 activation，不返回原始 admin 客户端。启动实现用通用 prepare/start API，重试保留 operation ID。该窄接口是待接线的消费端口，不是已经存在的 AGH 作者 API。

设备传输使用公开 `@agnes/mhs-device` TypeScript SDK；Python 设备使用 `packages/mhs-device/python` 独立发行包。两者均不经 MCP。协议校验和准入由 SDK 与 Hub 拥有，不向本包复制 wire schema。两种 SDK 都必须保留设备本地断线停车及手动 deadman。本浏览器模拟器不是硬件安全控制器，也不证明 MHS 认证。

工作区具备 MHS SDK 后运行：

```sh
pnpm exec tsc -p examples/mhs/mars-rescue/tsconfig.json
pnpm exec vitest run examples/mhs/mars-rescue/test --project fast --maxWorkers=1
node examples/mhs/mars-rescue/tools/build.mjs
```

构建使用 esbuild 0.28.2，浏览器产物随源码提交供离线安装。资源清单记录字节、SHA-256 和许可，源码变化后重建；AGH 发行包应完整携带 `client`、`assets`、`skills`、`LICENSE` 和 `NOTICE`。浏览器、受管理运行时和批准的完整检查属于集成验收，单测不能替代。旧版世界没有可复用演示视频；当前以源码及视角控制供审阅，仍待集成预览验收。
