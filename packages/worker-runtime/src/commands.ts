import type { Host, HostSession, ResolvedProfile } from '@agnes/host'
import type { LocalGate } from '@agnes/plugin-runtime/host'
import {
  type Actor,
  type ApprovalVerdict,
  type ExtensionCallParams,
  type McpStatus,
  rpcError,
  type SkillDescriptor,
  type SkillRootStatus,
  type WorkerGeneration,
} from '@agnes/protocol'
import {
  bootstrapWorkerResources,
  type WorkerResourceBootstrapInput,
  type WorkerResourceState,
} from '@agnes/resource-control-worker'

import type { SessionCommandFrame, WorkerCommandFrame } from './frames.js'
import type { McpRowRuntime } from './mcp-row-runtime.js'

/** Direct unit-level invocation shape. Wire frames are the stricter SessionCommandFrame union. */
type SessionCommandInvocation = Omit<SessionCommandFrame, 'sessionKey' | 'method'> & {
  sessionKey?: string
  /** Direct resource-reload tests exercise the worker-wide marker against this shared state cell. */
  method: SessionCommandFrame['method'] | 'resource.stale'
}

/**
 * The one long-lived, mutable resource cell a worker process owns, created once by `runWorker()` and
 * handed to every `handleCommand` call BY REFERENCE (never copied into a per-command snapshot).
 *
 * That reference sharing is the whole point, and it is load-bearing for correctness rather than a
 * convenience: `resource.stale` and the `run` it is meant to affect are two different frames handled
 * by two different, concurrently-live `dispatch()` calls, and `run`'s call stays awaited for the full
 * duration of the turn. Anything that copies these fields into a per-frame object and writes the copy
 * back once the command finishes loses every write another command made in the meantime - a
 * `resource.stale` that lands mid-turn would be reverted by the overlapped turn's write-back the
 * instant that turn ended, and silently discarded (the daemon already ACKed it, so nothing retries).
 * Mutating this object in place has no such window: there is only ever one copy of the truth.
 *
 * `staleMarks`/`reloadedMarks` are monotonic counters rather than a single "stale since" timestamp so
 * that a notice arriving *during* a reload is never mistaken for the one that reload is consuming:
 * `run` records the exact mark count it observed before reloading and only advances `reloadedMarks`
 * to that same value on success, leaving any newer notice still pending for the next turn. Two
 * notices within one millisecond are distinguishable this way; two `Date.now()` stamps are not.
 *
 * `runAdmissions` supplies a worker-wide safe point for Host resource replacement while preserving
 * parallel turns between reloads. `reloadInFlight` records the exact stale mark captured by the one
 * reload attempt that owns an admission batch, so marks received after that attempt started remain
 * pending for a later turn.
 */
export type WorkerResourceSlot = {
  /** The MCP/Skill generation this worker currently serves, or undefined if it booted without a
   *  resource-control snapshot (and after a reload found the snapshot gone). */
  generation: WorkerResourceState | undefined
  /** The session worker's MCP supply: one Host row per server in the snapshot (stage 2b step 3).
   *  Set once by `runWorker` after Host assembly; absent in workers that host no sessions. */
  mcpRows?: McpRowRuntime
  /** Count of `resource.stale` notices received so far. Only `case 'resource.stale':` writes it. */
  staleMarks: number
  /** The `staleMarks` value the last successful reload consumed; `staleMarks > reloadedMarks` is the
   *  single definition of "this worker owes a reload before its next turn". */
  reloadedMarks: number
  /** Set for the duration of one `reloadWorkerResources` attempt. `observed` is fixed when that
   *  attempt starts; newer marks are never declared consumed by an older snapshot read. */
  reloadInFlight?: { observed: number; promise: Promise<boolean> } | undefined
  /** A failed rollback left Host rows inconsistent with the retained resource generation. */
  recoveryRequired?: boolean
  /** Shared admission state for session runs. A pending reload holds the admission queue until all
   *  previously admitted runs have left, so replacing Host-wide extensions cannot cut across a turn
   *  in another session. Kept on the shared slot for the same reason as the generation counters. */
  runAdmissions?: {
    locked: boolean
    waiters: Array<() => void>
    active: number
    idleWaiters: Set<() => void>
    reloadBarrier?: {
      promise: Promise<boolean>
      finish(attempted: boolean): void
    }
  }
}

