import type { OpState } from '@agnes/protocol'
import {
  batchTrigger,
  type ForkBase,
  forkBaseProviders,
  pageYield,
  type SeededLog,
  seededLogs,
} from '../log/fork-seed.js'
import { makeRelationCheck } from '../log/relations.js'
import { scanPages } from '../log/scan-pages.js'
import { type AppendedExtra, type OpenLogOptions, SessionLogImpl } from '../log/session-log.js'
import { type RegisterRow, SCAN_PAGE_MAX } from '../log/storage.js'
import { SurfaceCache, seedSurface } from '../project/surface.js'
import { markIncomplete, UIProjectionCell } from '../project/ui.js'
import { canonicalJson } from '../request/hash.js'
import { CoreError, type Event, type Seq } from '../types.js'
import { verifyOpCells } from './op-check.js'
import { reduce } from './reducer.js'
import { type EffectTree, effectTree, initialState, type LedgerState } from './state.js'

/** Live ledger state: the fold so far, advanced by every batch the log admits. */
export class StateTracker {
  state: LedgerState = initialState()

  apply(events: Event[]): void {
    for (const e of events) this.state = reduce(this.state, e)
  }

  /** Folds a log from its first row, one bounded page at a time. */
  static async rebuild(log: SessionLogImpl, pageSize = SCAN_PAGE_MAX): Promise<StateTracker> {
    const t = new StateTracker()
    for await (const page of scanPages((q) => log.scan(q), { fromSeq: 1 }, pageSize)) t.apply(page)
    return t
  }
}

/**
 * Which register each state map materializes. Typed as a total record over the register maps, so a
 * map added to LedgerState without a name here does not compile — the alternative, a hand-written
 * list, stays green while quietly leaving the new register out of both halves of the resume path.
 */
export const REGISTER_NAMES: Record<keyof LedgerState['registers'], string> = {
  planItems: 'plan.items',
  budgetState: 'budget.state',
  artifactJobs: 'artifact/job',
  inbox: 'inbox',
  harnessEntries: 'harness/entry',
}

/**
 * The register maps as storage rows. This is the single place that says which state map holds which
 * register, so the materialization check and the cache reseed cannot disagree about the set.
 */
export function registerRows(state: LedgerState): RegisterRow[] {
  const rows: RegisterRow[] = []
  for (const name of Object.keys(REGISTER_NAMES) as (keyof LedgerState['registers'])[]) {
    const map: ReadonlyMap<string, { seq: Seq; value: unknown }> = state.registers[name]
    for (const [key, cell] of map)
      rows.push({ register: REGISTER_NAMES[name], key, seq: cell.seq, data: cell.value })
  }
  return rows
}

// A harness entry key joins kind and id with NUL, which would print as an invisible gap in a
// mismatch line.
// The separator is written as an escape for the same reason storage.ts spells it that way: a
// literal NUL in source is invisible and does not survive copying the file around.
const show = (key: string) => key.replaceAll('\u0000', ' / ')

/**
 * Compares the materialized register table against a rebuild of the same log. The table is only a
 * shortcut for the fold, so any disagreement — a row the fold does not produce, a cell the table has
 * lost, a differing seq or a differing value at the same seq — means the table is the copy to discard.
 * The program counter's cells are not folded from rows, so they are not part of this comparison.
 */
export function verifyRegisters(
  tracker: StateTracker,
  rows: RegisterRow[],
): { ok: boolean; mismatches: string[] } {
  const rebuilt = new Map<string, Map<string, RegisterRow>>()
  for (const row of registerRows(tracker.state)) {
    let byKey = rebuilt.get(row.register)
    if (!byKey) {
      byKey = new Map()
      rebuilt.set(row.register, byKey)
    }
    byKey.set(row.key, row)
  }
  const mismatches: string[] = []
  const seen = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.register === 'op.state') continue
    let keys = seen.get(row.register)
    if (!keys) {
      keys = new Set()
      seen.set(row.register, keys)
    }
    keys.add(row.key)
    const want = rebuilt.get(row.register)?.get(row.key)
    if (want === undefined) mismatches.push(`${row.register} ${show(row.key)}: not in rebuild`)
    else if (want.seq !== row.seq)
      mismatches.push(`${row.register} ${show(row.key)}: seq ${row.seq} ≠ ${want.seq}`)
    else if (canonicalJson(want.data) !== canonicalJson(row.data))
      mismatches.push(`${row.register} ${show(row.key)}: value differs at seq ${row.seq}`)
  }
  for (const [register, byKey] of rebuilt)
    for (const key of byKey.keys())
      if (!seen.get(register)?.has(key)) mismatches.push(`${register} ${show(key)}: missing from table`)
  return { ok: mismatches.length === 0, mismatches }
}

