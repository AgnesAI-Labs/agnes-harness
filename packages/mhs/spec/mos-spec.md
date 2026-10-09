# Agnes MOS: Model Observation Standard

**Version 1.0** (2026-10-08).

MOS is the companion of the [Agnes MHS specification](mhs-spec.md). MHS defines what a device is and what it can do; MOS defines what a device observes and how those observations reach the hub as they happen.

## Contents

1. Introduction
2. The Nerve channel
3. Sources
4. Derived perception
5. Data messages
6. Frames or video
7. Video streams
8. Rates and configure
9. Congestion and latency
10. Time synchronization
11. Extensibility and security
12. Conformance

Appendix A. Message index · Appendix B. Data kinds · Appendix C. Field roles

---

## 1. Introduction

A device that senses something declares each sensor, or each stream of results it computes, as a **data source**. MOS gives every source a typed description (what it measures, where it is mounted, its units and limits) and streams its data live over a second channel, **Nerve**. Perception results (detections, tracks, localization, transcripts, a shared world) use the same typed formats whether a device computes them on board or the hub does. Data flows on demand: the hub says which sources it needs and how often, and under load the newest data wins over complete data.

**Observations are pushed; state is pulled.** A device's current state (its mode, posture, a lock, a volume, its battery level) is not a MOS source: it is the device's state dictionary of MHS section 10.1, which the hub keeps and anyone reads at any time. MOS is for what is measured continuously and watched live: camera frames, video, scans, audio, inertial data, telemetry curves, and perception results. Rule of thumb: if what matters is the current value, it is state; if what matters is how it changes over time, it is a source.

### 1.1 Scope and conventions

- A device that implements MOS also implements MHS Core: its identity, registration and command channel come from MHS. MOS defines the `sources` part of the registration, the Nerve channel, data messages, and the stream-control requests `mhs/configure`, `mhs/keyframe` and `mhs/time`, which travel on the MHS command channel.
- Roles, requirement language, identifiers, units (degrees for angles), frames, time and text are those of MHS sections 1.2, 1.3 and 3. Requirement identifiers continue those of MHS and are unique across both standards.
- *Informative:* the requests MOS defines on the command channel use the `mhs/` prefix, like every request on that channel.

## 2. The Nerve channel

- It is the second WebSocket channel of a device, at `<base>/ws/nerve` (MHS 4.1), opened by the device. Liveness and reconnecting follow MHS 4.4 and 4.5.
- A device that declares data sources, manual control (MHS 9), or tools taking audio clips **MUST** open it. The hub pairs it with the command channel by device id and considers the device available only when both channels are open and registration has succeeded.
- The device **MAY** open it before or after registering.
- It carries every data source of the device, and the messages to the device of section 2.3. What matters on it is the newest data, delivered quickly; completeness matters less.

### 2.1 Opening

- [CONN-4] The first message on the Nerve channel **MUST** be:

```json
{"type": "hello", "device": "arm-03"}
```

### 2.2 Messages

- [MSG-4] Nerve messages are JSON objects with a `type` field, sent as text frames. A binary payload is sent as the binary frame immediately following the text frame that describes it (section 5).
- [MSG-5] A Nerve text frame **MUST NOT** exceed 1 MiB. A binary frame **MUST NOT** exceed 16 MiB.

### 2.3 Messages to the device

The hub sends two kinds of message on Nerve. `manual` carries a person's manual input; its rules are those of MHS section 9. `clip` carries audio for a tool to play:

```json
{"type": "clip", "id": "a7", "rate": 24000, "channels": 1}
<binary frame: 16-bit little-endian PCM>
```

- A tool that plays audio declares a string parameter `clip`. The hub sends the clip first, then calls the tool with its id.
- [STR-8] A device that declares a tool with a `clip` parameter **MUST** accept `clip` messages. It keeps at least the 4 most recent clips for at least 60 s.
- If the clip is missing, the device uses its own fallback (noted in `notes`), or ends with `error` / `dependency`.
- A device recording audio **SHOULD** add `"speaking": true` to its `audio` data while its own speaker plays, so the device does not take itself for someone speaking.

