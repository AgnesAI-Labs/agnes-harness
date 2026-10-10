import type * as THREE from 'three'
import { MONOLITH } from './devices.js'

/**
 * Fixed viewpoints: an overview with every device in frame, one close view per area, and views
 * that follow the hopper and Monolith. Keys 1–9 and 0 switch between them; ?shot=<name> picks one in the URL. Each
 * area view leaves the left third of the screen calm for the overlay that will show what Agnes is
 * doing with each device.
 */
export const SHOTS: {
  name: string
  label: string
  from: [number, number, number]
  to: [number, number, number]
  fov?: number
  /** The devices this view is about; only they get tags. Omitted: every device. */
  devices?: string[]
  /** A device this view follows, from behind and above, instead of staying put. */
  follow?: string
  /** How far behind and above the followed device the view keeps, in metres (default 10 and 5),
   * and how far round from straight behind, in radians, counter-clockwise seen from above. */
  behind?: [number, number, number?]
}[] = [
  { name: 'overview', label: 'Overview', from: [-11, 22, 57], to: [-4.5, 0, 9.5], fov: 50 },
  {
    name: 'dock',
    label: 'Dock & lab',
    from: [-27, 5, 37],
    to: [-12, 1, 15],
    fov: 48,
    devices: ['rover-01', 'lab-01', 'cam-base'],
  },
  {
    name: 'pad',
    label: 'Hopper pad',
    from: [36.5, 4.2, 0.5],
    to: [24.5, 0.8, 20],
    fov: 44,
    devices: ['hopper-01', 'cam-base', 'power-01'],
  },
  {
    name: 'airlock',
    label: 'Airlock',
    from: [6.5, 2.1, 22],
    to: [-0.4, 1.6, 12.5],
    fov: 40,
    devices: ['airlock-01', 'habitat-01', MONOLITH.id],
  },
  {
    name: 'field',
    label: 'Field worksite',
    from: [-21, 2.6, 31],
    to: [-33, 1, 25.5],
    fov: 46,
    devices: ['suit-01'],
  },
  { name: 'power', label: 'Power', from: [2, 6, 35], to: [18, 0.5, 18], fov: 46, devices: ['power-01'] },
  {
    name: 'flag',
    label: 'Agnes flag',
    from: [-0.5, 2.4, 27],
    to: [-4.6, 5.2, 12],
    fov: 46,
    devices: ['airlock-01', 'habitat-01'],
  },
  {
    name: 'comms',
    label: 'Comms & weather',
    from: [6, 3.4, -9],
    to: [-10, 2.8, -14],
    fov: 48,
    devices: ['comms-01', 'weather-01'],
  },
  {
    name: 'hopper',
    label: 'Following the hopper',
    from: [36, 6, 8],
    to: [27, 1, 8],
    fov: 50,
    devices: ['hopper-01'],
    follow: 'hopper-01',
  },
  {
    name: 'monolith',
    label: `Following ${MONOLITH.name}`,
    from: [8, 3, 22],
    to: [3.4, 1, 15.4],
    fov: 50,
    devices: [MONOLITH.id],
    follow: MONOLITH.id,
    behind: [6, 2.2, 1.25],
  },
]

export function applyShot(camera: THREE.PerspectiveCamera, name: string): string {
  const shot = SHOTS.find((s) => s.name === name) ?? (SHOTS[0] as (typeof SHOTS)[number])
  camera.position.set(...shot.from)
  camera.lookAt(...shot.to)
  camera.fov = shot.fov ?? 42
  camera.updateProjectionMatrix()
  return shot.name
}
