# MHS 与设备接入：让任务走进物理现场

[English](mhs.md) | 简体中文

[项目首页](../../README.zh-CN.md) · [文档导航](../README.zh-CN.md) · [FDE 与应用场景](why-agh.zh-CN.md)

> **源码预览：已有原生 MHS 设备 SDK、profile Hub、插件 factory 和浏览器模块；普通安装激活使用通用 profile 受管理运行时、原生 authority 和认证 stream。物理设备尚未验收。**

从巡检和运维到仪器协作，现场工作需要将设备状态、人的判断与业务流程连接起来。MHS 插件通过自己的版本化命令与 MOS 观测通道，把状态读取、操作请求和执行回执接入任务流程；MHS 不以 MCP 作为设备传输层。

在 AGH 的[架构](../develop/architecture.zh-CN.md#大脑小脑记忆与身体)中，设备适配器连接任务编排与物理能力。设备及其控制器提供这些能力，AGH 提供任务编排、人工确认和记录。这一方向可以纳入使用同一软件底座的 FDE 交付。

我们将围绕这些场景逐步开放指南和可复现示例，帮助开发者把设备能力、人工确认与业务界面组织成应用。

## AGH 计划如何接入

下面是拟议的职责关系，具体接口尚待验证：

```mermaid
flowchart LR
  Task[业务任务与人工确认] --> AGH[AGH 任务编排与记录]
  AGH --> Adapter[设备接入适配层]
  Adapter --> Controller[设备控制器]
  Controller --> Device[仪器与物理设备]
  Device --> Receipt[状态与执行回执]
  Receipt --> AGH
```

AGH 负责组织任务、授权交互和结果记录；适配层将设备能力接入任务流程；设备控制器负责实际动作与现场保护。[设备 SDK](../../packages/mhs-device/README.zh-CN.md) 维护声明和本地安全，[Hub](../../packages/mhs-hub/README.zh-CN.md) 维护设备状态与回执，[Harness 插件](../../packages/mhs-plugin/README.zh-CN.md) 消费通用 Host 接口。Host 缺少 profile runtime 合同时拒绝激活，浏览器不会直接连接裸 North 控制 socket。

独立的 MCP [device-inspection bundle](../../examples/fde/device-inspection/README.zh-CN.md) 已在本地模拟器展示“读取状态 → 识别异常 → 人工确认 → 受约束处置 → 核对回执”。具体型号、动作和失败处理需要单独实现与验证。

## 浏览器工作台

官方发行包会在全新 home 中默认安装并启用 MHS，因此首次启动即可看到侧栏一级 **MHS** 入口。在 **MHS → 示例** 中可审查并一键安装/启动随包提供的火星救援示例。在插件页禁用 MHS 后，入口随之隐藏。已有 home 不自动补装，需自行安装并启用。

MHS 客户端提供固定一级入口，包含设备、地图、活动、接入、示例五个标签，以及设备详情、七种设备工具卡片和会话设备工作台。设备页面通过 profile services 读取与请求操作，查看或停止设备不创建隐藏会话。原生批准和设备人工控制租约由后端裁定；结果未知时可以只读核实状态，不会自动重发动作。

活动采用 Hub 的七天窗口、最早可读时间和有界 cursor 分页；未选中会话时禁用当前会话筛选。工作台数量来自所选会话用过的设备，切换会话立即清空。详情展示已确认的源状态与最近操作摘要；SDK 在到达静止检查点后才报告暂停。地图支持声明的区域、地标、设备信任/离线标记，以及点、姿态和多边形目标。

接入页展示 SDK 用法、声明与有界协议事件摘要；受管理健康、公开 SDK 地址、外部设置和一致性检查需要宿主拥有的诊断适配。示例使用经过审查的本地包启用/启动流程和已注册的页内场景，安装与运行分别显示。剩余接线边界见[浏览器合同](../../packages/mhs-ui/README.zh-CN.md)。

## 即将开放的内容

| 内容 | 计划说明的范围 | 当前状态 |
| --- | --- | --- |
| 接入指南 | [SDK](../../packages/mhs-device/README.zh-CN.md)、[Hub](../../packages/mhs-hub/README.zh-CN.md) 与[浏览器模块](../../packages/mhs-ui/README.zh-CN.md)合同 | 源码预览 |
| 示例与复现步骤 | [模拟巡检](../../examples/fde/device-inspection/README.zh-CN.md)，默认 dry-run | 预览 |
| 设备验证说明 | 支持型号、软件版本、验证环境与已知限制 | 即将开放 |

具体适配方案、支持设备与示例将在验证后公布，开放日期尚未确定。当前处于探索阶段；模拟器提供软件流程示例，但尚无已验证的通用 MHS 适配器或物理设备。

## 接缝（预览）

包可在其他能力之外声明 插件条目上的 `capabilities.device: true`，为安装预览、能力 hash 与 allow/deny 检查添加 `device` 审核/策略原子。这是可选的增量字段，既有清单的 hash 与行为保持不变。它不授予控制器权限、不隔离插件代码，也不认证设备适配器。

MCP 桥保留 `readOnlyHint`、`destructiveHint` 与 `idempotentHint`，映射到已有工具策略元数据：

| MCP 注解 | 工具元数据 / 默认手动策略 |
| --- | --- |
| 只读且无破坏性提示 | 只读，可安全重放 |
| 破坏性提示，包括矛盾的只读提示 | 写操作，`requiresApproval: always` |
| 写操作无幂等保证 | `replay: never`，`requiresApproval: always` |
| 显式非破坏性且幂等的写操作 | `replay: idempotent`；仍受其他部署策略约束 |

缺失的写操作注解保守处理。幂等性不会预批准破坏性动作。默认策略在正常 manual 模式消费这些元数据；显式 full-access 或 approval-off 配置保留既有语义。设备 bundle 的策略在这些设置下也会对每次写操作询问。桥不会从提示推断安全限额，也不保证远端真实幂等。

可安装的 [device-inspection bundle](../../examples/fde/device-inspection/README.zh-CN.md) 包含公开端口 loop、工具、确认策略、Skill 与本地 stdio MCP 模拟器。它默认 `dry_run: true`，只接受受限降温目标与状态版本前置条件，拒绝冲突幂等键，动作后读取回执与状态。dry-run 回执只证明预演，不证明温度变化。回执仅存于模拟器进程中。结果未知或副作用中断时停止并要求检查，不自动重放。

该示例 **受 MHS 启发，不宣称 MHS 兼容**。真实接入仍须验证单位、限额、控制器权限、持久去重和回执对账。安装与客户适配见 [FDE bundle 索引](../../examples/fde/README.zh-CN.md)。

## 设备控制边界

实时运动控制、互锁、急停和现场接管由相应设备与控制系统承担。AGH 中取消任务不等于设备已安全停止；连接中断或回执缺失时，需要核对设备状态，避免重复执行结果未知的动作。桌面 Computer Use 的验证也不代表物理设备已经接入。

目前可以先从[后端插件](../develop/backend.zh-CN.md)、[MCP](mcp.zh-CN.md)和[前后端联动](../develop/fullstack.zh-CN.md)了解软件扩展方式。设备方向的需求可按[反馈规则](../develop/contributing.zh-CN.md)提供，代码与文档 PR 仍仅限受邀内部开发者。

## 当前状态摘要

**原生 MHS 源码模块与独立 MCP 巡检示例已提供。** 经过验证的通用 MHS 适配器与受支持设备清单仍待后续交付。模拟器不证明 MHS 兼容或物理设备验收。实时控制与物理安全仍由设备控制器负责。

## 火星救援示例

随包的[火星救援](../../examples/mhs/mars-rescue/README.zh-CN.md) 实现 11 台模拟设备及页内程序化 3D 场景。[火星指南](mars-world.zh-CN.md) 说明生命周期、业务 Agent 启动及集成状态。经审核的 producer 连接已接入安装后的父运行时，定向检查覆盖注册、原生批准、Stop 与停用；完整浏览器和物理设备验收仍是独立检查。
