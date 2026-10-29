import { scanAll } from '@agnes/core'
import type { LocalArtifactReadStore } from '@agnes/host-artifacts/artifact-read-store'
import {
  ARTIFACT_REGISTERED_EVENT,
  type ArtifactRef,
  sessionArtifactRoots,
  validateAgainst,
} from '@agnes/protocol'
import {
  UiArtifactFileData,
  type UiArtifactStatus,
  type UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import type { HostSession } from '../lifecycle/host.js'

/** Incremental, session-owned ledger projection. Only trusted roots, never surface payloads. */
export function createUiArtifactChecker(store: LocalArtifactReadStore) {
  const sessions = new WeakMap<
    HostSession,
    { through: number; lane: string; roots: Map<string, number | undefined> }
  >()
  return async (session: HostSession, ref: ArtifactRef, signal: AbortSignal): Promise<UiArtifactStatus> => {
    signal.throwIfAborted()
    if (session.closingOrClosed) return 'unavailable'
    try {
      const through = session.lastSeq
      let cached = sessions.get(session)
      if (!cached || cached.lane !== session.lane || cached.through > through)
        cached = { through: 0, lane: session.lane, roots: new Map() }
      if (cached.through < through) {
        const roots = new Map(cached.roots)
        const rows = await scanAll((query) => session.scan(query), {
          type: [ARTIFACT_REGISTERED_EVENT, 'tool/result', 'request/header'],
          lane: session.lane,
          fromSeq: Math.max(cached.through, session.d.log.parent?.boundarySeq ?? 0) + 1,
          toSeq: through,
        })
        for (const row of rows) {
          if ((row.lane ?? 'main') !== session.lane) continue
          for (const root of sessionArtifactRoots(row) ?? []) {
            const key = `${root.sha256}:${root.mime}`
            // A legacy root cannot overwrite exact registration metadata.
            if (root.size !== undefined || !roots.has(key)) roots.set(key, root.size)
          }
        }
        signal.throwIfAborted()
        if (session.closingOrClosed) return 'unavailable'
        cached = { through, lane: session.lane, roots }
        sessions.set(session, cached)
      }
      const roots = cached.roots
      const key = `${ref.sha256}:${ref.mime}`
      if (!roots.has(key))
        return [...roots.keys()].some((key) => key.startsWith(`${ref.sha256}:`))
          ? 'identity_mismatch'
          : 'not_found'
      const size = roots.get(key)
      if (size !== undefined && size !== ref.size) return 'identity_mismatch'
      const status = await store.status(ref, signal)
      signal.throwIfAborted()
      // A registered provider ref does not promise bytes through this local Web adapter.
      return session.closingOrClosed || (size !== undefined && status === 'not_found')
        ? 'unavailable'
        : status
    } catch {
      signal.throwIfAborted()
      return 'unavailable'
    }
  }
}

/** Current Host facts also decorate records returned by a retained older UI provider. */
export async function withUiArtifactStatuses(
  record: UiSurfaceRecord,
  check: (ref: ArtifactRef, signal: AbortSignal) => Promise<UiArtifactStatus>,
  signal: AbortSignal,
): Promise<UiSurfaceRecord> {
  const artifacts: Record<string, UiArtifactStatus> = {}
  for (const component of record.surface.components) {
    if ('fallback' in component || component.kind !== 'artifact-file') continue
    signal.throwIfAborted()
    const file = validateAgainst<UiArtifactFileData>(
      UiArtifactFileData,
      record.surface.data[component.dataKey],
    )
    try {
      artifacts[component.id] = file.ok ? await check(file.value.artifact, signal) : 'identity_mismatch'
    } catch {
      signal.throwIfAborted()
      artifacts[component.id] = 'unavailable'
    }
  }
  signal.throwIfAborted()
  return Object.keys(artifacts).length ? { ...record, artifacts } : record
}
