# Write a device: the MHS device libraries

English | [简体中文](mhs-device.zh-CN.md)

<a id="编写设备mhs-设备库"></a>

[Documentation](../README.md) · [MHS and devices](mhs.md) · [MHS specification](../../packages/mhs/spec/mhs-spec.md)

This guide shows how to connect your own hardware, or a simulation of it, to AgnesHub with one of the two device libraries: `agnes_mhs` for Python and `@agnes/mhs/device` for TypeScript. Both have the same design. You declare what the device is and what it can do, write the tool functions and a few hooks, and the library speaks the protocol: registration, reconnecting, argument checks and clamping, resources, cancel, stop, pause, the manual deadman, state reports, settings, stream rates, keyframe requests, clock replies, audio clips and liveness.

<a id="设备声明什么"></a>

## What a device declares

A device registers once per connection with a description of itself ([MHS section 5](../../packages/mhs/spec/mhs-spec.md#5-device-description-mhsregister)). The libraries build it from the constructor options and the tools and sources you declare.

| Part | What it is | Spec |
| --- | --- | --- |
| Identity | `id`, `kind`, display `name`, `model`, `mobile`, and a `profile` of physical facts | [MHS 5](../../packages/mhs/spec/mhs-spec.md#5-device-description-mhsregister) |
| Localization | `none`, `fixed` with a `placement`, `self` with a `pose` source, or `external` | [MHS 5.2](../../packages/mhs/spec/mhs-spec.md#52-localization) |
| Tools | What the device can be asked to do, with a parameter schema whose ranges are limits | [MHS 6](../../packages/mhs/spec/mhs-spec.md#6-tools) |
| Resources | Parts only one call may use at a time, each `reject` or `queue` | [MHS 6.3](../../packages/mhs/spec/mhs-spec.md#63-resources) |
| State | A few named values the hub keeps, some of them writable settings, plus `problem` and `faults` | [MHS 10.1](../../packages/mhs/spec/mhs-spec.md#101-state) |
| Sources | Data streamed on the Nerve channel: cameras, scans, readings, poses | [MOS 3](../../packages/mhs/spec/mos-spec.md#3-sources) |
| Maps | Map frames the device knows, with named places | [MOS 3.5](../../packages/mhs/spec/mos-spec.md#35-maps-and-places) |
| Manual control | Axes a person can steer, and the deadman | [MHS 9](../../packages/mhs/spec/mhs-spec.md#9-manual-control) |

The description is fixed for the life of a connection: a device whose abilities differ reconnects and registers again.

<a id="最小的设备"></a>

## A minimal device

A thermometer with a buzzer: one state field (`battery`), one data source (`air`) and one tool (`beep`). The two versions below are the same device.

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

What each part does:

- **The constructor** gives the identity and declares the state fields. `update` gives every field its first value before `run`, because the device reports all of them right after registering.
- **The source** is declared with its kind and fields. The loop sends a reading only when `wants()` says so: the library keeps track of the rate and the on or off the hub asks for, and drops what is not wanted.
- **The tool** declares its parameters as JSON Schema. The library rejects wrong types and clamps `times` into 1 to 5, with a note in the result, before the function runs. The returned string is the result's `detail`, the sentence the brain reads.
- **`run`** opens the command and Nerve channels, registers, answers the hub, and reconnects with back-off after a lost connection. It returns when the hub replaces the device with another connection of the same id, or refuses it.

<a id="接到-dev-hub-和-mhs-check"></a>

### Run it against dev-hub and mhs-check

Python commands run from `packages/mhs/python`, where `uv run` sets up the environment ([package README](../../packages/mhs/python/README.md)). The TypeScript library is part of the `@agnes/mhs` workspace package: a package of this repository that lists `"@agnes/mhs": "workspace:*"` in its dependencies and has `"type": "module"` imports it as `@agnes/mhs/device`, as [`examples/mars-world`](../../examples/mars-world/README.md) does. It runs in Node and in browsers, which both have a global `WebSocket`.

To see the device on the Devices page, start the development hub from the repository root (see [Try it without hardware](mhs.md#try-it-without-hardware)), then point the device at it:

```sh
cd packages/mhs/python
uv run python path/to/thermometer.py ws://127.0.0.1:4191
```

For the TypeScript version, run this in the package that holds it:

```sh
pnpm exec tsx thermometer.ts ws://127.0.0.1:4191
```

To check it against the protocol, start `mhs-check`, which waits on port 8800, then start the device without an address:

```sh
cd packages/mhs/python
uv run python -m agnes_mhs.check
uv run python path/to/thermometer.py   # in a second terminal
```

Both versions pass the Core, Perception and Streaming profiles.

<a id="库参考"></a>

## Library reference

Names are given as TypeScript, then Python. Import them with `import { Device, CallError } from '@agnes/mhs/device'` or `from agnes_mhs import Device, CallError`.

<a id="设备与声明"></a>

### Device and declarations

| TypeScript | Python | What it does |
| --- | --- | --- |
| `new Device({ id, kind, name, model, vendor, firmware, mobile, radius, profile, localization, placement, maps, resources, manual, state, ui })` | `Device(id, kind, *, name, model, vendor, firmware, mobile, radius, profile, localization, placement, maps, resources, manual, state, ui)` | The device. Every option is a field of the description ([MHS 5](../../packages/mhs/spec/mhs-spec.md#5-device-description-mhsregister)); `localization` defaults to `none`, `mobile` to false |
| `dev.tool({ name, description, timeout, params, required, uses, motion, readOnly, pausable, needs, ui }, handler)` | `@dev.tool(description, *, timeout, name, params, required, uses, motion, read_only, pausable, needs, ui)` | Declares a tool ([MHS 6.1](../../packages/mhs/spec/mhs-spec.md#61-declaration)). `params` are the schema's `properties`, `required` its required names. In Python, `name` defaults to the function's name |
| `handler(call, args)` | `fn(call, **args)` | The tool itself, plain or async. It gets the call and the checked arguments: an object in TypeScript, keyword arguments in Python |
| Returns `undefined`, a string, or `{ detail, data, notes }` | Returns `None`, a string, or `{"detail", "data", "notes"}` | The result. A string is the `detail`; without one, the detail is `<tool> done` |
| `dev.source(id, kind, description, meta)` | `dev.source(id, kind, description, **meta)` | Declares a data source and returns it ([MOS 3.1](../../packages/mhs/spec/mos-spec.md#31-declaration)). `meta` holds `hz`, `fields`, `mount`, `default`, `switchable` and the kind's metadata |
| `dev.description()` | `dev.description()` | The registration the library sends, for printing or testing |

<a id="调用"></a>

### Calls

| TypeScript | Python | What it does |
| --- | --- | --- |
| `call.id`, `call.name`, `call.args`, `call.motion`, `call.pausable`, `call.uses` | the same | The running call and its tool's declaration |
| `call.progress({ done, total, text, data })` | `call.progress(done=, total=, text=, data=)` | Reports progress ([MHS 7.2](../../packages/mhs/spec/mhs-spec.md#72-progress)). At most 2 per second go out; the rest are dropped, so it is safe to call in a tight loop |
| `await call.checkpoint(rest?)` | `await call.checkpoint(rest=None)` | Call it often in a long tool. While a pause is asked for, it calls `rest` once (bring the motion to rest) and waits for resume. A pause is refused when the tool reaches no checkpoint within 1.5 s |
| `await call.sleep(ms)` | `await asyncio.sleep(s)` | Waits. In TypeScript, `sleep` and `checkpoint` throw `Interrupted` once the call is cancelled, stopped or taken over. In Python, the call's task is cancelled, so `CancelledError` comes out of whatever it awaits |
| `call.signal`, `call.aborted()` | `call.task` | TypeScript: an `AbortSignal` and a promise for the interruption, to pass to fetches and timers. Python: the call's asyncio task |
| `call.endReason` | `call.end_reason` | Why the call was interrupted: `stop`, `cancel`, `manual` or `disconnect` |
| `call.notes` | `call.notes` | Notes added to the result; argument clamping already adds its own |
| `call.paused` | `call.paused` | Whether a pause is asked for |
| `call.interrupt(reason)` | — | TypeScript only: ends the call as interrupted from device code |
| `throw new CallError(reason, detail, { status, data })` | `raise CallError(reason, detail, *, status=None, data=None)` | Ends the call with a reason ([MHS 10.2](../../packages/mhs/spec/mhs-spec.md#102-statuses-and-reasons)). The status is `interrupted` for `stop`, `cancel`, `manual`, `estop` and `pause_timeout`, otherwise `error`. Custom reasons are `x_<name>` |
| Any other exception | Any other exception | Ends the call as `error` / `failed`, with the message in `detail` |

The library rejects a call before the tool runs: `invalid` for an unknown tool or bad arguments, `unsafe` when the `unsafe` hook gives a reason, and `busy` when a `reject` resource in `uses` is held. A call that uses a `queue` resource waits for it.

When a call is interrupted, TypeScript sends the result at once and the handler keeps running until its next `checkpoint()` or `sleep()`. Python cancels the task, so cleanup belongs in `finally`; a tool that catches `CancelledError` must raise it again.

<a id="状态健康与钩子"></a>

### State, health and hooks

| TypeScript | Python | What it does |
| --- | --- | --- |
| `dev.update({ name: value })` | `dev.update(name=value)` | Sets state values. The ones that differ go to the hub at once ([MHS 10.1](../../packages/mhs/spec/mhs-spec.md#101-state)). An undeclared name throws (`Error`, `KeyError`) |
| `dev.state` | `dev.state` | A copy of the current values, `problem` and `faults` included |
| `dev.problem = 'sentence'` or `null` | `dev.problem = "sentence"` or `None` | One sentence when operators should know something is wrong |
| `dev.faults = ['code']` | `dev.faults = ["code"]` | The device's own fault codes |
| `dev.onSet = (name, value) => …` | `dev.on_set = lambda name, value: …` | Applies a writable field the hub sets. The value is already checked and clamped. Return the value in effect, or nothing to keep it; throw to refuse it. The library replies and reports the value |
| `dev.onStop = () => …` | `dev.on_stop = …` | Zeroes all motion. Called on `mhs/stop` before motion calls are interrupted, and when the command channel drops while calls run ([MHS 12](../../packages/mhs/spec/mhs-spec.md#12-safety-requirements)) |
| `dev.unsafe = (tool) => reason` | `dev.unsafe = lambda tool: reason` | Why a tool cannot run now, or `undefined` / `None`. A reason rejects the call as `unsafe` |
| `dev.after = () => ({ … })` | `dev.after = lambda: {…}` | A snapshot added to every result as `after`. A mobile device includes `odometry`; one with `localization: self` includes `pose` ([MHS 7.3](../../packages/mhs/spec/mhs-spec.md#73-result)) |

`onStop`, `onSet`, `onManual` and `onConfigure` may be async; `unsafe` and `after` are plain functions.

<a id="数据源音频片段与手动控制"></a>

### Sources, clips and manual control

| TypeScript | Python | What it does |
| --- | --- | --- |
| `source.wants()` | `source.wants()` | Whether a message sent now would go out: the source is on and its rate allows it |
| `source.send(data, binary?, { t, of_seq, lag })` | `source.send(data, binary=None, *, t=None, of_seq=None, lag=None)` | Queues one message; returns false when the source did not want it. `t` defaults to now; give the capture time when it differs. An unsent older message of the source is replaced by the newer one |
| `source.on`, `source.hz`, `source.bitrateKbps`, `source.size` | `source.on`, `source.hz`, `source.bitrate_kbps`, `source.size` | What the hub configured ([MOS 8](../../packages/mhs/spec/mos-spec.md#8-rates-and-configure)). Before the first configure: images 1 Hz, video 5 Hz at its lowest bitrate, others at their declared rate up to 2 Hz |
| `source.keyframeRequested` | `source.keyframe_requested` | A video source must send a keyframe next: the hub asked, or a picture was dropped. Until then the library holds back other pictures |
| `source.onConfigure = (applied) => …` | `source.on_configure = …` | Called after the hub configures the source, for example to release a camera that is off |
| `source.sent` | `source.sent` | The last message queued, whose `seq` and `t` a derived source names |
| `dev.clip(id)` | `dev.clip(id)` | An audio clip the hub sent for a tool with a string `clip` parameter: `{ rate, channels, pcm, received }`, or nothing when it is not kept ([MOS 2.3](../../packages/mhs/spec/mos-spec.md#23-messages-to-the-device)) |
| `manual` option and `dev.onManual = (axes) => …` | `manual=` and `dev.on_manual = …` | Manual control ([MHS 9](../../packages/mhs/spec/mhs-spec.md#9-manual-control)). `onManual` gets every axis clamped to its range, and zeros after `deadman_s` without input. Non-zero input interrupts motion calls and holds their resources |

<a id="连接与运行"></a>

### Running

| TypeScript | Python | What it does |
| --- | --- | --- |
| `await dev.run(url)` | `await dev.run(url)` | Connects to `ws://host:port` and keeps both channels up. The Nerve channel opens only when the device declares sources, manual control or a `clip` parameter |
| `dev.close()` | cancel the task | Disconnects for good |
| `dev.log = (line) => …` | the `agnes_mhs` logger | Where the library writes what it does. In Python, `logging.basicConfig(level=logging.INFO)` shows it |

The TypeScript library sends `mhs/ping` every 2 s for liveness, since a page cannot send WebSocket pings. The Python library uses WebSocket pings.

<a id="常用写法"></a>

## Patterns

<a id="带进度可暂停的长时间运动"></a>

### A long motion with progress and pause

Declare the tool with `motion`, the resource it moves, and `pausable`. In the loop, pass `checkpoint` a function that brings the motion to rest, report progress, and zero the motion in `finally`, whatever ends the call. From [`packages/mhs/device/example.ts`](../../packages/mhs/device/example.ts):

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

The same in Python, for a cart that drives straight:

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

Give `timeout` room for the slowest case: the hub cancels a call that runs 5 s past it.

<a id="干净地停下"></a>

### Stop cleanly

`onStop` zeroes every motion at once and returns quickly; the reply to `mhs/stop` waits for it. The library then interrupts the running motion calls, whose `finally` blocks run as well. Calls of tools without `motion` keep running. A mobile device also reports its odometry in every result. From [`packages/mhs/tools/dev-hub.ts`](../../packages/mhs/tools/dev-hub.ts):

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

In TypeScript, an interrupted handler goes on until its next `checkpoint()` or `sleep()`. A tool that waits on something else races it against `call.aborted()`, as `wait` in [`examples/mars-world/src/live/world.ts`](../../examples/mars-world/src/live/world.ts) does, or passes `call.signal` to it.

The library stops the device when the command channel drops, but it cannot stop the device when its own process hangs. Real hardware keeps a watchdog of its own ([MHS 12](../../packages/mhs/spec/mhs-spec.md#12-safety-requirements)).

<a id="相机jpeg-静态图与-h264-视频"></a>

### A camera: JPEG stills and H.264 video

A camera is either an `image` source, one JPEG or PNG per message, or a `video` source, one H.264 access unit per message ([MOS 6](../../packages/mhs/spec/mos-spec.md#6-frames-or-video)). Stills are simpler and a model can read them; video is lighter for people watching live. Declare `size`, `fov_deg` and `mount`, so the hub can turn pixels into directions. Modelled on [`examples/mars-world/src/live/camera.ts`](../../examples/mars-world/src/live/camera.ts), which takes its JPEG from a WebGL render:

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

For video, every keyframe carries SPS and PPS, there are no B-frames, and a keyframe comes at least every `gop_s` (at most 2 s), whenever `keyframe_requested` is set, and after a dropped picture ([MOS 7](../../packages/mhs/spec/mos-spec.md#7-video-streams)). Reopen the encoder when the hub configures another bitrate or rate. From [`packages/mhs/python/examples/camera.py`](../../packages/mhs/python/examples/camera.py), which encodes with x264 through PyAV (excerpts):

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

In a browser, `camera.ts` encodes with WebCodecs: `VideoEncoder` with codec `avc1.42e01f`, `latencyMode: 'realtime'` and `avc: { format: 'annexb' }`.

<a id="带地点的地图与固定安装位置"></a>

### A map with places, and a fixed placement

The device that knows a site declares its map: a frame in meters, its bounds, and places, each a landmark (`at`, with an optional `yaw` to face) or a zone (`points`) ([MOS 3.5](../../packages/mhs/spec/mos-spec.md#35-maps-and-places)). Other devices name the map by its id. A device installed at a fixed spot declares `localization: 'fixed'` and its `placement`, whose `yaw` is the direction its body x axis points. Condensed from [`packages/mhs/tools/dev-hub.ts`](../../packages/mhs/tools/dev-hub.ts), where the robot declares the office and the room sensor is installed in it:

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

In Python the same options are keyword arguments:

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

A device with `localization: 'self'` also streams a `pose` source, `{ map, x, y, yaw, ok }` in that map's frame, with `ok: false` when it has lost its fix.

<a id="健康故障与拒绝"></a>

### Health, faults and refusals

A device reports its health three ways. State fields with a standard `role` and an `alert` let the hub raise an alert on a device it has never seen; `problem` is one sentence for people; `faults` are its own codes. Python:

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

A tool that cannot run in the device's present condition is refused before it starts, with the reason the brain reads. One that fails while running ends with a reason code. From [`examples/mars-world/src/live/power.ts`](../../examples/mars-world/src/live/power.ts) and [`rover.ts`](../../examples/mars-world/src/live/rover.ts):

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

<a id="检查设备"></a>

## Check the device

Run `mhs-check` against every device before connecting it to AGH. It works out from the registration which profiles apply: a motion tool adds Motion, a pausable one Pause, a map or placement Maps, a video source Video. [Write and check a device](mhs.md#write-and-check-a-device) lists the profiles and flags, and the [conformance suite](../../packages/mhs/spec/mhs-conformance.md) describes every scenario. Without odometry, the checks of physical behavior need `--interactive` and an operator watching the device. Passing shows that the device follows the protocol under the tested conditions; it does not make the device safe.