type CommandOptions = Parameters<typeof handleCommand>[2]

/**
 * Admits one worker command through the process-local reconcile gate. The read covers only the
 * synchronous command handoff: once `execute` has returned its result or Promise, publication can
 * proceed while that already-admitted command finishes under its own lifecycle rules.
 */
export async function admitWorkerCommand<T>(gate: LocalGate, execute: () => T | Promise<T>): Promise<T> {
  const release = await gate.enterRead()
  try {
    return execute()
  } finally {
    release()
  }
}

async function reloadIfStale(o: CommandOptions, slot: WorkerResourceSlot): Promise<void> {
  if (slot.staleMarks <= slot.reloadedMarks) return
  let flight = slot.reloadInFlight
  if (!flight) {
    flight = { observed: slot.staleMarks, promise: reloadWorkerResources(o) }
    slot.reloadInFlight = flight
  }
  try {
    if (await flight.promise) slot.reloadedMarks = Math.max(slot.reloadedMarks, flight.observed)
  } finally {
    if (slot.reloadInFlight === flight) slot.reloadInFlight = undefined
  }
}

/** Admit one session turn through the worker-wide resource boundary. Ordinary turns only hold the
 *  queue while incrementing `active`; a stale turn keeps it held until older turns drain and the
 *  reload completes. Consequently later turns cannot enter with either the revoked or half-published
 *  generation. */
async function admitResourceRun(o: CommandOptions, signal: AbortSignal): Promise<(() => void) | undefined> {
  const slot = o.resources
  if (!slot) return signal.aborted ? undefined : () => undefined
  if (!slot.runAdmissions)
    slot.runAdmissions = {
      locked: false,
      waiters: [],
      active: 0,
      idleWaiters: new Set(),
    }
  const admissions = slot.runAdmissions
  // Capture a reload already claimed by an earlier run before queueing. This run belongs to that
  // admission batch even if a newer stale mark arrives while the reload is in flight; the newer mark
  // remains owed by the first run arriving after this batch.
  const joinedBarrier = admissions.reloadBarrier
  if (admissions.locked)
    await new Promise<void>((resolve) => {
      admissions.waiters.push(resolve)
    })
  else admissions.locked = true

  let ownedBarrier: NonNullable<typeof admissions.reloadBarrier> | undefined
  let attemptedReload = false
  try {
    if (joinedBarrier && (await joinedBarrier.promise)) {
      // The owning run completed the one reload attempt for this batch. Its observed mark, rather
      // than this joiner's later view, decides what remains stale.
    } else if (slot.staleMarks > slot.reloadedMarks && !signal.aborted) {
      let finishBarrier!: (attempted: boolean) => void
      const promise = new Promise<boolean>((resolve) => {
        finishBarrier = resolve
      })
      ownedBarrier = { promise, finish: finishBarrier }
      admissions.reloadBarrier = ownedBarrier
    }
    if (ownedBarrier && admissions.active > 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          admissions.idleWaiters.delete(finish)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        admissions.idleWaiters.add(finish)
        signal.addEventListener('abort', finish, { once: true })
        if (admissions.active === 0 || signal.aborted) finish()
      })
    }
    if (signal.aborted) return undefined
    if (ownedBarrier) {
      await reloadIfStale(o, slot)
      attemptedReload = true
    }
    if (slot.recoveryRequired) throw new Error('resource generation recovery required')
    if (signal.aborted) return undefined
    admissions.active++
  } finally {
    if (ownedBarrier) {
      ownedBarrier.finish(attemptedReload)
      if (admissions.reloadBarrier === ownedBarrier) delete admissions.reloadBarrier
    }
    const next = admissions.waiters.shift()
    if (next) next()
    else admissions.locked = false
  }

  let released = false
  return () => {
    if (released) return
    released = true
    admissions.active--
    if (admissions.active !== 0) return
    const waiters = [...admissions.idleWaiters]
    admissions.idleWaiters.clear()
    for (const wake of waiters) wake()
  }
}

