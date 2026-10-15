# Mars rescue

English | [简体中文](README.zh-CN.md)

Eleven virtual devices, a procedural 3D Mars base inside the MHS example page, and rescue and sampling business-Agent launch declarations. All devices are simulations. [Device guide](../../../docs/guide/mhs.md).

This package targets the new plugin architecture and a clean AGH home. It does not migrate old Mars-world sessions. It ships its complete browser resources and licenses; opening it downloads no models, textures or Draco decoder. The original procedural scene replaces the old downloaded models, rather than redistributing those assets.

**Integration status:** the simulation, profile runtime, scene and SDK contract tests are implemented. The parent MHS reviewed device-transport/launch adapter is still required. Until it is installed, Start reports an unavailable connection, devices do not appear online, and Agent launch is disabled. This is not a claim of working production activation or end-to-end acceptance.

## Installation and use

In a host with the MHS managed runtime and reviewed example connector integrated, open **MHS → Examples → Mars rescue**, inspect the bundled package's capabilities and explicitly enable it. `exampleOf: @agnes/mhs` is catalog metadata, not permission to use the parent's services. Review the explicit parent connection as well. Start/Retry waits for all eleven SDK registrations before showing Ready. No model account or hidden model route is included; select an image-and-tool-capable model already configured in your profile.

The scene is in the MHS page and shows an offline base preview before Start. Keys **1–9** select overview, dock/lab, hopper pad, airlock, field, power, flag, comms and hopper-follow; **0** follows Monolith. **L** toggles device labels; **M** toggles the map. Controls belong to this component instance; there are no global DOM IDs or document-wide keyboard handlers.

**Reset simulation** interrupts motion and restores poses, consumables, cargo, analysis and rescue state without replacing the eleven device registrations. **Stop example** stops motion and disconnects this fleet, leaving the parent Hub and other devices alone. Start can reconnect the stopped fleet. Leaving the scene for a session or closing its device workbench detaches only the view: the profile runtime and camera renderer remain active. Closing the browser, losing a device connection, suspending the simulation clock, revoking the example or disabling the parent must stop and disconnect the fleet. Reopening never resumes an old motion automatically.

**Rescue Agent** and **Sample Agent** start ordinary, deduplicated sessions through the reviewed parent launch facade. All seven tools come from MHS; the example registers only its business Skill. Native motion approval remains mandatory. Refusal stops that action, and an unknown receipt requires inspection before any retry. Launch prompts and simulation status never authorize movement.

## Devices and missions

| Device | Behaviors |
| --- | --- |
| habitat-01 | Atmospheric readings; normal, shelter and medical modes |
| airlock-01 | Pressure/door interlocks and safe cycling |
| suit-01 | Oxygen, pose, helmet image and verified rescued state |
| rover-01 | Bounded obstacle-safe routes, sample cargo, dock and deadman manual axes |
| hopper-01 | Rocket hops, camera survey, altitude/fuel limits and landing reserve |
| monolith-01 | Ground movement, following, carrying astronaut/sample, manual axes and speech |
| lab-01 | Unload only from a docked rover; analyze a queued sample |
| power-01 | Array stow/deploy/clean, load shedding and life-support priority |
| weather-01 | Synthetic wind, dust and storm readings |
| comms-01 | Dish pointing and report delivery with a link/window |
| cam-base | Camera viewpoints and zoom declarations |

Rescue: survey the west field, carry the astronaut to the airlock, prepare medical mode and verify `suit-01.rescued`. Sampling: survey, follow the safe route to rock-1, collect, dock, unload, analyze and transmit; verify both the synthetic lab result and sent report.

Cameras render independently of the visible scene. Model inputs are real PNG captures of the simulation. WebCodecs H.264 video is optional, bounded to two active sources, and reports failures with a retry control. Missing WebGL produces an unavailable camera, never a fabricated image. This small example does not reproduce the visual fidelity or all autonomous environmental dynamics of the previous Mars world.

## Extension ports and local checks

`MarsRuntime` accepts a `MarsTransport` whose `connect(Device, signal)` returns registration readiness, connection lifetime and an idempotent close operation. Readiness must establish both SDK channels; an opened socket alone is insufficient. The parent MHS client must supply `mhsExampleAccess` through its reviewed Cordis profile scope: `connect(exampleId, device, signal)` and `launch: ExampleLaunches` (the parent’s `ctx.profile.launch.prepare/start` facade). That facade must bind the active profile, exact example package, reviewed cross-owner grant and current activation. It must not return a raw admin client. The launch implementation uses the real generic prepare/start API and persists both launch ticket and operation ID across uncertain retries. This facade is a consumer port awaiting the MHS production adapter, not an existing AGH author API.

Use the public `@agnes/mhs-device` TypeScript SDK to implement transport; consume the published Python distribution `packages/mhs-device/python` for Python devices. Neither route is MCP. The SDK and Hub own protocol validation and admission; do not copy their wire schemas into this package. Both SDK languages must preserve device-local stopping on disconnect and manual deadman expiration. This browser simulator is not a hardware safety controller or MHS certification.

After the MHS SDK is present in the workspace:

```sh
pnpm exec tsc -p examples/mhs/mars-rescue/tsconfig.json
pnpm exec vitest run examples/mhs/mars-rescue/test --project fast --maxWorkers=1
node examples/mhs/mars-rescue/tools/build.mjs
```

Build tools use esbuild 0.28.2; browser resources are committed for offline installation. The resource manifest records exact bytes, SHA-256 and licensing; regenerate it after source changes. The full AGH distribution must retain `client`, `assets`, `skills`, `LICENSE` and `NOTICE`. Full browser/managed-runtime/approval checks belong to integration acceptance and are not established by these unit tests. There is no retained video demo from the former world; the source and view controls are the current review material pending integrated preview acceptance.

The exported `createMarsHubTransport` adapter uses the real public Hub/DeviceLink contract for an embedded managed simulator. It requires an explicit reviewed-current-link check and refuses taking over an online fleet. Browser stream transport and native launch authorization remain the parent MHS adapter’s responsibility.

The managed-runtime check also uses the real `@agnes/sdk/managed-service` runtime, SQLite owned store and `startManagedMhsHub`; disabling the parent parks all eleven devices. No simulator-owned Hub or fake singleton is started. The integrated `registerMhsStreams` adapter supplies North event/media/control lanes; it does not supply the browser simulator producer or example launch binding described above.
