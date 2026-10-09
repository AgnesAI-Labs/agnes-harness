import type { Device } from '@agnes/mhs/device'
import { round } from './route.js'
import { type Body, every, type World } from './world.js'

/**
 * Where a moving device is: a `pose` source on the base map from the scene's truth, and the base
 * map itself as a `grid` source, so a device page can draw the device on its map.
 */
export function addPlace(
  dev: Device,
  world: World,
  body: Body,
  options: { what: string; maxError: number; hz?: number },
  log: (line: string) => void,
): void {
  const hz = options.hz ?? 2
  const pose = dev.source('pose', 'pose', `where the ${options.what} is on the base map`, {
    hz,
    model: { name: 'agnes-base-truth', version: '1' },
    max_error_m: options.maxError,
  })
  const map = dev.source('map', 'grid', 'the base map: buildings, boulders and steep ground', {
    hz: 0.2,
    model: { name: 'agnes-base-truth', version: '1' },
  })
  every(1000 / hz, () => void (pose.wants() && pose.send(body.pose())), log)
  every(
    5000,
    async () => {
      if (!map.wants()) return
      const { grid, png } = await world.baseMap()
      map.send({ id: grid.id, resolution: grid.resolution, origin: grid.origin }, png)
    },
    log,
  )
}

/** A reading with a little noise, rounded to `digits`. */
export const reading = (value: number, noise: number, digits = 1) =>
  round(value + (Math.random() - 0.5) * 2 * noise, digits)