/**
 * One `CommandFrame` dispatched against the worker's own open session. This is the worker-process
 * analogue of daemon's in-process `_agnes/v1/session.*` handlers (../local/methods/agnes.ts): same
 * host/session calls, reached over the internal wire instead of a direct function call.
 *
 * `run`'s `AbortController` is keyed by `params.runId` in `o.aborts` for the duration of the call
 * only — `abort` looks it up by the same key and triggers it, which `HostSession.run()` already turns
 * into a real session abort via its own `signal` listener (packages/core/src/step/session.ts). There
 * is no per-runId state left behind either way: the `finally` below removes the entry whether `run`
 * finished on its own or was cut short.
 *
 * `setPreset`/`setModel` go through `o.host.validatePresetSwitch`/`validateModelSwitch` first, not
 * a `HostSession` method the caller invokes unchecked — `Host` is the only place that can weigh a
 * switch against the actual assembly (`packages/host/src/host.ts`), and `HostSession` has no method
 * that does this check on its own.
 *
 * `decideApproval` resolves a pending ticket through `HostSession.resumeApproval` — core's session
 * has no method literally named `decideApproval`; that name is this command's, not core's.
 *
 * `resource.stale`/`run`'s reload check implement next-turn reload: a `resource.stale` notification from the daemon only bumps
 * `o.resources.staleMarks` and returns immediately — it does no reload work of its own, on purpose, so
 * a notification arriving mid-turn cannot do anything on that turn's critical path. The reload itself
 * is claimed by the *next* `run`, which blocks later run admissions, waits for every earlier session
 * turn to finish, and reloads before its own `session.run()` begins. The triggering turn therefore
 * sees the refreshed resource set from its first step or proceeds on the old one after a failed
 * reload, without revoking resources underneath another active session.
 *
 * Both of those writes land on `o.resources`, the caller's own long-lived `WorkerResourceSlot` object
 * (see its doc comment) — never on a per-command copy. The notification and the `run` that consumes it
 * are separate frames dispatched concurrently, and `run` stays awaited for the whole turn, so a
 * per-command copy written back afterwards would revert whatever the overlapping notification wrote.
 */
