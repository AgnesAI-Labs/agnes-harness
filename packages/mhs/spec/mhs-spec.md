# Agnes MHS: Model Hardware Standard

**Version 1.0** (2026-10-08).

Its companion, the [Agnes MOS specification](mos-spec.md) (Model Observation Standard), defines what a device observes and how it streams it to the hub.

## Contents

**Part I: Overview**

1. Introduction
2. Overview
3. Conventions

**Part II: Devices and control**

4. Connection lifecycle
5. Device description (`mhs/register`)
6. Tools
7. Calls
8. Cancel, stop, pause and resume
9. Manual control
10. State and reason codes
11. Timeouts
12. Safety requirements

**Part III: Rules for everyone**

13. Extensibility and versioning
14. Security considerations
15. Conformance

**Appendices**

- A. Message index
- B. Vocabularies
- C. Example devices
- D. Relationship to Anthropic's Model Hardware Standard and to MCP

---

## 1. Introduction

Agnes MHS (Model Hardware Standard) is a protocol that connects physical devices (robots, sensors, cameras, actuators) to a **hub**. Through the hub, AI agents and people can:

- discover what each device can do;
- read what state it is in, at any time;
- call its abilities;
- stop it at any time.

When a device connects, it describes itself once:

- what it is (identity and physical profile);
- what it can do (**tools**);
- what state it reports (**state**: a small dictionary of named values, such as a mode, a lock or a battery level);
- whether a person can steer it directly (**manual control**);
- what it senses (**data sources**, defined by MOS).

From then on, the hub keeps its current state, calls its tools, changes its settings, and can interrupt it at any time. The device stays responsible for its own safety.

Agnes MHS specifies how hardware hands its abilities to the system on the model's side. A model never talks to a device directly: it acts through the hub, which validates every call, enforces timeouts and can stop the device at any time.

Agnes MHS gives a model two ways to know a device, and one to act on it:

- **State, pulled.** The hub keeps every device's current state; a model reads it whenever it needs a fact ("is the door locked?"), without waking the device (section 10.1).
- **Observations, pushed.** What a device measures continuously (frames, video, scans, telemetry, perception results) streams live, on demand, under the companion standard MOS.
- **Tools, called.** Actions are accepted at once, report progress and end with exactly one result; any of them can be stopped (sections 6 to 8).

### 1.1 Scope

This document specifies the protocol between a **device** and a **hub**. It defines:

- the messages;
- the order in which they may be sent;
- the meaning of every field and data format;
- what a device must do so that any conforming hub can use it safely.

Out of scope:

