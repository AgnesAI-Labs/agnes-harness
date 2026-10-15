import type { Device } from '@agnes/mhs-device'
import type { MarsConnection } from './runtime.js'

export const MARS_PACKAGE_ID = '@agnes-example/mars-rescue' as const
/** MHS-owned Cordis service `mhsExampleAccess`; implementations enforce the reviewed child link. */
export interface MarsExampleAccess {
  connect(example: typeof MARS_PACKAGE_ID, device: Device, signal: AbortSignal): Promise<MarsConnection>
  /** Use the generic owner-bound launch facade; return only after its session id is known. */
  launch(
    example: typeof MARS_PACKAGE_ID,
    launchId: 'rescue' | 'sample',
    operationId: string,
  ): Promise<{ sessionId: string }>
}