export async function handleCommand(
  session: HostSession,
  cmd: SessionCommandInvocation,
  o: {
    host: Host
    aborts: Map<string, AbortController>
    workerGeneration?: WorkerGeneration
    /** This worker's live resource cell, shared by reference with its owner (main.ts's `runWorker`)
     *  and mutated in place here. Absent for callers with no resource-control wiring at all, which
     *  makes `resource.stale` a no-op and leaves `run` with nothing to reload. */
    resources?: WorkerResourceSlot
    /** The same bootstrap input that produced `o.resources.generation`, kept so a stale reload can
     *  re-run `bootstrapWorkerResources()` against the now-changed snapshot file without a second
     *  wiring channel. Absent means this worker has no resource-control snapshot to reload from. */
    workerResourcesInput?: WorkerResourceBootstrapInput
    /** HostedSessions owns forked children. The callback lets it adopt the new HostSession without
     *  ever putting that process-local object on the daemon wire. Direct command tests may omit it
     *  and retain the create/close probe behavior below. */
    fork?: (input: {
      at: number
      childKey: string
      credential: unknown
      binding: unknown
    }) => Promise<unknown>
  },
): Promise<unknown> {
  const p = cmd.params
  switch (cmd.method) {
    case 'ping':
      return {
        ok: true,
        lastSeq: session.lastSeq,
        preset: session.preset.name,
        parent: session.d.log.parent ?? null,
      }
    case 'resource.stale':
      if (o.resources) o.resources.staleMarks++
      return { ok: true }
    case 'enqueue':
      return session.enqueue(p.target as 'next-turn' | 'next-step', p.msg as never)
    case 'manualCompact':
      return session.requestCompaction({
        actor: p.actor as Actor,
        admissionId: String(p.admissionId),
        ...(typeof p.instructions === 'string' ? { instructions: p.instructions } : {}),
      })
    case 'run': {
      const runId = String(p.runId)
      if (o.aborts.has(runId)) throw new Error(`run ${runId} is already active`)
      const ac = new AbortController()
      o.aborts.set(runId, ac)
      let releaseResources: (() => void) | undefined
      try {
        releaseResources = await admitResourceRun(o, ac.signal)
        if (!releaseResources) return { reason: 'aborted', lastSeq: session.lastSeq }
        return await session.run({ until: (p.until as 'turn-end' | 'idle') ?? 'turn-end', signal: ac.signal })
      } finally {
        releaseResources?.()
        if (o.aborts.get(runId) === ac) o.aborts.delete(runId)
      }
    }
    case 'abort':
      o.aborts.get(String(p.runId))?.abort()
      return {}
    case 'scan':
      return session.scan(p as never)
    case 'previewSnapshot':
      return session.previewSnapshot()
    case 'latest':
      return session.latest(String(p.register), p.key as string | undefined) ?? null
    case 'projectUI':
      return session.projectUI(
        p.upto as number | undefined,
        (p.surface ? { surface: p.surface } : {}) as never,
      )
    case 'projectUIPatch':
      return session.projectUIPatch(
        Number(p.after),
        p.upto as number | undefined,
        (p.surface ? { surface: p.surface } : {}) as never,
      )
    case 'projectUIOpening':
      return session.projectUIOpening({
        ...(p.surface ? { surface: p.surface } : {}),
        ...(p.maxNodes === undefined ? {} : { maxNodes: Number(p.maxNodes) }),
        ...(p.maxBytes === undefined ? {} : { maxBytes: Number(p.maxBytes) }),
      } as never)
    case 'projectUIHistory':
      return session.projectUIHistory(Number(p.cut), Number(p.beforeIndex), {
        ...(p.surface ? { surface: p.surface } : {}),
        ...(p.limit === undefined ? {} : { limit: Number(p.limit) }),
        ...(p.maxBytes === undefined ? {} : { maxBytes: Number(p.maxBytes) }),
      } as never)
    case 'append':
      return session.append(p.tx as never)
    case 'setPreset': {
      return { effectiveFromSeq: await o.host.setSessionPreset(session.key, String(p.preset)) }
    }
    case 'setModel': {
      const sel = p.sel as { slot: string; route: string; model: string }
      o.host.validateModelSwitch(sel)
      return { effectiveFromSeq: await session.setModel(sel) }
    }
    case 'setYolo': {
      if (typeof p.enabled !== 'boolean') throw new TypeError('invalid setYolo command')
      const computerUseSession = { key: session.key, lane: session.lane }
      if (!o.host.computerUse) return { effectiveFromSeq: await session.setYolo(p.enabled, p.actor as Actor) }
      if (!p.enabled) {
        await o.host.computerUse.setSessionYolo(computerUseSession, false)
        return { effectiveFromSeq: await session.setYolo(false, p.actor as Actor) }
      }
      const effectiveFromSeq = await session.setYolo(true, p.actor as Actor)
      try {
        await o.host.computerUse.setSessionYolo(computerUseSession, true)
        return { effectiveFromSeq }
      } catch (error) {
        const failures: unknown[] = [error]
        try {
          await o.host.computerUse.setSessionYolo(computerUseSession, false)
        } catch (rollbackError) {
          failures.push(rollbackError)
        }
        try {
          await session.setYolo(false, p.actor as Actor)
        } catch (rollbackError) {
          failures.push(rollbackError)
        }
        throw new AggregateError(failures, 'Computer Use session YOLO mode switch failed')
      }
    }
    case 'decideApproval': {
      const args = p as { ticket: string; verdict: ApprovalVerdict; decidedBy: Actor }
      return session.resumeApproval(args.ticket, args.verdict, args.decidedBy)
    }
    case 'resolveActor': {
      const args = p as { credential: unknown; surface: 'session' | 'approval' }
      return o.host.resolveActor(args.credential, args.surface)
    }
    case 'fork': {
      if (o.fork)
        return o.fork({
          at: Number(p.at),
          childKey: String(p.childKey),
          credential: p.credential,
          binding: p.binding,
        })
      const child = await o.host.createSession({
        key: String(p.childKey),
        cwd: session.d.cwd,
        credential: p.credential,
        parent: { key: session.key, boundarySeq: Number(p.at) },
      })
      try {
        return { sessionId: child.key, parent: child.d.log.parent }
      } finally {
        await child.close()
        o.host.kernel.sessions.delete(child.key)
      }
    }
    case 'resume':
      return session.resume()
    default:
      throw new Error(`unknown worker method ${String(cmd.method)}`)
  }
}

