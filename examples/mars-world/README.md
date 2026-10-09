# Mars world: Agnes Base, Mars

A small research base at the rim of Jezero crater, full of virtual MHS devices, for demos of Agnes driving devices through MHS. No hardware is needed. To command the base from AGH, follow the [Mars base guide](../../docs/guide/mars-world.md); this page is the reference for the world and its devices.

```sh
pnpm --filter @agnes/mars-world start      # fetches assets, starts a hub and the world, opens the browser
```

`start` runs the dev hub of `@agnes/mhs` on `127.0.0.1:4180` (type `help` in that terminal to call devices by hand) and serves the world on `http://127.0.0.1:4200/?hub=ws://127.0.0.1:4180`. `pnpm --filter @agnes/mars-world dev` serves the world alone.

In the page:

- **Fixed views.** Keys `1`–`9`: the overview with every device in frame, then the rover dock and lab, the hopper pad, the airlock, the field worksite, the power system, the Agnes flag, the comms dish and weather station, and a view that follows the hopper from behind and above wherever it flies; key `0` follows Monolith from its side. `?shot=<name>` picks one (see `src/shots.ts`). Close views tag only the devices they are about.
- **Minimap.** Top right: the base map frame the poses use (x east, y north, metres from the habitat) with a 10 m grid and labelled ticks, buildings, boulders and steep ground, every device where it is now (moving ones in orange with their heading) and the view's direction, redrawn four times a second. `M` toggles it; `?minimap=0` hides it.
- **Reset.** With a hub, the Reset button (bottom right) or `R` puts the base back as the page started it, without reloading, so the devices stay connected: every running call ends `interrupted` / `stop` as on `mhs/stop`; the rover, hopper, Monolith and the astronaut go back to where they started (rover docked, hopper landed on its pad, the astronaut at work in the field); battery, propellant, oxygen and the battery bank go back to their starting levels; cargo, what Monolith carries, the lab's queue and last result are cleared and the sampled rock is whole again; the airlock is pressurized with its outer door shut, the habitat back to normal, the dish unpointed with its window timeline restarted, the array deployed with no load shed and life support first, the base camera unpanned and unzoomed, Monolith's humor and honesty back to 75 % and 90 %. Every changed state field goes to the hub at once; poses follow at their next tick, within a second. Readings that follow the page's clock (wind, dust, habitat CO2 drift, solar haze) carry on where they are. Reset is a control of this page, not part of any device.
- `L` toggles the device tags. `?time=morning|noon|sunset` sets the time of day. `?quality=high|balanced|low` trades sharpness for frame rate: `high` renders at the full Retina resolution with ambient occlusion, `balanced` (the default) caps the pixel ratio at 1.25 and leaves ambient occlusion out, `low` renders one pixel per CSS pixel; the status line shows the frame rate. `?ao=1` or `?ao=0` turns ambient occlusion on or off whatever the quality, `?bloom=0` turns off the bloom. Frames are capped at 30 a second; `?fps=60` lifts the cap. `?stats` adds draw calls, triangles and JavaScript time per frame (averaged over a second) to the status line.
- **What a frame costs.** The scanned rocks near the base each have a coarse copy (vertex clustering, a few hundred triangles); before every render, the main view's and each device camera's, the rocks outside that camera's view are left out and those over 28 m away drawn coarse. No material uses transmission (it would draw every opaque object twice a frame), and device cameras render only while someone wants their pictures. On an M1 Pro at 1600×900 CSS pixels and Retina scale, the overview draws 1.4 M triangles in 250 draw calls and could run at about 200 frames a second uncapped.

**The base is Agnes's.** The Agnes flag, the white mark on indigo, flies on a 9 m pole beside the airlock, rippling in the thin wind with an occasional gust; a name board below it and the landing pad read AGNES BASE. The mark is a vector path (`src/agnes-mark.ts`) that `tools/trace-mark.mjs` traces from `packages/web/public/brand-mark.png`, so it stays sharp at any size.

The devices are laid out for three chains of work that need several of them at once:

| Device | Where |
|---|---|
| `rover-01` | In its dock south of the garage, beside the charging post |
| `lab-01` | The lab module next to the dock; its arm reaches the docked rover |
| `hopper-01` | On its pad east of the base |
| `power-01` | The battery bank and the solar array |
| `airlock-01`, `habitat-01` | The airlock door and the habitat dome |
| `suit-01` | Worn by the astronaut, who works at the rock outcrop out in the west field and walks about it on their own |
| `weather-01`, `comms-01` | North of the habitat |
| `cam-base` | On a mast south of the base, overlooking the dock, the airlock and the hopper pad |
| `monolith-01` | Monolith, a robot of four metal slabs, waits beside the airlock |

