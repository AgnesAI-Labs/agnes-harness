import type { EventEnvelope } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'

/** Read a fresh SDK session's replay through the stable projection watermark. */
export async function readSessionEvents(session: Session): Promise<EventEnvelope[]> {
  const { upto } = await session.projectUI()
  if (upto === 0) return []
  const rows: EventEnvelope[] = []
  try {
    for await (const event of session.events()) {
      if (event.seq <= upto) rows.push(event)
      if (event.seq >= upto) break
    }
  } finally {
    await session.detach()
  }
  return rows
}
