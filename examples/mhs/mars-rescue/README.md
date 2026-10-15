# Mars rescue

English | [简体中文](README.zh-CN.md)

Eleven virtual devices, an offline 3D Mars base inside the MHS example page, and rescue and sampling business-Agent launch declarations. All devices are simulations. [Device guide](../../../docs/guide/mhs.md).

This package targets the new plugin architecture and a clean AGH home. It does not migrate old Mars-world sessions. It ships its complete browser resources and licenses; opening it downloads no models, textures or Draco decoder. NASA rover/suit and Poly Haven rock geometry ship with their original sources, textures and attribution. The renderer uses locally baked geometry and material base colors; no runtime Draco decoder is needed.

**Integration status:** the installed MHS profile runtime and reviewed browser producer binding are implemented. Enabling the example starts its profile-owned simulation; readiness requires eleven real Hub registrations. GPU/media and real-model browser acceptance remain separate checks.

## Installation and use

In a host with the MHS managed runtime and reviewed example connector integrated, open **MHS → Examples → Mars rescue**, inspect the bundled package's capabilities and explicitly enable it. `exampleOf: @agnes/mhs` is catalog metadata, not permission to use the parent's services. Review the explicit parent connection as well. Start/Retry waits for all eleven SDK registrations before showing Ready. No model account or hidden model route is included; select an image-and-tool-capable model already configured in your profile.

The scene is in the MHS page and shows an offline base preview before Start. Keys **1–9** select overview, dock/lab, hopper pad, airlock, field, power, flag, comms and hopper-follow; **0** follows Monolith. **L** toggles device labels; **M** toggles the map. **R** resets the orbit; drag to orbit and scroll to zoom. Quality, time, height occlusion, highlight bloom and optional FPS controls affect this view; `?stats` starts with FPS visible. Controls belong to this component instance; there are no global DOM IDs or document-wide keyboard handlers.

**Reset simulation** interrupts motion and restores poses, consumables, cargo, analysis and rescue state without replacing the eleven device registrations. **Stop example** stops motion and disconnects this fleet, leaving the parent Hub and other devices alone. Start can reconnect the stopped fleet. Leaving the scene for a session or closing its device workbench detaches only the view: the profile runtime and camera renderer remain active. Closing the browser, losing a device connection, suspending the simulation clock, revoking the example or disabling the parent must stop and disconnect the fleet. Reopening never resumes an old motion automatically.

**Rescue Agent** and **Sample Agent** start ordinary, deduplicated sessions through the reviewed parent launch facade. All seven tools come from MHS; the example registers only its business Skill. Native motion approval remains mandatory. Refusal stops that action, and an unknown receipt requires inspection before any retry. Launch prompts and simulation status never authorize movement.

## Devices and missions

| Device | Behaviors |
| --- | --- |
| habitat-01 | Atmospheric readings; normal, shelter and medical modes |
| airlock-01 | Pressure/door interlocks and safe cycling |
| suit-01 | Oxygen, pose, helmet image and verified rescued state |
| rover-01 | Read-only `plan_route`, obstacle-safe routes, lidar, occupancy PNG, sample cargo, dock and deadman manual axes |
| hopper-01 | Rocket hops, camera survey, movement/climb-dependent fuel, distinct landing pads and landing reserve |
| monolith-01 | Walk/roll gaits with rock clearance and near-person refusal, following, carrying astronaut/sample, manual axes and speech |
| lab-01 | Unload only from a docked rover; analyze a queued sample |
| power-01 | Array stow/deploy/clean, load shedding and life-support priority |
| weather-01 | Synthetic wind, dust and storm readings |
| comms-01 | Dish pointing and report delivery with a link/window |
| cam-base | Camera viewpoints and zoom declarations |

Rescue: survey the west field, carry the astronaut to the airlock, prepare medical mode and verify `suit-01.rescued`. Sampling: survey, follow the safe route to rock-1, collect, dock, unload, analyze and transmit; verify both the synthetic lab result and sent report.