- **Scout and sample**: the hopper surveys from the air, the rover follows its route and collects a sample, docks, the lab's arm unloads it for analysis, and the dish sends the result.
- **Storm**: the weather station warns, the power system stows the array, the hopper lands once the base camera sees its pad clear, the rover docks, the airlock brings the crew in.
- **Rescue**: the suit reports low oxygen out in the field; the hopper flies out and finds the astronaut, Monolith walks to them and carries them back to the airlock, which cycles them in while the habitat gets ready.

## Live devices

All the devices speak MHS from the page and drive their part of the scene (`src/live/`). `?devices=hopper-01,rover-01` connects only the listed ones, for example to run `python -m agnes_mhs.check` against one device.

| Device | Tools | State | Sources |
|---|---|---|---|
| `habitat-01` | `set_mode {mode}` (`normal`, `storm_shelter`, `medical`; the windows show it) | `mode`, `o2` (role `consumable` of `oxygen`), `co2`, `pressure`, `temperature` (role `temperature` of `air`), with alert levels | `air`: the same and humidity, once a second |
| `airlock-01` | `cycle_out`, `cycle_in`, `open_outer`, `close_outer` | `mode`, `pressure`, `inner`, `outer`, `occupied` | `chamber`: pressure and temperature |
| `suit-01` | — | `o2_left` (role `consumable` of `oxygen`), `battery`, `comm` | `vitals`: heart rate, body temperature, SpO2; `life_support`: suit pressure, CO2, temperature; `helmet` camera; `pose`; `map` |
| `rover-01` | `drive_to {x, y}`, `follow_route {points}`, `collect_sample {target}`, `dock`; manual `vx`, `wz` | `mode`, `battery` (role `battery`), `cargo`, `docked` | `front` camera; `hazcam` (stills only); `lidar` (`scan`, all round); `health`: voltage, motor current, motor, battery and electronics temperatures, CPU; `pose`; `odometry`; `map` |
| `hopper-01` | `take_off {alt}`, `fly_to {x, y, alt}` (progress as the distance left), `survey {area}` (`west field`, `east dunes`), `land {pad}` (`hopper pad`, `landing pad`) | `mode` (`landed`, `hovering`, `flying`), `propellant` (role `consumable` of `propellant`), `flight_time_left`, `max_altitude`, `battery` (role `battery`), `temperature` (role `temperature` of `engine`), `refueling` | `down` and `front` cameras; `telemetry`: altitude, thrust, tank pressure, voltage, engine temperature; `pose`; `map` |
| `lab-01` | `unload_rover`, `analyze {sample}` | `mode`, `queue`, `last_result` | `arm` camera on the wrist; `room`: temperature, pressure, analyzer oven temperature |
| `power-01` | `stow_array`, `deploy_array`, `clean_array`, `shed {load, on}` | `storage` (role `battery` of `bank`), `production`, `load` (role `power`), `dust`, `panels`, `shed`, writable `priority` | `flow`: production, load, bank voltage and temperature |
| `weather-01` | — | `storm_warning` (`none`, `watch`, `warning`, from wind and dust) | `air`: wind, pressure, temperature (role `temperature` of `air`), dust, radiation, once a second, with alert levels |
| `comms-01` | `point {target}` (`earth`, `orbiter`), `send {report}` | `link`, `target`, `window`, `window_changes_at` | `signal`: strength of the link (role `signal` of `earth`) and transmitter temperature |
| `cam-base` | `look_at {preset or pan, tilt}`, `zoom {level}` | `preset`, `pan`, `tilt`, `zoom` | `view` camera; `housing` temperature |
| `monolith-01` | `go_to {x, y, gait}` (`walk` or `roll`), `follow {target, seconds}` (`suit-01`, `rover-01`, `hopper-01`), `carry {target}` (`suit-01` or `rock-1`), `put_down`, `say {text}`, `stop`; manual `vx`, `wz` | `mode` (`idle`, `walking`, `rolling`, `carrying`), `carrying` (`none`, `astronaut`, `sample`), `battery` (role `battery`), writable `humor` and `honesty` (0–100 %) | `front` camera; `health`: battery, hinge motor temperature; `pose`; `odometry`; `map` |

