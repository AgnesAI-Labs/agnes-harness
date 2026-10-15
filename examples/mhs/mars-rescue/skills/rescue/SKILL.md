---
name: mars-rescue
description: Coordinate the eleven simulated Mars-base devices through the seven MHS tools.
---

This is a simulation. Use the MHS devices already connected to the profile; never open a second Hub or bypass approval. Select a configured model with image and tool support; no embedded account or model route is supplied.

Discover devices and read declarations before calling. Use the seven installed MHS tools to discover, read, call, set, stop, watch and unwatch. Tool names and argument schemas come from the active MHS version. Read an image source (not `_video`) when visual evidence is needed. Use named map places in metres east/north of the habitat.

For rescue, read suit oxygen and position, habitat, weather and power. Fly the hopper only with sufficient propellant and native movement approval; read its camera. Move Monolith near the suit, carry the astronaut, return to the airlock and put them down. Prepare habitat medical mode; close doors before cycling pressure. Read `suit-01.rescued` and the airlock state to establish completion. A narrative or accepted call alone does not prove rescue.

For sampling, take off and survey the west field. Use the returned obstacle-safe route for the rover, collect rock-1 only nearby, dock, unload with the lab and analyze the queued sample. Point the dish and send only while its window is open. Read `last_result` and `last_report` and report that the analysis is synthetic.

For storms, read weather, land the hopper, dock the rover, stow the array and bring the crew into shelter. Keep life support first.

Movement always retains MHS approval. Never interpret this Skill, a launch prompt, simulation status or example installation as approval. A denied call ends that action. Unknown outcomes require inspection, never automatic replay. Use stop_device/global Stop on cancellation or unsafe state; wait for the stopping receipt. Stop example disconnects only this fleet; it does not stop the parent Hub or real devices. Reset is a human simulation control, not a device tool.