---

## 3. Sources

The perception layer describes everything a device senses, in a form any hub or client can understand without knowing the device: what each sensor is, where it is, what its data looks like, and what can be concluded from it.

### 3.1 Declaration

Each sensor, or each stream of readings or results a device can report, is a **data source** with its own id.

```json
"sources": [
  {"id": "cam_front", "kind": "video", "codec": "h264", "encoding": "rgb", "size": [1280, 720], "hz": 30,
   "fov_deg": [69, 42], "bitrate_kbps": [300, 4000], "gop_s": 1,
   "mount": {"xyz": [0.12, 0, 0.30], "rpy": [0, 10, 0]},
   "description": "front camera, tilted 10 degrees down", "default": true},
  {"id": "lidar", "kind": "scan", "hz": 10, "range_m": [0.1, 12], "mount": {"xyz": [0, 0, 0.35], "rpy": [0, 0, 0]},
   "description": "2D lidar on top"},
  {"id": "people", "kind": "detections", "of": "cam_front", "hz": 15,
   "model": {"name": "example-person-det", "version": "3.1"}, "labels": ["person"],
   "description": "people detected on board in the front camera"},
  {"id": "motors", "kind": "values", "hz": 20, "description": "drive motor current and temperature",
   "fields": {"current": {"type": "number", "unit": "A", "min": 0, "max": 8, "role": "current", "of": "motor"},
              "temperature": {"type": "number", "unit": "°C", "min": 0, "max": 90, "role": "temperature",
                              "of": "motor", "alert": {"warn": 70, "bad": 80}}}}
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Source id (MHS 3.3) |
| `kind` | yes | A kind from Appendix B, or `x_<name>` |
| `description` | yes | What it is, where it is, anything notable |
| `hz` | no | Highest rate the device can deliver. Omitted for the event-driven kinds, `switch`, `text` and `transcript`, whose messages follow what happens rather than a clock. A source computed from another, such as `detections`, has a rate: the highest it can compute at, at most its input's |
| `of` | derived kinds | Id of the source this one is computed from (section 4) |
| `model` | derived kinds | `{name, version}` of what computes it |
| `fields` | `values`, `switch` | Field declarations (3.3) |
| `mount` | no | Pose in the body frame (MHS 3.4). **RECOMMENDED** for imaging and ranging sensors |
| `switchable` | no, default `false` | The source may be turned off on request (privacy, power) |
| `default` | no, default `false` | Part of the device's default view |
| kind-specific metadata | per kind | Appendix B |
| `ui` | no | Presentation hints |

- [PER-1] Every data message **MUST** carry a payload that follows its source's kind (Appendix B). For `values` and `switch`, each value **MUST** have its field's declared `type`, and be one of its `enum` when one is declared.

### 3.2 Raw and derived kinds

| Class | What it is | Kinds |
|---|---|---|
| **Raw** | Measured by a sensor | `image`, `video`, `scan`, `points`, `audio`, `imu`, `odometry`, `gnss`, `values`, `switch`, `text` |
| **Derived** | Computed from other sources | `detections`, `pose`, `grid`, `transcript`, `world` |

- A derived source can be produced by the device (a smart camera with an on-board detector, a robot with its own SLAM) or by the hub (a hub running a detector on a device's video).
- **The format is the same either way.** A client reads a `detections` source the same way whatever computed it.
- A device declares only the derived sources it computes itself. Hubs add their own when they expose sources to clients.
- `world` is produced only by hubs; its format is defined here so hubs and clients interoperate.

### 3.3 Field declarations

The `values` and `switch` kinds carry named fields. Each field is declared so that a program that has never seen the device can display it, check it against limits, and describe it in words.

| Key | Meaning |
|---|---|
| `type` | `number`, `integer`, `boolean` or `string` |
| `enum` | Allowed values, for strings |
| `unit` | Unit from MHS Appendix B.4 |
| `min`, `max` | Normal range, for gauges and scales |
| `alert` | `{"warn": 70, "bad": 80}` alerts above; add `"below": true` to alert below |
| `role` | What the field is in standard terms, from Appendix C: `battery`, `temperature`, `heart_rate`, … |
| `of` | With `role`: the part it belongs to, for example `motor`, `cpu` or `oxygen` (an identifier, MHS 3.3) |
| `description` | One line |
| `ui` | Presentation hints |

- `values` messages **MAY** contain only the fields that changed. Absent fields keep their last value.
- **Roles.** A field's name is the device's own; its `role` says what it is in terms every hub knows, so that a hub or a model can find "the battery" or "the motor temperature" of any device without learning its names. A device **SHOULD** give a role to every field that has one in Appendix C. A field without a role is still displayed and checked against its `alert`; it is only left out of summaries across devices.
- `switch` messages are sent on change, and at least every 10 s.

### 3.4 Geometry

Perception is only useful if its geometry is known.

- [PER-2] Imaging sources (`image`, `video`) **SHOULD** declare `fov_deg` and `mount`. Ranging sources (`scan`, `points`) **SHOULD** declare `range_m` and `mount`.
- With `mount` and `fov_deg`, a hub converts a pixel in an image into a bearing in the body frame, and a scan point into a body-frame point. Without them, it can only show the data, not reason about it.
- A sensor without a `mount` is assumed at the body origin, facing forward.

### 3.5 Maps and places

Positions mean something only on a known map. A **map** is a named 2D frame (MHS 3.4) with a description; its **places** name parts of it, so that people, agents and the hub can say "the airlock" instead of coordinates.

A device that defines a map, because it built it or because it knows the site, describes it in its registration under `maps`:

```json
"maps": [{
  "id": "base", "name": "Base", "bounds": [-60, -60, 60, 60],
  "places": [
    {"id": "airlock", "name": "Airlock", "at": [-12, 4], "yaw": 180, "description": "Outer door of the habitat airlock"},
    {"id": "dock", "name": "Rover dock", "at": [-15.5, -16]},
    {"id": "west-field", "name": "West field", "points": [[-60, -60], [-25, -60], [-25, -20], [-60, -20]]}
  ]}]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Map id (MHS 3.3). `pose`, `grid` and `placement` name maps by this id |