export type OpenTrackedOptions = OpenLogOptions & {
  /** A writer already opened by SessionLogImpl.forkInto; it is attached, never opened twice. */
  existing?: SessionLogImpl
  verify?: 'always' | 'sample' | 'never'
  sampleRate?: number
  random?: () => number
  /** Page size of the separate replay of an attached (`existing`) log; a fresh open folds while it verifies. */
  pageSize?: number
  lane?: string
}

/**
 * Opens a log with live state attached: the tracker and the lane's surface are seeded by replaying
 * what is already stored, then advanced by every batch the log admits. On open the register table is
 * checked against that replay, and a table that disagrees is discarded in favour of the replay.
 *
 * This is the only place a SurfaceCache is built. Every caller uses the ones returned here: a second
 * cache built elsewhere is never fed, so it reports an empty surface and the model stops seeing the
 * conversation.
 *
 * `surfaces` is that registry, returned alongside the opened lane's own cache. A caller needing a
 * second lane registers its cache in this map instead of holding one on the side: every cache in the
 * map is fed by `onAppended` and read by the relation check, which is exactly what a cache kept
 * outside it lacks. One registered after open sees rows from that point on, so a lane that already
 * has history must be replayed by whoever registers it; v0.1 writes only `main`.
 */
export async function openTracked(o: OpenTrackedOptions): Promise<{
  log: SessionLogImpl
  tracker: StateTracker
  surface: SurfaceCache
  surfaces: Map<string, SurfaceCache>
  ui: UIProjectionCell
  registersRebuilt: boolean
}> {
  const lane = o.lane ?? 'main'
  const tracker = new StateTracker()
  let surface = new SurfaceCache(lane)
  let ui = new UIProjectionCell(o.key, lane)
  const surfaces = new Map([[lane, surface]])
  // The default check reads the tracker's live state and this surface, which are what the batch is
  // about to be appended to. A caller that brings its own check replaces it wholesale.
  const relationCheck = o.relationCheck ?? makeRelationCheck(tracker, surfaces)
  // The state and surface at the trigger of the last turn this process opened, kept so a delegated
  // child forked there can start from them instead of refolding the parent's history.
  let forkPoint: ForkBase | undefined
  const onAppended = (events: Event[], extra: AppendedExtra): void => {
    const { integrity } = extra
    const trigger = integrity && surfaces.size === 1 ? batchTrigger(events, extra.op) : undefined
    const digest =
      trigger === undefined ? undefined : integrity?.find((entry) => entry.seq === trigger)?.digest
    const cut = digest === undefined ? -1 : events.findIndex((e) => e.seq > (trigger as Seq))
    const upto = cut === -1 ? events : events.slice(0, cut)
    const after = cut === -1 ? [] : events.slice(cut)
    tracker.apply(upto)
    const stateAtTrigger = tracker.state
    tracker.apply(after)
    ui.apply(events)
    ui.setOp(currentOp(log, lane))
    // Every registered cache is fed, not just the opened lane's: each one filters the batch down
    // to its own lane, so feeding them all is how a later-registered lane stays live.
    for (const c of surfaces.values()) c.push(upto)
    if (digest !== undefined)
      forkPoint = {
        kind: 'trigger',
        seq: trigger as Seq,
        state: stateAtTrigger,
        surface: surface.snapshot(),
        headDigest: digest,
      }
    for (const c of surfaces.values()) c.push(after)
    o.onAppended?.(events, extra)
  }
  // Folds ledger rows into the tracker, the surface and the UI cell, every row from the first.
  const foldPage = (events: Event[]): void => {
    tracker.apply(events)
    surface.push(events)
    ui.apply(events)
  }
  let log: SessionLogImpl
  let seed: SeededLog | undefined
  if (o.existing) {
    if (o.existing.key !== o.key || o.existing.writerRunId !== o.writerRunId)
      throw new CoreError('E_ENVELOPE', 'existing session log identity mismatch')
    log = o.existing
    seed = seededLogs.get(log)
    seededLogs.delete(log)
    log.attach({ relationCheck, onAppended })
  } else {
    log = await SessionLogImpl.open({
      ...o,
      relationCheck,
      onAppended,
      replay: { page: foldPage },
    })
  }
  try {
    if (seed && log.parent) {
      // A delegated child forked from its live parent: start from the parent's state and surface at
      // the fork point, then fold the verified parent rows up to the boundary and the child's own rows.
      // Its UI cell holds only the child's own rows and is marked incomplete: it cannot stand in for
      // a full replay.
      tracker.state = seed.base.state
      surface = seedSurface(lane, seed.base.surface, seed.base.seq)
      surfaces.set(lane, surface)
      ui = new UIProjectionCell(o.key, lane)
      ui.startAfter(log.parent.boundarySeq)
      markIncomplete(ui)
      const own = [...seed.own, ...seed.tail]
      tracker.apply(seed.inherited)
      tracker.apply(own)
      surface.push(seed.inherited)
      surface.push(own)
      ui.apply(own)
    } else if (o.existing) await replay()
    ui.sealReplay()
    return await finishOpen()
  } catch (error) {
    // A log this call opened is its own to give back; a writer handed in by a fork belongs to the
    // caller, which gives it back on this same failure. The open's own error is the one reported.
    if (!o.existing) await log.abandon().catch(() => undefined)
    throw error
  }

  async function replay(): Promise<void> {
    // An attached log was verified when it was opened elsewhere, so its rows are read again here.
    let firstPage = true
    for await (const page of scanPages((q) => log.scan(q), { fromSeq: 1 }, o.pageSize ?? SCAN_PAGE_MAX)) {
      if (!firstPage) await pageYield()
      firstPage = false
      foldPage(page)
    }
  }

  async function finishOpen() {
    const mode = o.verify ?? 'always'
    const doVerify =
      mode === 'always' || (mode === 'sample' && (o.random ?? Math.random)() < (o.sampleRate ?? 0.05))
    let registersRebuilt = false
    if (doVerify) {
      const check = verifyRegisters(tracker, log.allRegisters())
      if (!check.ok) {
        // The fold knows nothing of the program counter, so its cells are kept, not rebuilt away.
        const opCells = log.allRegisters().filter((row) => row.register === 'op.state')
        log.replaceRegisterCache([...registerRows(tracker.state), ...opCells])
        registersRebuilt = true
      }
    }
    // Always, whatever the sampling: a wrong program counter drives execution and nothing repairs it.
    await verifyOpCells(log, tracker.state)
    // Seeded after the check, so a table that was just rebuilt is the one the summary shows.
    ui.setOp(currentOp(log, lane))
    forkBaseProviders.set(log, (boundarySeq, childLane) => {
      if (surfaces.size !== 1 || childLane !== lane) return undefined
      if (
        boundarySeq === log.lastSeq &&
        tracker.state.lastSeq === boundarySeq &&
        surface.upto === boundarySeq
      )
        return { kind: 'head', seq: boundarySeq, state: tracker.state, surface: surface.snapshot() }
      return forkPoint && forkPoint.seq <= boundarySeq ? forkPoint : undefined
    })
    return { log, tracker, surface, surfaces, ui, registersRebuilt }
  }
}

/** The program counter of `lane` as the register holds it. */
export function currentOp(log: SessionLogImpl, lane: string): OpState {
  return (log.registerRow('op.state', lane)?.data as OpState | undefined) ?? null
}

export function pendingEffects(tracker: StateTracker): EffectTree {
  return effectTree(tracker.state)
}
