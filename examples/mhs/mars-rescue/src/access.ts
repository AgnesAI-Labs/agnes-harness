import type { Device } from '@agnes/mhs-device'
import type { ExampleLaunches } from '@agnes/sdk/browser'
import type { MarsConnection } from './runtime.js'

export const MARS_PACKAGE_ID = '@agnes-example/mars-rescue' as const
/** MHS-owned service; the parent delegates its real owner-bound launch facade. */
export interface MarsExampleAccess {
  connect(example: typeof MARS_PACKAGE_ID, device: Device, signal: AbortSignal): Promise<MarsConnection>
  launch: ExampleLaunches
}

/** Keep both ticket and operation id after an uncertain response; never silently create a new session. */
export async function launchMarsAgent(
  launch: ExampleLaunches,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string,
  launchId: 'rescue' | 'sample',
): Promise<{ sessionId: string }> {
  const saved = storage.getItem(key)
  const pending: unknown = saved ? JSON.parse(saved) : { operationId: crypto.randomUUID() }
  if (
    !pending ||
    typeof pending !== 'object' ||
    !('operationId' in pending) ||
    typeof pending.operationId !== 'string' ||
    !pending.operationId ||
    ('launchTicket' in pending && typeof pending.launchTicket !== 'string')
  )
    throw new Error('invalid-pending-launch')
  storage.setItem(key, JSON.stringify(pending))
  let ticket = 'launchTicket' in pending ? (pending.launchTicket as string) : undefined
  if (!ticket) {
    const prepared = await launch.prepare(MARS_PACKAGE_ID, launchId)
    if (!prepared.launchTicket) throw new Error('launch-outcome-unknown')
    ticket = prepared.launchTicket
    storage.setItem(key, JSON.stringify({ operationId: pending.operationId, launchTicket: ticket }))
  }
  const result = await launch.start(ticket, pending.operationId)
  if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error('launch-outcome-unknown')
  storage.removeItem(key)
  return result
}