| `name` | no | Display name; defaults to the id |
| `bounds` | no | `[xmin, ymin, xmax, ymax]` in meters: the part of the frame the map covers |
| `anchor` | no | Where this frame lies in a wider one: `{map, x, y, yaw}` (this frame's origin and +x direction in the frame of `map`), or `{lat, lon, heading}` (its origin on the Earth, and the compass heading of +x in degrees) |
| `places` | no | Named places on the map |

A place is either a **landmark**, a point, or a **zone**, an area:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the map (MHS 3.3) |
| `name` | yes | What people call it |
| `at` | landmarks | `[x, y]` in meters |
| `yaw` | no | For a landmark: the direction to face there, in degrees (a door, a docking bay) |
| `points` | zones | The zone's outline, `[[x, y], …]`, at least three points |
| `description` | no | A sentence: what it is, what to be careful about |

- [MAP-1] Map ids, and place ids within a map, **MUST** be unique and follow MHS 3.3. A place **MUST** have exactly one of `at` and `points`, and carries only the fields above.
- [MAP-2] Coordinates **MUST** be meters and degrees in the map's frame. Every device that declares the same map id **MUST** mean the same frame; a hub keeps the latest declaration of a map and merges places by id.
- [MAP-3] A `pose` or `grid` message, and a `placement`, **SHOULD** name a map that some connected device declares. A hub shows positions on a map it has no description for, but cannot name places there.
- [MAP-4] Places, placements and `pose` positions **SHOULD** lie within their map's `bounds` when it declares them. A position outside usually means coordinates in another unit or frame.
- A hub keeps the maps it has seen after their devices disconnect. It may add places of its own, for example ones a person draws, and gives the result to clients as `world` (Appendix B).
- `anchor` relates frames so that a hub can show devices on different maps together, for example a robot's SLAM map placed on a site plan. A hub that does not use anchors shows each map on its own.

## 4. Derived perception

- [PER-3] A derived source **MUST** declare `model`, and `of` where its kind requires it (Appendix B: `detections` and `transcript`; `pose` may name one; `grid` and `world` have none). `of` names a declared source of the same device.
- [PER-4] Each data message of a source that declares `of` **MUST** carry `of_seq`, the `seq` of the input message it was computed from, and `t` equal to that input's capture time. Clients can then line up a detection with the exact frame it came from. Messages of a derived source without `of` (`grid`, `world`, a `pose` that names no input) carry no `of_seq`.
- Derived messages **MAY** carry `lag`: seconds spent computing the result, for latency accounting.
- [PER-5] Confidences are numbers from 0 to 1. Boxes are in pixels of the input image (MHS 3.4). Bearings are degrees in the body frame, counter-clockwise (left) positive. Distances are meters.
- Derived sources follow the same rules for rates and `configure` as raw ones. A hub can turn off an on-board detector nobody needs.

**Localization quality.** Whether a position can be trusted matters as much as the position itself.

- [PER-6] A `pose` source **MUST** send `ok: false` whenever the device's localizer does not trust its fix: not yet localized, lost, relocalizing, or diverged. It **SHOULD** keep sending at its rate while not `ok`, so that silence means the localizer stopped, not that it is lost.
- A `pose` source **MAY** declare `max_error_m`, the position error (one standard deviation) above which a fix should not be trusted even with `ok: true`. With `cov`, the error is the square root of the larger of its x and y variances.
- *Informative:* a hub judges a device's position as **trusted** (`ok`, fresh, error within `max_error_m`), **uncertain** (`ok: false`, error too large, or a jump that the device's `odometry` does not explain) or **lost** (no fresh pose, or the device unavailable; only the last known position remains).