/**
 * Re-bootstraps this worker's resource generation from the live resource-control snapshot file, brings
 * Host in line with it, and only then swaps the new generation into `o.resources.generation` in place
 * (the caller's own shared slot, not a return value — see `handleCommand`'s doc comment). Failure at
 * any step is logged and left for the next `run` to retry: the caller advances `reloadedMarks` only
 * when this returns `true`, and a failed reload must never throw out of `run` — the turn proceeds on
 * whatever resource set it already had.
 *
 * MCP (stage 2b step 3): the snapshot's servers are applied as Host rows, one per server
 * (`o.resources.mcpRows`). Host swaps only a row whose definition changed and unmounts only a removed
 * server's row; every other server keeps its connection. The rows own their connections, so this
 * generation holds none, and applying rows is idempotent against the snapshot: a retry after a later
 * failure re-applies the same rows and changes nothing. A missing snapshot means no MCP servers.
 *
 * Skills: `agnes/skills` is reloaded with the new generation, and its `loaded` flag is checked
 * explicitly — `reloadEcosystemExtension`'s own `managed.load()` resolves with `{ loaded: false,
 * error }` rather than throwing (packages/host/src/ext-host/managed-host.ts), so a silent failure
 * would otherwise be missed. `tool_search`'s Skill listing (agnes/mcp-search) reads whatever
 * generation agnes/skills serves, so nothing else needs reloading (design §3.9, D123).
 *
 * On failure the new generation is closed, never adopted. Closing it only closes its (empty) MCP
 * manager: MCP rows are independent of it. Staleness stays set so every later turn retries — so
 * skipping the close would leak one generation per retried turn.
 */
async function reloadWorkerResources(o: {
  host: Host
  resources?: WorkerResourceSlot
  workerResourcesInput?: WorkerResourceBootstrapInput
}): Promise<boolean> {
  const slot = o.resources
  if (!slot || !o.workerResourcesInput) return false
  const previous = slot.generation
  let next: WorkerResourceState | undefined
  let mcpAttempted = false
  try {
    next = await bootstrapWorkerResources(o.workerResourcesInput)
    if (previous && next) next.runtime.skills.shareRuntimeFrom(previous.runtime.skills)
    mcpAttempted = !!slot.mcpRows
    await slot.mcpRows?.apply(next?.mcpEntries ?? [])
    await refreshSkills(o.host, next?.skillResources)
  } catch (error) {
    // Host refreshSkillRow compensates its own Skills row before rejecting. Only a failed Host
    // compensation or failed reverse MCP apply requires intervention before another turn runs.
    if (error instanceof AggregateError && error.message === 'Skills row refresh recovery required')
      slot.recoveryRequired = true
    if (mcpAttempted) {
      try {
        await slot.mcpRows?.apply(previous?.mcpEntries ?? [])
      } catch (restoreError) {
        slot.recoveryRequired = true
        console.error('agnes worker: resource generation recovery required:', restoreError)
      }
    }
    console.error('agnes worker: resource reload failed, will retry on the next run:', error)
    if (next && next !== previous) closeDisownedGeneration(next)
    return false
  }
  // An empty reload result (no snapshot found — e.g. it was deleted out from under this worker) is a
  // real outcome, not a no-op: the slot's `generation` is a required key holding `undefined` for
  // exactly this case, so it can be assigned either way without the `exactOptionalPropertyTypes`
  // present-but-undefined-vs-absent distinction an optional key would force.
  slot.generation = next
  // Nothing else in worker-runtime will ever close the outgoing generation once the slot no longer
  // points at it, so this swap is also the one place responsible for retiring it.
  if (previous) closeDisownedGeneration(previous)
  return true
}

