import type * as THREE from 'three'
import type { Parts } from '../devices.js'
import { airlock } from './airlock.js'
import { baseCamera } from './basecam.js'
import { comms } from './comms.js'
import { habitat } from './habitat.js'
import { hopper } from './hopper.js'
import { lab } from './lab.js'
import { monolith } from './monolith.js'
import { power } from './power.js'
import { rover } from './rover.js'
import { suit } from './suit.js'
import { weatherStation } from './weather.js'
import { World, type WorldDevice } from './world.js'

/**
 * The devices of Agnes Base, each speaking MHS from the page and driving its part of the scene, and
 * a reset that puts the base back as the page started it while the devices stay connected.
 */
export function connectDevices(
  hub: string,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  parts: Parts,
  sky: THREE.Object3D,
  sun: number,
  log: (line: string) => void,
  only?: string[],
): { devices: WorldDevice[]; reset: () => Promise<void> } {
  const world = new World(renderer, scene, parts, sky, sun)
  const all = [
    habitat(world, log),
    airlock(world, log),
    suit(
      world,
      { id: 'suit-01', name: 'Suit', model: parts.astronaut, o2: 71, battery: 78, working: true },
      log,
    ),
    rover(world, log),
    hopper(world, log),
    monolith(world, log),
    lab(world, log),
    power(world, log),
    weatherStation(world, log),
    comms(world, log),
    baseCamera(world, log),
  ]
  // ?devices=hopper-01,rover-01 connects only these, for example to check one device on its own.
  const devices = only ? all.filter((d) => only.includes(d.id)) : all
  for (const dev of devices) void dev.run(hub)
  addEventListener('pagehide', () => {
    for (const dev of devices) dev.close()
  })
  // Reset ends every running call (reported as interrupted, as mhs/stop does), gives the tools a
  // moment to reach their next checkpoint, then restores the scene and every device's state.
  const reset = async () => {
    await Promise.all(all.map((dev) => dev.stopAll()))
    await new Promise((resolve) => setTimeout(resolve, 300))
    world.reset()
  }
  return { devices, reset }
}
