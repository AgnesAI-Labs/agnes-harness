import type { WorkspaceEntry } from '@agnes/protocol'

type Port = {
  /** The workspaces the page knows now; undefined before it first read them, when there is nothing to miss yet. */
  known(): readonly WorkspaceEntry[] | undefined
  read(): Promise<{ items: WorkspaceEntry[] }>
  /** Takes a freshly read list; it changes neither the open session nor any group's pages. */
  apply(page: { items: WorkspaceEntry[] }): void
  /** Milliseconds now; the clock by default. */
  now?(): number
}

/** How long a workspace a read did not find waits before the list is read for it again. */
export const UNKNOWN_WORKSPACE_RETRY_MS = 30_000

/**
 * Keeps the page's workspace list up with the sidebar's groups. Another client, such as an app opening a session in a
 * directory of its own, registers workspaces after this page read the list; the daemon then groups that session under
 * a workspace the page does not know, and the group could only show as unassigned. A group naming an unknown
 * workspace reads the list again; one the list still lacks then waits `UNKNOWN_WORKSPACE_RETRY_MS` before it is read
 * for again, so neither every refresh reads the list nor a workspace that appears later stays unknown. A read that
 * fails leaves it to the next change to try again. Reads run one after another.
 */
export function createWorkspaceSync(port: Port) {
  /** When the list was last read for each workspace it lacked; a workspace it has is forgotten. */
  const asked = new Map<string, number>()
  const now = () => port.now?.() ?? Date.now()
  let reading: Promise<void> = Promise.resolve()
  return {
    reconcile(groups: readonly { workspaceId?: string | undefined }[]): Promise<void> {
      const rows = port.known()
      if (!rows) return reading
      const known = new Set(rows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : [])))
      for (const id of known) asked.delete(id)
      const at = now()
      const unknown = [
        ...new Set(
          groups.flatMap((group) => {
            const id = group.workspaceId
            if (!id || known.has(id)) return []
            const last = asked.get(id)
            return last !== undefined && at - last < UNKNOWN_WORKSPACE_RETRY_MS ? [] : [id]
          }),
        ),
      ]
      if (!unknown.length) return reading
      for (const id of unknown) asked.set(id, at)
      reading = reading.then(async () => {
        try {
          port.apply(await port.read())
        } catch {
          for (const id of unknown) asked.delete(id)
        }
      })
      return reading
    },
  }
}
