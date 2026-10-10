# AgnesHub API

AgnesHub is the hub of Agnes MHS. Devices connect to it from below with the [MHS](../spec/mhs-spec.md) and [MOS](../spec/mos-spec.md) standards. This document describes how Agnes connects to it from above: the brain, the workbench's device pages, and other agents.

**This is AgnesHub's own interface, not a standard.** It changes together with AgnesHub and Agnes. Devices never see it; a device needs to know nothing beyond MHS and MOS.

## Contents

1. Overview
2. Conventions
3. Sessions
4. Devices
5. State and settings
6. Health and position
7. Reading data
8. Calls
9. Cancel, stop, pause and resume
10. Manual control and source switches
11. Events
12. Waiting for something: watch
13. Who may do what
14. How demand reaches devices
15. The brain
16. Security
17. What comes later

Appendix A. Message index

---

## 1. Overview

```
  the brain · device pages · agents
        │  AgnesHub API: hub/* on one WebSocket /ws/hub (the brain calls the same operations in process)
     AgnesHub
        │  MHS and MOS: mhs/* on /ws/mhs, data on /ws/nerve
     devices
```

The same port serves the Devices panel as a page of its own at `/`, with its script and styles at `/dist/page.js` and `/dist/page.css`. The page opens `/ws/hub` on the host it was loaded from as a `ui` client, so a phone on the network can see devices, run tools and stop them without the Agnes workbench. Other paths get 404.

What AgnesHub does:

- **Toward devices**: accepts their connections, checks what they register, sends calls and control, validates and clamps arguments, enforces the timeouts, synchronizes clocks, and keeps each device's state and newest data.
- **Toward Agnes**: one table of all devices; their state, health and position; the maps they declare, with their places; data on demand; calls with arbitration (who holds what, who may interrupt whom); events; and waiting for conditions.
- **For safety**: every action of the brain passes through it. Stop always works; a person at the controls comes first; a device that drops off loses its jobs.

What it does not do:

- **No frames of its own.** Maps and their named places come from the devices that declare them (MOS 3.5): a robot's SLAM map, a site plan. AgnesHub keeps what they declare and puts the devices on it (section 4.4); deployments without any map work the same way.
- **No model.** Every rule here is deterministic. Judgment belongs to the brain.
- **AgnesHub is not a device.** It does not list itself among the devices.

## 2. Conventions

- Identifiers, units, frames and text follow MHS section 3. Angles are degrees.
- All times are Unix seconds **on AgnesHub's clock**. Device timestamps are converted with the clock synchronization of MOS section 10.
- Messages are JSON-RPC 2.0, one per WebSocket text frame, with string request ids. Receivers ignore fields they do not know.
- **Text for models.** Results, rejections, read results and events carry `text`: one or two plain English sentences written by AgnesHub for a language model, stating what happened and the current situation. Pages that show data to people may ignore it.

Errors use the JSON-RPC codes of MHS 3.2, plus:

| Code | Meaning |
|---|---|
| -32004 | Not allowed for this caller (section 13) |
| -32005 | Unknown device, source, job, subscription or watch |

## 3. Sessions

A client opens `ws://<hub>/ws/hub`. Its first message is `hub/hello`:

```json
→ {"jsonrpc": "2.0", "id": "1", "method": "hub/hello",
   "params": {"role": "ui", "client": {"name": "devices-panel", "version": "0.1"}}}
← {"jsonrpc": "2.0", "id": "1", "result": {
     "session": "a5", "caller": {"name": "web", "level": 1},
     "hub": {"name": "agnes-hub", "version": "0.1.0"}, "time": 1791400000.12}}
```

| `role` | Who | Level |
|---|---|---|
| `ui` | A page operated by a person | 1 |
| `agent` | An agent acting on its own | 2 |

- **No authentication.** The role is what the client says (section 16).
- The caller's name is `client.name`, except that every `ui` client is called `web`. Names appear in rejections ("held by drive_to j9 (web)") and events.
- **When a client disconnects**, the jobs it started run to completion and their results are kept for 10 minutes (`hub/job`). Manual control is the exception: it stops at once (section 10).
- Subscribed data never queues behind results or events: AgnesHub keeps only the newest item per subscription and drops older ones when the connection lags.