async function refreshSkills(
  host: Host,
  input: WorkerResourceState['skillResources'] | undefined,
): Promise<void> {
  // Existing test hosts still implement the older worker facade; production Host supplies the row
  // method. Both currently route to the same single Skills row, never to managed.loadEmbedded.
  if (typeof host.refreshSkillRow === 'function') return host.refreshSkillRow(input)
  const status = await host.reloadEcosystemExtension('agnes/skills', input ? { skillResources: input } : {})
  if (!status.loaded)
    throw new Error(`agnes/skills reload failed: ${status.error?.message ?? 'unknown error'}`)
}

/** Retire a generation nobody holds any more. Never awaited: closing it must not delay the turn the
 *  caller is on. */
function closeDisownedGeneration(generation: WorkerResourceState): void {
  void generation.runtime.mcp
    .close()
    .catch((error: unknown) =>
      console.error('agnes worker: disowned resource generation close failed:', error),
    )
}

/**
 * Drives a control-plane MCP change to take effect right now instead of waiting for the next turn's
 * `resource.stale` check (design §3.3): the daemon has already committed the change to its own
 * journal and snapshot file before calling this, so what remains is making *this* worker's rows agree
 * with it. Reused as-is for `resourceMcpApply` and `resourceMcpReconnect` - the only difference
 * between them is whether `reconnect` bumps this server's remount epoch first.
 *
 * Goes through the exact same run-admission barrier a session turn's own reload does
 * (`admitResourceRun`): a turn in flight is let to finish before rows are replaced, and this "turn"
 * releases its own admission immediately after, rather than holding it open - it mounts nothing of
 * its own, it only forces the reload every later run would eventually have forced anyway.
 */
export async function applyMcpRowChange(
  o: { host: Host; resources?: WorkerResourceSlot; workerResourcesInput?: WorkerResourceBootstrapInput },
  serverId: string,
  reconnect: boolean,
): Promise<McpStatus | undefined> {
  const slot = o.resources
  if (reconnect) slot?.mcpRows?.reconnect(serverId)
  if (slot) slot.staleMarks++
  const ac = new AbortController()
  const release = await admitResourceRun(
    {
      host: o.host,
      aborts: new Map(),
      ...(o.resources ? { resources: o.resources } : {}),
      ...(o.workerResourcesInput ? { workerResourcesInput: o.workerResourcesInput } : {}),
    },
    ac.signal,
  )
  release?.()
  return slot?.mcpRows?.status(serverId)
}

/**
 * A skill scan/removal scoped to one daemon-resolved workspace root, run inside whatever worker
 * already holds this process (design §3.5) instead of a dedicated skill-scan worker. Builds one
 * throwaway resource generation via `bootstrapWorkerResources({..., cwd, mcpRows: true})`: `mcpRows`
 * forces `managedMcp` empty, so this generation stages and connects no MCP server, and its own
 * fresh `createSkillCandidateRegistry` + `ExtensionActivationBarrier` never touch the worker's real
 * `resourceSlot.generation` or its mounted Host rows - the daemon-visible resident view is
 * untouched, exactly as the design's "不碰会话视图" requires. The revision returned is the sha256 of
 * whatever `AGNES_RESOURCE_SNAPSHOT` bytes this call actually read, which is what makes the
 * mismatch check below meaningful: a concurrent write between the daemon computing its own expected
 * revision and this call landing is a real race, not a bug, and must fail rather than silently
 * answer from a snapshot the daemon no longer recognizes.
 */
