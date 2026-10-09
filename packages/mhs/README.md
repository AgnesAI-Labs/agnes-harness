# Agnes MHS

Agnes MHS (Model Hardware Standard) is how physical devices — robots, vehicles, sensors — connect to Agnes. A device dials the hub, registers the tools and data sources it has, then takes calls and streams data. The model never talks to a device directly; it acts through the hub. Agnes MHS is independent of Anthropic's standard of the same name.

Status: MHS 1.0 and MOS 1.0. Everything here runs from the source repository.

The [MHS guide](../../docs/guide/mhs.md) walks through trying devices without hardware, writing and checking a device, and using devices from Agnes. [Write a device](../../docs/guide/mhs-device.md) shows how to write one with the Python or TypeScript library.

| Path | What |
|---|---|
| [spec/mhs-spec.md](spec/mhs-spec.md) | MHS, the Model Hardware Standard: what a device is, what state it is in, what it can do, and how it is stopped |
| [spec/mos-spec.md](spec/mos-spec.md) | MOS, the Model Observation Standard: what a device observes and how it streams it live, and the maps and places positions refer to |
| [spec/mhs-conformance.md](spec/mhs-conformance.md) | The JSON Schema and the `mhs-check` test hub, which runs every profile that applies to a device (Core, Motion, Manual, Pause, Perception, Maps, Derived perception, Streaming, Video, Audio clip) |
| [schema/mhs-v1.json](schema/mhs-v1.json) | JSON Schema (2020-12) for every message, part, kind and vocabulary of `mhs/v1` |
| `gen/ts/mhs-v1.ts` | TypeScript types and TypeBox checks generated from the schema: `pnpm --filter @agnes/protocol gen`; `gen:check` fails on drift |
| [test/schema-cases.json](test/schema-cases.json) | The spec's examples and forbidden messages, checked with ajv and with the generated checks |
| [server/](server/) | AgnesHub as plain Node modules. `South` accepts devices on `/ws/mhs` and `/ws/nerve`, validates and forwards calls and control, receives data, and enforces the timeouts. `North` serves the AgnesHub API on `/ws/hub`: sessions, devices, state, reading, data subscriptions, calls, jobs, control, settings, health and position, events and watches, and the maps devices declare with their places (`hub/world`; a fixed device's position is its placement, and every position names the zone it is in). `Brain` gives the brain its device tools, its per-turn snapshot and its wake-ups |
| [server/hub-api.md](server/hub-api.md) | The AgnesHub API: how the brain, device pages and agents use devices through the hub (AgnesHub's own interface, not a standard) |
| [plugin/](plugin/) | AgnesHub as an Agnes plugin, **optional**: Agnes runs without it. While enabled, AgnesHub listens on `AGNES_HUB_LISTEN` (default `127.0.0.1:4180`), the brain gets seven device tools, and the Devices panel docks to the workbench. See [Use devices from Agnes](#use-devices-from-agnes) |
| [device/](device/) | `Device` in TypeScript for browsers and Node (`@agnes/mhs/device`), the counterpart of the Python `Device`; `device/example.ts` is a small desk lamp that passes `mhs-check` (Core, Motion, Manual, Pause, Perception, Streaming) |
| [python/](python/) | `agnes_mhs`, the device library (internal for now). `Device` declares tools, sources, maps and manual control and speaks the protocol: registration, reconnecting, argument checks, resources, cancel, stop, pause, the deadman, status, configure. `is_valid` / `errors` check values against the schema, `python -m agnes_mhs.validate log.jsonl` checks a recorded session, and `python -m agnes_mhs.check` is the test hub. `examples/sensor.py` (a room sensor: Core, Perception, Streaming) and `examples/camera.py` (a test pattern as H.264: Video) are the smallest devices that pass it |
| [tools/](tools/) | `dev-hub.ts`, a development AgnesHub with sample devices and the Devices page; `build-plugin.ts` and `install-plugin.ts`; `panel-smoke.mjs` and `panel-shots.mjs`, which drive the Devices page in headless Chrome |

## Try it without hardware

```sh
pnpm --filter @agnes/mhs build:plugin
pnpm --filter @agnes/mhs dev-hub
```

`dev-hub` is the real AgnesHub with four sample devices built on the device library, and the Devices panel as a page of its own: open `http://127.0.0.1:4191/` (add `?lang=zh-CN`, `?theme=light` or `?device=robot-01`; a port after `dev-hub` changes 4191). `robot-01` is a mobile robot with a camera, a map of its office and manual drive, `lamp-01` a lamp with writable state, `env-01` a room sensor installed in the office, and `arm-01` an arm with a switchable microphone. Typing `health robot-01 hot` or `pose robot-01 lost` pushes their health and position around. `DEV_DEVICES_TO=ws://host:port` connects the same devices to another hub instead, and `DEV_DEVICES=robot-01,env-01` only the listed ones.

`pnpm --filter @agnes/mhs dev [host:port] --record session.jsonl` is AgnesHub with a command line for trying a device by hand (`help` lists the commands, `quit` ends it). It listens on `AGNES_HUB_LISTEN` or `127.0.0.1:4180`, so give it another address while the plugin's AgnesHub runs. It writes one `session.<device>.jsonl` per device into `packages/mhs`, ready for the validator.

## Write and check a device

[Write a device](../../docs/guide/mhs-device.md) covers both libraries: a minimal device, the API, and common patterns. The Python commands run from `packages/mhs/python`, where `uv run` sets up the environment, PyAV included. In another project, `uv pip install -e <repository>/packages/mhs/python` installs the library, and its `video` extra adds PyAV.

```sh
cd packages/mhs/python
uv run python -m agnes_mhs.check                 # the test hub, waiting on ws://127.0.0.1:8800
uv run python examples/sensor.py                 # in a second terminal: the device under test
uv run python -m agnes_mhs.validate ../session.robot-01.jsonl   # a session recorded with dev --record
```

`mhs-check` works out which profiles apply from the registration, runs their scenarios and reports `pass`, `fail`, `warn` (a **SHOULD** missed), `skip` (not run) or `manual` (needs an operator) for every requirement id; the exit status is non-zero when one failed. `--profile core,video` limits the run, `--no-motion` keeps the device still, `--interactive` asks the operator at the physical checks, `--report out.json` writes the JSON report, and `--host`, `--port`, `--wait`, `--replace-wait` and `--check-version` are described in [the conformance suite](spec/mhs-conformance.md). Any device can be pointed at it: `DEV_DEVICES=robot-01 DEV_DEVICES_TO=ws://127.0.0.1:8800 pnpm --filter @agnes/mhs dev-hub` for a sample device, `uv run python examples/camera.py` for the video example, `pnpm exec tsx packages/mhs/device/example.ts ws://127.0.0.1:8800` (from the repository root) for the TypeScript one.

## Use devices from Agnes

1. Build Agnes ([installation guide](../../docs/guide/install.md)).
2. In a terminal, from the repository root: `pnpm --filter @agnes/mhs plugin:install`. It builds the plugin and installs it through the normal package flow; confirm the preview. The package starts disabled.
3. Start the web server with the hub's origin, so the workbench may connect to it: `AGNES_HUB_ORIGIN=http://127.0.0.1:4180 node packages/cli/dist/local/agnes.mjs serve`.
4. In Web, Settings → Plugins → `@agnes/mhs` → Enable. AgnesHub then listens, and devices connect to `ws://127.0.0.1:4180`.

| Variable | Read by | Meaning |
|---|---|---|
| `AGNES_HUB_LISTEN` | the daemon, which runs the plugin | `host:port` AgnesHub listens on, default `127.0.0.1:4180`; a bare port listens on loopback. A network address is for a trusted network only ([hub API section 16](server/hub-api.md#16-security)) |
| `AGNES_HUB_DATA` | the daemon | AgnesHub's data directory, default `<AGH_HOME>/hub` (`~/.agh/hub`); it keeps `maps.json`, the maps devices declared |
| `AGNES_HUB_ORIGIN` | the web server | AgnesHub's `http(s)` origin, added to the workbench's content security policy |

The daemon reads its variables when it starts, so set them before the first `agnes` command, or stop the daemon and start it again. The workbench panel connects to the `hubUrl` in `plugin/client/agnes.client.json`, `ws://127.0.0.1:4180/ws/hub`; with another port, change it there and reinstall.

While the plugin is enabled:

- **The Devices panel** docks to the right of the workbench, with an entry in the sidebar and a full-screen console. Its tabs: Devices (a card per device, and a page per device), Flow (calls and data between the brain, AgnesHub and the devices), Activity (the brain's device calls in the open conversation) and World (every known map with its zones, landmarks and devices).
- **The conversation** shows a card for every device tool call of the brain.
- **The brain** gets seven tools, `list_devices`, `read_device`, `call_device`, `set_device`, `stop_device`, `watch_device` and `unwatch_device`; a snapshot of the maps and devices at the start of every turn; and wake-ups when a job it started ends or a watch it set fires ([hub API section 15](server/hub-api.md#15-the-brain)). `read_device` declares `returnsImages`, so the pictures it reads reach the model.
- **AgnesHub's own address**, `http://127.0.0.1:4180/`, opens the Devices panel as a page of its own, with every tab but Activity: dark by default, `?theme=light` and `?lang=zh-CN` to change it. To open it from a phone, set `AGNES_HUB_LISTEN` to a network address on a trusted network.

## Tests

```sh
pnpm --filter @agnes/mhs test                    # schema cases, AgnesHub, the brain, the plugin
(cd packages/mhs/python && uv run pytest)         # the device library and mhs-check
node packages/mhs/tools/panel-smoke.mjs          # with dev-hub running: clicks through the Devices page in headless Chrome
```