- How a hub exposes devices to agents or user interfaces (the hub's client API).
- What a device observes and how it streams it: the companion standard MOS.
- How a device implements its tools or computes its perception results.
- Hub-internal behavior (scheduling policy, which detector it runs), except where it affects devices or where the hub produces data in a kind defined here.

### 1.2 Requirement language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **MAY** and **OPTIONAL** are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in bold capitals.

- Requirements that a conformance test can check carry an identifier in brackets, such as **[CALL-3]**. The conformance suite (`mhs-conformance.md`) reports results by these identifiers.
- Text marked *informative* explains or gives examples and adds no requirements.

### 1.3 Roles

| Role | Description |
|---|---|
| **Device** | One physical machine, or one logical machine behind a bridge, that registers with a hub. It owns its tools, its state, its data sources and its safety. |
| **Hub** | The server devices connect to. It validates and forwards calls, receives and fans out data, decides which data is needed, may compute perception results, and sends stop. A hub may serve many devices. |
| **Client** | An agent or user interface talking to the hub. Clients never talk to devices directly. *(Out of scope; mentioned for context.)* |

A device **MAY** be a **bridge**: a process that speaks Agnes MHS on behalf of hardware that does not, for example a computer controlling a robot through a vendor SDK. The protocol does not distinguish bridges from native devices. A bridge is the device.

---

## 2. Overview

*Informative.*

```
  Device                                     Hub
    │ ── command channel (JSON-RPC 2.0) ───▶  │   register · state · call · progress · result
    │ ◀─────────────────────────────────────  │   set · cancel · stop · pause · resume · configure · keyframe · time
    │                                         │
    │ ── Nerve channel (stream, MOS) ──────▶  │   data: frames, video, scans, telemetry, perception (+ binary)
    │ ◀─────────────────────────────────────  │   manual · clip (+ binary)
```

- **Two WebSocket channels, both opened by the device.** The device dials out, so it needs no public address and no open ports.
- **The command channel** carries small messages that must not be lost: registration, state changes and settings, calls and their results, and control, including stream control (`configure`, `keyframe`).
- **The Nerve channel**, defined by MOS, carries the live stream: camera frames or encoded video, scans, audio, telemetry, perception results, and the person's manual input. On Nerve the newest message always matters most; an old message that has been superseded may be dropped.

Keeping them apart means a burst of video can never delay a stop or a result, and a large audio clip can never delay a stop.

**A call has two phases.**

1. The device decides immediately whether it accepts the call and replies.
2. It then reports progress, and finally exactly one result.

**Stop is not a tool.** It is a protocol message every device must handle at any time, in any state.

**State is kept, data flows on demand.** A device reports its state when it changes, and the hub keeps it for anyone to read. Streams are different: the hub tells each device which sources to stream and how fast, based on who is watching, recording or computing (MOS). A device with ten sensors and no one watching sends almost nothing.

---

## 3. Conventions

### 3.1 Messages

**Command channel**

- [MSG-1] Every message on the command channel **MUST** be a JSON-RPC 2.0 request, response or notification, sent as one WebSocket text frame. Batches **MUST NOT** be used.
- [MSG-2] Request `id`s **MUST** be strings. Each side numbers its own requests and **MUST NOT** reuse an `id` while a request with that `id` is outstanding.
- [MSG-3] A command-channel message **MUST NOT** exceed 64 KiB. A receiver **MAY** close the connection on a larger message.

**Nerve channel**

- Its messages follow MOS section 2.2 ([MSG-4], [MSG-5]).

**Both channels**

- [MSG-6] Receivers **MUST** ignore fields they do not recognize.
- [MSG-7] Senders **MUST NOT** rely on a receiver understanding fields that are not defined in this version.

### 3.2 Protocol errors versus failed calls

- A malformed message is answered with a JSON-RPC `error`, using the codes in the table below. Examples: not JSON, an unknown method, missing required parameters.
- A call that is well formed but is refused or fails is **not** a protocol error. It is answered with a status and a reason code (section 10).

| Code | Meaning |
|---|---|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32001 | Unsupported protocol version |
| -32003 | Not registered (a call or control message arrived before registration completed) |

### 3.3 Identifiers

| Identifier | Syntax | Example |
|---|---|---|
| Device id | `[a-z0-9][a-z0-9-]{0,31}` | `arm-03` |
| Source id, field name, resource name, axis id | `[a-z][a-z0-9_]{0,31}` | `cam_front` |
| Tool name | `[a-z][a-z0-9_]{0,63}` | `go_to` |
| Map id, place id (MOS 3.5) | `[a-z0-9][a-z0-9-]{0,63}` | `office-2026-10-01`, `west-field` |
| Custom vocabulary entry | `x_` followed by the identifier syntax | `x_torque_map` |

- [ID-1] A device id **MUST** be stable across restarts of the device. Two devices connected to the same hub **MUST NOT** use the same id.

### 3.4 Units and frames

**Units** are SI unless stated otherwise. Angles are in **degrees** everywhere in this protocol, including angular rates (deg/s). Where a payload field carries a unit, this specification fixes it. Where a declaration lets the device choose (field declarations, axes), the device states the unit using the registry in Appendix B.4.

**Body frame**

- Every device has a right-handed body frame: x forward, y left, z up.
- The origin is the center of the device's footprint on the ground; for a stationary device, a point the device describes in its profile.
- Yaw is counter-clockwise from +x.

**Mounting**

- A sensor's pose in the body frame is its `mount`: `{"xyz": [x, y, z], "rpy": [roll, pitch, yaw]}`, in meters and degrees.
- Rotations are applied yaw, then pitch, then roll (intrinsic Z-Y-X).
- A sensor's own frame has x along its optical axis or forward direction, y left, z up.

**Image coordinates** are pixels with the origin at the top-left corner, x to the right and y down.

**Map frame**

- A map is a named 2D frame: x and y in meters, yaw in degrees counter-clockwise from +x.
- Whoever builds the map defines its frame: a device's SLAM, a site plan, a simulated world. A device that knows a map describes it in its registration (MOS 3.5); the hub records and keeps maps, it does not define frames.
- A device that localizes itself reports map poses in this frame (kind `pose`); a fixed device states where it is installed (5.2).

### 3.5 Time

- Time values are Unix time in seconds, as JSON numbers with a fractional part.
- [TIME-1] Data timestamps (`t`) **MUST** be taken from the device's clock at the moment of capture, not at the moment of sending. For a result computed from a declared input (`of`), `t` is that input's capture time (MOS section 4).
- The hub estimates the offset between the clocks with `mhs/time` (MOS section 10). Devices need not synchronize their clocks.

### 3.6 Text

- Human-readable fields (`description`, `detail`, `text`, `notes`) are shown to people and to language models.
- They **SHOULD** be short, plain sentences.
- They **SHOULD** describe direction as left or right rather than by sign.
- English is **RECOMMENDED**. Names chosen by end users (zone names, display names) are kept as entered.

### 3.7 Version

This document defines protocol version **`mhs/v1`**. Section 13 gives the compatibility rules.

---

## 4. Connection lifecycle

### 4.1 Finding the hub

- [CONN-1] A device **MUST** let its operator configure the hub's base URL, for example `ws://192.168.1.20:8000`.
- The command channel is at `<base>/ws/mhs` and the Nerve channel at `<base>/ws/nerve`, unless the operator configures other paths.
- A hub **MAY** advertise itself with DNS-SD as `_mhs._tcp`, with TXT records `cmd=/ws/mhs` and `nerve=/ws/nerve`. A device **MAY** use this.
- Devices **SHOULD** send the WebSocket subprotocol `mhs.v1` on both channels. A hub that supports it echoes it.

### 4.2 Opening the command channel

1. The device opens the command channel.
2. [CONN-2] Its first message **MUST** be `mhs/register` (section 5).
3. [CONN-3] Until the hub answers `mhs/register` with a result, the device **MUST NOT** send anything else on the command channel except replies to `mhs/stop`.
4. The hub replies with the result below, or with a JSON-RPC error (`-32001` for an unsupported version, `-32602` for an invalid description) and then closes the connection.

```json
← {"jsonrpc": "2.0", "id": "1", "result": {
     "session": "s17", "hub": {"name": "example-hub", "version": "1.4.0"}, "time": 1791400000.12}}
```

The result carries `session` (an id for this registration), `hub` (`name` and `version`) and `time` (the hub's clock); all three are required.

### 4.3 The Nerve channel

A device that declares data sources, manual control, or tools taking audio clips also opens a second channel, Nerve, defined by MOS section 2. The hub considers such a device available only when both channels are open and registration has succeeded.

### 4.4 Liveness

- Both sides send WebSocket pings every 2 s.
- [CONN-5] A side that receives no pong within 3 s **MUST** treat the channel as lost.
- [CONN-9] A device that cannot send WebSocket pings, such as a page in a web browser, **MUST** instead send `mhs/ping` on the command channel every 2 s and treat both channels as lost when a reply has not arrived within 3 s. The hub answers `mhs/ping` at once with an empty result. Browsers answer the hub's WebSocket pings by themselves, so the hub's side of CONN-5 is unchanged.

```json
→ {"jsonrpc": "2.0", "id": "p17", "method": "mhs/ping", "params": {}}
← {"jsonrpc": "2.0", "id": "p17", "result": {}}
```

### 4.5 Reconnecting

- [CONN-6] A device **MUST** reconnect a lost channel. The first retry should come within 1 s, and later retries back off to no more than one every 5 s.
- [CONN-7] After reconnecting the command channel, the device **MUST** register again. It **MUST NOT** resume any action that was running before the loss (see [SAFE-2]).
- [CONN-8] **Replacement.** When a hub accepts a new connection with the id of an existing device, it closes the older connection with close code **4001**. A device that receives 4001 **MUST NOT** reconnect automatically, because another instance with the same id is running. It **SHOULD** report this to its operator.

| Close code | Meaning |
|---|---|
| 4001 | Replaced by a newer connection with the same device id |
| 4002 | First message missing or invalid (`hello` or `mhs/register`) |
| 4003 | Unsupported protocol version |

---

## 5. Device description (`mhs/register`)

```json
→ {"jsonrpc": "2.0", "id": "1", "method": "mhs/register", "params": {
     "protocol": "mhs/v1",
     "device": {"id": "arm-03", "kind": "arm", "model": "Example Arm 6", "name": "Bench arm",
                "vendor": "Example Robotics", "firmware": "2.1.0", "mobile": false},
     "profile": {"size_m": [0.4, 0.4, 0.9], "weight_kg": 11, "reach_m": 0.85,
                 "notes": "6-axis arm bolted to the bench. Payload up to 3 kg. Stops on contact."},
     "localization": "none",
     "resources": {"arm": "reject", "gripper": "reject"},
     "state": { … },
     "sources": [ … ],
     "tools": [ … ],
     "manual": { … },
     "ui": {"icon": "arm", "primary": "cam_wrist"}}}
```

| Field | Required | Meaning |
|---|---|---|
| `protocol` | yes | `"mhs/v1"` |
| `device.id` | yes | Device id (3.3) |
| `device.kind` | yes | What sort of device: `car`, `dog`, `arm`, `drone`, `camera`, `sensor`, … Free text up to 40 characters, informative only |
| `device.model`, `device.name`, `device.vendor`, `device.firmware` | no | Up to 40 characters each. `name` is the display name; it defaults to the id |
| `device.mobile` | no, default `false` | Whether the device moves around in space |
| `device.radius` | no | Radius in meters a mobile device occupies, for other devices' planning |
| `profile` | no | Physical facts and usage notes (5.1) |
| `localization` | no, default `none` | How the device knows where it is (5.2) |
| `placement` | with `localization: fixed` | Where the device is installed: `{map, x, y, yaw}` (5.2) |
| `maps` | no | Maps the device defines: their frames and named places (MOS 3.5) |
| `resources` | no | Things only one call may use at a time (6.3) |
| `state` | no | State fields (10.1) |
| `sources` | no | Data sources: raw sensors and on-board perception (MOS section 3) |
| `tools` | no | Tools (section 6). A device with no tools is valid, for example a pure sensor |
| `manual` | no | Manual control (section 9) |
| `ui` | no | Presentation hints (Appendix B.7). Hubs and clients **MAY** ignore them |

Rules:

- [REG-1] The description **MUST** validate against the `register` schema.
- [REG-2] Within a description, source ids, tool names, resource names and axis ids **MUST** each be unique.
- [REG-3] The description is fixed for the lifetime of the connection. A device whose abilities change **MUST** reconnect and register again.

### 5.1 Profile

- `profile` tells people and agents what the device is physically like and what to be careful about.
- Numeric fields with unit suffixes are **RECOMMENDED** where they apply: `size_m` [length, width, height], `weight_kg`, `max_speed` (m/s), `reach_m`, `payload_kg`, `runtime_min`.
- `notes` is a short paragraph in plain language: known limits, typical errors, things an operator must know.
- All profile fields are informative. Safety limits that matter are enforced by the device itself (section 12).

### 5.2 Localization

| Value | Meaning |
|---|---|
| `none` | The device has no notion of its position (an arm on a bench nobody placed on a map) |
| `fixed` | The device is installed at a known place and does not move: `placement` gives it |
| `self` | The device localizes itself in a map frame and reports a `pose` source |
| `external` | The device reports odometry and ranging; the hub, or another system, places it on the map |

- [REG-4] A device with `localization: fixed` **MUST** give `placement`, in meters and degrees in the frame of the map it names. Its yaw is the direction of its body x axis, so a fixed camera's placement says where it looks when it is not panned.
- A hub treats a fixed device's placement as its position, always trusted. A person may also place a device with `localization: none` through the hub; that placement belongs to the hub, not to the device.

---

## 6. Tools

A tool is something the device can be asked to do: move, grasp, take a picture, speak, switch a mode.

```json
{"name": "move_joint",
 "description": "Move one joint to an angle and hold it there.",
 "inputSchema": {"type": "object",
   "properties": {"joint": {"type": "integer", "minimum": 1, "maximum": 6, "description": "joint number, 1 is the base"},
                  "angle": {"type": "number", "minimum": -170, "maximum": 170, "description": "target angle in degrees"}},
   "required": ["joint", "angle"]},
 "uses": ["arm"], "motion": true, "pausable": true, "timeout": 20}
```

### 6.1 Declaration

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Tool name (3.3) |
| `description` | yes | One or two sentences: what it does, what to expect. Shown to agents |
| `inputSchema` | yes | Parameters, in the subset of 6.2. A tool without parameters uses `{"type": "object"}` |
| `uses` | no, default `[]` | Resources held while the call runs (6.3) |
| `motion` | no, default `false` | The tool makes the device or part of it move. Motion calls are interrupted by `mhs/stop`, by manual control, by the device's own safety stop, and by losing the command channel |
| `readOnly` | no, default `false` | The tool only observes and changes nothing |
| `pausable` | no, default `false` | The call can be paused and resumed (8.3) |
| `needs` | no, default `[]` | Internal services the tool depends on, informative. A call whose dependency cannot start ends with `error` / `dependency` |
| `timeout` | yes | Upper bound in seconds from acceptance to result |
| `ui` | no | Presentation hints |

### 6.2 Parameter schema subset

`inputSchema` **MUST** be a JSON Schema whose root is `{"type": "object"}`, using only:

`type` (`object`, `number`, `integer`, `string`, `boolean`, `array`), `properties`, `required`, `default`, `minimum`, `maximum`, `maxLength`, `items`, `minItems`, `maxItems`, `enum`, `description`.

- [TOOL-1] A device **MUST NOT** use other keywords.
- **Ranges are limits.** `minimum` and `maximum` state the physical and safety limits of the device. The hub uses them to clamp arguments (6.4), and the device enforces them again ([SAFE-4]).

### 6.3 Resources

`resources` maps each resource name to a conflict policy:

| Policy | Meaning |
|---|---|
| `reject` | While a call holds the resource, a new call that uses it is rejected with `busy` |
| `queue` | A new call that uses it is accepted and waits until the resource is free |

- Calls with disjoint `uses` run concurrently.
- Manual control (section 9) holds every resource used by the device's motion tools for as long as input is active, plus `deadman_s`.

### 6.4 Validating arguments

Both the hub and the device validate every call against the tool's `inputSchema`.

| Situation | Outcome |
|---|---|
| Wrong type, missing required parameter, NaN or infinite number | Rejected, reason `invalid` |
| Number outside `minimum` / `maximum` | **Clamped** to the bound and executed; the result's `notes` says so |
| String longer than `maxLength` | Truncated and executed; noted |
| Parameter not in `properties` | Dropped |
| Parameter omitted | Its `default`, if any |

- [TOOL-2] The device **MUST** apply these rules itself, even though the hub applied them before sending.
- *Informative:* clamping instead of rejecting is deliberate. "Moved 2 m, the most allowed" is more useful to an agent than a refusal.

---

## 7. Calls

### 7.1 Request and acceptance

```json
→ {"jsonrpc": "2.0", "id": "c31", "method": "mhs/call",
   "params": {"name": "move_joint", "arguments": {"joint": 2, "angle": 45},
              "meta": {"job": "j12", "level": 2, "caller": "agent"}}}
← {"jsonrpc": "2.0", "id": "c31", "result": {"accepted": true}}
```

- The request `id` is the **call id**; progress and result refer to it.
- `name` and `arguments` are required; a call without parameters sends `"arguments": {}`.
- `meta` is hub bookkeeping. [CALL-1] Devices **MUST NOT** change their behavior based on `meta`.
- [CALL-2] A device **MUST** answer `mhs/call` with acceptance or rejection within 2 s, without waiting for any slow operation.

The device decides in this order:

1. Unknown tool, or invalid arguments: reject with `invalid`.
2. Not in a state to act safely (watchdog missing, a required sensor stale, a fault latched, a bridge cut off from its hardware): reject with `unsafe`.
3. A `reject` resource in `uses` is held: reject with `busy`, naming the holder.
4. Otherwise accept. If a `queue` resource is held, the call waits for it.

```json
← {"jsonrpc": "2.0", "id": "c32", "result": {
     "accepted": false, "status": "rejected", "reason": "busy",
     "detail": "arm held by move_joint (c30)", "holder": {"call": "c30", "tool": "move_joint"}}}
```

- [CALL-3] A `busy` rejection **MUST** include `holder`: the holding call's id and tool, or `{"manual": true}`.
- Accepting a call takes its resources; sending its result frees them.

### 7.2 Progress

```json
← {"jsonrpc": "2.0", "method": "mhs/progress",
   "params": {"call": "c31", "done": 20, "total": 45, "text": "joint 2 at 20 degrees"}}
```

| Field | Meaning |
|---|---|
| `call` | Required. The call id |
| `done`, `total` | Optional numeric progress |
| `text` | Optional one-line description |
| `data` | Optional structured progress |
| `state` | `"paused"` or `"running"` when a pausable call changes state (8.3) |

[CALL-4] At most 2 progress notifications per second per call. Pause and resume state changes are exempt.

### 7.3 Result

```json
← {"jsonrpc": "2.0", "method": "mhs/result",
   "params": {"call": "c31", "status": "done", "detail": "joint 2 at 45.0 degrees",
              "notes": [], "data": {"angle": 45.0}}}
```

| Field | Meaning |
|---|---|
| `call` | The call id |
| `status` | `done`, `interrupted` or `error` (section 10) |
| `reason` | Reason code; absent when `done` |
| `detail` | One sentence for people and agents. **SHOULD** be present: it is what an agent reads |
| `notes` | Optional remarks: arguments clamped or defaulted, fallbacks used |
| `data` | Optional structured result |
| `after` | Snapshot when the call ended. Mobile devices **MUST** include `odometry` (kind `odometry` payload); devices with `localization: self` include `pose` when localized |

### 7.4 Ordering guarantees

[CALL-5] For every call:

1. The first message about it is the acceptance or rejection reply.
2. A rejected call gets nothing more.
3. An accepted call gets zero or more progress notifications, then **exactly one** result. After the result, the call id is never used again.

- Results that could not be sent because the command channel was lost are not sent later.
- *Informative:* the two channels are not ordered relative to each other. A hub that needs the state after an action uses `after`, not the latest stream data.

---

## 8. Cancel, stop, pause and resume

### 8.1 Cancel

```json
→ {"jsonrpc": "2.0", "id": "x7", "method": "mhs/cancel", "params": {"call": "c31"}}
← {"jsonrpc": "2.0", "id": "x7", "result": {"cancelled": true}}
```

- Cancels one call, running or queued.
- `cancelled: true`: the result follows with `interrupted` / `cancel`. The reply and the result may arrive in either order.
- `cancelled: false`: the call id is unknown or already finished, or the tool cannot stop part-way. In that last case it completes and reports normally.
- [CTL-1] Cancelling twice **MUST NOT** be an error.

### 8.2 Stop

```json
→ {"jsonrpc": "2.0", "id": "x8", "method": "mhs/stop", "params": {}}
← {"jsonrpc": "2.0", "id": "x8", "result": {"stopped": ["c31"]}}
```

- [CTL-2] A device **MUST** accept `mhs/stop` at any time: before registration completes, while idle, during any call, during manual control. It **MUST NOT** reject it.
- [CTL-3] On `mhs/stop`, the device **MUST**:
  1. command zero motion on all actuators first;
  2. then interrupt every `motion` call, each ending `interrupted` / `stop`;
  3. then reply with the ids it interrupted.
- [CTL-4] The reply **MUST** come within 2 s.
- Calls that are not `motion` continue. Stop needs no declaration, takes no parameters, and uses no resources.

### 8.3 Pause and resume

Only for tools declared `pausable`.

```json
→ {"jsonrpc": "2.0", "id": "p2", "method": "mhs/pause", "params": {"call": "c31"}}
← {"jsonrpc": "2.0", "id": "p2", "result": {"paused": true}}
→ {"jsonrpc": "2.0", "id": "p3", "method": "mhs/resume", "params": {"call": "c31"}}
← {"jsonrpc": "2.0", "id": "p3", "result": {"resumed": true}}
```

- [CTL-5] On pause, a device **MUST** bring the paused motion to rest before replying. It keeps the call's resources and remembers what is left to do. It then sends progress with `state: "paused"`. On resume it **MUST** continue and send `state: "running"`; the call then ends with its one result ([CALL-5]) at most the tool's `timeout` after resuming: `done`, or `interrupted` or `error` when something ends it after resuming (a safety stop, for example).
- `paused: false` means the call is unknown, finished or not pausable. `resumed: false` means it is unknown, finished or not paused.
- [CTL-6] A paused call is still running: `mhs/stop`, `mhs/cancel` and manual control interrupt it as usual.
- A device **MAY** end a call that stays paused longer than it can hold its state, with `interrupted` / `pause_timeout`.

---

## 9. Manual control

Some devices can be steered directly by a person. Each such device declares exactly what can be steered.

```json
"manual": {
  "axes": [
    {"id": "vx", "role": "forward", "unit": "m/s", "min": -0.4, "max": 0.4},
    {"id": "wz", "role": "turn", "unit": "deg/s", "min": -60, "max": 60},
    {"id": "z", "role": "up", "unit": "m/s", "min": -0.05, "max": 0.05, "keys": ["r", "f"]}
  ],
  "rate_hz": 10, "deadman_s": 0.5,
  "speeds": [{"label": "slow", "scale": 0.5}, {"label": "fast", "scale": 1.0}]
}
```

| Field | Meaning |
|---|---|
| `axes` | Required, at least one. What a person can command. Each axis has `id`, `role` (Appendix B.2), `unit`, `min`, `max`, and optionally suggested `keys` (positive, negative) |
| `rate_hz` | Required. How often input is sent while a person holds a control |
| `deadman_s` | Required. If no input arrives for this long, the device stops |
| `speeds` | Optional presets that scale every axis |

- **Quick actions are tools.** Buttons offered next to the manual controls (stand up, take off, open gripper) are ordinary tools with the hint `ui.group: "manual"`.
- **A device without `manual` cannot be steered by hand.**

Input arrives on the Nerve channel:

```json
{"type": "manual", "axes": {"vx": 0.2, "wz": 0}}
```

- [MAN-1] Axes not present in a message are zero.
- [MAN-2] The device **MUST** clamp each axis to its declared range.
- [MAN-3] A message with any non-zero axis **MUST** interrupt every running `motion` call (`interrupted` / `manual`). Manual control then holds the resources of the motion tools until `deadman_s` after the last non-zero message.
- [MAN-4] If no `manual` message arrives within `deadman_s`, the device **MUST** stop all manually commanded motion.
- [MAN-5] The deadman **MUST** keep working if the process handling Agnes MHS stops responding. An independent watchdog is the **RECOMMENDED** way ([SAFE-5]).

---

## 10. State and reason codes

### 10.1 State

A device's **state** is a small dictionary of named values describing what the device is and how it is set right now: a mode, a posture, a lock, a volume, a battery level. State is not streamed. It changes rarely, every change matters, and the hub keeps the current value, so that anyone can read it at any time without disturbing the device.

**Declaration.** The description lists the fields in `state`, with the field declaration of MOS 3.3 and one more key, `writable`:

```json
"state": {
  "mode": {"type": "string", "enum": ["idle", "cleaning", "docked"], "description": "what it is doing"},
  "battery": {"type": "number", "unit": "%", "min": 0, "max": 100, "role": "battery", "alert": {"warn": 20, "bad": 10, "below": true}},
  "volume": {"type": "integer", "min": 0, "max": 10, "writable": true, "description": "speaker volume"}
}
```

- Every device also has two standard fields, without declaring them: `problem`, one sentence when operators should know something is wrong, otherwise `null`; and `faults`, a list of device-defined fault codes.
- A field's `role` (MOS 3.3 and Appendix C) says what it is in standard terms, such as `battery` or `temperature`, so the hub can summarize the health of devices it has never seen. Its `alert` says when the value is a problem.
- `writable` (default `false`) marks a setting the hub may change with `mhs/set`. `min`, `max` and `enum` of a writable field are limits the device enforces.

**Updates.** The device reports state on the command channel:

```json
← {"jsonrpc": "2.0", "method": "mhs/state", "params": {"t": 1791400000.5, "values": {"mode": "cleaning", "battery": 76}}}
```

- [STATE-1] Right after the hub answers `mhs/register`, the device **MUST** send `mhs/state` with every declared field and both standard fields.
- [STATE-2] After that, the device **MUST** send `mhs/state` within 1 s of any change, with the changed fields only. Every value **MUST** have its field's declared type, and be one of its `enum` when one is declared. `t` is the device clock at the change (MHS 3.5).
- A value that changes more than about once a second, or whose history matters, belongs in a data source (MOS), not in state. A device **SHOULD** report state at the precision that matters, for example the battery in whole percent.

**Settings.** The hub changes writable fields with `mhs/set`:

```json
→ {"jsonrpc": "2.0", "id": "s4", "method": "mhs/set", "params": {"values": {"volume": 12}}}
← {"jsonrpc": "2.0", "id": "s4", "result": {"values": {"volume": 10}, "notes": ["volume was 12, clamped to 10"]}}
```

- [STATE-3] A device **MUST** apply `mhs/set` only to writable fields, validating and clamping each value as in 6.4. It replies within 2 s with the values in effect, lists fields it did not change in `refused` with a reason, and reports the change with `mhs/state` as well.
- [STATE-4] Setting a value **MUST NOT** start motion ([SAFE-7]). A setting takes effect at once and has no progress; anything that takes time, can fail part-way, or must be interruptible is a tool.

**What the hub knows by itself.** Which calls hold which resources follows from the calls the hub made (7.1) and the manual input it sent (section 9), so devices do not report it. *Informative:* a hub keeps the latest state of every device, together with what it knows itself (whether the device is available, which jobs hold which resources), and serves it to its clients; it raises an alert when a field crosses its declared alert level.

### 10.2 Statuses and reasons

| Status | Meaning |
|---|---|
| `done` | Completed |
| `rejected` | Not started; the device did nothing. Only in the acceptance reply |
| `interrupted` | Started, then stopped by someone else: a person, the hub, or the device's own safety system |
| `error` | Started and did not succeed |

| Reason | With status | Meaning |
|---|---|---|
| `invalid` | rejected | Unknown tool, or invalid arguments |
| `busy` | rejected | A resource is held; see `holder` |
| `unsafe` | rejected | The device cannot act safely right now |
| `offline` | rejected | Hub only: the device is not connected |
| `denied` | rejected | Hub only: the caller may not use this tool |
| `stop` | interrupted | `mhs/stop` |
| `cancel` | interrupted | `mhs/cancel` |
| `manual` | interrupted | A person took manual control |
| `estop` | interrupted | The device's own safety system stopped the action |
| `preempted` | interrupted | Hub only: a lower-priority job yielded |
| `pause_timeout` | interrupted | Paused for too long |
| `disconnect` | interrupted | Hub only: the command channel was lost |
| `dependency` | error | A required internal service did not start, or an audio clip was missing |
| `timeout` | error | The tool ran out of time |
| `stuck` | error | Could not make progress |
| `unreachable` | error | The goal cannot be reached |
| `failed` | error | Any other failure; see `detail` |

- [RES-1] Devices **MUST NOT** send the reasons marked hub only. Custom reasons use `x_<name>`, with the closest standard status.

---

## 11. Timeouts

| What the hub waits for | Limit | The hub then |
|---|---|---|
| Acceptance of a call | 2 s ([CALL-2]) | Sends `mhs/stop`; records the call as `error` / `timeout` |
| Result of a call | The tool's `timeout` + 5 s | Sends `mhs/cancel`; 2 s later, `mhs/stop` |
| Reply to `mhs/cancel` or `mhs/stop` | 2 s ([CTL-4]) | Closes the command channel; the device then stops by itself ([SAFE-2]) |
| Reply to `mhs/set`, `mhs/configure`, `mhs/keyframe`, `mhs/pause`, `mhs/resume` | 2 s | Treats the request as failed |
| Reply to `mhs/time` | 0.5 s (MOS [TIME-2]) | Ignores that sample |

- [TO-1] Devices **SHOULD** enforce their own per-call time limits and report `error` / `timeout` before the hub's limit.

---

## 12. Safety requirements

The device is responsible for its own safety. A hub, a network or an agent may fail at any moment, and the device must remain safe when they do.

| Id | Requirement |
|---|---|
| [SAFE-1] | A device **MUST** handle `mhs/stop` as in [CTL-2] and [CTL-3]: always accepted, zero motion first. |
| [SAFE-2] | When the command channel is lost, a device **MUST** stop all motion within 1 s of detecting the loss, end every `motion` call, and **MUST NOT** resume them after reconnecting. |
| [SAFE-3] | When the Nerve channel is lost, manual control ends by the deadman ([MAN-4]). |
| [SAFE-4] | A device **MUST** enforce the limits it declares (parameter ranges, axis ranges) on every command, whatever the hub sent. |
| [SAFE-5] | A device that can move **SHOULD** have a watchdog independent of the process that speaks Agnes MHS. If it has one, it **MUST** reject motion calls as `unsafe` whenever the watchdog is not running. |
| [SAFE-6] | A device **SHOULD** stop motion that would collide, by its own sensing, and report `interrupted` / `estop`. |
| [SAFE-7] | A device **MUST NOT** start motion except in response to an accepted call or to manual input. |

*Informative:* none of these depend on the hub behaving well.

---

## 13. Extensibility and versioning

- **Version string.** The version is `mhs/v<major>`. A hub that does not support a device's major version rejects registration with `-32001` and closes with 4003.
- **Minor changes need no version change.** These add optional fields, kinds, roles, reasons, units, or video codecs. Receivers ignore what they do not know ([MSG-6]).
  - A hub meeting an unknown kind treats it like an `x_` kind.
  - A hub meeting an unknown reason treats it as its status's generic case.
  - A hub meeting an unknown unit or axis role shows it as text.
  - The schema of a version checks messages of that version exactly. A hub applies these rules before it rejects a message from a newer minor version.
- **Custom names.** Use `x_<name>` for custom kinds, roles, reasons and fault codes.
- **Vendor fields.** Vendor-specific fields go in any object under a key beginning with `x_`. Standard fields never begin with `x_`. The exception is a tool's `inputSchema`: it is a JSON Schema limited to the keywords of 6.2 ([TOOL-1]), so it takes no vendor fields.
- **Breaking changes.** Removing or redefining a field, a message or a meaning requires a new major version.
- **Presentation hints** (`ui`) are hints. Ignoring them never breaks interoperability.

## 14. Security considerations

Agnes MHS 1.0 has **no authentication and no encryption** of its own.

- **Exposure.** Anyone who can reach the hub can register a device. Anyone who can reach a device's channels can impersonate the hub. Streams, including camera video and microphone audio, travel unencrypted unless `wss://` is used.
- **Where it belongs.** It is intended for trusted local networks: labs, workshops, homes.
- **Recommendations.**
  - Isolate hubs and devices on their own network or VLAN.
  - Use `wss://` on shared networks.
  - Mark microphones and cameras in private spaces `switchable` and default them off.
  - Never expose a hub to the internet.
- **What protects people.** The safety requirements (section 12) assume a possibly hostile or broken hub, and they are the main protection the protocol offers.

## 15. Conformance

### 15.1 Profiles

A device conforms when it meets every **MUST** of the profiles that apply to it. Which profiles apply follows from its description.

| Profile | Applies when | Requirements |
|---|---|---|
| **Core** | Always | MSG-1…3, MSG-6, MSG-7, ID-1, CONN-1…3, CONN-5…9, REG-1…4, TOOL-1…2, CALL-1…5, CTL-1…4, STATE-1…4, RES-1, SAFE-1, SAFE-4, SAFE-7 |
| **Motion** | Any tool has `motion: true` | SAFE-2, SAFE-5, SAFE-6 (both **SHOULD**), `after.odometry` for mobile devices |
| **Manual** | `manual` is present | MAN-1…5, SAFE-3 |
| **Pause** | Any tool has `pausable: true` | CTL-5, CTL-6 |

The Perception, Maps, Derived perception, Streaming, Video and Audio clip profiles are those of MOS (MOS section 12). A device may claim, for example, "Agnes MHS 1.0: Core, Motion, Manual; Agnes MOS 1.0: Perception, Streaming" when the conformance suite passes for those profiles.

### 15.2 Hubs

This specification is written for device makers. A hub that wants its devices to rely on it **MUST**:

- validate and clamp arguments before calling (6.4);
- never call before registration completes;
- honor the timeouts of section 11;
- keep the latest state of every device (10.1);
- meet the hub rules of MOS section 12 when devices declare sources;
- treat a lost command channel as interrupting every running call.

---

## Appendix A. Message index

| Message | Channel | Direction | Type | Section |
|---|---|---|---|---|
| `mhs/register` | command | device → hub | request | 5 |
| `mhs/ping` | command | device → hub | request | 4.4 |
| `mhs/call` | command | hub → device | request | 7.1 |
| `mhs/progress` | command | device → hub | notification | 7.2 |
| `mhs/result` | command | device → hub | notification | 7.3 |
| `mhs/cancel` | command | hub → device | request | 8.1 |
| `mhs/stop` | command | hub → device | request | 8.2 |
| `mhs/pause`, `mhs/resume` | command | hub → device | request | 8.3 |
| `mhs/state` | command | device → hub | notification | 10.1 |
| `mhs/set` | command | hub → device | request | 10.1 |
| `manual` | Nerve | hub → device | — | 9 |

The stream messages (`hello`, `data`, `clip`, `mhs/configure`, `mhs/keyframe`, `mhs/time`) are listed in MOS Appendix A.

## Appendix B. Vocabularies

### B.1 Data kinds

Defined by MOS, Appendix B.

### B.2 Axis roles

| Role | Meaning | Suggested keys |
|---|---|---|
| `forward` | Forward / backward speed | W / S |
| `turn` | Turn rate, counter-clockwise positive | A / D |
| `strafe` | Sideways speed, left positive | Q / E |
| `up` | Vertical speed or height change | R / F |
| `roll` | Roll | Z / C |
| `pitch` | Pitch (camera tilt, drone pitch) | ↑ / ↓ |
| `yaw` | Yaw of a mechanism (camera pan) | ← / → |
| `zoom` | Zoom | + / − |
| `grip` | Gripper opening speed, open positive | G / H |
| `joint` | One joint of an arm (add `joint` index to the axis) | — |
| `x_<name>` | Anything else | — |

### B.3 Reason codes

See section 10.2.

### B.4 Units

`m`, `mm`, `m/s`, `m/s²`, `deg`, `deg/s`, `rad`, `rad/s`, `s`, `ms`, `min`, `Hz`, `bpm`, `V`, `A`, `W`, `Wh`, `%`, `°C`, `Pa`, `kPa`, `lux`, `ppm`, `dB`, `dBm`, `kg`, `N`, `N·m`, `kbit/s`.

- Others use `x_<name>`.
- `rad` and `rad/s` are allowed in declarations (fields, axes); protocol payloads always use degrees.

### B.5 Device kinds (informative)

`car`, `dog`, `humanoid`, `arm`, `drone`, `camera`, `sensor`, `speaker`, `display`, `door`, `light`, `other`, or free text.

### B.6 Status values

`done`, `rejected`, `interrupted`, `error`.

### B.7 Presentation hints (`ui`)

All optional; anyone may ignore them.

| Where | Keys |
|---|---|
| Device | `icon`, `primary` (source id of the main view), `order` |
| Source | `group`, `order`, `label`, `hidden`, `widget` |
| Field | `label`, `tile` (show on summary cards), `widget`, `hidden` |
| Tool | `group` (`"manual"` places it with the manual controls), `label`, `confirm`, `hidden`, `widget` |
| Tool parameter | `pick` (`"map-point"`, `"map-pose"`, `"map-polygon"`), `limit` (soft limit), `label` |

## Appendix C. Example devices

*Informative.* Six devices that share nothing but the protocol.

**C.1 Environmental sensor**: no tools, no manual control, two sources.

```json
{"protocol": "mhs/v1",
 "device": {"id": "env-01", "kind": "sensor", "model": "Example Air 2"},
 "sources": [
   {"id": "air", "kind": "values", "hz": 0.2, "default": true, "description": "air near the floor",
    "fields": {"temperature": {"type": "number", "unit": "°C", "min": -20, "max": 60, "role": "temperature", "of": "air", "alert": {"warn": 35, "bad": 45}},
               "humidity": {"type": "number", "unit": "%", "min": 0, "max": 100}}},
   {"id": "door", "kind": "switch", "description": "front door contact", "fields": {"open": {"type": "boolean"}}}]}
```

**C.2 Smart security camera**: perception on board, no motion.

- One `video` source (H.264, 1080p).
- A `detections` source of it (people and vehicles, with tracks), computed on the camera.
- A `switchable` microphone (`audio`).
- Tools `snapshot` (returns a still in `data`) and `privacy {on}`.

**C.3 Wheeled mobile robot (mecanum)**:

- Tools `move {x, y}`, `turn {angle}`, `goto {x, y, yaw}`, `say {text, clip}`.
- Resources `chassis: reject`, `speaker: queue`.
- `localization: self`.
- State: `mode`, `battery`, and a writable `volume`.
- Sources: `video` front camera, `image` depth camera, `scan`, `odometry`, `pose` and `grid` from its own SLAM.
- `manual` with `forward`, `strafe`, `turn`.

**C.4 Quadruped**:

- Like C.3, but `localization: external`, without `goto` and `grid`.
- An `action {name: enum}` tool; its stand and sit actions carry `ui.group: "manual"`.
- State `posture`, `height` and `gait`, with `gait` writable.

**C.5 Robot arm**:

- Tools `move_joint` (`pausable`), `move_to {x, y, z}`, `grip {width}`, `home`.
- Resources `arm`, `gripper`.
- Sources: a wrist `image` camera, `joints` (`values`), a `switch` for the emergency button.
- `manual` with `joint` axes and `grip`.

**C.6 Pan-tilt camera**:

- Tools `look_at {pan, tilt}`, `preset {name: enum}`.
- Resource `ptz: reject`.
- One `video` source.
- `manual` with `yaw`, `pitch`, `zoom`.

## Appendix D. Relationship to Anthropic's Model Hardware Standard and to MCP

*Informative.*

**Anthropic's Model Hardware Standard.** Anthropic announced a research preview of a standard also called the Model Hardware Standard on 2026-08-27. Agnes MHS is **independent of it**: it is not an implementation of it, not a profile of it, and not affiliated with Anthropic. Its full specification was not public when this specification was written. The comparison below relies on Anthropic's public announcement only.

| | Anthropic's Model Hardware Standard (public description) | Agnes MHS |
|---|---|---|
| Shared ideas | Devices discoverable in a standard format; read and write primitives; a device reference file stating what it measures, what can be adjusted, and which safety limits it enforces; limits enforced on the device; access by agents through MCP, a CLI or code | Registration describes the device; state is what can be read and, where writable, adjusted (`mhs/set`); tools are what can be done; profile, ranges and resources state its limits; the device enforces them |
| Perception | Values to read | A typed perception layer (MOS): kinds with fixed formats, sensor geometry (mount, field of view), field units and alert ranges, and standard derived results (detections, tracks, localization, transcripts, a world model), whether computed on the device or the hub |
| Data movement | A shared-memory state dictionary on the host; data is read by pulling | Both. State is pulled: the hub keeps each device's state dictionary, changed only when the device reports a change, and anyone reads it at any time. Observations are pushed (MOS): real-time streaming with demand-driven rates set by the hub, encoded video, keyframe requests, latest-wins under congestion, clock synchronization |
| Control | Not described publicly | Immediate acceptance, then progress and one result; cancel, pause, resume; stop that always succeeds; manual control with a deadman; explicit safety requirements |
| Conformance | Not described publicly | Requirement identifiers, profiles, and a test hub (`mhs-conformance.md`) |

**MCP.** Agnes MHS borrows the Model Context Protocol's message format (JSON-RPC 2.0) and tool declaration (`name`, `description`, `inputSchema`). It differs where physical devices need it:

- the device dials the hub;
- calls are accepted at once and finish later;
- stop is a protocol message that cannot fail;
- streams travel apart from commands;
- devices declare resources and motion.

A hub may expose Agnes MHS devices to MCP clients through a gateway; that is outside this specification.