async function buildWorkspaceSkillScan(
  workerResourcesInput: WorkerResourceBootstrapInput,
  workspaceRoot: string,
): Promise<WorkerResourceState> {
  const temp = await bootstrapWorkerResources({ ...workerResourcesInput, cwd: workspaceRoot, mcpRows: true })
  if (!temp) throw new Error('resource worker did not observe a snapshot for this workspace scan')
  return temp
}

export async function scanWorkspaceSkills(
  workerResourcesInput: WorkerResourceBootstrapInput,
  params: { workspaceRoot: string; rootKey?: string; snapshotRevision: string },
): Promise<{
  /** The resolved descriptors (actual/trust/desired/resolution), for reconcile's re-observation of
   *  Skills the daemon already tracks. Never filtered by `rootKey` (reconcile never passes one). */
  skills: readonly SkillDescriptor[]
  /** Raw candidates + capability hash, for refresh's discovery of new/changed Skills. */
  candidates: readonly Readonly<{ descriptor: SkillDescriptor; capabilityHash: string }>[]
  failedRoots: readonly string[]
  skippedResourceIds: readonly string[]
  roots: readonly SkillRootStatus[]
}> {
  const temp = await buildWorkspaceSkillScan(workerResourcesInput, params.workspaceRoot)
  try {
    if (temp.revision !== params.snapshotRevision)
      throw new Error('resource snapshot changed before this Skill scan completed')
    const rootKey = params.rootKey
    return {
      skills: temp.skills,
      candidates: rootKey
        ? temp.discovery.candidates.filter((row) => row.descriptor.sourceIdentity.rootKey === rootKey)
        : temp.discovery.candidates,
      failedRoots: temp.discovery.failedRoots,
      skippedResourceIds: rootKey
        ? temp.discovery.skippedResourceIds.filter((id) => id.split('/')[2] === rootKey)
        : temp.discovery.skippedResourceIds,
      roots: temp.discovery.roots,
    }
  } finally {
    await temp.runtime.mcp.close().catch(() => undefined)
  }
}

export async function removeWorkspaceSkill(
  workerResourcesInput: WorkerResourceBootstrapInput,
  params: { workspaceRoot: string; descriptor: SkillDescriptor; validateOnly: boolean },
): Promise<void> {
  const temp = await buildWorkspaceSkillScan(workerResourcesInput, params.workspaceRoot)
  try {
    await temp.removeSkill(params.descriptor, params.validateOnly)
  } finally {
    await temp.runtime.mcp.close().catch(() => undefined)
  }
}

/** Service workers deliberately have no HostSession. Their command surface is correspondingly tiny
 * and cannot reach session storage or a writer lease. */
