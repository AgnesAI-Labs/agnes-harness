# Agnes MHS and MOS Conformance Suite

**For Agnes MHS 1.0 and Agnes MOS 1.0** (2026-10-08). Status: the schema, the log validator and `mhs-check` with every profile are built (`packages/mhs/python`).

The suite has two parts that let a device maker check an implementation against the [Agnes MHS specification](mhs-spec.md) without our hub or our devices:

1. **JSON Schemas** for every message and vocabulary, usable by any validator.
2. **`mhs-check`**, a test hub. The device connects to it like to a real hub; it runs scenarios and reports, for every requirement id in the specification, whether it passed.

## 1. JSON Schemas

### 1.1 Layout

All schemas use JSON Schema draft 2020-12 and live in one file, [`packages/mhs/schema/mhs-v1.json`](../schema/mhs-v1.json), with `$id` `https://agnes.ai/schema/mhs-v1.json`. `v1` is the protocol major version (`mhs/v1`, spec 15). Every message, part, kind payload and vocabulary is a named definition under `$defs`. To validate one message, reference its definition, for example `mhs-v1.json#/$defs/RegisterParams`.

```
$defs
  envelopes   JSON-RPC request / response / notification, string ids
  methods     the params and replies of every method: register (the device description, spec 5),
              call ({name, arguments, meta}; accepted | rejected + reason, detail, holder),
              progress, result, cancel, stop, pause, resume, state, set, ping, configure, keyframe, time
  nerve       hello, data, manual, clip
  parts       device, profile, source, field, tool, axis, manual, ui, mount, identifiers,
              and the meta-schema that allows only the parameter keywords of spec 6.2
  kinds       one source declaration and one data payload per kind in MOS Appendix B
  vocab       kinds, axis roles, field roles, reasons, statuses, units, encodings
```

The TypeScript types and runtime checks in `packages/mhs/gen/ts/` are generated from this file. `pnpm gen:check` fails when they drift from it.

### 1.2 Principles

- **One definition per message or part**, referenced with `$ref`, so a device maker can validate exactly what they send.
- **Strict where the spec is strict.** Required fields are required. Identifiers carry their patterns. Enumerations come from the vocabulary definitions, with the `x_` escape allowed by pattern.
- **Open where the spec is open.** `additionalProperties` is allowed everywhere, because receivers must ignore unknown fields (spec [MSG-6]). A separate *lint* mode in `mhs-check` warns about unknown fields that are not `x_`-prefixed, which catches typos.
- **Kind payloads are checked by kind.** The Nerve `data` definition checks the envelope. `mhs-check` then picks the data definition of the kind the source declared to check the payload. JSON Schema alone cannot express "look up the kind elsewhere".
- **Cross-field rules live in `mhs-check`**, not in schemas: unique ids, `uses` naming declared resources, `seq` continuity, `bin` pairing, timing.
- **Versioning.** Schemas are versioned with the protocol major version (`mhs-v1.json` for `mhs/v1`; a major version 2, `mhs/v2`, would get `mhs-v2.json` beside it). Minor additions only add optional properties and vocabulary entries.

### 1.3 Using them without the tool

- A device maker can validate a captured `register` message, or a log of messages, with any 2020-12 validator.
- The repository includes a small validator (`python -m agnes_mhs.validate`, in `packages/mhs/python/`, standard library plus `jsonschema`) that validates a JSON Lines log of messages and reports which schema each line failed.

## 2. `mhs-check`, the test hub

### 2.1 How it is used

```
python -m agnes_mhs.check [--port 8800] [--profile core,video] [--no-motion] [--interactive]
                          [--report out.json] [--replace-wait 30] [--check-version]
```

1. The operator points the device at `ws://<host>:8800` (spec 4.1).
2. The device connects. `mhs-check` reads the registration, works out which profiles apply (MHS 15.1, MOS 12) and runs their scenarios in this order: Core, Perception, Maps, Streaming, Video, Derived perception, Manual, Pause, Audio clip, Motion. Then come the scenarios that close the device's connections on purpose: Reconnect, with a motion call running (Motion's channel loss), and Replacement, or Version with `--check-version`. The device ends up stopped.
3. `--profile` runs only the listed profiles among those that apply: `core`, `motion`, `manual`, `pause`, `perception`, `maps`, `derived`, `streaming`, `video`, `clip`, comma-separated or repeated. Registration always runs; without `core`, its other scenarios and Replacement are left out.
4. `--no-motion` keeps the device still: no motion tool is called and no manual input is sent. Those scenarios count as *not run* (`skip`), never as passed.
5. Physical behavior is judged from the device's own odometry when it declares an `odometry` source, which `mhs-check` turns on at up to 10 Hz for it. Without odometry, `--interactive` makes `mhs-check` ask the operator at the physical checks, for example "Did arm-03 stop within 1 s when mhs-check dropped its command channel just now? [y/n]", and record the answer with the result (`operator`). Without `--interactive` those results are `manual`.
6. Decoding pictures needs PyAV, the `video` extra of the package (`agnes-mhs[video]`). Without it, the Keyframes scenario reports `skip` with the reason, and the other video and image checks look at the structure only.
7. At the end it prints a summary and writes a JSON report. The exit status is non-zero if any requirement of a profile that ran failed.

