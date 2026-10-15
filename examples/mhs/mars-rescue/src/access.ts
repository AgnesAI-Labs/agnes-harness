import type { Device } from '@agnes/mhs-device'
import type { MarsConnection } from './runtime.js'

export const MARS_PACKAGE_ID = '@agnes-example/mars-rescue' as const
/** MHS-owned reviewed device connector. Agent launch uses the Examples page host. */
export interface MarsExampleAccess {
  connect(example: typeof MARS_PACKAGE_ID, device: Device, signal: AbortSignal): Promise<MarsConnection>
}