*Informative example:* a detection stream computed on board.

```json
{"type": "data", "source": "people", "seq": 5521, "t": 1791400000.290, "of_seq": 4410, "lag": 0.031,
 "data": {"w": 1280, "h": 720, "items": [
   {"label": "person", "conf": 0.91, "box": [412, 180, 520, 610], "track": 17, "bearing": 18.5, "dist": 1.8}]}}
```

---

## 5. Data messages

```json
{"type": "data", "source": "motors", "seq": 902, "t": 1791400000.311, "data": {"current": 1.4, "temperature": 41.5}}
{"type": "data", "source": "cam_front", "seq": 4410, "t": 1791400000.290, "data": {"key": false, "w": 1280, "h": 720}, "bin": true}
<binary frame: one H.264 access unit>
```

| Field | Meaning |
|---|---|
| `source` | Source id |
| `seq` | Per-source sequence number |
| `t` | Capture time, device clock (MHS 3.5) |
| `data` | The payload, or for binary kinds its descriptive part |
| `bin` | `true` when a binary frame follows |
| `of_seq`, `lag` | Derived sources only: `of_seq` for those that declare `of` (section 4) |

- [STR-1] `seq` **MUST** increase by one for each message *produced* for a source within a connection. A device that drops a message under load skips its `seq`, so the receiver can count what was lost.
- [STR-2] `t` **MUST** not decrease within a source.
- [STR-3] When `bin` is `true`, the very next frame the device sends on the Nerve channel **MUST** be the binary payload.

## 6. Frames or video

A camera is declared either as frames or as an encoded video stream:

| Kind | What travels | Use when |
|---|---|---|
| `image` | One self-contained JPEG or PNG per message | Simple devices, low rates, depth and thermal images, stills |
| `video` | One encoded H.264 access unit per message | Live viewing, higher resolution or rate, constrained bandwidth |

- *Informative:* a 720p camera at 15 Hz needs roughly 1–2 Mbit/s as H.264, and 10–20 Mbit/s as JPEG frames.
- A camera is declared once, as one source. A hub that needs still images from a `video` source decodes them itself.
- Every hub **MUST** accept both kinds.

## 7. Video streams

Rules for `video` sources:

