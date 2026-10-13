import type { SessionLister } from '@agnes/daemon-foundation/local/ports'
import type { PluginGenerationStatus } from '@agnes/protocol'

const MAX_PAGES = 8

/**
 * Names the sessions a generation still holds and says which are mid-turn, so a person choosing
 * what to migrate reads titles rather than keys. The worker knows the pins; the daemon knows what
 * each session is called and whether it is running. A title that cannot be read is left out: the
 * list stays usable by key.
 */
export async function describeGenerationSessions(
  status: PluginGenerationStatus,
  deps: { lister: Pick<SessionLister, 'list'>; running(sessionKey: string): boolean },
): Promise<PluginGenerationStatus> {
  const keys = [
    ...new Set(status.generations.flatMap((generation) => (generation.sessions ?? []).map(({ key }) => key))),
  ]
  const titles = new Map<string, string>()
  try {
    let cursor: string | undefined
    for (let page = 0; keys.length > 0 && page < MAX_PAGES; page++) {
      const result = await deps.lister.list({ sessionIds: keys, limit: 256, ...(cursor ? { cursor } : {}) })
      for (const row of result.items) if (row.title) titles.set(row.sessionId, row.title.slice(0, 512))
      cursor = result.cursor
      if (!cursor) break
    }
  } catch {
    // Titles are a reading aid; the pins and counts above them are the facts.
  }
  return {
    ...status,
    generations: status.generations.map((generation) =>
      generation.sessions
        ? {
            ...generation,
            sessions: generation.sessions.map((session) => {
              const title = titles.get(session.key)
              return {
                ...session,
                ...(title ? { title } : {}),
                run: deps.running(session.key) ? ('running' as const) : ('idle' as const),
              }
            }),
          }
        : generation,
    ),
  }
}