`mhs-check` is a plain hub implementation with no scheduling, no UI and no AI. It ships as a single Python package; the device side may be written in any language. A run takes one to two minutes, plus `--replace-wait`.

`packages/mhs/python/examples/` holds the smallest devices that pass: `sensor.py`, a simulated room sensor that passes Core, Perception and Streaming, and `camera.py`, a test pattern streamed as H.264 that passes Video.

### 2.2 Report

```json
{"device": "arm-03", "protocol": "mhs/v1", "profiles": ["core", "motion", "manual", "pause", "perception", "streaming", "video"],
 "motion": true, "started": "2026-10-07T10:00:00Z", "tool": "mhs-check 1.0.0",
 "results": [
   {"id": "CALL-2", "status": "pass", "evidence": "13 calls, slowest acceptance 41 ms"},
   {"id": "CTL-3", "status": "pass", "evidence": "stop during move_joint: zero-motion reported, call c7 interrupted/stop, reply 120 ms",
    "operator": "confirmed stop within 1 s"},
   {"id": "VID-7", "status": "fail", "evidence": "cam_wrist: seq 455 missing, then non-key picture 456 sent before a keyframe"},
   {"id": "SAFE-5", "status": "warn", "evidence": "no watchdog reported (SHOULD)"}]}
```

Statuses:

- `pass`, `fail`;
- `warn`: a **SHOULD** not met;
- `skip`: not run;
- `manual`: needs an operator and none was available.

Every requirement id of the profiles that ran appears once, with the worst status any scenario gave it and the evidence of up to three of those. `7.3` and `8.3` stand for the rules of those sections that carry no id.

### 2.3 Scenarios

Each scenario lists the requirement ids it checks. "Observe" means `mhs-check` watches what the device sends; "Act" means it sends something and checks the reaction.

**Core (every device)**

| Scenario | What it does | Checks |
|---|---|---|
| Registration | Validate `mhs/register` against the schemas; check ids, uniqueness, that `uses` names declared resources, and that a `fixed` device gives its `placement` | CONN-2, REG-1, REG-2, REG-4, TOOL-1, ID-1 (format) |
| Silence before reply | Delay the register reply 1 s; the device must send nothing but stop replies meanwhile | CONN-3 |
| Unknown fields | Send calls and control messages with extra fields | MSG-6 |
| Wrong arguments | For each tool: wrong types, missing required parameters, NaN (where JSON permits it via a string form, the device must reject); expect `rejected` / `invalid` | CALL-2, TOOL-2 |
| Clamping | For each numeric parameter with a range: send a value beyond the bound; expect acceptance and a `notes` entry | TOOL-2 |
| Acceptance time | Every call is answered within 2 s | CALL-2 |
| Ordering | For every call: acceptance first, then progress, then exactly one result, with no reuse of the id | CALL-5, CALL-4 |
| Busy | Two calls on the same `reject` resource; expect `busy` with `holder` | CALL-3 |
| Cancel | Cancel a running call, an unknown id, and the same call twice | CTL-1 |
| Stop anywhere | `mhs/stop` while idle, during each motion tool, and before the register reply; reply within 2 s, motion calls interrupted, non-motion calls continue | CTL-2, CTL-3, CTL-4, SAFE-1 |
| State | Right after the register reply, a full `mhs/state` with every declared field and `problem`, `faults`; values of the declared types. `mhs/set` on a writable field beyond its range is clamped, noted, and reported in `mhs/state` within 1 s; on a field that is not writable it is refused. With odometry, no motion within 2 s of `mhs/set` | STATE-1, STATE-2, STATE-3, STATE-4 |
| Reconnect | Close the command channel; the device reconnects, registers again, and has nothing running | CONN-6, CONN-7 |
| Replacement | Close with 4001; the device does not reconnect within 30 s | CONN-8 |
| Version | Answer register with -32001; the device does not loop faster than the back-off. Only with `--check-version`: a device may stop for good after a version refusal, which leaves Replacement untestable in the same run | CONN-6 |