| Id | Requirement |
|---|---|
| [VID-1] | `codec` **MUST** be `h264` in this version. `h265` and `av1` are reserved for later versions. |
| [VID-2] | Each binary frame **MUST** hold exactly one access unit (one picture) in Annex B format, with start codes. |
| [VID-3] | Every keyframe (IDR) **MUST** carry `key: true` in its `data` and **MUST** include the sequence and picture parameter sets (SPS, PPS), so that a receiver can start decoding at any keyframe. |
| [VID-4] | Pictures **MUST** be sent in presentation order: no B-frames. Each message's `t` is that picture's capture time. |
| [VID-5] | The interval between keyframes **MUST NOT** exceed the declared `gop_s`, which **MUST NOT** exceed 2 s. |
| [VID-6] | On `mhs/keyframe`, the device **MUST** send a keyframe for each listed source within 1 s. |
| [VID-7] | After dropping any picture, the device **MUST NOT** send further non-key pictures of that source until it has sent a new keyframe. A receiver therefore never gets a picture it cannot decode. |

```json
→ {"jsonrpc": "2.0", "id": "f2", "method": "mhs/keyframe", "params": {"sources": ["cam_front"]}}
← {"jsonrpc": "2.0", "id": "f2", "result": {"sources": ["cam_front"]}}
```

- A hub requests a keyframe when a new viewer joins, or after it detects a gap in `seq`.
- Devices **SHOULD** encode for low latency: no lookahead, and a capture-to-send delay under 100 ms.

## 8. Rates and configure

The hub decides which sources it needs and how often, and tells the device.

```json
→ {"jsonrpc": "2.0", "id": "k4", "method": "mhs/configure", "params": {"sources": {
     "cam_front": {"on": true, "hz": 15, "bitrate_kbps": 1500},
     "lidar": {"on": true, "hz": 5},
     "people": {"on": false}}}}
← {"jsonrpc": "2.0", "id": "k4", "result": {"sources": {
     "cam_front": {"on": true, "hz": 15, "bitrate_kbps": 1500}, "lidar": {"on": true, "hz": 5}, "people": {"on": false}}}}
```

| Setting | Applies to | Meaning |
|---|---|---|
| `on` | all | Stream the source or not |
| `hz` | all but the event-driven kinds (3.1) | Target rate, at most the declared `hz` |
| `bitrate_kbps` | `video` | Bitrate ceiling within the declared range |
| `size` | `video`, `image`, if the source declares `sizes` | One of the declared resolutions |

- [STR-4] A device **MUST** apply `mhs/configure` and reply with what it actually applied. It uses the nearest value it supports. The applied `bitrate_kbps` is a ceiling: averaged over 10 s, a video source's bitrate **MUST NOT** exceed it by more than 50 %. A lower bitrate is fine, for example on a still scene, which compresses well.
- [STR-5] A device **MUST** stop sending a source configured `on: false`. A `switchable` source that is off **SHOULD** release its hardware (a microphone, a camera).
- Turning off a source that is not `switchable` is a request the device **MAY** decline; its reply shows the actual state.
- A source not mentioned keeps its setting.
- Before the first `mhs/configure`, a device streams every source at a low default: images at 1 Hz, video at its lowest declared bitrate and 5 Hz, everything else at its declared rate capped at 2 Hz, and the event-driven kinds as their events happen.
- *Informative:* hubs compute these settings from demand (who is viewing, recording or running a detector). A device does not need to know why.

## 9. Congestion and latency

- [STR-6] When the Nerve channel cannot keep up, a device **MUST** prefer dropping older stream data to queueing it. Use the latest-wins rule per source, and [VID-7] for video.
- [STR-7] Handling `manual` input **MUST NOT** be delayed by stream data. A device reads the channel and acts on manual input while frames are queued.
- Devices **SHOULD** keep capture-to-send delay under 100 ms for imaging sources and under 50 ms for other raw sources.
- Large binary payloads **SHOULD** be sized so that one message does not block the channel for more than 100 ms at the expected bandwidth. For example, lower the resolution rather than send 8 MB frames.

## 10. Time synchronization

