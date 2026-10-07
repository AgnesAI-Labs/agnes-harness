# MHS 与设备接入：让任务走进物理现场

[English](mhs.md) | 简体中文

[项目首页](../../README.zh-CN.md) · [文档导航](../README.zh-CN.md) · [FDE 与应用场景](why-agh.zh-CN.md)

> **预览：MCP 设备接缝与模拟巡检 bundle 已提供，不宣称 MHS 兼容。**

从巡检和运维到仪器协作，现场工作需要将设备状态、人的判断与业务流程连接起来。AGH 计划探索通过 MHS（Model Hardware Standard）接入物理设备，以 MCP（Model Context Protocol）作为设备连接层，让状态读取、操作请求和执行回执进入同一套任务流程。

在 AGH 的[大脑、小脑、记忆与身体比喻](../develop/architecture.zh-CN.md#大脑小脑记忆与身体)中，MHS 代表身体，即连接物理能力的接口。设备及其控制器提供这些能力，AGH 提供任务编排、人工确认和记录。这一方向可以纳入使用同一软件底座的 FDE 交付。

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

AGH 负责组织任务、授权交互和结果记录；适配层将设备能力接入任务流程；设备控制器负责实际动作与现场保护。AGH 的设备接入方向以 MCP（Model Context Protocol）为适配层基础——这是一套模型无关、有版本规范的协议，而不是厂商专属 SDK 或 ROS 桥接。仅完成一次 MCP 连接本身不构成 MHS 兼容性验证，因为目前没有可供认证的公开 MHS 规范。

[device-inspection bundle](../../examples/fde/device-inspection/README.zh-CN.md) 已在本地模拟器展示“读取状态 → 识别异常 → 人工确认 → 受约束处置 → 核对回执”。具体型号、动作和失败处理需要单独实现与验证。

## 即将开放的内容

| 内容 | 计划说明的范围 | 当前状态 |
| --- | --- | --- |
| 接入指南 | 设备能力描述、适配位置、身份与权限配置 | 即将开放 |
| 示例与复现步骤 | [模拟巡检](../../examples/fde/device-inspection/README.zh-CN.md)，默认 dry-run | 预览 |
| 设备验证说明 | 支持型号、软件版本、验证环境与已知限制 | 即将开放 |

具体适配方案、支持设备与示例将在验证后公布，开放日期尚未确定。当前处于探索阶段；模拟器提供软件流程示例，但尚无已验证的通用 MHS 适配器或物理设备。

## 接缝（预览）

包可在其他能力之外声明 `agnes.capabilities.device: true`，为安装预览、能力 hash 与 allow/deny 检查添加 `device` 审核/策略原子。这是可选的增量字段，既有清单的 hash 与行为保持不变。它不授予控制器权限、不隔离插件代码，也不认证设备适配器。

MCP 桥保留 `readOnlyHint`、`destructiveHint` 与 `idempotentHint`，映射到已有工具策略元数据：

| MCP 注解 | 工具元数据 / 默认手动策略 |
| --- | --- |
| 只读且无破坏性提示 | 只读，可安全重放 |
| 破坏性提示，包括矛盾的只读提示 | 写操作，`requiresApproval: always` |
| 写操作无幂等保证 | `replay: never`，`requiresApproval: always` |
| 显式非破坏性且幂等的写操作 | `replay: idempotent`；仍受其他部署策略约束 |

缺失的写操作注解保守处理。幂等性不会预批准破坏性动作。默认策略在正常 manual/smart 模式消费这些元数据；显式 full-access 或 approval-off 配置保留既有语义。设备 bundle 的策略在这些设置下也会对每次写操作询问。桥不会从提示推断安全限额，也不保证远端真实幂等。

可安装的 [device-inspection bundle](../../examples/fde/device-inspection/README.zh-CN.md) 包含公开端口 loop、工具、确认策略、Skill 与本地 stdio MCP 模拟器。它默认 `dry_run: true`，只接受受限降温目标与状态版本前置条件，拒绝冲突幂等键，动作后读取回执与状态。dry-run 回执只证明预演，不证明温度变化。回执仅存于模拟器进程中。结果未知或副作用中断时停止并要求检查，不自动重放。

该示例 **受 MHS 启发，不宣称 MHS 兼容**。真实接入仍须验证单位、限额、控制器权限、持久去重和回执对账。安装与客户适配见 [FDE bundle 索引](../../examples/fde/README.zh-CN.md)。

## 设备控制边界

实时运动控制、互锁、急停和现场接管由相应设备与控制系统承担。AGH 中取消任务不等于设备已安全停止；连接中断或回执缺失时，需要核对设备状态，避免重复执行结果未知的动作。桌面 Computer Use 的验证也不代表物理设备已经接入。

目前可以先从[后端插件](../develop/backend.zh-CN.md)、[MCP](mcp.zh-CN.md)和[前后端联动](../develop/fullstack.zh-CN.md)了解软件扩展方式。设备方向的需求可按[反馈规则](../develop/contributing.zh-CN.md)提供，代码与文档 PR 仍仅限受邀内部开发者。

## 当前状态摘要

**预览接缝与模拟巡检示例已提供。** 经过验证的通用 MHS 适配器与受支持设备清单仍待后续交付。模拟器不证明 MHS 兼容或物理设备验收。实时控制与物理安全仍由设备控制器负责。
