import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { CoreError } from '@agnes/core'
import {
  ComparisonWorkspaceError,
  type ConfigurationAdmissionReceipt,
  comparisonPayloadDigest,
  createComparisonStore,
  createComparisonWorkspaces,
  inspectComparisonInput,
  type ScanRead,
  verifyComparisonWorkspaceReferences,
} from '@agnes/host'
import type {
  ComparisonCancelParams,
  ComparisonCreateParams,
  ComparisonIdParams,
  ComparisonSubmitParams,
  ComparisonTreeCut,
  EventEnvelope,
} from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import {
  ComparisonCoordinator,
  ComparisonError,
  comparisonInputCancelled,
  type SessionPort,
} from '@agnes/runtime-comparison'
import { runQueued } from '../command-queue.js'
import type { ComparisonCapture } from '../comparison-capture.js'
import { comparisonSessionKeys } from '../comparison-identity.js'
import type { LocalEndpoint } from '../endpoint.js'
import { reserveOwnedSession } from '../session-admission.js'
import type { LocalContext } from './acp.js'
import { registerComparisonRead } from './comparison-read.js'

export interface ComparisonLedgerReader {
  captureTree?(rootSessionId: string): Promise<ComparisonTreeCut>
  head(sessionId: string): Promise<number>
  scan(sessionId: string, query: Parameters<ScanRead<EventEnvelope>>[0]): Promise<EventEnvelope[]>
}
export type ComparisonStorage = ReturnType<typeof createComparisonStore>
export function openComparisonStorage(dataDir: string): ComparisonStorage {
  return createComparisonStore(join(dataDir, 'comparisons', 'index.sqlite'), {
    sessionKeys: comparisonSessionKeys,
  })
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** The daemon owns authentication and allocation; the coordinator never receives a socket or Host. */
export function registerComparison(
  ep: LocalEndpoint,
  cx: LocalContext,
  options?: {
    dataDir: string
    storage: ComparisonStorage
    ledger?: ComparisonLedgerReader
    capture?: ComparisonCapture
  },
): { drain(): Promise<void> } {
  registerComparisonRead(ep, cx.sessionOwnership, options?.storage, options?.ledger)
  const controls = new Map<string, ComparisonCoordinator>()
  function makeCoordinator(principal: string): ComparisonCoordinator | undefined {
    const credential = ep.conn.credential
    const store = options?.storage.scoped(principal)
    const physicalId = (id: string) => hash(`${principal}\u0000${id}`)
    const sessionId = (id: string, side: 'left' | 'right') => comparisonSessionKeys(principal, id)[side]
    const snapshotDirectory = join(options?.dataDir ?? '', 'comparisons', 'workspaces')
    const referenceOptions = {
      directory: snapshotDirectory,
      async authorizeExternalRead(path: string) {
        for (const denied of [await realpath(options!.dataDir), join(homedir(), '.ssh')]) {
          const rel = relative(denied, path)
          if (rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)))
            throw rpcError('CAPABILITY_DENIED')
        }
      },
    }
    const isolationFor = async (id: string) => {
      const record = await store!.read(id)
      if (!record?.baseline)
        throw new ComparisonError('COMPARISON_NOT_READY', 'Workspace baseline unavailable')
      const source = JSON.parse(record.createPayload) as ComparisonCreateParams
      const authorized = await cx.workspaces.bind(undefined, source.cwd)
      return {
        sourceRoot: authorized.path,
        storageRoot: await realpath(snapshotDirectory),
        workspaceRoots: Object.values(record.baseline.roots),
        externalPaths: await verifyComparisonWorkspaceReferences(
          referenceOptions,
          physicalId(id),
          record.baseline,
        ),
      }
    }
    const getEntry = (key: string) => {
      if (cx.sessionOwnership?.resolve(key)?.principalId !== principal)
        throw rpcError('CAPABILITY_DENIED', { reason: 'comparison session owner unavailable' })
      return cx.registry.require(key)
    }
    const admissions = new Map<string, ConfigurationAdmissionReceipt>()
    const admissionKey = (sessionId: string, inputId: string) => `${sessionId}\u0000${inputId}`
    const sessions: SessionPort = {
      async admit(input) {
        const acquired: ConfigurationAdmissionReceipt[] = []
        try {
          const isolation = await isolationFor(input.comparisonId)
          for (const side of (['left', 'right'] as const)
            .slice()
            .sort((a, b) => input.lanes[a].sessionId.localeCompare(input.lanes[b].sessionId))) {
            const lane = input.lanes[side]
            getEntry(lane.sessionId)
            await cx.host.prepareSessionConfiguration(lane.sessionId, isolation)
            const prepared = input.prepared[side]
            if (!prepared || typeof prepared.configuration.fingerprints.mounted !== 'string')
              throw rpcError('SEMANTIC_REJECTED', { code: 'CONFIGURATION_UNKNOWN' })
            acquired.push(
              await cx.host.configurationAdmissions.acquire({
                sessionId: lane.sessionId,
                inputId: input.inputId,
                payloadDigest: comparisonPayloadDigest(input.content),
                prepared,
                permissionMode: input.permissionMode,
              }),
            )
          }
          const left = acquired.find((value) => value.sessionId === input.lanes.left.sessionId)!
          const right = acquired.find((value) => value.sessionId === input.lanes.right.sessionId)!
          const a = left.prepared.configuration.fingerprints
          const b = right.prepared.configuration.fingerprints
          if (
            (['mounted', 'tools', 'model', 'preset', 'permission'] as const).some(
              (key) => typeof a[key] !== 'string' || typeof b[key] !== 'string' || a[key] !== b[key],
            )
          )
            throw rpcError('SEMANTIC_REJECTED', { code: 'CONFIGURATION_MISMATCH' })
          for (const value of acquired) admissions.set(admissionKey(value.sessionId, input.inputId), value)
          return {
            prepared: { left: left.prepared, right: right.prepared },
            enqueue: (side) =>
              sessions.enqueue({
                ...input,
                side,
                sessionId: input.lanes[side].sessionId,
                ...(input.lanes[side].runtime ? { runtime: input.lanes[side].runtime.id } : {}),
              }),
            async ready() {
              await isolationFor(input.comparisonId)
              // All owners are still held while both checks and seals complete. A partial seal
              // never dispatches: only this shared barrier can invoke either run capability.
              await Promise.all(
                acquired.map((value) => cx.host.configurationAdmissions.check(value.sessionId, value.token)),
              )
              await Promise.all(
                acquired.map((value) =>
                  cx.host.configurationAdmissions.check(value.sessionId, value.token, true),
                ),
              )
            },
            run: (side) => sessions.run({ sessionId: input.lanes[side].sessionId, inputId: input.inputId }),
            async release() {
              const results = await Promise.allSettled(
                acquired.map(async (value) => {
                  await cx.host.configurationAdmissions.release(value.sessionId, value.token)
                  admissions.delete(admissionKey(value.sessionId, input.inputId))
                }),
              )
              if (results.some((result) => result.status === 'rejected'))
                throw new Error('configuration admission release unconfirmed')
            },
          }
        } catch (error) {
          await Promise.allSettled(
            acquired.map((value) => cx.host.configurationAdmissions.release(value.sessionId, value.token)),
          )
          throw error
        }
      },
      async create(input) {
        const key = sessionId(input.comparisonId, input.side)
        const ownership = cx.sessionOwnership
        if (!ownership) throw rpcError('CAPABILITY_DENIED')
        // Only backend-created snapshot roots reach addComparison(); request cwd must already be registered.
        await cx.workspaces.addComparison(input.cwd)
        const reservation = await reserveOwnedSession({
          ownership,
          workspaces: cx.workspaces,
          principalId: principal,
          sessionKey: key,
          canonicalRoot: input.cwd,
          hasSessionFact: cx.workspaces.sessionPath(key) !== undefined || cx.registry.get(key) !== undefined,
        })
        const entry = await cx.registry
          .open({
            key,
            cwd: input.cwd,
            binding: reservation.envelope,
            runtime: input.runtime,
            ...(input.preset ? { preset: input.preset } : {}),
            ...(credential === undefined ? {} : { credential: credential }),
          })
          .catch((error: unknown) => {
            const failure = error as {
              code?: unknown
              reason?: unknown
              detail?: { reason?: unknown }
            } | null
            // This error arrives only from the trusted local owner or authenticated worker open, never request payload.
            const reason =
              error instanceof CoreError
                ? error.detail?.reason
                : error instanceof Error
                  ? undefined
                  : failure?.reason
            if (failure?.code === 'E_LANE_BUSY' && reason === 'runtime-publication-pending')
              throw new ComparisonError(
                'COMPARISON_PREPARATION_BUSY',
                'Comparison preparation requires available runtime publication',
              )
            throw error
          })
        if (reservation.reservedNew && !ownership.activateNew(key, principal))
          throw rpcError('CAPABILITY_DENIED')
        if (input.model) {
          const selection = { slot: 'primary', ...input.model, thinking: input.model.thinking ?? null }
          cx.host.validateModelSwitch(selection)
          await entry.session.setModel(selection)
        }
        // JevLoop lane stage bindings land before preparation, so the attested receipt records
        // them (runtimeConfig.languageStages) exactly as the lane will run.
        const stages = Object.fromEntries(
          Object.entries(input.jevStages ?? {}).filter(([, binding]) => binding !== undefined),
        )
        if (Object.keys(stages).length) {
          for (const binding of Object.values(stages))
            if (binding)
              cx.host.validateModelSwitch({
                slot: 'primary',
                route: binding.route,
                model: binding.model,
                ...(binding.thinking === undefined ? {} : { thinking: binding.thinking }),
              })
          await entry.session.setJevStages({ stages })
        }
        const prepared = await cx.host.prepareSessionConfiguration(
          key,
          await isolationFor(input.comparisonId),
        )
        const state = await entry.session.runtimeState()
        if (state.runtime.id !== input.runtime) throw rpcError('SEMANTIC_REJECTED', { code: 'RUNTIME_OWNER' })
        return {
          side: input.side,
          sessionId: key,
          runtime: state.runtime,
          workspaceLabel: input.side,
          phase: state.phase,
          lastSeq: entry.session.lastSeq,
          prepared,
        }
      },
      async enqueue(input) {
        const receipt = await runQueued(
          cx.commandQueue,
          input.sessionId,
          new AbortController().signal,
          async () => {
            const entry = getEntry(input.sessionId)
            const record = await store!.read(input.comparisonId)
            if (record && comparisonInputCancelled(record, input.inputId, input.side))
              return {
                status: 'rejected' as const,
                error: { code: 'CANCELLED', message: 'Input was cancelled' },
              }
            if (entry.inflight)
              return {
                status: 'rejected' as const,
                error: { code: 'SESSION_BUSY', message: 'Session is running' },
              }
            const actor = await cx.resolveNewSessionActor(credential, 'session')
            const message = {
              actor,
              content: input.content,
              commandId: input.inputId,
              ...(input.decisionBackend !== undefined && input.runtime === 'jevloop'
                ? { runtimeOptions: { decisionBackend: input.decisionBackend } }
                : {}),
              admissionId: hash(
                `comparison\u0000${input.comparisonId}\u0000${input.side}\u0000${input.inputId}\u0000${JSON.stringify(input.content)}`,
              ),
            }
            const admission = admissions.get(admissionKey(input.sessionId, input.inputId))
            const seq = admission
              ? await cx.host.configurationAdmissions.enqueue(input.sessionId, admission.token, message)
              : await entry.session.enqueue('next-turn', message)
            return { status: 'accepted' as const, seq }
          },
        )
        await options?.capture?.flush(principal, input.comparisonId)
        return receipt
      },
      async run(input) {
        const record = await store!.findSession(input.sessionId)
        const side = record?.lanes.left?.sessionId === input.sessionId ? 'left' : 'right'
        if (!record || comparisonInputCancelled(record, input.inputId, side))
          return {
            phase: 'idle',
            lastSeq: record?.lanes[side]?.lastSeq ?? 0,
            settled: true,
            terminalCause: record ? 'cancelled' : 'unknown',
          }
        const entry = getEntry(input.sessionId)
        if (entry.inflight) throw rpcError('SESSION_BUSY')
        const abort = new AbortController()
        const admission = admissions.get(admissionKey(input.sessionId, input.inputId))
        const queued = admission ? undefined : cx.activationBarrier.enqueue('turn')
        let finish!: () => void
        const settled = new Promise<void>((resolve) => {
          finish = resolve
        })
        const operation = { promptId: `comparison:${input.inputId}`, abort, settled }
        entry.inflight = operation
        cx.onPromptStart?.(input.sessionId)
        try {
          let running: ReturnType<typeof entry.session.run> | undefined
          await runQueued(cx.commandQueue, input.sessionId, abort.signal, async () => {
            const invocation = await queued?.start()
            try {
              const current = await store!.findSession(input.sessionId)
              if (
                abort.signal.aborted ||
                (current && comparisonInputCancelled(current, input.inputId, side))
              ) {
                invocation?.finish()
                return
              }
              running = admission
                ? (cx.host.configurationAdmissions.run(input.sessionId, admission.token, {
                    until: 'turn-end',
                    signal: abort.signal,
                  }) as ReturnType<typeof entry.session.run>)
                : invocation!.run(() => entry.session.run({ until: 'turn-end', signal: abort.signal }))
            } catch (error) {
              invocation?.finish()
              throw error
            }
          })
          if (!running)
            return {
              phase: 'idle',
              lastSeq: entry.session.lastSeq,
              settled: true,
              terminalCause: 'cancelled',
            }
          const result = await running
          const state = await entry.session.runtimeState()
          let referencesValid = true
          try {
            await verifyComparisonWorkspaceReferences(
              referenceOptions,
              physicalId(record.id),
              record.baseline,
            )
          } catch {
            referencesValid = false
          }
          const settled =
            result.reason !== 'blocked' && !['waiting', 'parked', 'recovering'].includes(state.phase)
          return {
            phase: state.phase,
            lastSeq: result.lastSeq,
            settled,
            ...(settled
              ? {
                  terminalCause: !referencesValid
                    ? ('failed' as const)
                    : result.reason === 'completed'
                      ? ('finished' as const)
                      : result.reason === 'aborted'
                        ? ('cancelled' as const)
                        : ('failed' as const),
                }
              : {}),
          }
        } catch (error) {
          const current = await store!.findSession(input.sessionId)
          if (current && comparisonInputCancelled(current, input.inputId, side)) {
            const state = await entry.session.runtimeState()
            const settled = !['running', 'waiting', 'parked', 'recovering'].includes(state.phase)
            const recorded = await sessions.inspect(input)
            return {
              phase: state.phase,
              lastSeq: entry.session.lastSeq,
              settled,
              ...(settled ? { terminalCause: recorded.state?.terminalCause ?? ('unknown' as const) } : {}),
            }
          }
          throw error
        } finally {
          queued?.cancel()
          if (entry.inflight === operation) entry.inflight = null
          cx.onPromptEnd?.(input.sessionId)
          finish()
          if (record) await options?.capture?.flush(principal, record.id)
        }
      },
      async cancel(input) {
        // Coordinator persisted its cancellation fence before entering this port.
        const entry = cx.registry.get(input.sessionId)
        if (!entry) throw rpcError('SEMANTIC_REJECTED', { code: 'CONFIGURATION_OWNER_UNAVAILABLE' })
        getEntry(input.sessionId)
        const record = await store!.findSession(input.sessionId)
        const actor = await cx.resolveNewSessionActor(credential, 'session')
        if (input.inputId !== undefined && input.inputId !== record?.rounds.at(-1)?.inputId) {
          await cx.host.configurationAdmissions.cancel(input.sessionId, input.inputId, actor, true)
          const lastSeq = options?.ledger ? await options.ledger.head(input.sessionId) : entry.session.lastSeq
          return { phase: 'idle', lastSeq, settled: true, terminalCause: 'cancelled' }
        }
        const inflight = entry.inflight
        inflight?.abort.abort()
        // Internal child-report wakes have no RPC inflight entry. Stop their owner as well.
        await entry.session.abort(await cx.resolveNewSessionActor(credential, 'session'))
        if (input.inputId)
          await runQueued(
            cx.commandQueue,
            input.sessionId,
            new AbortController().signal,
            () => entry.session.cancelQueuedInput(input.inputId!),
            undefined,
            'maintenance',
          )
        await inflight?.settled
        await cx.host.configurationAdmissions.cancel(
          input.sessionId,
          input.inputId,
          await cx.resolveNewSessionActor(credential, 'session'),
        )
        let state = await entry.session.runtimeState()
        if (!inflight && ['waiting', 'parked', 'recovering'].includes(state.phase)) {
          await entry.session.abort(await cx.resolveNewSessionActor(credential, 'session'))
          state = await entry.session.runtimeState()
        }
        const settled = !['running', 'waiting', 'parked', 'recovering'].includes(state.phase)
        const recorded = input.inputId
          ? await sessions.inspect({ sessionId: input.sessionId, inputId: input.inputId })
          : undefined
        return {
          phase: state.phase,
          lastSeq: entry.session.lastSeq,
          settled,
          ...(settled ? { terminalCause: recorded?.state?.terminalCause ?? ('cancelled' as const) } : {}),
        }
      },
      async close(input) {
        const key = sessionId(input.comparisonId, input.side)
        // A missing registry entry cannot prove the owner exited after a lost create reply.
        if (!cx.registry.closeAndConfirm) {
          await cx.registry.close(key)
          return { exited: false }
        }
        const confirmation = await cx.registry.closeAndConfirm(key)
        return { exited: confirmation.exited }
      },
      async inspect(input) {
        if (!options?.ledger || cx.sessionOwnership?.resolve(input.sessionId)?.principalId !== principal)
          return {}
        const throughSeq = await options.ledger.head(input.sessionId)
        return inspectComparisonInput({
          ...input,
          throughSeq,
          scan: (query) => options.ledger!.scan(input.sessionId, query),
        })
      },
    }
    const coordinator =
      store && options
        ? new ComparisonCoordinator({
            store,
            sessions,
            clock: { now: () => Date.now(), monotonic: () => performance.now() },
            async resolveCreation(input) {
              const catalog = cx.runtimeCatalog ? await cx.runtimeCatalog() : cx.host.runtimeCatalog()
              for (const lane of [input.left, input.right])
                if (!catalog.some((item) => item.id === lane.runtime && item.available))
                  throw rpcError('SEMANTIC_REJECTED', { code: 'RUNTIME_UNAVAILABLE', runtime: lane.runtime })
              await cx.workspaces.bind(undefined, input.cwd)
              return cx.host.resolveSessionSelection({
                ...(input.preset === undefined ? {} : { preset: input.preset }),
                ...(input.model === undefined ? {} : { model: input.model }),
              })
            },
            workspaces: {
              async prepare(input) {
                const authorized = await cx.workspaces.bind(undefined, input.cwd)
                const workspaces = createComparisonWorkspaces({
                  directory: join(options.dataDir, 'comparisons', 'workspaces'),
                  authorizeExternalRead: referenceOptions.authorizeExternalRead,
                  async authorizeRead(path) {
                    const rel = relative(authorized.path, path)
                    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
                      throw rpcError('CAPABILITY_DENIED')
                  },
                })
                try {
                  return await workspaces.prepare({
                    cwd: authorized.path,
                    comparisonId: physicalId(input.comparisonId),
                  })
                } catch (error) {
                  if (error instanceof ComparisonWorkspaceError)
                    throw new ComparisonError(`WORKSPACE_${error.code}`, 'Workspace preparation failed')
                  throw error
                }
              },
              release: (id) =>
                createComparisonWorkspaces({
                  directory: join(options.dataDir, 'comparisons', 'workspaces'),
                  async authorizeRead() {
                    throw rpcError('CAPABILITY_DENIED')
                  },
                }).release(physicalId(id)),
            },
          })
        : undefined
    return coordinator
  }
  const requireCoordinator = () => {
    const principal = ep.conn.principalId
    let coordinator = controls.get(principal)
    if (!coordinator) {
      coordinator = makeCoordinator(principal)
      if (coordinator) controls.set(principal, coordinator)
    }
    if (!coordinator)
      throw rpcError('CAPABILITY_DENIED', { reason: 'durable comparison storage unavailable' })
    if (
      cx.auth.config.transport === 'ws' &&
      cx.auth.config.localWeb !== true &&
      cx.sessionCredentialAuthority !== true
    )
      throw rpcError('CAPABILITY_DENIED', { reason: 'comparison actor authority unavailable' })
    return coordinator
  }
  function rejectComparison(error: unknown): never {
    // Only the owning domain error's bounded identifier is public. Never forward exception
    // prose, causes, parameters, or duck-typed codes from unknown backend failures.
    if (error instanceof ComparisonError && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code))
      throw rpcError('SEMANTIC_REJECTED', { code: error.code })
    throw error
  }
  async function comparisonRequest<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      return rejectComparison(error)
    }
  }
  ep.register('_agnes/v1/comparison.create', async (params) => {
    const control = requireCoordinator()
    const input = params as ComparisonCreateParams
    if (input.isolation && input.isolation !== 'snapshot')
      throw rpcError('SEMANTIC_REJECTED', { code: 'ISOLATION_UNSUPPORTED' })
    const state = await comparisonRequest(() => control.create(input))
    // An idempotent create may return historical lanes without opening either session.
    if (state.lanes.every((lane) => cx.registry.get(lane.sessionId)))
      await options?.capture?.ensure(ep.conn.principalId, state.id)
    return state
  })
  ep.register('_agnes/v1/comparison.get', (params) =>
    comparisonRequest(() => requireCoordinator().get((params as ComparisonIdParams).id)),
  )
  ep.register('_agnes/v1/comparison.reconcile', (params) =>
    comparisonRequest(() => requireCoordinator().reconcile((params as ComparisonIdParams).id)),
  )
  ep.register('_agnes/v1/comparison.submit', async (params) => {
    const input = params as ComparisonSubmitParams
    const control = requireCoordinator()
    const existing = await options?.storage.scoped(ep.conn.principalId).read(input.id)
    if (
      existing?.lanes.left &&
      existing.lanes.right &&
      Object.values(existing.lanes).every((lane) => lane && cx.registry.get(lane.sessionId))
    )
      await options?.capture?.ensure(ep.conn.principalId, input.id)
    try {
      const state = await control.submit(input)
      return state.rounds.find((round) => round.inputId === input.inputId)!
    } catch (error) {
      if (
        error instanceof ComparisonError &&
        error.rejectedInput?.id === input.id &&
        error.rejectedInput.inputId === input.inputId
      )
        throw rpcError('SEMANTIC_REJECTED', {
          code: error.code,
          id: input.id,
          inputId: input.inputId,
          phase: 'pre-admission',
          inputAccepted: false,
          ...(error.rejectedInput.admissionReason
            ? { admissionReason: error.rejectedInput.admissionReason }
            : {}),
        })
      // Other domain errors expose no pre-admission receipt. A CAS/storage error may have
      // committed and remains unknown; a later read cannot authorize a different input identity.
      return rejectComparison(error)
    }
  })
  ep.register('_agnes/v1/comparison.cancel', (params) =>
    comparisonRequest(() => requireCoordinator().cancel(params as ComparisonCancelParams)),
  )
  return {
    drain: async () => {
      await Promise.all([...controls.values()].map((control) => control.drain()))
    },
  }
}