**Motion (any tool with `motion: true`)**

| Scenario | What it does | Checks |
|---|---|---|
| Channel loss during motion | Start the motion tool with the longest timeout, then drop the command channel; on reconnect the call is not resumed. Odometry is at rest from 1 s after the drop; without odometry, the operator confirms | SAFE-2 |
| Unsafe | With `--interactive`, the operator says whether the device has a watchdog (no: `warn`, a SHOULD) and disables it; a motion call must be rejected `unsafe` | SAFE-5 |
| No spontaneous motion | Over the whole run, no motion outside a call (until 1.5 s after its result) or manual input (until `deadman_s` + 1.5 s after it). Observed through odometry when present; otherwise the operator confirms | SAFE-7 |
| Odometry in results | Mobile devices include `after.odometry` in every result; the profile runs one motion call to its end for it | 7.3 |
| Collision | No scenario: it needs an obstacle in the device's way. Reported `skip` | SAFE-6 |

**Perception (sources declared)**

| Scenario | What it does | Checks |
|---|---|---|
| Payloads | Every `data` message validates against its kind's schema; `values` and `switch` values have their fields' declared types | PER-1 |
| Geometry | Imaging sources declare `fov_deg` and `mount`; ranging sources declare `range_m` and `mount` | PER-2 (warn) |

**Maps (`maps` or `placement` declared, or a `pose` or `grid` source)**

| Scenario | What it does | Checks |
|---|---|---|
| Declaration | Each map validates; map ids are unique, place ids unique within their map, each place a landmark or a zone | MAP-1 |
| Map names | The `placement`, and `pose` and `grid` messages, name a map the device declares. Another connected device may declare it, so a map the device does not declare is a `warn` | MAP-3 (SHOULD) |
| Frames | Whether the device's maps use meters and degrees, and every device naming them means the same frame, takes the operator: with `--interactive` they answer, without it the result is `manual` | MAP-2 |
| Bounds | Places, the `placement` and `pose` positions lie within their map's `bounds`; one outside is a `warn` (meters? the right frame?) | MAP-4 (SHOULD) |

**Derived perception (a derived kind declared)**

| Scenario | What it does | Checks |
|---|---|---|
| Declaration | `of` names a declared source; `model` is present | PER-3 |
| Alignment | The derived sources that declare `of` and their inputs stream for a few seconds; each message's `of_seq` is a `seq` the input source actually sent (or skipped as dropped), and `t` equals that input's `t` | PER-4 |
| Values | Confidences are in [0, 1]; boxes lie within the input image; bearings within the camera's field of view | PER-5 |
| Lost fix | With `--interactive`, the operator makes the localizer lose its fix; the `pose` source sends `ok: false` within 5 s | PER-6 |

**Streaming (sources declared)**

