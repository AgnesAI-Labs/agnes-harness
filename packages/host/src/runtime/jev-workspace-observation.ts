import { resolve } from 'node:path'
import { canonicalJson, type SessionImpl, sha256Hex } from '@agnes/core'
import type { EnvironmentEpoch, JsonValue } from '@agnes/jev-runtime'

/** Enumerate only the host-selected root through its revocable, policy-fenced capability. */
export async function observeJevWorkspace(
  session: SessionImpl,
  epoch: EnvironmentEpoch,
  maxEntries: number,
  signal: AbortSignal,
): Promise<JsonValue> {
  signal.throwIfAborted()
  const base = {
    kind: 'jev.workspace-directory.v1',
    root: session.d.cwd,
    environmentEpoch: epoch,
    limit: maxEntries,
    sourceEnumeration: 'agnes-workspace-fs-list-stat',
    ioBounded: false,
    // Stat metadata is a change indicator, not a content digest or execution authorization.
    versionSource: 'stat-kind-size-mtime-v1',
  } as const
  const unavailable = (code: string): JsonValue => ({
    ...base,
    status: 'unavailable',
    entries: [],
    complete: false,
    omitted: null,
    error: { code },
  })
  const port = session.d.workspaceInvocation
  if (!port) return unavailable('FS_UNAVAILABLE')
  try {
    const handler: Parameters<typeof port.run<JsonValue>>[0] = async (view) => {
      await view.ready(signal)
      signal.throwIfAborted()
      const fs = view.fs()
      const listed = await fs.list(session.d.cwd)
      signal.throwIfAborted()
      const entries: JsonValue[] = []
      let denied = 0
      let inaccessible = 0
      let authorized = 0
      const seen = new Set<string>()
      for (const entry of [...listed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        signal.throwIfAborted()
        if (
          !entry.name ||
          entry.name === '.' ||
          entry.name === '..' ||
          /[/\\\0]/u.test(entry.name) ||
          seen.has(entry.name)
        ) {
          inaccessible++
          continue
        }
        seen.add(entry.name)
        try {
          // list() authorizes the directory, not each child. stat() applies the actual child policy,
          // including symlink targets; a denied name must never be sent to the decision backend.
          const stat = await fs.stat(resolve(session.d.cwd, entry.name))
          signal.throwIfAborted()
          authorized++
          if (entries.length >= maxEntries) continue
          entries.push({
            path: entry.name,
            kind: stat.kind === 'dir' ? 'directory' : stat.kind,
            size: stat.size,
            version: sha256Hex(canonicalJson({ kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs })),
          })
        } catch (error) {
          signal.throwIfAborted()
          if (
            error instanceof Error &&
            (('code' in error && error.code === 'E_FS_DENIED') || error.message.includes('E_FS_DENIED'))
          )
            denied++
          else inaccessible++
        }
      }
      signal.throwIfAborted()
      return {
        ...base,
        status: 'observed',
        entries,
        complete: authorized === entries.length && denied === 0 && inaccessible === 0,
        omitted: listed.length - entries.length,
        deniedEntries: denied,
        inaccessibleEntries: inaccessible,
      }
    }
    return session.d.workspacePublication
      ? await session.d.workspacePublication.workspace(() => ({ port, handler }))
      : await port.run(handler)
  } catch (error) {
    signal.throwIfAborted()
    return unavailable(
      error instanceof Error && 'code' in error && error.code === 'E_FS_DENIED'
        ? 'E_FS_DENIED'
        : 'FS_OBSERVATION_FAILED',
    )
  }
}
