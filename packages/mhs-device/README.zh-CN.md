# Agnes MHS 设备 SDK（预览）

[English](README.md)

`@agnes/mhs-device` 拥有设备侧 MHS/MOS 协议、声明 schema 与 TypeScript SDK，不依赖 Harness Core、Host 或 daemon 内部实现。Python 独立发行目录为 [`python/`](python/)。这是新产品格式，不读取或迁移旧 Hub 状态。

设备声明身份、资源、工具、状态、数据源、地图与可选人工轴。`schema.ts` 是 schema 源，并推导公开 TypeScript 类型。`pnpm --filter @agnes/mhs-device gen` 生成 JSON schema 及 Python 包内的同一份资源，`gen:check` 检查两者。

```ts
import { Device, connectDevice } from '@agnes/mhs-device'

const device = new Device({
  protocol: 'mhs/v1',
  device: { id: 'sensor-01', kind: 'sensor' },
  state: { temperature: { type: 'number', unit: '°C' } },
})
device.update({ temperature: 22 })
const lifetime = new AbortController()
await connectDevice(device, 'ws://127.0.0.1:4180', lifetime.signal)
```

连接使用 `/ws/mhs` 传递有界 JSON-RPC 命令，`/ws/nerve` 传递观测与人工轴，两者使用 `mhs.v1` 子协议。注册成功后，Nerve 发送 `{type:'hello',device:<id>}`。`device.publish(source, data, bytes?, mime?)` 连续发送一条 MOS JSON 头及对应二进制帧。调用、停止与回执留在独立命令通道；`onConfigure` 和 `onKeyframe` 供适配器实现数据需求与视频恢复。

工具使用有界 JSON Schema 子集：object、array、number、integer、string、boolean、properties、required、default、上下限、enum 与 description。未知参数丢弃、数值限幅、字符串截断，类型无效时拒绝执行。设备和 Hub 都校验。资源在异步执行前占用，`reject` 拒绝冲突，`queue` 串行等待。工具获得 abort signal 和协作暂停 checkpoint，硬件驱动必须响应取消。

运动与人工控制必须提供 `SafetyPort`。`arm(ms)` 必须启动独立于当前 JavaScript 进程的 watchdog，`stop(reason)` 归零并确认硬件停止后才能完成。`onManual` 获得全部声明轴，缺省轴归零、数值限幅。人工 deadman 必须位于 `(0,2]` 秒。本地定时器仅是补充保护，不能在进程卡死时证明硬件安全。运动 handler 应频繁调用 `checkpoint(rest)` 刷新独立 watchdog，只有 checkpoint 确认静止后才确认暂停。

Stop 中断全部运动并归零人工轴。命令连接丢失时停止，重连不会恢复旧动作。替换关闭码 4001 与不支持版本关闭码 4003 会阻止自动重连。没有停止确认意味着结果未知，不能声称安全静止；联锁、急停与本地接管仍由硬件适配器负责。

监听默认只绑定 loopback，拒绝携带浏览器 Origin 的设备连接。裸 MHS 设备 id 不代表认证。真实部署需要显式认证的设备准入适配器或受控网络；人工与 Agent API 必须使用经审核的 Harness authority 与 stream gateway。系统不开放免认证的 North 控制 WebSocket。

除低频 pose 外，source 初始关闭，由 `mhs/configure` 按消费者需求启用。工具 `needs` 只能引用已声明的 source，关闭时以 `reason: "needs"` 和 source id 列表拒绝。资源占用拒绝包含 `holder: {call, tool, caller?}` 或 `{manual: true}`；caller 是 Hub 提供的展示标签，不是授权依据。

PCM16 音频使用 `{type:"clip",id,rate,channels}` 加单个 Nerve 二进制帧。两个 SDK 校验大小与采样对齐，最多缓存 8 段、60 秒，缓存成功后通过命令通道发送 `mhs/clip-received {id}`。名为 `clip` 的工具参数必须引用仍在缓存的音频。旧设备没有该新增确认时，上传视为未确认；发送前应升级两端。clip 和运动授权均不跨重连保留。
