import type { ArtifactRef, UITimeline, UITurn } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import {
  UiArtifactFileData,
  type UiArtifactStatus,
  type UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import type { Client, Session } from '@agnes/sdk/browser'
import type { SessionService } from './services-session.js'

/** Read-only display contract. A ref names immutable bytes, never a mutable workspace path. */
export type DeliverableRecord = Readonly<{
  id: string
  sessionId: string
  laneId: string
  source: { owner: string; toolUseId?: string; callSeq?: number; surfaceId?: string }
  turnId?: string
  seq: number
  inline: boolean
  workbench: boolean
  artifactStatus?: UiArtifactStatus
  presentedAt?: number
  name: string
  description: string
  artifact: ArtifactRef
}>
export type DeliverablesSnapshot = Readonly<{
  sessionId?: string
  files: readonly DeliverableRecord[]
  loading: boolean
  error?: string
}>
const turnOf = (turns: readonly UITurn[], seq: number) =>
  turns.find((turn) => seq >= turn.startSeq && (turn.endSeq === undefined || seq <= turn.endSeq))?.id

/** Historical file-list surfaces use the very same artifact contract as durable present results. */
export function surfaceDeliverables(
  sessionId: string,
  record: UiSurfaceRecord,
  turns: readonly UITurn[] = [],
): DeliverableRecord[] {
  const { surface } = record
  if (
    !surface.components.length ||
    !surface.components.every((component) => component.kind === 'artifact-file')
  )
    return []
  const turnId = turnOf(turns, record.createdSeq)
  return surface.components.flatMap((component, index) => {
    if (!('dataKey' in component)) return []
    const file = validateAgainst<UiArtifactFileData>(UiArtifactFileData, surface.data[component.dataKey])
    return file.ok
      ? [
          {
            id: `${sessionId}:${record.lane}:${surface.id}:${index}`,
            sessionId,
            laneId: record.lane,
            source: { owner: record.owner, surfaceId: surface.id },
            inline: surface.placement.inline,
            workbench: surface.placement.workbench,
            ...((record.artifacts as Record<string, UiArtifactStatus> | undefined)?.[component.id]
              ? { artifactStatus: (record.artifacts as Record<string, UiArtifactStatus>)[component.id]! }
              : {}),
            ...(turnId ? { turnId } : {}),
            seq: record.createdSeq,
            ...(typeof surface.data.presentedAt === 'number'
              ? { presentedAt: surface.data.presentedAt }
              : {}),
            ...file.value,
          },
        ]
      : []
  })
}

export function deliveredFiles(
  value: unknown,
): { name: string; description: string; artifact: ArtifactRef }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const file = item as Record<string, unknown>
    const parsed = validateAgainst<UiArtifactFileData>(UiArtifactFileData, {
      name: file.name,
      description: file.description,
      artifact: file.ref,
    })
    return parsed.ok ? [parsed.value] : []
  })
}

