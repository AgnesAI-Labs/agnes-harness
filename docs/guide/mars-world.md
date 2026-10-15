# Mars rescue: eleven simulated devices

English | [简体中文](mars-world.zh-CN.md)

[Documentation](../README.md) · [MHS devices](mhs.md) · [Example source](../../examples/mhs/mars-rescue/README.md)

The new Mars rescue example packages eleven simulated devices, a 3D scene inside the MHS page and rescue/sampling business-Agent launch declarations. It uses the MHS device SDK, not MCP. It is a new-product example, without migration from the former Mars world.

The installed profile runtime and reviewed producer binding are implemented. Enable the local example to start its profile-owned simulation; Ready requires eleven actual Hub registrations. Missing or revoked child/parent authority refuses the connection. GPU, real-model and complete browser acceptance remain integration checks.

On an integrated host, review and enable the local bundle under **MHS → Examples**, then wait for Ready (or use Start/Retry after a failure). Choose a configured model with image and tool support. The example ships NASA/Poly Haven source assets, locally baked geometry, terrain resources and notices, so first opening needs no model/texture download. `exampleOf` grants no parent service authority; review the explicit device connection. All movement retains native MHS approval.

Use keys **1–9 / 0** for views, **L** for labels and **M** for the map and **R** to reset the camera. Drag to orbit, scroll to zoom, and use the quality, time, occlusion, bloom and FPS controls to adjust the view. Leaving the scene or hiding the session workbench keeps the profile devices and model-camera rendering alive. Stop disconnects only this example fleet. Reset interrupts calls and restores simulation state while retaining registrations. Browser closure, lost transport, suspension or revocation stops the fleet; reconnection does not resume motion.

The rover exposes read-only route planning, lidar and a north-up occupancy grid. Monolith distinguishes walking from rolling and refuses rolling near the astronaut. Hopper movement/climb consumes more fuel than hovering, and the two landing pads are distinct. Suit consumables, weather, solar production and communications windows change with the simulation clock.

For rescue, locate the astronaut, carry them to the airlock, prepare the habitat and verify the suit's rescued state after safe cycling. For sampling, survey, follow the safe rover route, collect, dock, analyze and send the synthetic result. The business Skill requires receipts and state verification, and refuses automatic replay of an unknown action. The parent MHS owns the seven tools and session workbench.

See the [package reference](../../examples/mhs/mars-rescue/README.md) for devices, SDK ports, local checks, resource licensing and current integration limits. The source asset manifest retains individual attribution and checksums. An integrated, reviewable browser preview and video remain acceptance requirements.