**Cameras.** Every camera is two sources: `<id>`, a JPEG at 1 Hz for a model to read, and `<id>_video`, H.264 for people to watch (MOS 7): 640×360, 20 Hz (or the lower rate the hub configures), constrained baseline in Annex B, a keyframe with SPS and PPS at least every second (`gop_s` 1) and on `mhs/keyframe`, 600–2000 kbit/s. The browser's WebCodecs encoder (`latencyMode: realtime`) makes it from an off-screen render of that camera: pictures are taken on a steady clock, read back from the GPU through a buffer and a fence so the page never waits for the GPU, and sent in order as the source's rate allows; a picture still waiting 300 ms after its turn (the encoder starting up, a stalled page) is dropped, and the stream goes on from a new keyframe. Three cameras streaming at once each deliver 20 frames a second while the main view holds 30. Both render only while the hub wants them, and an encoder nobody has wanted for 5 s is closed.

**The hopper flies on rockets, so it needs no air.** `hopper-01` is a small rocket lander on four legs: a methane-oxygen engine under the deck (its plume and the dust it blows off the ground show the thrust), two propellant tanks, a downward and a forward camera. It lights the engine, lifts off, hovers and hops between points at up to 10 m/s. Propellant sets every limit: hovering burns 0.5 % of a full load a second, moving and climbing more; 10 % is kept for landing; take-off needs 30 %; `flight_time_left` and `max_altitude` (at most 30 m) in its state follow from what is left, and a climb above `max_altitude` ends with `x_too_high`. A flight tool that reaches the landing reserve ends with `x_propellant_low`; a hopper at the reserve with nothing to do lands where it is. It refuels only while landed on the hopper pad, 2 % a second, from the propellant service unit at the pad's edge. It refuses (`unsafe`) to take off or fly on under a dust storm warning at `weather-01`, or with too little propellant. Stopped in the air, it hovers.

