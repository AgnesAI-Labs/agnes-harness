import { LAYOUT } from '../base.js'
import { MAP_AREA } from './map.js'
import { toMap } from './route.js'

/** Where a fixed device is installed on the base map (REG-4): a world point and its body x direction. */
export const placed = ([x, z]: readonly [number, number], yaw: number) => ({
  map: 'base',
  ...toMap({ x, z }),
  yaw,
})

const at = ([x, z]: readonly [number, number]): [number, number] => {
  const p = toMap({ x, z })
  return [p.x, p.y]
}

/**
 * The base map (MOS 3.5), declared by the habitat: the frame every pose, grid and placement here
 * uses (x east, y north, metres from the habitat, yaw counter-clockwise from east), what it covers,
 * and its named places.
 */
export const BASE_MAP = {
  id: 'base',
  name: 'Agnes Base',
  bounds: [MAP_AREA.x0, MAP_AREA.y0, MAP_AREA.x1, MAP_AREA.y1],
  places: [
    {
      id: 'airlock',
      name: 'Airlock',
      at: at(LAYOUT.airlockDoor),
      yaw: 90,
      description: 'Outer door of the habitat airlock, on its south side; one person at a time.',
    },
    {
      id: 'dock',
      name: 'Rover dock',
      at: at(LAYOUT.dock),
      yaw: 90,
      description: 'Where the rover charges, nose north, beside the lab whose arm unloads its samples.',
    },
    {
      id: 'hopper-pad',
      name: 'Hopper pad',
      at: at(LAYOUT.hopperPad),
      description: "The hopper's pad, where it lands and refuels. Keep people clear when it lands.",
    },
    {
      id: 'landing-pad',
      name: 'Landing pad',
      at: at(LAYOUT.landingPad),
      description: 'The large pad south of the base, 18 m across.',
    },
    { id: 'lab', name: 'Lab', at: at(LAYOUT.lab), description: 'The sample lab, west of the dock.' },
    {
      id: 'comms-dish',
      name: 'Comms dish',
      at: at(LAYOUT.comms),
      description: 'The high-gain dish north-west of the habitat.',
    },
    {
      id: 'outcrop',
      name: 'Rock outcrop',
      at: at(LAYOUT.field),
      description: 'Boulders in the west field where the astronaut works.',
    },
    {
      id: 'west-field',
      name: 'West field',
      points: [
        [-58, -58],
        [-24, -58],
        [-24, -20],
        [-58, -20],
      ],
      description: 'Open ground with boulders and the unusual rock the base wants a sample of.',
    },
    {
      id: 'east-dunes',
      name: 'East dunes',
      points: [
        [48, -30],
        [90, -30],
        [90, 30],
        [48, 30],
      ],
      description: 'Soft sand east of the base.',
    },
    {
      id: 'base-area',
      name: 'Base area',
      points: [
        [-28, 18],
        [36, 18],
        [36, -52],
        [-24, -52],
        [-24, -20],
        [-28, -20],
      ],
      description: 'The buildings, the dock and the pads.',
    },
  ],
}
