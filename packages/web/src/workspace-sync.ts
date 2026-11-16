import type { WorkspaceEntry } from '@agnes/protocol'

type Port = {
  /** The workspaces the page knows now; undefined before it first read them, when there is nothing to miss yet. */
  known(): readonly WorkspaceEntry[] | undefined
  read(): Promise<{ items: WorkspaceEntry[] }>
  /** Takes a freshly read list; it changes neither the open session nor any group's pages. */
  apply(page: { items: WorkspaceEntry[] }): void
}

/**
 * Keeps the page's workspace list up with the sidebar's groups. Another client, such as an app opening a session in a
 * directory of its own, registers workspaces after this page read the list; the daemon then groups that session under
 * a workspace the page does not know, and the group could only show as unassigned. A group naming an unknown
 * workspace reads the list again, once for that workspace: one the list still lacks after that is not read for again on
 * every refresh. A read that fails leaves it to the next change to try again. Reads run one after another.
 */
export function createWorkspaceSync(port: Port) {
  const asked = new Set<string>()
  let reading: Promise<void> = Promise.resolve()
  return {
    reconcile(groups: readonly { workspaceId?: string | undefined }[]): Promise<void> {
      const rows = port.known()
      if (!rows) return reading
      const known = new Set(rows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : [])))
      const unknown = [
        ...new Set(
          groups.flatMap((group) =>
            group.workspaceId && !known.has(group.workspaceId) && !asked.has(group.workspaceId)
              ? [group.workspaceId]
              : [],
          ),
        ),
      ]
      if (!unknown.length) return reading
      for (const id of unknown) asked.add(id)
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