| Scenario | What it does | Checks |
|---|---|---|
| Sequence and time | Per source, `seq` increases by one per produced message (gaps count as drops and are reported) and `t` never decreases; `t` within ±2 s of the hub clock after offset correction (a derived message's `lag` is not counted; data the hub itself held back during Congestion is left out) | STR-1, STR-2, TIME-1 |
| Binary pairing | Each `bin: true` is immediately followed by a binary frame, and no binary frame comes unannounced; a JPEG or PNG has its signature and decodes at the size its `data` states (every 20th); audio is whole samples; points match `n` | STR-3 |
| Configure | Set every source to half its rate (at most 10 Hz), then the full rate, then off; rates measured from `t` over 3 to 10 s within ±30 % of the applied rate the device reported (a source too slow to measure in that time counts by its reply); off means silence after 0.5 s, unless a source that is not `switchable` reports that it stays on | STR-4, STR-5 |
| Congestion | Stop reading the Nerve socket for 2 s (within the 3 s of CONN-5), then read again. Messages in the first second after reading resumes may be old, since socket buffers hold them; from 1 s after reading resumes, over the next second, every message of a source that was streaming when reading stopped is fresh (`t` within 0.5 s of its arrival). A motion call started while reading is stopped is interrupted by manual input within 1 s | STR-6, STR-7 |
| Time | Five `mhs/time` requests, each answered within 0.5 s; their median offset converts every `t` for TIME-1 | TIME-2 |

*Informative:* on a loopback link the Congestion scenario cannot tell a device that queues from one that drops; run it over a real network for a meaningful result.

**Video (a `video` source declared)**

| Scenario | What it does | Checks |
|---|---|---|
| Codec | Every binary frame is one H.264 access unit in Annex B; `codec` is `h264` | VID-1, VID-2 |
| Keyframes | Every `key: true` picture is an IDR, holds SPS and PPS and decodes on its own with a reference decoder (FFmpeg / PyAV); every IDR carries `key: true` | VID-3 |
| Order | No B slices; `t` increases | VID-4 |
| GOP | Streaming at up to 15 Hz for 3 `gop_s` + 1 s, the longest gap between keyframes stays within `gop_s` (≤ 2 s), give or take one frame | VID-5 |
| Keyframe request | `mhs/keyframe` produces a keyframe within 1 s | VID-6 |
| Drop discipline | Over the whole run, congestion included, after a gap in `seq` the next picture is a keyframe; the whole stream decodes without errors from the first keyframe of each connection | VID-7 |
| Bitrate | `configure` with the lowest and the highest declared `bitrate_kbps`; at each, the bitrate measured over 10 s **MUST NOT** exceed the applied value by more than 50 %. A lower bitrate passes and is reported, for example on a still scene | STR-4 |

**Manual (`manual` declared)**

| Scenario | What it does | Checks |
|---|---|---|
| Interrupt | Start a motion call, then send non-zero manual input (the `forward` axis, else `turn`, else the first, at half its maximum); the call ends `interrupted` / `manual` | MAN-3 |
| Busy while manual | A motion call during manual control is rejected `busy` with `holder: {"manual": true}` | MAN-3, CALL-3 |
| Deadman | Send input, then stop sending; odometry speed (if present) drops to zero within `deadman_s` + 0.5 s; otherwise the operator confirms | MAN-4 |
| Clamping | Send three times the axis maximum; the observed speed stays within the range (odometry `v` for a `forward` axis in m/s, `w` for a `turn` axis in deg/s) or the operator confirms | MAN-2 |
| Absent axes | Send the axis, then messages without it; with odometry, the device is at rest before the deadman would stop it | MAN-1 |
| Nerve lost | Close the Nerve channel while sending input; once the device has reconnected, odometry is at rest from `deadman_s` + 0.5 s after the close, or the operator confirms | SAFE-3 |
| Watchdog | `mhs-check` cannot see that the deadman survives a hung process (2.4); with `--interactive` the operator answers | MAN-5 |

**Pause (any `pausable` tool)**

| Scenario | What it does | Checks |
|---|---|---|
| Pause and resume | Pause, expect `paused: true` within 2 s, progress `state: "paused"` and, with odometry, rest; resume, expect `resumed: true` and progress `state: "running"`, then a result within the tool's `timeout` + 5 s of resuming: `done`, `interrupted` (a safety stop, for example) or `error` all pass; a call that stays paused or sends no result fails | CTL-5 |
| Stop while paused | Pause, then stop (a motion tool) or cancel; expect `interrupted` / `stop` or `cancel` | CTL-6 |
| Non-pausable | Pause a non-pausable call; expect `paused: false` | 8.3 |

**Audio clip (a tool with a `clip` parameter)**

| Scenario | What it does | Checks |
|---|---|---|
| Clip then call | Send a 2 s tone as a clip, then call the tool with its id; expect `done`, without a note of a fallback for that clip | STR-8 |
| Missing clip | Call with an unknown clip id; expect a fallback noted in `notes`, or `error` / `dependency` | STR-8 |

### 2.4 Limits of what it can prove

- **Physical behavior.** Did it really stop? Did it stay within speed? This can only be confirmed by an operator, or inferred from the device's own odometry. The report says which.
- **Independence of the watchdog.** `mhs-check` cannot verify that the watchdog is independent of the main process. It records the device's claim and the operator's confirmation.
- **Not a certification.** Passing shows the device follows the protocol under the tested conditions. It does not certify the device as safe.

## 3. How the suite is validated

- **Schemas.** `packages/mhs/test/schema-cases.json` holds every example of the specifications and the messages they forbid. Each is checked with ajv against the schema file and with the generated TypeScript checks, so a schema that rejects a valid example, or accepts a forbidden one, fails the tests.
- **`mhs-check` against itself.** Its tests in `packages/mhs/python/tests` run it against devices built on the Python device library, conforming ones and ones broken on purpose, and expect every requirement to pass or to fail as built.
- **Reference devices.** The example devices of the Python and TypeScript device libraries (`examples/sensor.py`, `examples/camera.py`, `device/example.ts`) and the sample devices of the development hub (`pnpm --filter @agnes/mhs dev-hub`) meet every **MUST** of the profiles that apply to them: no requirement fails.
- **Smallest examples.** `examples/sensor.py`, a simulated room sensor in about 100 lines of Python, passes Core, Perception and Streaming; `examples/camera.py`, a test pattern streamed as H.264, passes Video. A device maker can start from either.
