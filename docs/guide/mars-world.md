# Mars base: command eleven devices from AGH

English | [简体中文](mars-world.zh-CN.md)

<a id="火星基地在-agh-里指挥十一台设备"></a>

[Documentation](../README.md) · [MHS and devices](mhs.md) · [Example reference](../../examples/mars-world/README.md)

[`examples/mars-world`](../../examples/mars-world/README.md) is a small research base on Mars, drawn in 3D in the browser. Its eleven devices are virtual, but they speak MHS like real ones: they connect to AgnesHub, declare their tools, state and cameras, and move in the world when they are called. You give the task in AGH; the brain plans it and drives the devices, and you watch it happen. No hardware is needed.

<a id="开始之前"></a>

## Before you start

- A [source build of AGH](install.md) with a model configured in Web. The brain reads camera pictures and calls tools, so choose a model that supports both images and tool calls.
- The `@agnes/mhs` plugin installed, as in [Use devices from AGH](mhs.md#use-devices-from-agh) steps 1–3. AgnesHub then listens on `127.0.0.1:4180`.
- A desktop browser with WebGL and WebCodecs (a recent Chrome, Edge or Safari).

<a id="启动"></a>

## Start

1. Start Web with AgnesHub's origin and enable the plugin, if they are not running yet:

   ```sh
   AGNES_HUB_ORIGIN=http://127.0.0.1:4180 node packages/cli/dist/local/agnes.mjs serve
   ```

2. In another terminal, from the repository root, serve the world. The first run downloads about 27 MB of models and textures and checks their hashes:

   ```sh
   pnpm --filter @agnes/mars-world dev
   ```

3. Open `http://127.0.0.1:4200/?hub=ws://127.0.0.1:4180`. The devices live in this page and connect to AgnesHub from it. Keep it open while you play; a background tab keeps them running. Open it only once: a second page takes the same devices over.
4. In the workbench, the Devices panel docks on the right; Devices in the sidebar opens it. The eleven devices appear in the Devices tab, and the World tab shows the base map with every device on it.

`pnpm --filter @agnes/mars-world start` is the variant without AGH: it starts a hub with a command line on `127.0.0.1:4180`, serves the world on port 4200 and opens it in the browser. Stop `dev` and AGH's AgnesHub before running it, since it needs both ports.

<a id="基地里有什么"></a>

## What is on the base

| Device | What it does |
| --- | --- |
| `rover-01` | Drives, follows routes, collects rock samples and docks to charge. Stops by itself before boulders and people |
| `hopper-01` | A rocket lander. Takes off, flies, surveys an area from the air and plans a route for the rover. Limited by its propellant |
| `monolith-01` | A walking robot of four metal slabs. Walks or rolls, follows, carries the astronaut or a sample, and speaks. Its `humor` and `honesty` can be set |
| `suit-01` | Worn by the astronaut working at the rock outcrop in the west field. Reports oxygen, vital signs and a helmet camera |
| `airlock-01`, `habitat-01` | The airlock cycles people in and out; the habitat reports its air and switches modes |
| `lab-01` | Unloads a docked rover's sample and analyzes it |
| `comms-01` | Points the dish and sends reports to Earth while the window is open |
| `power-01`, `weather-01`, `cam-base` | The battery bank and solar array, the weather station, and a camera overlooking the base |

The habitat declares the base map with named places (airlock, rover dock, hopper pad, lab, rock outcrop, west field and more), so you can name places in a task instead of giving coordinates. The [example reference](../../examples/mars-world/README.md) lists every tool, state field and data source.

<a id="试试这些任务"></a>

## Tasks to try

Type these into a conversation, in English or any language your model handles. Start with the short ones.

**Look around**

> How is the base doing? Check the habitat's air, the power and the weather.

> What does the base camera see right now?

**One device**

> Drive the rover to the airlock door.

> Set Monolith's humor to 100% and have it say hello to the crew.

**Several devices**

> The astronaut out in the field has gone quiet. Send the hopper to find them in the west field, then have Monolith bring them back into the habitat.

The brain flies the hopper out to survey, sends Monolith to the astronaut, cycles the airlock open, has Monolith carry the astronaut into the chamber and cycles them into the habitat. If another device stands in the way, it moves that first.

> Look for an unusual rock in the west field from the air, have the rover collect a sample along the hopper's route, analyze it in the lab and send the result to Earth.

The rover cannot drive straight to the rock, because the outcrop is in the way; the hopper's route goes around it. The dish can only send while the window to Earth is open: closed for the first two minutes after the world page opens, then open three minutes in every four. The brain waits for it.

> A dust storm is coming. Get the base ready.

There is no single right answer: the weather station, the solar array, the hopper, the rover and the airlock all have a part.

<a id="观察过程"></a>

## Watch it happen

- **In the conversation**, every device call shows as a card with its arguments, progress and result. A finished turn folds its cards under its summary line, Completed · took …; click that line to unfold them.
- **In the Devices panel**: Activity lists the brain's device calls in this conversation, newest first; World shows the devices moving on the base map; a device's own page shows its state, data and cameras. Stop on a device page, or `stop_device`, stops it at once.
- **In the world page**, keys `1`–`9` switch between fixed views (overview, rover dock and lab, hopper pad, airlock, field worksite, power, flag, comms, and one that follows the hopper), `0` follows Monolith, `M` toggles the minimap and `L` the device tags.

<a id="重来一次"></a>

## Start over

Press **Reset** at the bottom right of the world page, or `R`. Every running call ends as if stopped, and the devices go back to where they started, with the battery, propellant and oxygen levels they started with, the rock whole again and the airlock closed. The devices stay connected, so you can give the next task right away. Open a new conversation too, so the brain does not plan from the last run.

<a id="遇到问题"></a>

## When something is off

| What you see | What to check |
| --- | --- |
| No devices in the panel | Is the world page open with `?hub=ws://127.0.0.1:4180`? Is the plugin enabled? Only one program can hold port 4180: `mars-world start` and AGH's AgnesHub cannot run together |
| The panel cannot connect to AgnesHub | Web was started without `AGNES_HUB_ORIGIN=http://127.0.0.1:4180` |
| A device keeps going offline and back | The world is open in two pages; close one |
| The world runs slowly | Add `&quality=low` to the world page's address |
