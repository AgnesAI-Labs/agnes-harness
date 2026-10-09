# 编写设备：MHS 设备库

[English](mhs-device.md) | 简体中文

[文档导航](../README.zh-CN.md) · [MHS 与设备](mhs.zh-CN.md) · [MHS 规范](../../packages/mhs/spec/mhs-spec.md)

本页介绍怎样用两个设备库之一把自己的硬件（或者它的模拟）接入 AgnesHub：Python 的 `agnes_mhs` 和 TypeScript 的 `@agnes/mhs/device`。两个库的设计相同。你声明设备是什么、能做什么，编写工具函数和几个钩子，协议由库来处理：登记、重连、参数检查与截断、资源、取消、停止、暂停、手动控制的失联保护（deadman）、状态上报、设置、数据流速率、关键帧请求、时钟应答、音频片段和存活检测。

## 设备声明什么

设备每次连接时登记一次，附上对自身的描述（[MHS 第 5 节](../../packages/mhs/spec/mhs-spec.md#5-device-description-mhsregister)）。库根据构造参数以及你声明的工具和数据源生成这份描述。

| 部分 | 说明 | 规范 |
| --- | --- | --- |
| 身份 | `id`、`kind`、显示名称 `name`、`model`、`mobile`，以及描述物理特性的 `profile` | [MHS 5](../../packages/mhs/spec/mhs-spec.md#5-device-description-mhsregister) |
| 定位方式 | `none`；`fixed`，附 `placement`；`self`，附 `pose` 数据源；或 `external` | [MHS 5.2](../../packages/mhs/spec/mhs-spec.md#52-localization) |
| 工具 | 可以要求设备做的事，参数 Schema 中的范围就是限制 | [MHS 6](../../packages/mhs/spec/mhs-spec.md#6-tools) |
| 资源 | 同一时间只允许一个调用使用的部件，策略为 `reject` 或 `queue` | [MHS 6.3](../../packages/mhs/spec/mhs-spec.md#63-resources) |
| 状态 | 由中枢保存的少量命名值，其中一部分是可写的设置，另有 `problem` 和 `faults` | [MHS 10.1](../../packages/mhs/spec/mhs-spec.md#101-state) |
| 数据源 | 通过 Nerve 通道推送的数据：相机、雷达、读数、位姿 | [MOS 3](../../packages/mhs/spec/mos-spec.md#3-sources) |
| 地图 | 设备知道的地图坐标系，以及其中带名字的地点 | [MOS 3.5](../../packages/mhs/spec/mos-spec.md#35-maps-and-places) |
| 手动控制 | 人可以操纵的轴，以及失联保护时间 | [MHS 9](../../packages/mhs/spec/mhs-spec.md#9-manual-control) |

在一次连接期间描述保持不变：能力不同的设备需要重新连接并再次登记。

## 最小的设备

一个带蜂鸣器的温度计：一个状态字段（`battery`）、一个数据源（`air`）和一个工具（`beep`）。下面两个版本是同一台设备。

### Python

```python
import asyncio
import random
import sys

from agnes_mhs import Device

dev = Device(
    "thermo-01",
    "sensor",
    name="Thermometer",
    state={"battery": {"type": "integer", "unit": "%", "min": 0, "max": 100, "role": "battery"}},
)
dev.update(battery=90)
air = dev.source(
    "air", "values", "air temperature at the device", hz=1,
    fields={"temperature": {"type": "number", "unit": "°C", "role": "temperature", "of": "air"}},
)


@dev.tool("Beep a few times, so people can find the device.", timeout=5,
          params={"times": {"type": "integer", "minimum": 1, "maximum": 5}}, required=["times"])
async def beep(call, times):
    for i in range(times):
        call.progress(done=i, total=times)
        await asyncio.sleep(0.3)
    return f"beeped {times} times"


async def measure():
    while True:
        if air.wants():
            air.send({"temperature": round(21 + random.random(), 1)})
        await asyncio.sleep(0.1)


async def main(url):
    sensing = asyncio.create_task(measure())
    try:
        await dev.run(url)
    finally:
        sensing.cancel()


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8800"))
```

### TypeScript

```ts
import { Device } from '@agnes/mhs/device'

const dev = new Device({
  id: 'thermo-01',
  kind: 'sensor',
  name: 'Thermometer',
  state: { battery: { type: 'integer', unit: '%', min: 0, max: 100, role: 'battery' } },
})
dev.log = (line) => console.log(line)
dev.update({ battery: 90 })
const air = dev.source('air', 'values', 'air temperature at the device', {
  hz: 1,
  fields: { temperature: { type: 'number', unit: '°C', role: 'temperature', of: 'air' } },
})

dev.tool(
  {
    name: 'beep',
    description: 'Beep a few times, so people can find the device.',
    timeout: 5,
    params: { times: { type: 'integer', minimum: 1, maximum: 5 } },
    required: ['times'],
  },
  async (call, { times }) => {
    for (let i = 0; i < times; i++) {
      call.progress({ done: i, total: times })
      await call.sleep(300)
    }
    return `beeped ${times} times`
  },
)

setInterval(() => {
  if (air.wants()) air.send({ temperature: Math.round((21 + Math.random()) * 10) / 10 })
}, 100)

await dev.run(process.argv[2] ?? 'ws://127.0.0.1:8800')
process.exit(0)
```

各部分的作用：

- **构造函数**给出身份并声明状态字段。在 `run` 之前用 `update` 给每个字段赋初值，因为设备登记后要立即上报全部字段。
- **数据源**声明了类型和字段。循环只在 `wants()` 为真时发送读数：库会跟踪中枢要求的速率和开关，不需要的数据直接丢弃。
- **工具**用 JSON Schema 声明参数。函数运行前，库会拒绝类型错误的参数，并把 `times` 截断到 1 到 5，同时在结果里附上说明。返回的字符串就是结果的 `detail`，也就是大脑读到的那句话。
- **`run`** 打开命令通道和 Nerve 通道，完成登记，应答中枢，连接中断后按退避间隔重连。中枢用同 id 的另一条连接替换该设备，或拒绝它时，`run` 返回。

### 接到 dev-hub 和 mhs-check

Python 命令在 `packages/mhs/python` 下运行，`uv run` 会准备好环境（[包说明](../../packages/mhs/python/README.md)）。TypeScript 库属于 `@agnes/mhs` 工作区包：本仓库中在依赖里写了 `"@agnes/mhs": "workspace:*"`、并设置了 `"type": "module"` 的包，可以用 `@agnes/mhs/device` 导入它，[`examples/mars-world`](../../examples/mars-world/README.md) 就是这样做的。它可以在 Node 和浏览器中运行，两者都有全局的 `WebSocket`。

要在设备页面上看到这台设备，先在仓库根目录启动开发中枢（见[不接硬件先试用](mhs.zh-CN.md#不接硬件先试用)），再让设备连上去：

```sh
cd packages/mhs/python
uv run python path/to/thermometer.py ws://127.0.0.1:4191
```

TypeScript 版本在它所在的包中运行：

```sh
pnpm exec tsx thermometer.ts ws://127.0.0.1:4191
```

要按协议检查它，先启动在 8800 端口等待的 `mhs-check`，再不带地址启动设备：

```sh
cd packages/mhs/python
uv run python -m agnes_mhs.check
uv run python path/to/thermometer.py   # 在第二个终端中
```

两个版本都能通过 Core、Perception 和 Streaming 测试档。

## 库参考

名称先写 TypeScript，再写 Python。用 `import { Device, CallError } from '@agnes/mhs/device'` 或 `from agnes_mhs import Device, CallError` 导入。

### 设备与声明

| TypeScript | Python | 作用 |
| --- | --- | --- |
| `new Device({ id, kind, name, model, vendor, firmware, mobile, radius, profile, localization, placement, maps, resources, manual, state, ui })` | `Device(id, kind, *, name, model, vendor, firmware, mobile, radius, profile, localization, placement, maps, resources, manual, state, ui)` | 设备本身。每个选项都是描述中的一个字段（[MHS 5](../../packages/mhs/spec/mhs-spec.md#5-device-description-mhsregister)）；`localization` 默认为 `none`，`mobile` 默认为 false |
| `dev.tool({ name, description, timeout, params, required, uses, motion, readOnly, pausable, needs, ui }, handler)` | `@dev.tool(description, *, timeout, name, params, required, uses, motion, read_only, pausable, needs, ui)` | 声明工具（[MHS 6.1](../../packages/mhs/spec/mhs-spec.md#61-declaration)）。`params` 是 Schema 的 `properties`，`required` 是必填参数名。Python 中 `name` 默认取函数名 |
| `handler(call, args)` | `fn(call, **args)` | 工具本身，可以是普通函数或异步函数。它收到调用对象和检查过的参数：TypeScript 中是一个对象，Python 中是关键字参数 |
| 返回 `undefined`、字符串或 `{ detail, data, notes }` | 返回 `None`、字符串或 `{"detail", "data", "notes"}` | 调用结果。字符串即 `detail`；没有时 `detail` 为 `<tool> done` |
| `dev.source(id, kind, description, meta)` | `dev.source(id, kind, description, **meta)` | 声明数据源并返回它（[MOS 3.1](../../packages/mhs/spec/mos-spec.md#31-declaration)）。`meta` 包括 `hz`、`fields`、`mount`、`default`、`switchable` 以及该类型的元数据 |
| `dev.description()` | `dev.description()` | 库发送的登记内容，便于打印或测试 |

### 调用

| TypeScript | Python | 作用 |
| --- | --- | --- |
| `call.id`、`call.name`、`call.args`、`call.motion`、`call.pausable`、`call.uses` | 相同 | 正在运行的调用及其工具声明 |
| `call.progress({ done, total, text, data })` | `call.progress(done=, total=, text=, data=)` | 上报进度（[MHS 7.2](../../packages/mhs/spec/mhs-spec.md#72-progress)）。每秒最多发出 2 条，其余丢弃，所以可以放心在密集循环里调用 |
| `await call.checkpoint(rest?)` | `await call.checkpoint(rest=None)` | 在长时间运行的工具里经常调用。收到暂停请求时，它调用一次 `rest`（让运动停稳），然后等待恢复。工具在 1.5 秒内没有到达检查点时，暂停被拒绝 |
| `await call.sleep(ms)` | `await asyncio.sleep(s)` | 等待。TypeScript 中，调用被取消、停止或被手动接管后，`sleep` 和 `checkpoint` 会抛出 `Interrupted`。Python 中，调用所在的任务会被取消，正在等待的地方抛出 `CancelledError` |
| `call.signal`、`call.aborted()` | `call.task` | TypeScript：一个 `AbortSignal` 和一个在中断时完成的 Promise，可以交给 fetch 和定时器。Python：调用所在的 asyncio 任务 |
| `call.endReason` | `call.end_reason` | 调用被中断的原因：`stop`、`cancel`、`manual` 或 `disconnect` |
| `call.notes` | `call.notes` | 附加到结果中的说明；参数截断会自动添加说明 |
| `call.paused` | `call.paused` | 是否收到了暂停请求 |
| `call.interrupt(reason)` | — | 仅 TypeScript：由设备代码把调用作为中断结束 |
| `throw new CallError(reason, detail, { status, data })` | `raise CallError(reason, detail, *, status=None, data=None)` | 以某个原因结束调用（[MHS 10.2](../../packages/mhs/spec/mhs-spec.md#102-statuses-and-reasons)）。原因为 `stop`、`cancel`、`manual`、`estop`、`pause_timeout` 时状态为 `interrupted`，其余为 `error`。自定义原因写作 `x_<name>` |
| 其他异常 | 其他异常 | 以 `error` / `failed` 结束调用，异常信息写入 `detail` |

工具运行之前，库会拒绝以下调用：未知工具或参数错误时为 `invalid`；`unsafe` 钩子给出原因时为 `unsafe`；`uses` 中某个 `reject` 资源被占用时为 `busy`。使用 `queue` 资源的调用会等待资源空闲。

调用被中断时，TypeScript 立即发送结果，处理函数继续运行到下一次 `checkpoint()` 或 `sleep()`。Python 取消任务，所以清理工作放在 `finally` 中；捕获了 `CancelledError` 的工具必须重新抛出它。

### 状态、健康与钩子

| TypeScript | Python | 作用 |
| --- | --- | --- |
| `dev.update({ name: value })` | `dev.update(name=value)` | 设置状态值。与上次不同的值立即发给中枢（[MHS 10.1](../../packages/mhs/spec/mhs-spec.md#101-state)）。名称未声明时抛出异常（`Error`、`KeyError`） |
| `dev.state` | `dev.state` | 当前值的副本，包括 `problem` 和 `faults` |
| `dev.problem = 'sentence'` 或 `null` | `dev.problem = "sentence"` 或 `None` | 需要让操作员知道出了问题时，用一句话说明 |
| `dev.faults = ['code']` | `dev.faults = ["code"]` | 设备自定义的故障码 |
| `dev.onSet = (name, value) => …` | `dev.on_set = lambda name, value: …` | 应用中枢设置的可写字段。值已经检查并截断。返回实际生效的值，不返回则保留该值；抛出异常表示拒绝。库负责应答并上报该值 |
| `dev.onStop = () => …` | `dev.on_stop = …` | 让所有运动归零。收到 `mhs/stop` 时在中断运动调用之前调用；有调用运行时命令通道断开，也会调用（[MHS 12](../../packages/mhs/spec/mhs-spec.md#12-safety-requirements)） |
| `dev.unsafe = (tool) => reason` | `dev.unsafe = lambda tool: reason` | 工具此刻不能运行的原因，或 `undefined` / `None`。给出原因时调用以 `unsafe` 被拒绝 |
| `dev.after = () => ({ … })` | `dev.after = lambda: {…}` | 附加到每个结果中的快照 `after`。移动设备要包含 `odometry`；`localization: self` 的设备包含 `pose`（[MHS 7.3](../../packages/mhs/spec/mhs-spec.md#73-result)） |

`onStop`、`onSet`、`onManual` 和 `onConfigure` 可以是异步函数；`unsafe` 和 `after` 必须是普通函数。

### 数据源、音频片段与手动控制

| TypeScript | Python | 作用 |
| --- | --- | --- |
| `source.wants()` | `source.wants()` | 此刻发送的消息是否会发出：数据源处于开启状态，且速率允许 |
| `source.send(data, binary?, { t, of_seq, lag })` | `source.send(data, binary=None, *, t=None, of_seq=None, lag=None)` | 排队一条消息；数据源不需要时返回 false。`t` 默认为当前时间；采集时间不同时请给出采集时间。同一数据源尚未发出的旧消息会被较新的消息替换 |
| `source.on`、`source.hz`、`source.bitrateKbps`、`source.size` | `source.on`、`source.hz`、`source.bitrate_kbps`、`source.size` | 中枢配置的值（[MOS 8](../../packages/mhs/spec/mos-spec.md#8-rates-and-configure)）。第一次配置之前：图像 1 Hz，视频 5 Hz 且用最低码率，其他数据源按声明速率、最高 2 Hz |
| `source.keyframeRequested` | `source.keyframe_requested` | 视频源下一帧必须是关键帧：中枢要求了，或者丢过一帧。在此之前库会扣下其他帧 |
| `source.onConfigure = (applied) => …` | `source.on_configure = …` | 中枢配置数据源后调用，例如在关闭时释放相机 |
| `source.sent` | `source.sent` | 最近排队的一条消息，派生数据源用它的 `seq` 和 `t` 标明来源 |
| `dev.clip(id)` | `dev.clip(id)` | 中枢为带字符串参数 `clip` 的工具发来的音频片段：`{ rate, channels, pcm, received }`；未保留时为空（[MOS 2.3](../../packages/mhs/spec/mos-spec.md#23-messages-to-the-device)） |
| `manual` 选项与 `dev.onManual = (axes) => …` | `manual=` 与 `dev.on_manual = …` | 手动控制（[MHS 9](../../packages/mhs/spec/mhs-spec.md#9-manual-control)）。`onManual` 收到截断到各自范围的每个轴，超过 `deadman_s` 没有输入时收到全零。非零输入会中断运动调用并占用它们的资源 |

### 连接与运行

| TypeScript | Python | 作用 |
| --- | --- | --- |
| `await dev.run(url)` | `await dev.run(url)` | 连接 `ws://host:port` 并保持两条通道。只有声明了数据源、手动控制或 `clip` 参数时才打开 Nerve 通道 |
| `dev.close()` | 取消任务 | 永久断开 |
| `dev.log = (line) => …` | `agnes_mhs` logger | 库记录自身动作的地方。Python 中用 `logging.basicConfig(level=logging.INFO)` 显示 |

TypeScript 库每 2 秒发送一次 `mhs/ping` 检测存活，因为网页无法发送 WebSocket ping。Python 库使用 WebSocket ping。

## 常用写法

### 带进度、可暂停的长时间运动

声明工具时写上 `motion`、它驱动的资源和 `pausable`。在循环里给 `checkpoint` 传一个让运动停稳的函数，上报进度，并在 `finally` 中让运动归零，无论调用因何结束。摘自 [`packages/mhs/device/example.ts`](../../packages/mhs/device/example.ts)：

```ts
lamp.tool(
  {
    name: 'tilt',
    description: 'Tilt the lamp head to an angle in degrees; positive tilts up.',
    timeout: 10,
    params: { angle: { type: 'number', minimum: -45, maximum: 45, description: 'degrees, up positive' } },
    required: ['angle'],
    uses: ['head'],
    motion: true,
    pausable: true,
  },
  async (call, { angle }) => {
    try {
      while (Math.abs(angle - tilt) > 0.5) {
        await call.checkpoint(() => {
          speed = 0
        })
        speed = Math.sign(angle - tilt) * SPEED
        call.progress({ done: Math.round(tilt), total: angle })
        await call.sleep(50)
      }
    } finally {
      speed = 0
    }
    return `head at ${tilt.toFixed(0)} degrees`
  },
)
```

同样的写法在 Python 中，用于一辆直线行驶的小车：

```python
@dev.tool("Drive straight ahead by x meters; negative backs up.", timeout=30,
          params={"x": {"type": "number", "minimum": -2, "maximum": 2}}, required=["x"],
          uses=["chassis"], motion=True, pausable=True)
async def move(call, x):
    start = odometer()
    try:
        while abs(odometer() - start) < abs(x):
            await call.checkpoint(motors_off)  # waits here while paused
            motors(0.4 if x > 0 else -0.4)
            call.progress(done=round(abs(odometer() - start), 2), total=abs(x))
            await asyncio.sleep(0.05)  # a cancel or stop raises CancelledError here
    finally:
        motors_off()
    return f"moved {odometer() - start:.2f} m"
```

`timeout` 要留出最慢情况所需的时间：调用超出它 5 秒后，中枢会取消调用。

### 干净地停下

`onStop` 立即让所有运动归零并尽快返回；对 `mhs/stop` 的应答会等它完成。随后库中断正在运行的运动调用，它们的 `finally` 也会执行。没有 `motion` 的工具调用继续运行。移动设备还要在每个结果中报告里程计。摘自 [`packages/mhs/tools/dev-hub.ts`](../../packages/mhs/tools/dev-hub.ts)：

```ts
robot.onStop = () => {
  manual = { vx: 0, wz: 0, vy: 0 }
}
robot.after = () => ({ odometry: odo, pose: { map: 'office', ...pose } })
```

```python
dev.on_stop = motors_off
dev.after = lambda: {"odometry": {"x": round(sim["x"], 3), "y": 0, "yaw": 0, "v": sim["v"], "w": 0}}
```

TypeScript 中，被中断的处理函数会一直运行到下一次 `checkpoint()` 或 `sleep()`。等待其他东西的工具要像 [`examples/mars-world/src/live/world.ts`](../../examples/mars-world/src/live/world.ts) 中的 `wait` 那样让它和 `call.aborted()` 竞争，或者把 `call.signal` 传给它。

命令通道断开时库会让设备停下，但设备自身进程卡死时库无能为力。真实硬件需要有自己的看门狗（[MHS 12](../../packages/mhs/spec/mhs-spec.md#12-safety-requirements)）。

### 相机：JPEG 静态图与 H.264 视频

相机可以是 `image` 数据源，每条消息一张 JPEG 或 PNG；也可以是 `video` 数据源，每条消息一个 H.264 访问单元（[MOS 6](../../packages/mhs/spec/mos-spec.md#6-frames-or-video)）。静态图更简单，模型可以直接读取；视频更适合让人实时观看，占用带宽更少。请声明 `size`、`fov_deg` 和 `mount`，中枢才能把像素换算成方向。参照 [`examples/mars-world/src/live/camera.ts`](../../examples/mars-world/src/live/camera.ts) 写成，该文件从 WebGL 渲染结果生成 JPEG：

```ts
const still = dev.source('front', 'image', 'front camera', {
  hz: 1,
  mime: 'image/jpeg',
  encoding: 'rgb',
  size: [640, 360],
  fov_deg: [90, 59],
  mount: { xyz: [0.2, 0, 0.3], rpy: [0, 0, 0] },
})
setInterval(async () => {
  if (still.wants()) still.send({ w: 640, h: 360 }, await takeJpeg())
}, 1000)
```

视频要求每个关键帧都带 SPS 和 PPS，不使用 B 帧，关键帧间隔不超过 `gop_s`（最多 2 秒）；`keyframe_requested` 为真时以及丢帧之后也要发送关键帧（[MOS 7](../../packages/mhs/spec/mos-spec.md#7-video-streams)）。中枢配置了不同的码率或帧率时，重新打开编码器。摘自 [`packages/mhs/python/examples/camera.py`](../../packages/mhs/python/examples/camera.py)，它通过 PyAV 用 x264 编码：

```python
video = dev.source(
    "video", "video", "test pattern of moving bars", codec="h264", encoding="rgb", size=[W, H], hz=15,
    fov_deg=[60, 45], mount={"xyz": [0, 0, 0.1], "rpy": [0, 0, 0]}, bitrate_kbps=[200, 800], gop_s=1,
    profile="baseline", default=True,
)
...
if settings != (video.bitrate_kbps, video.hz):
    settings = (video.bitrate_kbps, video.hz)
    ctx = encoder(video.bitrate_kbps or 200, video.hz or 15)
    video.keyframe_requested = True
t = time.time()
frame = pattern(n)
n += 1
if video.keyframe_requested or t - last_key >= gop_s - 0.5 / (video.hz or 15):
    frame.pict_type = av.video.frame.PictureType.I
for packet in ctx.encode(frame):
    if video.send({"key": packet.is_keyframe, "w": W, "h": H}, bytes(packet), t=t) and packet.is_keyframe:
        last_key = t
```

在浏览器中，`camera.ts` 用 WebCodecs 编码：`VideoEncoder`，编码格式 `avc1.42e01f`，`latencyMode: 'realtime'`，`avc: { format: 'annexb' }`。

### 带地点的地图与固定安装位置

了解场地的设备声明地图：一个以米为单位的坐标系、它的范围，以及若干地点。地点要么是地标（`at`，可选朝向 `yaw`），要么是区域（`points`）（[MOS 3.5](../../packages/mhs/spec/mos-spec.md#35-maps-and-places)）。其他设备通过 id 引用这张地图。安装在固定位置的设备声明 `localization: 'fixed'` 和 `placement`，其中 `yaw` 是设备机身 x 轴的指向。节选自 [`packages/mhs/tools/dev-hub.ts`](../../packages/mhs/tools/dev-hub.ts)：机器人声明办公室地图，室内传感器安装在其中：

```ts
const robot = new Device({
  id: 'robot-01',
  kind: 'robot',
  mobile: true,
  localization: 'self',
  maps: [
    {
      id: 'office',
      name: 'Office',
      bounds: [0, 0, 8, 6],
      places: [
        { id: 'dock', name: 'Charging dock', at: [1, 1], yaw: 180 },
        { id: 'desk', name: 'Desk', at: [6, 2], description: 'The desk with the lamp' },
        { id: 'hall', name: 'Hall', points: [[0.3, 3.5], [7.7, 3.5], [7.7, 5.7], [0.3, 5.7]] },
      ],
    },
  ],
})
const env = new Device({
  id: 'env-01',
  kind: 'sensor',
  name: 'Room sensor',
  localization: 'fixed',
  placement: { map: 'office', x: 7.3, y: 5.3, yaw: 225 },
})
```

Python 中这些选项是关键字参数：

```python
OFFICE = {
    "id": "office", "name": "Office", "bounds": [0, 0, 8, 6],
    "places": [
        {"id": "dock", "name": "Charging dock", "at": [1, 1], "yaw": 180},
        {"id": "hall", "name": "Hall", "points": [[0.3, 3.5], [7.7, 3.5], [7.7, 5.7], [0.3, 5.7]]},
    ],
}
dev = Device("env-01", "sensor", name="Room sensor", localization="fixed",
             placement={"map": "office", "x": 7.3, "y": 5.3, "yaw": 225}, maps=[OFFICE])
```

`localization: 'self'` 的设备还要推送 `pose` 数据源，内容为该地图坐标系中的 `{ map, x, y, yaw, ok }`，丢失定位时 `ok` 为 false。

### 健康、故障与拒绝

设备通过三种方式报告健康状况。带标准 `role` 和 `alert` 的状态字段，让中枢对从未见过的设备也能发出告警；`problem` 是写给人看的一句话；`faults` 是设备自己的故障码。Python：

```python
dev = Device(
    "cart-01", "car", name="Cart", mobile=True, resources={"chassis": "reject"},
    state={"battery": {"type": "integer", "unit": "%", "min": 0, "max": 100, "role": "battery",
                       "alert": {"warn": 20, "bad": 10, "below": True}}},
)


def battery_changed(level):
    sim["battery"] = level
    dev.update(battery=level)
    dev.problem = "battery low; drive back to the dock" if level < 20 else None
    dev.faults = ["battery_low"] if level < 10 else []
```

在设备当前条件下不能运行的工具，会在开始之前被拒绝，并附上大脑能读懂的原因。运行中失败的工具以一个原因码结束。摘自 [`examples/mars-world/src/live/power.ts`](../../examples/mars-world/src/live/power.ts) 和 [`rover.ts`](../../examples/mars-world/src/live/rover.ts)：

```ts
dev.unsafe = (tool) => {
  if (tool === 'clean_array' && panels !== 'deployed') return 'the array is not deployed'
  return undefined
}
```

```ts
} catch (e) {
  if (e instanceof Blocked) throw new CallError('estop', e.message)
  throw e
}
```

## 检查设备

把设备接入 AGH 之前，先用 `mhs-check` 检查它。`mhs-check` 根据登记内容判断适用哪些测试档：有运动工具就加上 Motion，有可暂停工具就加上 Pause，有地图或安装位置就加上 Maps，有视频源就加上 Video。测试档和参数见[编写并检查设备](mhs.zh-CN.md#编写并检查设备)，每个场景见[一致性测试套件](../../packages/mhs/spec/mhs-conformance.md)。没有里程计时，物理行为的检查需要 `--interactive` 和一位在旁观察设备的操作员。通过检查说明设备在测试条件下遵守协议，并不说明设备是安全的。