Cameras render independently of the visible scene. Model inputs are real PNG captures of the simulation. WebCodecs H.264 video is optional, bounded to two active sources, and reports failures with a retry control. Missing WebGL produces an unavailable camera, never a fabricated image. Wind/dust, suit consumables, power production/storage and communications windows advance on the deterministic simulation clock. GPU appearance, browser interaction and hardware H.264 remain integration acceptance checks.

## Extension ports and local checks

`MarsRuntime` accepts a `MarsTransport` whose `connect(Device, signal)` returns registration readiness, connection lifetime and an idempotent close operation. Readiness must establish both SDK channels; an opened socket alone is insufficient. The parent MHS client must supply `mhsExampleAccess.connect(exampleId, device, signal)` through its reviewed Cordis profile scope, bound to the active profile, exact example package, reviewed cross-owner grant and current activation. The installed browser connector uses the reviewed producer stream.

The actual `@agnes/mhs-ui` Examples tab renders the registered page. Its `ExampleSceneHost` is passed through the existing page context: the example binds profile runtime state/Stop once, and the host lists actual connected counts without owning the simulation. Leaving and re-entering the scene retains that binding. Rescue and Sample buttons request the parent's launch review; the host uses its real owner-bound `prepare/start` facade. Both buttons wait for a running fleet. Review remains visible inside the scene, and ticket plus operation ID survive uncertain retries and parent-page reloads. No launch authority or package admin client is supplied by this example.

Use the public `@agnes/mhs-device` TypeScript SDK to implement transport; consume the published Python distribution `packages/mhs-device/python` for Python devices. Neither route is MCP. The SDK and Hub own protocol validation and admission; do not copy their wire schemas into this package. Both SDK languages must preserve device-local stopping on disconnect and manual deadman expiration. This browser simulator is not a hardware safety controller or MHS certification.

After the MHS SDK is present in the workspace:

```sh
pnpm exec tsc -b examples/mhs/mars-rescue/tsconfig.json
pnpm exec vitest run examples/mhs/mars-rescue/test --project fast --maxWorkers=1
node examples/mhs/mars-rescue/tools/build.mjs
```

Build tools use esbuild 0.28.2; browser resources are committed for offline installation. The resource manifest records exact bytes, SHA-256 and licensing; regenerate it after source changes. The full AGH distribution must retain `client`, `assets`, `skills`, `LICENSE` and `NOTICE`. Full browser/managed-runtime/approval checks belong to integration acceptance and are not established by these unit tests. The [repository README](../../../README.md) links the original Mars World video; that recording documents the former scene, not acceptance of this package. The source and view controls remain the current review material pending integrated preview acceptance.

The exported `createMarsHubTransport` adapter uses the real public Hub/DeviceLink contract for an embedded managed simulator. It requires an explicit reviewed-current-link check and refuses taking over an online fleet. The installed browser path uses the authenticated producer bridge; Agent launch uses the integrated Examples host.

The managed-runtime check also uses the real `@agnes/sdk/managed-service` runtime, SQLite owned store and `startManagedMhsHub`; disabling the parent parks all eleven devices. No simulator-owned Hub or fake singleton is started. The installed runtime also registers the separately reviewed producer ingress; human control retains native motion admission.

The authority/wake check uses real `createProfileServiceRuntime`, `createMhsNativeProfileAdapter`, `mhsOwnedStore`, Host SQLite persistence, `ProfileWakeBindings` and `BoundWakeService`/`JobsRepo`. Native AR1 answers allow or refuse Mars motion; a fake approval seam throws if invoked. A real watch queues an original-session/lane/generation notification, retains its job on re-enqueue through a recreated queue adapter, and refuses delivery after revocation. Inventory, local principal and original-session facts are synthetic test fixtures; actual worker/session input delivery remains an integration check.

Producer heartbeats stop the local fleet within two seconds of a stalled channel. Resuming a suspended page also stops physics instead of catching up motion; Retry never replays a prior action.

To regenerate baked model geometry, install the standalone conversion tool `draco3dgltf@1.5.7` outside the workspace and run `node tools/bake-models.mjs <absolute-path-to-draco3dgltf.js>` from this example. Retain the original attribution and refresh resource hashes after a reviewed asset change. Conversion is a maintainer operation; normal opening and installation are fully offline.
