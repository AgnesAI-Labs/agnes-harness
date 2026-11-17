import type { EventEnvelope } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'

/** One case owns one stable cut; call only after its business writes have settled. */
export function createSessionEventSnapshot(session: Session): () => Promise<EventEnvelope[]> {
  let snapshot: Promise<EventEnvelope[]> | undefined
  return () => (snapshot ??= readSessionEvents(session))
}

/** Read a fresh SDK session's replay through the stable projection watermark. */
export async function readSessionEvents(session: Session): Promise<EventEnvelope[]> {
  const { upto } = await session.projectUI()
  if (upto === 0) return []
  const rows: EventEnvelope[] = []
  let failure: { error: unknown } | undefined
  try {
    for await (const event of session.events()) {
      if (event.seq !== rows.length + 1) throw new Error(`Incomplete session replay at seq ${event.seq}`)
      if (event.seq <= upto) rows.push(event)
      if (event.seq >= upto) break
    }
    if (rows.at(-1)?.seq !== upto) throw new Error(`Session replay ended before watermark ${upto}`)
  } catch (error) {
    failure = { error }
  }
  try {
    await session.detach()
  } catch (error) {
    failure ??= { error }
  }
  if (failure) throw failure.error
  return rows
}