/** Authorized SDK reads only. No attach/filter mutation, filesystem reads or retained content cache. */
export class DeliverablesStore {
  private snapshot: DeliverablesSnapshot = { files: [], loading: true }
  private readonly listeners = new Set<() => void>()
  private readonly stops: (() => void)[] = []
  private detach: (() => void) | undefined
  private generation = 0
  private disposed = false
  private running = false
  private requested = false
  constructor(
    private readonly client: Client,
    private readonly session: SessionService,
  ) {
    const switchSession = () => {
      this.generation++
      this.detach?.()
      const id = session.sessionId
      this.set({ ...(id ? { sessionId: id } : {}), files: [], loading: !!id })
      const handle = id ? client.sessions.get(id) : undefined
      const listener: Parameters<Session['listeners']['add']>[0] = () => {
        void this.refresh()
      }
      handle?.listeners.add(listener)
      this.detach = () => {
        handle?.listeners.delete(listener)
      }
      void this.refresh()
    }
    this.stops.push(session.subscribe(switchSession))
    for (const name of ['reconnected', 'gap', 'generationChanged'] as const)
      this.stops.push(
        client.on(name, () => {
          void this.refresh()
        }),
      )
    switchSession()
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(snapshot: DeliverablesSnapshot) {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  refresh = async (): Promise<void> => {
    this.requested = true
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (this.requested && !this.disposed) {
        this.requested = false
        const generation = this.generation,
          sessionId = this.session.sessionId
        if (!sessionId) continue
        try {
          const session = this.client.sessions.get(sessionId)
          if (!session) throw new Error('Session unavailable')
          const timeline = await session.projectUI()
          const files = await readDeliverables(session, timeline)
          if (!this.disposed && generation === this.generation) this.set({ sessionId, files, loading: false })
        } catch {
          if (!this.disposed && generation === this.generation)
            this.set({ ...this.snapshot, loading: false, error: 'Deliverables unavailable' })
        }
      }
    } finally {
      this.running = false
    }
  }
  dispose = () => {
    this.disposed = true
    this.generation++
    this.detach?.()
    for (const stop of this.stops) stop()
    this.listeners.clear()
  }
}

async function readDeliverables(session: Session, timeline: UITimeline): Promise<DeliverableRecord[]> {
  const files: DeliverableRecord[] = []
  // Surfaces are an optional enhancement. Durable tool results work when Intelligent UI is off.
  try {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await session.uiRead(cursor ? { cursor } : {})
      for (const record of page.surfaces)
        files.push(...surfaceDeliverables(session.id, record, timeline.turns))
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Repeated UI cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
  } catch {
    /* Optional UI provider unavailable: use the durable present result below. */
  }
  for (const node of timeline.nodes) {
    if (node.kind !== 'tool' || node.name !== 'present' || !node.resultSeq) continue
    const detail = await session.readToolDetail(node.seq, node.resultSeq)
    const result = detail.result
    const structured = result?.structured
    const data = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : {}
    const surfaceId =
      typeof data.surfaceId === 'string'
        ? data.surfaceId
        : 'card-' +
          Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(node.toolUseId))),
            (byte) => byte.toString(16).padStart(2, '0'),
          )
            .join('')
            .slice(0, 48)
    // Older present results kept display metadata only in the durable UI surface. Read closed ones by id too.
    if (!files.some((file) => file.source.surfaceId === surfaceId)) {
      try {
        const page = await session.uiRead({ surfaceId })
        for (const record of page.surfaces)
          files.push(...surfaceDeliverables(session.id, record, timeline.turns))
      } catch {
        /* The optional UI provider may be absent. New results below remain sufficient. */
      }
    }
    const rows = deliveredFiles(data.deliverables)
    const turnId = turnOf(timeline.turns, node.seq)
    // A surface inside this exact call is the enhanced copy of the same presentation.
    const enhanced = files.filter((file) => file.source.surfaceId === surfaceId)
    rows.forEach((file, index) => {
      const match = enhanced.find(
        (entry) =>
          entry.name === file.name &&
          entry.artifact.sha256 === file.artifact.sha256 &&
          entry.artifact.size === file.artifact.size &&
          entry.artifact.mime === file.artifact.mime,
      )
      if (match) {
        files.splice(files.indexOf(match), 1)
        enhanced.splice(enhanced.indexOf(match), 1)
      }
      files.push({
        ...file,
        id: `${session.id}:${typeof data.laneId === 'string' ? data.laneId : (match?.laneId ?? 'main')}:${node.toolUseId}:${index}`,
        sessionId: session.id,
        laneId: typeof data.laneId === 'string' ? data.laneId : (match?.laneId ?? 'main'),
        source: {
          owner: typeof data.owner === 'string' ? data.owner : (match?.source.owner ?? 'present'),
          toolUseId: node.toolUseId,
          callSeq: node.seq,
        },
        ...(turnId ? { turnId } : {}),
        seq: node.seq,
        inline: match?.inline ?? true,
        workbench: match?.workbench ?? true,
        ...(match?.artifactStatus ? { artifactStatus: match.artifactStatus } : {}),
        ...(match?.presentedAt === undefined ? {} : { presentedAt: match.presentedAt }),
      })
    })
  }
  return files.sort((a, b) => a.seq - b.seq)
}

/** Same-name history is a display grouping, not a lineage claim. Newest copy of each content wins. */
export function groupDeliveredFiles(
  files: readonly DeliverableRecord[],
): { latest: DeliverableRecord; earlier: DeliverableRecord[] }[] {
  const byName = new Map<string, DeliverableRecord[]>()
  for (const file of [...files].sort((a, b) => a.seq - b.seq)) {
    const versions = byName.get(file.name) ?? []
    const same = versions.findIndex(
      (other) =>
        other.artifact.sha256 === file.artifact.sha256 &&
        other.artifact.size === file.artifact.size &&
        other.artifact.mime === file.artifact.mime,
    )
    if (same >= 0) versions.splice(same, 1)
    versions.push(file)
    byName.set(file.name, versions)
  }
  return [...byName.values()].map((versions) => {
    const newest = versions.at(-1)!
    const candidate = [...versions]
      .reverse()
      .find(
        (file) => !['not_found', 'identity_mismatch', 'reclaimed'].includes(file.artifactStatus ?? 'unknown'),
      )
    const latest = candidate?.artifactStatus === 'available' ? candidate : newest
    return { latest, earlier: versions.filter((file) => file !== latest).reverse() }
  })
}
