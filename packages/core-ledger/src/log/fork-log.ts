import { CoreError, type Event, type EventInput, type Seq, type SessionKey } from '@agnes/core-common/types'
import type { ThinkingLevel } from '@agnes/protocol'
import {
  type ForkBase,
  forkBaseProviders,
  forkChecks,
  forkPaths,
  pageYield,
  seededLogs,
} from './fork-seed.js'
import {
  INTEGRITY_PAGE_SIZE,
  type IntegrityState,
  LedgerIntegrityFailure,
  verifyIntegrityRows,
} from './integrity.js'
import type { OpenLogOptions, SessionLogImpl } from './session-log.js'
import type { IntegrityRow, StorageAdapter } from './storage.js'

type ForkOpeners = {
  cold(options: OpenLogOptions): Promise<SessionLogImpl>
  live(
    options: OpenLogOptions,
    parent: { key: SessionKey; boundarySeq: Seq },
    start: IntegrityState,
    seed: { base: ForkBase; inherited: Event[] },
    check: () => void,
  ): Promise<SessionLogImpl>
}

export async function forkInto(
  parent: SessionLogImpl,
  o: OpenLogOptions,
  integrityState: IntegrityState,
  openers: ForkOpeners,
  boundarySeq: Seq,
  childKey: SessionKey,
  opener: {
    actor: Event['actor']
    agnesVersion: string
    preset: string | null
    permission?: 'read-only' | 'workspace-write' | 'full-access'
    resolvedProfileHash: string | null
    resolvedPresetHash?: string
    writerRunId: string
    commitCheck?: () => void
    lane: string
    loop?: { id: string; version: string }
    modelSelections?: Array<{
      slot: string
      route: string
      model: string
      thinking?: ThinkingLevel
      contextWindow?: number
    }>
    delegation?: {
      kind: 'fork' | 'spawn'
      creationId: string
      rootTaskId: string
      generationDepth: number
    }
  },
): Promise<SessionLogImpl> {
  const historyCheck = parent.forkCheck()
  const checkParent = () => {
    historyCheck()
    opener.commitCheck?.()
  }
  if (!Number.isSafeInteger(boundarySeq) || boundarySeq < 1 || boundarySeq > parent.lastSeq)
    throw new CoreError('E_SURFACE_RANGE', 'fork boundary out of range', {
      boundarySeq,
      lastSeq: parent.lastSeq,
    })

  // A delegated child of a live parent starts from the parent's own state at a fork point at or
  // before the boundary. The point is taken synchronously, before anything else can append.
  const provider = opener.delegation ? forkBaseProviders.get(parent) : undefined
  const base = provider?.(boundarySeq, opener.lane)
  let boundaryState: IntegrityState | undefined
  let inherited: IntegrityRow[] = []
  if (base?.kind === 'head') boundaryState = { ...integrityState }
  else if (base?.kind === 'trigger') {
    // This writer appends no legacy rows, so the legacy boundary it opened with still holds at c.
    const atTrigger = {
      lastSeq: base.seq,
      legacyThroughSeq: integrityState.legacyThroughSeq,
      headDigest: base.headDigest,
    }
    const range = await verifiedRange(o.storage, o.key, atTrigger, boundarySeq, checkParent)
    checkParent()
    boundaryState = range.state
    inherited = range.rows
  }
  checkParent()
  await o.storage.createChild(o.key, boundarySeq, childKey)
  checkParent()
  // Parent callbacks close over the parent's tracker and surface. The child is attached to its
  // own callbacks by the higher-level session assembler; inheriting these would cross-contaminate
  // the two branch projections as soon as session/start is appended.
  const childOptions: OpenLogOptions = {
    storage: o.storage,
    key: childKey,
    writerRunId: opener.writerRunId,
    ttlMs: o.ttlMs,
    ids: o.ids,
    clock: o.clock,
    ...(o.timers ? { timers: o.timers } : {}),
  }
  const child =
    base && boundaryState
      ? await openers.live(
          childOptions,
          { key: o.key, boundarySeq },
          boundaryState,
          {
            base,
            inherited: inherited.map((row) => row.event),
          },
          checkParent,
        )
      : await openers.cold(childOptions)
  if (opener.delegation)
    forkPaths.set(
      child,
      base && boundaryState
        ? { path: 'live-parent' }
        : { path: 'cold-open', reason: provider ? 'no-fork-point' : 'no-tracker' },
    )
  try {
    checkParent()
    forkChecks.set(child, checkParent)
    if (child.lastSeq > boundarySeq) {
      const own = seededLogs.get(child)?.own
      const [start] = own
        ? own
        : await child.scan({ fromSeq: boundarySeq + 1, toSeq: boundarySeq + 1, limit: 1 })
      const parent = (start?.data as { parent?: { key?: unknown; boundarySeq?: unknown } } | null)?.parent
      if (start?.type !== 'session/start' || parent?.key !== o.key || parent.boundarySeq !== boundarySeq)
        throw new CoreError('E_STORAGE_FAULT', 'existing fork child has invalid ancestry start', {
          childKey,
        })
      checkParent()
      return child
    }
    await child.append(
      [
        {
          type: 'session/start',
          actor: opener.actor,
          origin: 'system',
          trust: 'trusted',
          data: {
            key: childKey,
            ...(opener.loop ? { loop: { ...opener.loop } } : {}),
            parent: { key: o.key, boundarySeq },
            resolvedProfileHash: opener.resolvedProfileHash,
            ...(opener.resolvedPresetHash ? { resolvedPresetHash: opener.resolvedPresetHash } : {}),
            preset: opener.preset,
            ...(opener.permission ? { permission: opener.permission } : {}),
            agnesVersion: opener.agnesVersion,
            ...(opener.delegation ? { delegation: opener.delegation } : {}),
          },
        },
        {
          type: 'budget.state',
          actor: opener.actor,
          origin: 'system',
          trust: 'trusted',
          lane: opener.lane,
          register: 'budget.state',
          data: null,
        },
        {
          type: 'inbox',
          actor: opener.actor,
          origin: 'system',
          trust: 'trusted',
          lane: opener.lane,
          register: 'inbox',
          data: null,
        },
        ...(opener.modelSelections ?? []).map(
          (selection): EventInput => ({
            type: 'x/core/model-switch',
            actor: opener.actor,
            origin: 'system',
            trust: 'trusted',
            lane: opener.lane,
            ignorable: true,
            data: {
              slot: selection.slot,
              from: { route: selection.route, model: selection.model },
              to: {
                route: selection.route,
                model: selection.model,
                ...(selection.thinking === undefined ? {} : { thinking: selection.thinking }),
                ...(selection.contextWindow === undefined ? {} : { contextWindow: selection.contextWindow }),
              },
              reason: 'fork-origin',
            },
          }),
        ),
      ],
      { beforeCommit: checkParent, commitCheck: checkParent },
    )
    checkParent()
  } catch (err) {
    await child.abandon().catch(() => undefined)
    throw err
  }
  return child
}