export async function handleServiceCommand(
  host: Host | undefined,
  cmd: WorkerCommandFrame,
  aborts: Map<string, AbortController>,
  resourcesOrWorkerGeneration?:
    | {
        mcp: {
          test(input: {
            profile: string
            serverId: string
            definition: never
            signal: AbortSignal
          }): Promise<unknown>
          tools(serverId: string, cursor?: string): unknown
        }
      }
    | WorkerGeneration,
  _workerGeneration?: WorkerGeneration,
): Promise<unknown> {
  // The numeric fourth argument remains a generation slot for existing generic service callers.
  // Resource-only workers supply their narrow runtime port first and generation fifth so neither
  // control plane can reinterpret the other's input. Service dispatch no longer consults generation.
  const resources = typeof resourcesOrWorkerGeneration === 'number' ? undefined : resourcesOrWorkerGeneration
  if (cmd.method === 'configuration.apply') {
    if (!host || !cmd.params.profile || typeof cmd.params.profile !== 'object')
      throw new TypeError('invalid model configuration')
    await host.applyModelProfile(cmd.params.profile as ResolvedProfile)
    return { profileHash: host.profile.hash }
  }
  const p = cmd.params
  switch (cmd.method) {
    case 'ping':
      return { ok: true }
    case 'abortService':
      aborts.get(String(p.callId))?.abort()
      return {}
    case 'computerUse.status':
      if (!host?.computerUse) throw new Error('Computer Use runtime is unavailable')
      return host.computerUse.status()
    case 'computerUse.doctor':
      if (!host?.computerUse) throw new Error('Computer Use runtime is unavailable')
      return host.computerUse.doctor(p)
    case 'computerUse.permissionsStatus':
      if (!host?.computerUse) throw new Error('Computer Use runtime is unavailable')
      return host.computerUse.permissionsStatus()
    case 'computerUse.permissionsGrant':
      if (!host?.computerUse) throw new Error('Computer Use runtime is unavailable')
      return host.computerUse.permissionsGrant()
    case 'computerUse.operationStart':
      if (!host?.computerUse) throw new Error('Computer Use runtime is unavailable')
      if (p.kind !== 'install' && p.kind !== 'update' && p.kind !== 'restart')
        throw new TypeError('invalid Computer Use operation kind')
      return host.computerUse.operationStart(p.kind)
    case 'computerUse.operationStatus':
      if (!host?.computerUse) throw new Error('Computer Use runtime is unavailable')
      return host.computerUse.operationStatus(typeof p.operationId === 'string' ? p.operationId : undefined)
    case 'computerUse.operationCancel':
      if (!host?.computerUse || typeof p.operationId !== 'string')
        throw new TypeError('invalid Computer Use operation cancellation')
      return host.computerUse.operationCancel(p.operationId)
    case 'inspectService': {
      if (!host) throw new Error('generic services are unavailable in a resource lifecycle worker')
      const params = p.call as ExtensionCallParams | undefined
      if (
        typeof p.sessionKey !== 'string' ||
        p.sessionKey.length === 0 ||
        !params ||
        params.sessionId !== p.sessionKey
      )
        throw rpcError('CAPABILITY_DENIED')
      const callId = String(p.callId)
      if (!callId || aborts.has(callId)) throw new Error('duplicate service call id')
      const ac = new AbortController()
      aborts.set(callId, ac)
      try {
        return await host.inspectService(params, p.credential, ac.signal)
      } finally {
        aborts.delete(callId)
      }
    }
    case 'callService': {
      if (!host) throw new Error('generic services are unavailable in a resource lifecycle worker')
      const params = p.call as ExtensionCallParams | undefined
      if (
        typeof p.sessionKey !== 'string' ||
        p.sessionKey.length === 0 ||
        !params ||
        params.sessionId !== p.sessionKey
      )
        throw rpcError('CAPABILITY_DENIED')
      const callId = String(p.callId)
      if (!callId || aborts.has(callId)) throw new Error('duplicate service call id')
      const ac = new AbortController()
      aborts.set(callId, ac)
      try {
        const admission = p.effectCommandId
        return await host.callService(
          params,
          p.credential,
          ac.signal,
          typeof admission === 'string' ? { commandId: admission } : undefined,
        )
      } finally {
        aborts.delete(callId)
      }
    }
    case 'resourceMcpTools':
      if (!resources) throw new Error('resource runtime is unavailable')
      return resources.mcp.tools(String(p.serverId), typeof p.cursor === 'string' ? p.cursor : undefined)
    case 'resourceMcpTest': {
      if (!resources) throw new Error('resource runtime is unavailable')
      const callId = `resource-test:${String(p.serverId)}`
      if (aborts.has(callId)) throw new Error('duplicate resource test')
      const ac = new AbortController()
      aborts.set(callId, ac)
      try {
        return await resources.mcp.test({
          profile: String(p.profile),
          serverId: String(p.serverId),
          definition: p.definition as never,
          signal: ac.signal,
        })
      } finally {
        aborts.delete(callId)
      }
    }
    default:
      throw new Error(`method unavailable in service worker: ${String(cmd.method)}`)
  }
}