## 4. Devices

### 4.1 `hub/devices`

```json
→ {"jsonrpc": "2.0", "id": "2", "method": "hub/devices", "params": {}}
← {"jsonrpc": "2.0", "id": "2", "result": {"devices": [{
     "id": "robot-01", "kind": "robot", "name": "Robot", "model": "Example Mecanum", "mobile": true,
     "online": true, "available": true, "since": 1791399000.4,
     "profile": {"size_m": [0.5, 0.4, 0.3]}, "localization": "self",
     "resources": {"chassis": "reject", "speaker": "queue"},
     "state": {"fields": {"…": "…"}, "values": {"mode": "idle", "battery": 64, "problem": null, "faults": []},
               "updated": 1791399990.2, "alerts": {}},
     "busy": {"chassis": null, "speaker": null}, "jobs": [], "off": [],
     "health": {"level": "ok", "reasons": []},
     "position": {"trust": "trusted", "map": "office", "x": 12.4, "y": -3.1, "yaw": 40, "age": 0.3},
     "sources": ["…"], "tools": ["…"], "manual": {"…": "…"}, "ui": {"icon": "robot", "primary": "front_video"}}]}}
```

A device entry is the device's own description (MHS section 5) with what AgnesHub knows:

| Field | Meaning |
|---|---|
| `online` | The command channel is up |
| `available` | Both channels are up when the device needs Nerve (MHS 4.3); only then can its tools be called |
| `state` | The device's state (section 5): its declared `fields`, their `values`, when it last changed (`updated`), and the `alerts` of fields past their alert level |
| `busy` | For each declared resource, the job holding it, `{"manual": true}` while a person steers, or `null` |
| `jobs` | The device's jobs that have not ended: `job`, `tool`, `caller`, `state` (`running` or `paused`), `started`, `arguments`, the caller's `ref`, and the newest `progress` (`done`, `total`, `text`) |
| `off` | Sources switched off by hand (section 10) |
| `health`, `position` | AgnesHub's summaries (section 6). `position` is absent for devices with `localization: none` |
| `localization`, `placement`, `maps` | As the device registered them: how it knows where it is, where a fixed device is installed, the maps it declares (MOS 3.5) |

Devices that went offline stay listed with `online: false`, with their last state and data.

### 4.2 `hub/changed`

Sent to every client when a device comes or goes, registers again, or anything in its entry changes except `state` (section 5). Health and position are checked once a second; a position counts as changed when it moved 0.2 m or turned 5°:

```json
← {"jsonrpc": "2.0", "method": "hub/changed", "params": {"devices": [{"id": "robot-01", "…": "…"}], "removed": []}}
```

`devices` holds the complete entries that changed; `removed`, the ids of devices an operator removed.

### 4.3 `hub/traffic`

Once a second, when anything moved, every client gets how many messages each device exchanged in that second, for drawing the traffic:

```json
← {"jsonrpc": "2.0", "method": "hub/traffic", "params": {"time": 1791400001.0, "devices": {
     "robot-01": {"mhs_up": 3, "mhs_down": 1, "nerve_up": 42, "nerve_down": 10, "bytes_up": 612400}}}}
```

- `mhs_up`: state changes, progress and results from the device; `mhs_down`: calls and control sent to it (MHS).
- `nerve_up`: data items from the device, with their size in `bytes_up`; `nerve_down`: manual input to it (MOS).

### 4.4 Maps and `hub/world`

Devices describe the maps they know in their registration (`maps`, MOS 3.5). AgnesHub keeps every map it has seen:

- The latest declaration of a map gives its frame fields (`name`, `bounds`, `anchor`); places merge by id, the latest declaration of each place winning.
- Maps stay after their devices disconnect. The plugin keeps them in `maps.json` in its data directory (`AGNES_HUB_DATA`), so they survive a restart of the hub; the development hubs (`pnpm dev`, `pnpm dev-hub`) keep them in memory only.
- AgnesHub does not edit maps or add places of its own.

**`hub/world`** returns one `world` (MOS Appendix B) per map: the declared maps first, then maps that a device's position names without any declaration:

```json
→ {"jsonrpc": "2.0", "id": "3", "method": "hub/world", "params": {}}
← {"jsonrpc": "2.0", "id": "3", "result": {"worlds": [{
     "map": "site", "name": "Site", "bounds": [0, 0, 20, 10],
     "entities": [
       {"device": "gate-01", "x": 2, "y": 3, "yaw": 90, "ok": true, "fixed": true, "zone": "yard"},
       {"device": "robot-01", "x": 12.4, "y": 3.1, "yaw": 40, "ok": true}],
     "places": [
       {"id": "gate", "name": "Gate", "at": [1, 3], "yaw": 180, "description": "The way in"},
       {"id": "yard", "name": "Yard", "points": [[0, 0], [10, 0], [10, 10], [0, 10]]}]}]}}
```

- `entities` are the devices whose `position` (section 6.2) is on the map, offline ones with their last known position: `ok` is whether the position is `trusted`, `fixed` marks installed devices, `zone` is the zone the device is in.
- When a registration changes the maps, every client gets the same result as a notification, `hub/world` with `{worlds}`. Positions change far more often; they arrive with `hub/changed`.

## 5. State and settings

State is the device's dictionary of current values (MHS 10.1). AgnesHub keeps it, so reading it never disturbs the device.

- **`hub/state`**, a notification to every client whenever a device reports a change, with the changed fields only:

  ```json
  ← {"jsonrpc": "2.0", "method": "hub/state", "params": {"device": "robot-01", "time": 1791400001.0, "values": {"mode": "driving"}}}
  ```

- **`hub/set`** changes writable fields (levels 1 and 2):

  ```json
  → {"jsonrpc": "2.0", "id": "5", "method": "hub/set", "params": {"device": "lamp-01", "values": {"brightness": 40}}}
  ← {"jsonrpc": "2.0", "id": "5", "result": {"values": {"brightness": 40}, "notes": [], "refused": {},
       "text": "lamp-01: brightness 40."}}
  ```

  AgnesHub refuses unknown, read-only and mistyped fields itself (`refused`, one reason each) and passes the rest to the device as `mhs/set`, which clamps them.

## 6. Health and position

The brain should not need to learn every device's field names to know whether it is well and where it is. AgnesHub summarizes both from what devices declare, and from what it observes itself.

### 6.1 Health

`health` is `{level, reasons}`. `level` is `ok`, `attention` or `bad`; `reasons` are short sentences, worst first.

| What | `attention` | `bad` |
|---|---|---|
| A state or `values` field with an `alert` | past `warn` | past `bad` |
| The device's own `problem` and `faults` | `problem` set, or any fault | — |
| A source someone is using (section 14) | under half its requested rate for 5 s; newest item older than three periods; more than 20 % of `seq` lost over 10 s | no item for 10 s |
| The connection | round trip over 1 s | not available |

- Field reasons name the field by its role when it has one (MOS 3.3): "motor temperature 72 °C (warn 70)". A field without a role is reported by its name.
- A change of `level` is an event (section 11).

### 6.2 Position

For devices that localize (`localization: self`), from their `pose` source (MOS 4):

| `trust` | When |
|---|---|
| `trusted` | `ok: true`, no older than the larger of 2 s and three periods, and within `max_error_m` when the source declares it and the pose carries `cov` |
| `uncertain` | `ok: false`; an error over `max_error_m`; or a jump of more than 1 m that the device's `odometry` does not show |
| `lost` | No pose for 10 s, or the device not available. `x`, `y`, `yaw` are the last known, with their `age` |

```json
"position": {"trust": "trusted", "map": "office", "x": 12.4, "y": -3.1, "yaw": 40, "age": 0.3, "zone": "lab"}
```