```json
→ {"jsonrpc": "2.0", "id": "t3", "method": "mhs/time", "params": {}}
← {"jsonrpc": "2.0", "id": "t3", "result": {"t": 1791400000.251}}
```

- [TIME-2] A device **MUST** answer `mhs/time` with its current clock, the same clock used for `t`, within 0.5 s.
- The hub estimates the offset from the round trip and converts every `t` to its own clock. Sources from different devices can then be aligned in time.

## 11. Extensibility and security

- New kinds, units and video codecs are minor additions, as MHS section 13 describes. A hub meeting an unknown kind treats it like an `x_` kind. Custom kinds use `x_<name>`.
- The security considerations of MHS section 14 apply. Streams, including camera video and microphone audio, travel unencrypted unless `wss://` is used. Mark microphones and cameras in private spaces `switchable` and default them off.
- Fields with a body role (Appendix C) are personal health data of whoever wears the device. Hubs **SHOULD** show them only to the people operating the deployment and keep them no longer than needed.

## 12. Conformance

A device that implements MOS meets every **MUST** of the MOS profiles that apply to it, in addition to the MHS profiles.

| Profile | Applies when | Requirements |
|---|---|---|
| **Perception** | `sources` is not empty | CONN-4, MSG-4, MSG-5, PER-1, PER-2 (**SHOULD**) |
| **Maps** | `maps` or `placement` is declared, or a source has kind `pose` or `grid` | MAP-1, MAP-2, MAP-3 and MAP-4 (both **SHOULD**) |
| **Derived perception** | Any source has a derived kind | PER-3…6 |
| **Streaming** | `sources` is not empty | STR-1…7, TIME-1, TIME-2 |
| **Video** | Any source has kind `video` | VID-1…7 |
| **Audio clip** | Any tool has a `clip` parameter | CONN-4, STR-8 |

A device may claim, for example, "Agnes MHS 1.0: Core, Motion; Agnes MOS 1.0: Perception, Streaming, Video".

A hub that wants devices to rely on it **MUST** accept both `image` and `video` (section 6) and send `mhs/configure` according to demand (section 8).

---

## Appendix A. Message index

| Message | Channel | Direction | Type | Section |
|---|---|---|---|---|
| `hello` | Nerve | device → hub | — | 2.1 |
| `data` (+ binary) | Nerve | device → hub | — | 5 |
| `manual` | Nerve | hub → device | — | MHS 9 |
| `clip` (+ binary) | Nerve | hub → device | — | 2.3 |
| `mhs/configure` | command | hub → device | request | 8 |
| `mhs/keyframe` | command | hub → device | request | 7 |
| `mhs/time` | command | hub → device | request | 10 |

## Appendix B. Data kinds

In payloads, fields marked `?` are optional and all others are required. Declaration metadata is optional unless marked (required).

**Raw kinds**

| Kind | Binary | `data` payload | Declaration metadata |
|---|---|---|---|
| `image` | yes: JPEG or PNG (`mime`) | `{w, h}` | `encoding` (`rgb`, `mono`, `depth`, `thermal`, `ir`), `mime`, `size` [w, h], `sizes` (optional list), `fov_deg` [h, v], `range_m` for `depth` and `thermal`. Depth **SHOULD** be false-color (near blue, far red), or 16-bit PNG in millimeters with `"depth_units": "mm"` |
| `video` | yes: one H.264 access unit, Annex B | `{key, w, h}` | `codec` (`h264`, required), `encoding`, `size`, `sizes`, `fov_deg`, `bitrate_kbps` [min, max], `gop_s` (≤ 2, required), `profile` (`baseline`, `main` or `high`, informative) |
| `scan` | no | `{angle_min, angle_inc, ranges}`: degrees in the sensor frame, counter-clockwise; `ranges` in meters, `null` for no return | `range_m` [min, max] |
| `points` | yes: little-endian float32 records | `{n, fields}`: point count and record layout, for example `["x", "y", "z", "intensity"]`; meters in the sensor frame | `range_m` |
| `audio` | yes: little-endian signed 16-bit PCM, interleaved | `{rate, channels, speaking?}` | `rate`, `channels` (both required) |
| `imu` | no | `{accel: [x, y, z] m/s², gyro: [x, y, z] deg/s, rpy?: [roll, pitch, yaw] deg}` in the sensor frame | — |
| `odometry` | no | `{x, y, yaw, v, w}`: meters, degrees, m/s, deg/s, relative to where the device started | — |
| `gnss` | no | `{lat, lon, alt?, fix, acc_m}`, `fix` one of `none`, `2d`, `3d`, `rtk` | — |
| `values` | no | `{<field>: value, …}`, values of the declared field types | `fields` (required) |
| `switch` | no | `{<field>: boolean or string, …}`, on change and at least every 10 s | `fields` (required) |
| `text` | no | `{text}` | — |

