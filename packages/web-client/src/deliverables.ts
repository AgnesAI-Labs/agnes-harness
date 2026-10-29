import type { ArtifactRef, SessionDeliverableSource, UINode, UITimeline, UITurn } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import {
  UiArtifactFileData,
  type UiArtifactStatus,
  type UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import { applyUITimelinePatch, type Client, type Session } from '@agnes/sdk/browser'
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

type PresentResult = {
  surfaceId: string
  rows: ReturnType<typeof deliveredFiles>
  laneId?: string
  owner?: string
}

/** One durable present call with a result, in the order the projection lists tool calls. */
type PresentSource = Readonly<{
  callSeq: number
  toolUseId: string
  turnId?: string
  read: () => Promise<PresentResult>
}>

const DELIVERABLES_METHOD = '_agnes/v1/session.deliverables'

/** A listed file surface the deliverables read cannot file under a turn; the projection can. */
class SurfaceTurnUnknown extends Error {}

/** Between refreshes only node identity, turn bounds and present calls are needed to apply patches. */
function retained(timeline: UITimeline): UITimeline {
  const { sessionId, generation, upto, opState } = timeline
  return {
    sessionId,
    generation,
    upto,
    opState,
    nodes: timeline.nodes.map((node) =>
      node.kind === 'tool' && node.name === 'present'
        ? ({
            id: node.id,
            kind: node.kind,
            name: node.name,
            seq: node.seq,
            toolUseId: node.toolUseId,
            ...(node.resultSeq === undefined ? {} : { resultSeq: node.resultSeq }),
          } as UINode)
        : ({ id: node.id } as UINode),
    ),
    turns: timeline.turns.map(
      ({ id, startSeq, endSeq }) => ({ id, startSeq, ...(endSeq === undefined ? {} : { endSeq }) }) as UITurn,
    ),
  }
}

/** Authorized SDK reads only. No attach/filter mutation, filesystem reads or retained file content. */
export class DeliverablesStore {
  private snapshot: DeliverablesSnapshot = { files: [], loading: true }
  private readonly listeners = new Set<() => void>()
  private readonly stops: (() => void)[] = []
  private detach: (() => void) | undefined
  private generation = 0
  private disposed = false
  private running = false
  private requested = false
  // This connection's projection baseline. Durable present results are immutable per ledger
  // generation and are kept for the readiness epoch that read them.
  private timeline: UITimeline | undefined
  private baseline = 0
  // Per baseline: whether present results come from session.deliverables or from the projection.
  private source: 'query' | 'projection' | undefined
  private presents = new Map<string, PresentResult>()
  constructor(
    private readonly client: Client,
    private readonly session: SessionService,
  ) {
    const switchSession = () => {
      this.generation++
      this.dropBaseline()
      this.presents = new Map()
      this.detach?.()
      const id = session.sessionId
      const readiness = session.readiness.getSnapshot()
      this.set({
        ...(id ? { sessionId: id } : {}),
        files: [],
        loading: !!id && (readiness.status === 'connecting' || readiness.status === 'ready'),
      })
      const handle = id && readiness.status === 'ready' ? client.sessions.get(id) : undefined
      const listener: Parameters<Session['listeners']['add']>[0] = () => {
        void this.refresh()
      }
      handle?.listeners.add(listener)
      this.detach = () => {
        handle?.listeners.delete(listener)
      }
      void this.refresh()
    }
    // A cold history preview and the admitted session share an id. Readiness epochs,
    // rather than identity changes alone, retire old reads and bind the ready handle.
    this.stops.push(session.readiness.subscribe(switchSession))
    // Daemon baselines belong to one connection and generation: start over with a full projection.
    for (const name of ['reconnected', 'gap', 'generationChanged'] as const)
      this.stops.push(
        client.on(name, () => {
          this.dropBaseline()
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
          sessionId = this.session.sessionId,
          presents = this.presents
        if (!sessionId || this.session.readiness.getSnapshot().status !== 'ready') continue
        try {
          const session = this.client.sessions.get(sessionId)
          if (!session) throw new Error('Session unavailable')
          const files = await this.read(session, presents)
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
  private dropBaseline() {
    this.baseline++
    this.timeline = undefined
    this.source = undefined
  }
  /** Announced in apis.list, as optional methods are; an older daemon or a failed listing is not. */
  private async offered(): Promise<boolean> {
    try {
      const apis = await this.client.apis()
      return apis.families.some((family) => family.methods.includes(DELIVERABLES_METHOD))
    } catch {
      return false
    }
  }
  /** A daemon that announces session.deliverables answers without a projection; otherwise project. */
  private async read(session: Session, presents: Map<string, PresentResult>): Promise<DeliverableRecord[]> {
    for (;;) {
      const baseline = this.baseline
      if (this.source === undefined) {
        const offered = await this.offered()
        // A baseline dropped meanwhile (a reconnect drops it more than once) is detected again: what
        // this listing saw no longer decides, and a full projection here would be the costly guess.
        if (baseline !== this.baseline) continue
        this.source = offered ? 'query' : 'projection'
      }
      if (this.source === 'query')
        try {
          return await readQueried(session)
        } catch {
          if (baseline !== this.baseline) continue
          // A refused or oversized page, or a surface only the projection can file: stay on the projection.
          this.source = 'projection'
        }
      return readDeliverables(session, await this.project(session), presents)
    }
  }
  /** The first read per baseline is a full projection; later reads patch it. */
  private async project(session: Session): Promise<UITimeline> {
    const baseline = this.baseline,
      current = this.timeline
    let next: UITimeline | undefined
    if (current)
      try {
        const update = await session.projectUIPatch(current.upto)
        next = update.kind === 'patch' ? applyUITimelinePatch(current, update.patch) : update.timeline
      } catch {
        /* Resync required, cursor mismatch or no patch support: fall back to a full projection. */
      }
    next = retained(next ?? (await session.projectUI()))
    if (baseline === this.baseline) this.timeline = next
    return next
  }
  dispose = () => {
    this.disposed = true
    this.generation++
    this.detach?.()
    for (const stop of this.stops) stop()
    this.listeners.clear()
  }
}

async function readPresent(
  session: Session,
  node: Extract<UINode, { kind: 'tool' }>,
  resultSeq: number,
): Promise<PresentResult> {
  const detail = await session.readToolDetail(node.seq, resultSeq)
  return presentResult(detail.result?.structured, node.toolUseId)
}

/** The display data a present result recorded; older results keep it only in their surface. */
async function presentResult(
  structured: SessionDeliverableSource['structured'],
  toolUseId: string,
): Promise<PresentResult> {
  const data = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : {}
  const surfaceId =
    typeof data.surfaceId === 'string'
      ? data.surfaceId
      : 'card-' +
        Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(toolUseId))),
          (byte) => byte.toString(16).padStart(2, '0'),
        )
          .join('')
          .slice(0, 48)
  return {
    surfaceId,
    rows: deliveredFiles(data.deliverables),
    ...(typeof data.laneId === 'string' ? { laneId: data.laneId } : {}),
    ...(typeof data.owner === 'string' ? { owner: data.owner } : {}),
  }
}

async function readDeliverables(
  session: Session,
  timeline: UITimeline,
  presents: Map<string, PresentResult>,
): Promise<DeliverableRecord[]> {
  const sources = timeline.nodes.flatMap((node): PresentSource[] => {
    if (node.kind !== 'tool' || node.name !== 'present' || !node.resultSeq) return []
    const key = `${timeline.generation}:${node.seq}:${node.resultSeq}`
    const resultSeq = node.resultSeq
    const turnId = turnOf(timeline.turns, node.seq)
    const read = async () => {
      const present = presents.get(key) ?? (await readPresent(session, node, resultSeq))
      presents.set(key, present)
      return present
    }
    return [{ callSeq: node.seq, toolUseId: node.toolUseId, ...(turnId ? { turnId } : {}), read }]
  })
  return assemble(session, sources, () => timeline.turns)
}

/**
 * Every page of session.deliverables from the start. A present call's own surface is rendered while
 * the call runs, so it is filed under the call's turn; any other file surface needs the projection.
 */
async function readQueried(session: Session): Promise<DeliverableRecord[]> {
  const items = new Map<number, SessionDeliverableSource>()
  for (let afterSeq: number | undefined = 0; afterSeq !== undefined; ) {
    const page = await session.deliverables({ afterSeq })
    for (const item of page.items) items.set(item.callSeq, item)
    afterSeq = page.nextAfterSeq
  }
  const sources: PresentSource[] = []
  const surfaceTurns = new Map<string, string | undefined>()
  for (const item of [...items.values()].sort((a, b) => a.callSeq - b.callSeq)) {
    const present = await presentResult(item.structured, item.toolUseId)
    const known = surfaceTurns.has(present.surfaceId)
    surfaceTurns.set(
      present.surfaceId,
      known && surfaceTurns.get(present.surfaceId) !== item.turnId ? undefined : item.turnId,
    )
    sources.push({
      callSeq: item.callSeq,
      toolUseId: item.toolUseId,
      ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
      read: async () => present,
    })
  }
  return assemble(session, sources, (record) => {
    const turnId = surfaceTurns.get(record.surface.id)
    // A turn spanning only the record's seq files it under the call's turn.
    return turnId === undefined
      ? undefined
      : [{ id: turnId, startSeq: record.createdSeq, endSeq: record.createdSeq } as UITurn]
  })
}

/** Surface copies first, then each present result in call order, merged into its enhanced copy. */
async function assemble(
  session: Session,
  sources: readonly PresentSource[],
  surfaceTurns: (record: UiSurfaceRecord) => readonly UITurn[] | undefined,
): Promise<DeliverableRecord[]> {
  const files: DeliverableRecord[] = []
  const fromSurface = (record: UiSurfaceRecord) => {
    const turns = surfaceTurns(record)
    const found = surfaceDeliverables(session.id, record, turns ?? [])
    if (!turns && found.length > 0) throw new SurfaceTurnUnknown()
    return found
  }
  // Surfaces are an optional enhancement. Durable tool results work when Intelligent UI is off.
  try {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await session.uiRead(cursor ? { cursor } : {})
      for (const record of page.surfaces) files.push(...fromSurface(record))
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Repeated UI cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
  } catch (error) {
    if (error instanceof SurfaceTurnUnknown) throw error
    /* Optional UI provider unavailable: use the durable present result below. */
  }
  for (const source of sources) {
    const { surfaceId, rows, laneId, owner } = await source.read()
    // Older present results kept display metadata only in the durable UI surface. Read closed ones by id too.
    if (!files.some((file) => file.source.surfaceId === surfaceId)) {
      try {
        const page = await session.uiRead({ surfaceId })
        for (const record of page.surfaces) files.push(...fromSurface(record))
      } catch (error) {
        if (error instanceof SurfaceTurnUnknown) throw error
        /* The optional UI provider may be absent. New results below remain sufficient. */
      }
    }
    const { turnId } = source
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
        id: `${session.id}:${laneId ?? match?.laneId ?? 'main'}:${source.toolUseId}:${index}`,
        sessionId: session.id,
        laneId: laneId ?? match?.laneId ?? 'main',
        source: {
          owner: owner ?? match?.source.owner ?? 'present',
          toolUseId: source.toolUseId,
          callSeq: source.callSeq,
        },
        ...(turnId ? { turnId } : {}),
        seq: source.callSeq,
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
