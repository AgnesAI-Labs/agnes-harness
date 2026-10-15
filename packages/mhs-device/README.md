# Agnes MHS device SDK (preview)

[简体中文](README.zh-CN.md)

`@agnes/mhs-device` owns the device-side MHS/MOS protocol, declaration schemas and TypeScript SDK. It has no dependency on Harness Core, Host or daemon internals. The Python distribution lives in [`python/`](python/). This is a new product format; it does not load or migrate old Hub state.

Manual axes may declare `keys: [positive, negative]` as bounded UI hints. The client resolves these before role defaults, while the backend continues to enforce declared axis bounds and native control leases. MOS scan/IMU/pose/odometry angles use degrees; detection boxes are pixel corner coordinates `[x1,y1,x2,y2]`. Point records are interleaved float32 little-endian; grid payloads are north-up grayscale PNGs with bottom-left map origin.

A device declares identity, resources, tools, state, sources, maps and optional manual axes. `schema.ts` is the schema source and infers the public TypeScript types. `pnpm --filter @agnes/mhs-device gen` emits the JSON schema and the identical Python package resource; `gen:check` verifies both.

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

Each connection uses `/ws/mhs` for bounded JSON-RPC commands and `/ws/nerve` for observations/manual axes. Both use subprotocol `mhs.v1`. Nerve starts with `{type:'hello',device:<id>}` after registration succeeds. `device.publish(source, data, bytes?, mime?)` sends one MOS JSON header followed immediately by its binary payload. Calls, stops and receipts remain on the separate command channel. `onConfigure` and `onKeyframe` let adapters implement source demand and video recovery.

Tools use a bounded JSON Schema subset: object, array, number, integer, string, boolean, properties, required, default, bounds, enum and description. Unknown arguments are dropped, numeric limits clamp, strings truncate, and invalid types refuse execution. Device and Hub both validate. Resources are reserved before asynchronous execution; `reject` refuses overlapping calls and `queue` serializes them. A tool receives an abort signal and cooperative pause checkpoints. Every tool must honor cancellation in its hardware driver.

Motion and manual control require a `SafetyPort`. Its `arm(ms)` must arm a watchdog independent of this JavaScript process, and `stop(reason)` must zero hardware and resolve only after confirmation. `onManual` receives all declared axes, with omitted axes zero and values clamped. Manual deadman must be in `(0,2]` seconds. The local timer is a secondary safeguard; it cannot certify hardware safety if the process freezes. Motion handlers call `checkpoint(rest)` often enough to refresh the independent watchdog. A pause is acknowledged only after a checkpoint has brought motion to rest.

Stop interrupts all motion and zeros manual axes. Command loss stops motion; reconnect never resumes an old action. Replacement close code 4001 and unsupported-version close code 4003 suppress reconnect. A missing stop confirmation is an unknown outcome, never proof of safe rest. Hardware interlocks, emergency stops and local takeover remain the adapter's responsibility.

The listener defaults to loopback and refuses browser-Origin device upgrades. Bare MHS device identity is not authentication. Real deployments need an explicit authenticated device-admission adapter or a protected network; the human/agent API must use the reviewed Harness authority and stream gateway. There is no unauthenticated North control WebSocket.

Sources start off except low-rate pose; `mhs/configure` activates consumer demand. A tool's `needs` must name declared sources and refuses with `reason: "needs"` and the unavailable ids when any is off. Resource rejections include `holder: {call, tool, caller?}` or `{manual: true}`. The Hub supplies the caller label; it is descriptive, never authorization.

PCM16 clips arrive as `{type:"clip",id,rate,channels}` followed by one binary Nerve frame. Both SDKs validate size/alignment, cache at most eight clips for 60 seconds, and acknowledge caching on the command channel with `mhs/clip-received {id}`. A tool argument named `clip` must reference a live cached clip. Older devices without this additive acknowledgement produce an unconfirmed upload; update both ends before using clip sends. No clip or motion grant survives reconnect.