/** Verifies `(state.lastSeq, toSeq]` of `key` onward from `state`, a page at a time, keeping the rows. */
export async function verifiedRange(
  storage: StorageAdapter,
  key: SessionKey,
  from: IntegrityState,
  toSeq: Seq,
  check?: () => void,
): Promise<{ state: IntegrityState; rows: IntegrityRow[] }> {
  let state = from
  const rows: IntegrityRow[] = []
  while (state.lastSeq < toSeq) {
    if (rows.length > 0) await pageYield()
    check?.()
    const page = await storage.scanIntegrity(key, {
      fromSeq: state.lastSeq + 1,
      toSeq,
      limit: INTEGRITY_PAGE_SIZE,
    })
    check?.()
    if (page.length === 0)
      throw new LedgerIntegrityFailure('ledger ended before advertised sequence', { seq: state.lastSeq + 1 })
    // The digests cover each row's own session key, so rows of another ledger that happen to chain
    // from the same head would verify; they are refused by key before they are verified.
    const foreign = page.find((row) => row.sessionKey !== key)
    if (foreign)
      throw new LedgerIntegrityFailure('ledger row belongs to another session', { seq: foreign.event.seq })
    state = verifyIntegrityRows(page, state)
    rows.push(...page)
  }
  if (state.lastSeq !== toSeq)
    throw new LedgerIntegrityFailure('ledger exceeds advertised sequence', { seq: state.lastSeq })
  return { state, rows }
}