**Derived kinds**

| Kind | Binary | `data` payload | Declaration metadata |
|---|---|---|---|
| `detections` | no | `{w, h, items: [{label, conf, box: [x1, y1, x2, y2], track?, bearing?, dist?}]}`: boxes in pixels of the `of` image; `track` an integer stable while the object stays in view; `bearing` in degrees left positive; `dist` in meters | `of` (an `image` or `video` source, required), `model` (required), `labels` (optional list of label names) |
| `pose` | no | `{map, x, y, yaw, ok, cov?}`: map id, map-frame pose, whether the fix is trusted (PER-6), optional 3×3 covariance of x, y, yaw | `of` (optional), `model` (required), `max_error_m` |
| `grid` | yes: 8-bit grayscale PNG | `{id, resolution, origin}`: the map id (section 3.5), meters per pixel, map-frame [x, y] of the bottom-left pixel. 255 free, 0 occupied, 128 unknown; the top row is the largest y | `model` (required) |
| `transcript` | no | `{text, final, start, end, lang?, speaking?}`: one utterance; `final: false` for partial results that will be replaced; `start`/`end` capture times | `of` (an `audio` source, required), `model` (required), `lang` |
| `world` | no | `{map, name?, bounds?, entities: [{device, x, y, yaw, ok, fixed?, zone?}], places?: [place]}`: one map as the hub knows it. `entities` are the devices on it now (`fixed` for installed devices, `zone` the id of the zone each is in); `places` follow section 3.5. Hub only | — |

**Custom kinds**

| Kind | Binary | `data` payload | Declaration metadata |
|---|---|---|---|
| `x_<name>` | either | any object | `fields` optional |

## Appendix C. Field roles

Roles for fields of `values` and `switch` sources (3.3) and of the device state (MHS 10.1). A role fixes the meaning and the unit; `of` names the part when a device has several.

| Group | Role | Unit | Meaning | Typical `of` |
|---|---|---|---|---|
| Power | `battery` | `%` | State of charge | `main`, `backup` |
| | `voltage` | `V` | Supply or battery voltage | |
| | `current` | `A` | Current drawn | `motor`, `main` |
| | `power` | `W` | Power drawn (positive) or produced (negative) | `solar` |
| | `charging` | boolean | Charging now | |
| Thermal | `temperature` | `°C` | Temperature of a part, or of the air with `of: "air"` | `motor`, `cpu`, `battery`, `air` |
| Compute | `cpu`, `memory`, `storage` | `%` | Load, memory in use, storage in use | |
| Link | `signal` | `dBm` or `%` | Signal strength of a radio link | `wifi`, `cellular`, `satellite` |
| Supplies | `consumable` | `%` or a declared unit | What is left of something used up | `oxygen`, `water`, `ink` |
| Body | `heart_rate` | `bpm` | Heart rate of the wearer | |
| | `body_temperature` | `°C` | Body temperature of the wearer | |
| | `spo2` | `%` | Blood oxygen saturation of the wearer | |
| | `x_<name>` | | Anything else | |

- A field with a role **SHOULD** use the role's unit. `consumable` declares its own (`%`, `min`, `kg`, …).
- Roles are about meaning only. Whether a value is a problem follows from the field's `alert`, which the device declares because only it knows its limits.