- `position` is `{trust, map, x, y, yaw, age}`, plus `reason` when not `trusted`, and `zone` when the position lies in a zone of a map AgnesHub knows (section 4.4): the id of that zone, the smallest one where zones nest.
- Texts for a model (`text` in section 7.1, the brain's snapshot in section 15.2) name the zone by its name and then its id, `in zone Yard (yard)`, or by its id alone when its name is the id.
- **Fixed devices** (`localization: fixed`, MHS 5.2): `position` is the device's `placement`, always `trusted`, with `fixed: true` and no `age`, online or not: `{"trust": "trusted", "map": "site", "x": 2, "y": 3, "yaw": 90, "fixed": true, "zone": "yard"}`.
- A device with `localization: external` has `position` only if something else places it; otherwise `trust` is `lost` with `reason: "not placed"`.
- AgnesHub keeps `pose` sources on at a low rate so that `position` is always current (section 14).
- A change of `trust` is an event (section 11).

## 7. Reading data

### 7.1 `hub/read`

Reads a device. **Without `sources`, it returns state, health and position only**, which is what a model needs most of the time:

```json
→ {"jsonrpc": "2.0", "id": "7", "method": "hub/read", "params": {"device": "robot-01"}}
← {"jsonrpc": "2.0", "id": "7", "result": {
     "state": {"…": "…"}, "health": {"level": "attention", "reasons": ["motor temperature 72 °C (warn 70)"]},
     "position": {"trust": "uncertain", "map": "office", "x": 12.4, "y": -3.1, "yaw": 40, "age": 0.3,
                  "reason": "position error 1.5 m, over 0.5 m"},
     "items": [],
     "text": "robot-01 is idle. Attention: motor temperature 72 °C (warn 70). Position uncertain: (12.4, -3.1) facing 40°, error 1.5 m. Battery 64 %."}}
```

With sources, it adds their newest items:

| Parameter | Meaning |
|---|---|
| `device` | Device id |
| `sources` | Source ids to read |
| `kinds` | Instead of `sources`: every source of these kinds |
| `since` | Optional time. Only data newer than this, waiting up to 2 s: for example the picture after a move, using a result's `time` |
| `history` | Optional `true`: `values` sources also return the last 2 minutes, one sample per second, as `history: [{time, data}]` |

```json
     "items": [
       {"source": "front", "kind": "image", "seq": 812, "time": 1791400000.1, "age": 0.4,
        "mime": "image/jpeg", "b64": "…", "data": {"w": 1280, "h": 720}, "text": "robot-01 front: picture 1280x720, 0.4 s old"},
       {"source": "objects", "kind": "detections", "seq": 812, "time": 1791400000.1, "age": 0.4,
        "data": {"w": 1280, "h": 720, "items": ["…"]}, "text": "robot-01 objects: box 0.9 (2.1 m, 5° left)"}]
```

- Every item has `source`, `kind`, `seq`, `time`, `age` and `text`. Binary kinds carry `mime` and `b64`, plus `data` with their descriptive part; others carry `data` in the kind's format (MOS Appendix B).
- **Video is for watching, images are for reading.** A model takes pictures, not H.264, and AgnesHub decodes no video. Reading a `video` source gives an `error` saying so. A device whose camera the brain should see also declares a low-rate `image` source of the same camera; it costs nothing while nobody reads it.
- An item that cannot be read (source off, nothing yet, `since` timed out) has `error`, one sentence, instead of data.
- Reading a source that is off turns it on briefly (section 14) and waits up to 2 s for an item.

### 7.2 `hub/subscribe`

```json
→ {"jsonrpc": "2.0", "id": "9", "method": "hub/subscribe",
   "params": {"device": "robot-01", "sources": ["front_video", "lidar"], "hz": 15, "binary": true}}
← {"jsonrpc": "2.0", "id": "9", "result": {"sub": "s3"}}
← {"jsonrpc": "2.0", "method": "hub/data", "params": {"sub": "s3", "device": "robot-01", "item": {"source": "lidar", "…": "…"}}}
→ {"jsonrpc": "2.0", "id": "10", "method": "hub/unsubscribe", "params": {"sub": "s3"}}
```

- `hz`: at most this many items per second per source; without it, every item.
- **Newest only.** When the connection lags, older items are dropped, never queued.
- **A subscription is demand**: AgnesHub turns the source on and raises its rate (section 14).
- **Binary.** With `binary: true`, binary kinds come as an item with `bin: true` followed at once by one binary frame (a JPEG, PNG, H.264 access unit or PCM block) instead of `b64`. Video arrives as the device sent it; a new subscription starts at a keyframe.
- A subscription ends with `hub/unsubscribe` or when the connection closes.

## 8. Calls

### 8.1 `hub/call`

```json
→ {"jsonrpc": "2.0", "id": "12", "method": "hub/call",
   "params": {"device": "robot-01", "tool": "drive_to", "arguments": {"place": "dock"}}}
← {"jsonrpc": "2.0", "id": "12", "result": {"accepted": true, "job": "j12"}}
← {"jsonrpc": "2.0", "method": "hub/progress", "params": {"job": "j12", "done": 0.3, "total": 1, "text": "driving to the dock"}}
← {"jsonrpc": "2.0", "method": "hub/result", "params": {
     "job": "j12", "device": "robot-01", "tool": "drive_to", "status": "done",
     "detail": "docked", "notes": [], "time": 1791400003.2,
     "after": {"pose": {"map": "office", "x": -1.5, "y": 3.5, "yaw": 320, "ok": true}},
     "text": "robot-01 docked. Now at (-1.5, 3.5) facing 320 degrees."}}
```

- A **job** is one call through AgnesHub; `job` is AgnesHub's id, the device sees its own call id.
- **Order** follows MHS 7.4: the reply first; for an accepted job, any progress, then exactly one result; nothing after a rejection.
- **Arguments** are validated and clamped before the device sees them (MHS 6.4); `notes` say what changed.
- **The result goes to the connection that made the call.** Others see jobs through the device's `jobs` and `busy`, and the `job` event; the device entry changes with each progress report.
- `ref` (optional) is the caller's own reference for the call. AgnesHub keeps it on the job and in its `job` events; the brain sets it to its tool call id, so a page can show which conversation step a job belongs to.
- A job may run for minutes; AgnesHub's limit is the tool's `timeout` (MHS section 11). `time` is when it ended, usable as `since` in `hub/read`.

A rejection:

```json
← {"jsonrpc": "2.0", "id": "13", "result": {"accepted": false, "status": "rejected", "reason": "busy",
     "detail": "chassis held by drive_to j12 (web)", "holder": {"job": "j12", "tool": "drive_to", "caller": "web"},
     "text": "robot-01 is busy driving to the dock, started from the web page; try later or stop it first."}}
```

Besides the reasons of MHS 10.2, AgnesHub rejects with `offline` (the device is not available), `denied` (the caller may not use the tool), and `busy` with `holder: {"manual": true}` while a person steers.

### 8.2 Pausing, and `hub/job`

A paused job reports it as progress and keeps its resources:

```json
← {"jsonrpc": "2.0", "method": "hub/progress", "params": {"job": "j12", "state": "paused", "by": "web", "reason": "a person in the way"}}
```

`hub/job {"job": "j12"}` returns a job's device, tool, caller, state, and its result once it ended. Results are kept for 10 minutes.

## 9. Cancel, stop, pause and resume

| Request | Params | Result | Rule |
|---|---|---|---|
| `hub/cancel` | `job` | `{cancelled}` | Ends one job, whoever started it. Its result follows as usual |
| `hub/stop` | `device`, or nothing for every device | `{stopped: [jobs]}` | Stops every motion job, and speech. Always accepted, from anyone |
| `hub/pause` | `job` | `{paused}` | Only tools declared `pausable` (MHS 8.3). A job paused for 60 s is cancelled (`interrupted` / `pause_timeout`) |
| `hub/resume` | `job` | `{resumed}` | Levels 1 and 2 only |

## 10. Manual control and source switches

**`hub/manual`** (level 1), a notification:

```json
→ {"jsonrpc": "2.0", "method": "hub/manual", "params": {"device": "robot-01", "axes": {"vx": 0.4, "wz": 0}}}
```

- `axes` uses the axes the device declared (MHS section 9); absent axes are zero. Pages send it at the device's `rate_hz` while a person holds a control, and one all-zero message on release.
- AgnesHub clamps every axis and forwards it on Nerve. Non-zero input interrupts the device's motion jobs (`interrupted` / `manual`).
- When the connection sending manual input closes, AgnesHub sends all-zero input at once; the device's deadman stops it in any case.

**`hub/configure`** (level 1) turns `switchable` sources on or off by hand, for privacy or power:

```json
→ {"jsonrpc": "2.0", "id": "15", "method": "hub/configure", "params": {"device": "cam-pad", "sources": {"mic": {"on": false}}}}
← {"jsonrpc": "2.0", "id": "15", "result": {"sources": {"mic": {"on": false}}}}
```

A source switched off by hand stays off whatever the demand. Rates are not set here; they follow demand (section 14).

## 11. Events

```json
→ {"jsonrpc": "2.0", "id": "30", "method": "hub/subscribe", "params": {"events": ["health", "position", "alert"], "since": "e80"}}
← {"jsonrpc": "2.0", "id": "30", "result": {"sub": "s4"}}
← {"jsonrpc": "2.0", "method": "hub/event", "params": {"sub": "s4", "event": {
     "id": "e88", "time": 1791400000.5, "device": "robot-01", "type": "alert", "level": "warning",
     "text": "robot-01: battery 9 %, under 10",
     "data": {"field": "battery", "role": "battery", "value": 9, "alert": "bad"}}}}
```

- Events are **never dropped** and arrive in order. AgnesHub keeps the last 10 minutes; `since` (an event id) delivers the missed ones first.
- `events` lists the types to receive, or is `true` for every type. `device` limits a subscription to one device. `level` is `info`, `warning` or `critical`.

| Type | When | `data` |
|---|---|---|
| `online`, `offline` | A device becomes available, or stops being available | `reason` |
| `job` | A job starts or ends | `job`, `tool`, `caller`, `state`, `ref` when the caller gave one, and the outcome when it ended |
| `manual` | A person takes over | `by`, the interrupted `job` |
| `estop` | A device's own safety stop ended a job (`interrupted` / `estop`) | `job`, `detail` |
| `alert` | A state or `values` field crosses its alert level, or comes back | `field`, `role`, `of`, `value`, `alert`: `warn`, `bad` or `ok` |
| `health` | A device's health level changes | `level`, `reasons` |
| `position` | A device's position trust changes | `trust`, `reason` |
| `paused`, `resumed` | A job is paused or resumed | `job`, `by`, `reason` |
| `watch` | A watch matched or timed out; to its owner only (section 12) | `watch`, `matched`, `item` |

Devices never send events. AgnesHub derives them from results, state and data.

## 12. Waiting for something: watch

The brain thinks every few seconds at best and cannot stare at data; it can say what it is waiting for. AgnesHub compares each change with the condition and sends a `watch` event when it holds.

```json
→ {"jsonrpc": "2.0", "id": "50", "method": "hub/watch", "params": {
     "device": "robot-01", "until": {"state": "mode", "eq": "docked"},
     "timeout": 300, "note": "wait for the robot to dock before cleaning starts"}}
← {"jsonrpc": "2.0", "id": "50", "result": {"watch": "w3"}}
→ {"jsonrpc": "2.0", "id": "51", "method": "hub/unwatch", "params": {"watch": "w3"}}
```

| `until` | Holds when |
|---|---|
| `{"state": "battery", "lt": 20}`; also `gt`, `eq`, `ne` | the state field compares true |
| `{"source": "air", "field": "co2", "gt": 1000}` | a field of a `values` or `switch` source compares true |
| `{"source": "objects", "has": "person", "min_conf": 0.5}` | a `detections` item with this label appears (`min_conf` defaults to 0.5) |
| `{"source": "radio", "says": "ready"}` | a final `transcript` utterance contains these words |
| `{"health": "bad"}`, `{"trust": "lost"}` | the device's health level or position trust becomes this |

- **Comparisons only.** A watch runs no model. A condition that needs understanding needs a source that states it.
- **One-shot**, and **only new data counts**: a condition that already holds when the watch is set matches on the next change that satisfies it.
- `timeout` in seconds, default 600, at most 3600; on timeout the event has `matched: false`.
- `note` is the caller's own sentence, repeated in the event's `text`, so the brain remembers why it waited.
- A watch belongs to its caller and ends with its connection; at most 20 per caller. The brain owns its watches per conversation, and a matching watch wakes that conversation.

## 13. Who may do what

AgnesHub accounts by **caller**: each connection is one caller, named and levelled by its hello.

| Level | Who | Rule |
|---|---|---|
| 0, stop | anyone's `hub/stop` | always accepted |
| 1, people | `ui` clients | interrupt jobs of level 2 on the same resources (`interrupted` / `manual`); while a person steers and for 3 s after, motion calls of level 2 are rejected (`busy`, `holder: {"manual": true}`) |
| 2, agents | `agent` clients and the brain | a held resource means `busy`, naming the holder; no preemption. To take over, `stop` or `cancel` first |

- Resources are those the device declares (MHS 6.3), so a device can talk while it moves.
- AgnesHub may hide tools from a level by configuration (`denied`). By default every tool is visible to every level.

## 14. How demand reaches devices

AgnesHub keeps one demand per source and turns it into `mhs/configure` (MOS section 8) when it changes:

| Demand | Rate |
|---|---|
| A subscription | its `hz` |
| A watch on the source | the source's declared rate |
| A `hub/read` | the source's declared rate, for 10 s |
| `pose` sources, for `position` | 1 Hz |

The highest demand wins; no demand turns the source off. Sources switched off by hand stay off.

## 15. The brain

The brain runs in the same process as AgnesHub and calls its operations as functions, with the rights of an agent. AgnesHub's data is live; the brain is not: it thinks every few seconds and every step costs tokens. So live data (subscriptions) goes to pages only, and the brain gets a text snapshot at four moments, each decided by a fixed rule:

| When | Who decides | What the brain gets |
|---|---|---|
| It reads (`read_device`) | the brain | each item's `text`, with a picture for image sources |
| A tool returns | the job ended, or 50 s passed | the result's `text`, which ends with the result's `data` as JSON (up to 2000 characters); otherwise `running` with the job id |
| A turn starts (the `context` hook) | Agnes | a snapshot of the maps and every device, at most 6000 bytes |
| It is woken | an event, see below | a few sentences: which device, what happened, the job or watch concerned |

How much the brain sees depends on how much happens, not on how fast the data is.

### 15.1 Tools

Seven fixed tools, named verb + `device`. A device's own tools are not registered as brain tools: they are an argument of `call_device`, so no device tool name can clash with Agnes's own tools, and the tool list does not change when devices come and go.

| Tool | Parameters | Does | Operation |
|---|---|---|---|
| `list_devices` | — | Every device: id, name, kind, available, health, what it is doing, its tools and sources | `hub/devices` |
| `read_device` | `device`, `sources` (optional) | State, health and position; with `sources`, their newest data, pictures as attachments | `hub/read` |
| `call_device` | `device`, `tool`, `args` | Calls a tool and waits up to 50 s. A job still running then returns `running` and its job id; its result arrives by waking the conversation | `hub/call` |
| `set_device` | `device`, `values` | Changes writable state | `hub/set` |
| `stop_device` | `device` (optional) | Stops one device, or every device | `hub/stop` |
| `watch_device`, `unwatch_device` | as in section 12 | Waits for a condition; the watch belongs to the conversation that set it | `hub/watch`, `hub/unwatch` |

- **Which device.** `device` is required except in `list_devices` and `stop_device`, and may be left out only while a single device is online. There is no default device.
- **Names come from the devices.** The brain calls devices by the `name` and `kind` they report; nothing in AgnesHub maps nicknames to devices. When a request could mean more than one device, the brain asks the user.

### 15.2 The `context` hook

At the start of every turn, Agnes adds a snapshot from AgnesHub's memory:

- **Maps first** (section 4.4): each map's id, name and extent, and its places, a landmark as its point and facing, a zone as its centre and size, each with its description. The snapshot says how to use them: to send a device to a place, call the device's own tool with the place's coordinates. The maps take at most half of the snapshot; places that do not fit are counted.
- **Then the devices**: for each its id, name, kind, whether it is available, its health and position summaries (with the map it is on and the zone it is in, by the zone's name and id), what it is doing, and its tools.

```
Maps (x, y in metres, yaw in degrees counter-clockwise from +x). … To send a device to a place, call its own tool with the place's coordinates …
- site "Site", x 0..20, y 0..10:
  - gate "Gate": landmark at (1, 3), face 180° — The way in
  - yard "Yard": zone around (5, 5), 10 × 10 m
Devices:
- gate-01 (Gate camera, sensor): available; Installed at (2, 3) facing 90° on map site, in zone Yard (yard)
```

It takes well under a millisecond and is capped at 6000 bytes, since Agnes shares 8 KB of hook context among all plugins. The hook never throws: a failing context hook would fail the model request.

### 15.3 Waking the brain

| Event | Wakes when |
|---|---|
| `job` ended | a job the brain started, whose `call_device` already returned `running`: done, failed or interrupted. A result the tool is still waiting for comes back from the tool instead |
| `paused` | a job the brain started is paused |
| `manual` | a person takes over a job the brain started |
| `estop` | a device's safety stop ended a job the brain started |
| `watch` | a watch the brain set matched or timed out |

- **Where to.** The conversation that started the job or set the watch.
- **How.** Through the Agnes daemon's local socket: a one-shot job (`_agnes/v1/jobs.enqueue`, delivery `steer`) that is steered into the turn when the brain is running, or starts a new turn when it is idle. Plugins have no in-process way to post into a session.
- **No approval prompts.** The device tools ask for no approval and do not mark their results as open-world, which would bring approval back for the rest of the turn.
- **Pictures.** `read_device` declares `returnsImages` in its tool metadata. Agnes sends a tool's pictures to the model only when the tool declares this and its result is closed-world, as every device tool's is.
- **Merged.** Events for one conversation within 1 s are sent as one message.
- Device events are not written into the conversation record; pages get them from `/ws/hub`, the brain through the hook and the wake-ups.

## 16. Security

The AgnesHub API has **no authentication and no encryption**. Any client can claim any role, including `ui`, which can steer devices by hand.

- AgnesHub listens on `127.0.0.1` unless configured otherwise (`AGNES_HUB_LISTEN`). Listening on a network address is an explicit choice, for a trusted network only.
- Use `wss://` through a reverse proxy on shared networks. Never expose AgnesHub to the internet.
- Device safety does not rely on AgnesHub: the device-side requirements of MHS section 12 hold whatever any client sends.
- Fields with a body role (MOS Appendix C) are personal health data. AgnesHub shows them to the deployment's own pages and brain only, and keeps no history of them beyond the 2 minutes of `history`.

## 17. What comes later

When a deployment needs them:

- **Levels** (section 13). Until they are enforced, every caller may do everything; resources the device declares still decide who is `busy`.
- **Places by hand**: places a person draws on a map, kept by AgnesHub alongside the declared ones, and tools built on places (go to a zone, face a device).
- **Perception by AgnesHub**: computing derived sources such as detections from video with a GPU model, and decoding video into stills.
- **User input**: messages typed to devices, and speech heard by their microphones, with push-to-talk.
- **Composite tools**, such as speaking with AgnesHub's own speech synthesis.
- **Reflexes**: fast deterministic rules that pause jobs, for example when a person is detected in a device's path.
- **An MCP gateway**, offering the devices to MCP clients.

## Appendix A. Message index

| Message | Direction | Type | Section |
|---|---|---|---|
| `hub/hello` | client → hub | request | 3 |
| `hub/devices` | client → hub | request | 4.1 |
| `hub/changed` | hub → client | notification | 4.2 |
| `hub/traffic` | hub → client | notification | 4.3 |
| `hub/world` | client → hub, hub → client | request, notification | 4.4 |
| `hub/state` | hub → client | notification | 5 |
| `hub/set` | client → hub | request | 5 |
| `hub/read` | client → hub | request | 7.1 |
| `hub/subscribe`, `hub/unsubscribe` | client → hub | request | 7.2, 11 |
| `hub/data` | hub → client | notification | 7.2 |
| `hub/call` | client → hub | request | 8.1 |
| `hub/progress`, `hub/result` | hub → client | notification | 8 |
| `hub/job` | client → hub | request | 8.2 |
| `hub/cancel`, `hub/stop`, `hub/pause`, `hub/resume` | client → hub | request | 9 |
| `hub/manual` | client → hub | notification | 10 |
| `hub/configure` | client → hub | request | 10 |
| `hub/event` | hub → client | notification | 11 |
| `hub/watch`, `hub/unwatch` | client → hub | request | 12 |
