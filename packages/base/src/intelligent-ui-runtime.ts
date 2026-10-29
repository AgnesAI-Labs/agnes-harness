/** Process-local serial tail and cursor MAC for the official plugin. Not a package export. */
import { createHmac, randomBytes } from 'node:crypto'
import type { OwnerLedgerPort } from '@agnes/extension-api'
import { UI_EVENTS } from '@agnes/intelligent-ui-contract'
import type { EventEnvelope } from '@agnes/protocol'

interface SharedRuntime {
  tail: Promise<unknown>
  secret: Buffer
}

const runtimes = new Map<string, SharedRuntime>()

/** Cursor secret and action serialization survive a new bind of the same session. */
export function uiSerial(ports: {
  binding: {
    readonly generationId?: string
    readonly session?: { readonly key?: string; readonly lane?: string }
  }
}): { serial: <T>(work: () => Promise<T>) => Promise<T>; secret: Buffer } {
  const session = ports.binding.session
  const key = `${ports.binding.generationId ?? ''}\0${session?.key ?? ''}\0${session?.lane ?? ''}`
  let slot = runtimes.get(key)
  if (!slot) {
    slot = { tail: Promise.resolve(), secret: randomBytes(32) }
    runtimes.set(key, slot)
  }
  const shared = slot
  return {
    serial<T>(work: () => Promise<T>): Promise<T> {
      const result = shared.tail.then(work, work)
      shared.tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    secret: shared.secret,
  }
}

/** Page until the ledger cursor ends. `through` drops rows newer than a pinned read. */
export async function scanOwnUiEvents(ledger: OwnerLedgerPort, through: number): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = []
  let cursor: string | undefined
  do {
    const page = await ledger.scanOwn({
      names: UI_EVENTS,
      limit: 256,
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const event of page.events) {
      if (event.seq > through) return events
      events.push(event)
    }
    cursor = page.nextCursor
  } while (cursor)
  return events
}

export function uiCursorMac(secret: Buffer, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}