**Monolith is built to work beside people.** `monolith-01` (the name lives in `MONOLITH` in `src/devices.ts`) is four brushed-metal slabs side by side, 1.5 m tall, joined by a hinge through their middles, with a thin display strip across the front; it is made in code (`src/monolith.ts`). It walks at 1.3 m/s by swinging its slabs about the hinge, the outer pair against the inner pair, and on open ground unfolds them into an eight-spoked wheel and rolls at 6 m/s. It finds its own way on the base map around buildings, boulders and machines, and gets as near as it can to a point that is blocked (the airlock's door). Rolling needs open ground, 2.5 m clear of everything at both ends and all the way, and is refused while it carries something. Its safety stop looks 1 m ahead walking and 2.5 m rolling for boulders and machines and ends the call `interrupted` / `estop` the way the rover's does (`stopped 0.4 m before a boulder at (x, y)`), but it walks up to half a metre from a person. `carry` picks up the astronaut, or breaks off a sample of `rock-1`, within 1.2 m of its front; `put_down` sets the astronaut into the airlock's chamber when it stands at the open outer door (`airlock-01` then shows `occupied`, and `cycle_in` brings them into the habitat), on the ground anywhere else, and hands a sample to the lab, which queues it for `analyze`. `say` shows a bubble over it; `humor` adds a joke or a dry word to what it says and low `honesty` smooths things over when it speaks to the crew, while the facts in its results stay plain. `stop` ends what it is doing and keeps hold of its load.

**The base map.** `habitat-01` declares the map `base` (MOS 3.5, `src/live/basemap.ts`): named Agnes Base, bounds x −80…90, y −70…60, and its places, in metres on the map:

| Place | Id | Where |
|---|---|---|
| Airlock (outer door) | `airlock` | (0, −12.2), face 90° (north) to enter |
| Rover dock | `dock` | (−15.5, −15.5), nose 90° (north) |
| Hopper pad | `hopper-pad` | (27, −8) |
| Landing pad | `landing-pad` | (6, −42) |
| Lab | `lab` | (−24, −15.5) |
| Comms dish | `comms-dish` | (−13, 12) |
| Rock outcrop | `outcrop` | (−31, −27), where the astronaut works |
| West field | `west-field` | zone x −58…−24, y −58…−20 |
| East dunes | `east-dunes` | zone x 48…90, y −30…30 |
| Base area | `base-area` | zone x −28…36, y −52…18, less the west field's corner |

The devices that stay put are `localization: fixed` with a `placement` on `base` (REG-4), its yaw the direction of the device's body x axis: `habitat-01` (0, 0) facing its airlock at 270°, `airlock-01` (0, −12.2) facing out at 270°, `lab-01` (−24, −15.5) its arm reaching east at 0°, `comms-01` (−13, 12) the dish at rest facing north at 90°, `power-01` at the battery bank (10.5, −20) with the array facing south at 270°, `weather-01` (−4.5, 15) at 287°, and `cam-base` (−4, −28) looking north at 90° when not panned. Moving devices report `pose` on `base` and serve the map itself as a `grid` source `map` (1 m cells over the bounds: buildings, boulders and ground steeper than 0.4 occupied), so a device page can draw where they are.

How they work together:

- Positions are on the base map: metres, x east, y north, yaw counter-clockwise from east; the origin is the habitat.
- `survey` flies a circle over the area at 12 m and reports what lay under it, with map coordinates: the unusual rock `rock-1`, the boulders, the astronaut. For the rock it also plans a route a rover can drive from the dock, around everything in the way, in `data.route`.
- The rover stops by itself before a boulder or a person in its way: the call ends `interrupted` / `estop`, saying what is ahead and where. Driving straight from the dock to `rock-1` runs into the outcrop; following the hopper's route gets there. `dock` plans its own way home.
- The astronaut walks between a few spots at the outcrop on their own, working a while at each. The rover's safety stop and the hopper's routes keep clear of them wherever they are.
- `collect_sample` needs the rock within 4 m. `unload_rover` is refused (`unsafe`) unless the rover is docked with a sample on board; the lab's arm then reaches over the rover.
- `send` is refused unless the dish points at Earth while the window is open: closed for the first 120 s after the page opens, then open 180 s of every 240 s.
- Moving tools animate the models frame by frame; cancel, stop and pause take effect at the next frame, and every result carries the device's pose and odometry.

By hand, with `start` running (type these in its terminal):

```
call hopper-01 take_off {"alt": 12}
call hopper-01 survey {"area": "west field"}      # the result's data.route is the rover's route
call hopper-01 land {"pad": "hopper pad"}
call rover-01 follow_route {"points": [...]}      # paste data.route
call rover-01 collect_sample {"target": "rock-1"}
call rover-01 dock
call lab-01 unload_rover
call lab-01 analyze {"sample": "rock-1"}
call comms-01 point {"target": "earth"}
call comms-01 send {"report": "..."}
state rover-01
read rover-01 front
```

The rescue, by hand:

```
call hopper-01 take_off {"alt": 12}
call hopper-01 survey {"area": "west field"}      # finds suit-01 at the rock outcrop
call airlock-01 cycle_out
call airlock-01 open_outer
call monolith-01 follow {"target": "suit-01"}
call monolith-01 carry {"target": "suit-01"}
call monolith-01 go_to {"x": 0, "y": -12.2}       # the airlock place; it stops in front of the door
call monolith-01 put_down                          # into the chamber
call airlock-01 close_outer
call airlock-01 cycle_in                           # the astronaut steps into the habitat
call monolith-01 say {"text": "Everyone is inside."}
```

## Assets

Third-party models and textures are listed in [assets/manifest.json](assets/manifest.json) with source, authors, license or usage terms, and the size and md5 of every file. They are not stored in the repository: `tools/fetch-assets.mjs` downloads them into `assets/cache/` on first run and checks every hash. `tools/lock-assets.mjs` regenerates the manifest when the list changes.

- **Poly Haven, CC0**: the ground, rock and sand textures, metal plate, the moon rocks (dusted red; one dark and greenish, the unusual rock) and the boulders of the west field.
- **NASA 3D Resources**: the Perseverance rover and the Mark III spacesuit. The repository describes them as "free and without copyright"; NASA's media usage guidelines still forbid using the NASA insignia or implying endorsement. The world therefore paints over every NASA, JPL and mission mark, flag and patch on these models as it loads them (`COVERS` in `src/assets.ts`), and nothing here is affiliated with or endorsed by NASA.
- The models are Draco-compressed; `tools/draco.mjs` copies the decoder that ships with three into `dist/draco/`.
- The terrain (with its craters, ridges and buttes), sky, habitat, airlock, greenhouse, garage, rover dock, lab and its arm, battery bank, solar array, pads, the rocket hopper and its propellant service unit, weather station, dish, camera, oxygen plant, radiators, cargo, light masts, cables, route stakes, wheel tracks, seismometer, flag and name board are made in code.

`node tools/screenshot.mjs <dir> [url] [shot…]` renders views with headless Chrome and prints any page error, for checking the look.
