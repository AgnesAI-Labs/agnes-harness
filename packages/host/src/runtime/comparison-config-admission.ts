import { randomUUID } from 'node:crypto'
import {
  CoreError,
  canonicalJson,
  type EnqueueMsg,
  reserveSessionConfiguration,
  type SessionConfigurationAdmission,
  type SessionImpl,
  sha256Hex,
} from '@agnes/core'
import type { Actor, ComparisonPreparedReceipt, ContentBlock } from '@agnes/protocol'
import type { ActivationInvocation, ExtensionActivationBarrier } from '../ext-host/activation-barrier.js'
import {
  captureSessionConfiguration,
  prepareRoundConfiguration,
  verifyPreparedReceipt,
} from './comparison-prepared.js'

export interface ConfigurationAdmissionReceipt {
  token: string
  sessionId: string
  writerRunId: string
  inputId: string
  payloadDigest: string
  prepared: ComparisonPreparedReceipt
}
export interface ConfigurationAdmissionPort {
  acquire(
    input: {
      sessionId: string
      inputId: string
      payloadDigest: string
      prepared: ComparisonPreparedReceipt
      permissionMode?: 'view' | 'workspace' | 'full'
    },
    finish?: () => void,
  ): Promise<ConfigurationAdmissionReceipt>
  check(sessionId: string, token: string, seal?: boolean): Promise<void>
  enqueue(sessionId: string, token: string, message: EnqueueMsg): Promise<number>
  run(
    sessionId: string,
    token: string,
    options: { until: 'turn-end' | 'idle'; signal: AbortSignal },
  ): Promise<{ reason: string; lastSeq: number; error?: unknown }>
  release(sessionId: string, token: string): Promise<void>
  /** Returns undefined for ordinary sessions, preserving their existing control route. */
  control?(
    sessionId: string,
    input: Parameters<SessionImpl['controlRuntime']>[0],
  ): Promise<Awaited<ReturnType<SessionImpl['controlRuntime']>>> | undefined
  cancel(
    sessionId: string,
    inputId: string | undefined,
    actor: Actor,
    onlyMatching?: boolean,
  ): Promise<{ inputId: string | null }>
}
type ConfigurationPin = { release(): void; run<T>(operation: () => Promise<T>): Promise<T> }
type Owner = {
  session: SessionImpl
  receipt: ConfigurationAdmissionReceipt
  lease: SessionConfigurationAdmission
  invocation: ActivationInvocation
  pin: ConfigurationPin
  sealed: boolean
}

/** Host-private capability authority. Lost replies never expire or downgrade accepted ownership. */
export function createConfigurationAdmissions(
  lookup: (key: string) => SessionImpl | undefined,
  barrier: ExtensionActivationBarrier,
  retain: () => ConfigurationPin,
): ConfigurationAdmissionPort {
  const owners = new Map<string, Owner>()
  const owner = (sessionId: string, token: string) => {
    const value = owners.get(token)
    if (!value || value.session !== lookup(sessionId) || value.session.key !== sessionId)
      throw new CoreError('E_RELATION', 'Configuration admission owner unavailable')
    value.lease.check()
    return value
  }
  return {
    async acquire(input, finish) {
      const session = lookup(input.sessionId)
      if (!session) throw new CoreError('E_CLOSED', 'Configuration owner unavailable')
      const pin = retain()
      let invocation: ActivationInvocation
      try {
        invocation = barrier.admit('turn')
      } catch (error) {
        pin.release()
        throw error
      }
      const token = randomUUID()
      let acquired = false
      let lease: SessionConfigurationAdmission | undefined
      let released = false
      const releaseResources = () => {
        if (released) return
        released = true
        owners.delete(token)
        invocation.finish()
        pin.release()
        finish?.()
      }
      try {
        const prepared = input.prepared
        const [start, source] = await Promise.all([
          session.scan({ type: 'session/start', order: 'asc', limit: 1 }),
          session.scan({ fromSeq: prepared.sourceSeq, toSeq: prepared.sourceSeq, limit: 1 }),
        ])
        if (prepared.sessionId !== session.key || !verifyPreparedReceipt(prepared, [...start, ...source]))
          throw new CoreError(
            'E_RELATION',
            'Prepared configuration source does not match its durable receipt',
            { reason: 'prepared-source-invalid' },
          )
        const reserved = await reserveSessionConfiguration(
          session,
          {
            id: token,
            commandId: input.inputId,
            payloadDigest: input.payloadDigest,
            expectedConfigurationDigest: sha256Hex(canonicalJson(prepared.configuration)),
            ...(input.permissionMode === undefined
              ? {}
              : {
                  approvalMode: input.permissionMode === 'full' ? ('off' as const) : ('manual' as const),
                }),
          },
          () => captureSessionConfiguration(session, true),
          releaseResources,
        )
        lease = reserved.lease
        const permissionMode = input.permissionMode
        const roundPrepared =
          permissionMode === undefined
            ? prepared
            : await session.locked(async () => {
                reserved.lease.check()
                const value = await prepareRoundConfiguration(
                  session,
                  input.inputId,
                  permissionMode,
                  reserved.value,
                )
                reserved.lease.check()
                return value
              })
        acquired = true
        const receipt = {
          token,
          sessionId: session.key,
          writerRunId: session.writerRunId,
          inputId: input.inputId,
          payloadDigest: input.payloadDigest,
          prepared: roundPrepared,
        }
        owners.set(token, { session, receipt, lease: reserved.lease, invocation, pin, sealed: false })
        return structuredClone(receipt)
      } catch (error) {
        // No input has been enqueued here. Release outside the writer lock, restoring
        // the prior approval policy; an uncertain owner remains fail-closed.
        if (lease) await lease.release().catch(() => undefined)
        throw error
      } finally {
        // An unconfirmed lease release keeps its resource owner until explicit cancel/close.
        if (!acquired && !lease) releaseResources()
      }
    },
    async check(sessionId, token, seal = false) {
      const value = owner(sessionId, token)
      if (seal) value.sealed = true
    },
    enqueue(sessionId, token, message) {
      const value = owner(sessionId, token)
      return value.lease.enqueue(message)
    },
    async run(sessionId, token, options) {
      const value = owner(sessionId, token)
      if (!value.sealed) throw new CoreError('E_RELATION', 'Both lanes must be checked before dispatch')
      try {
        return await value.pin.run(() => value.invocation.retain().run(() => value.lease.run(options)))
      } finally {
        // A parked/unknown turn keeps its authority; cancellation or close may retire it later.
        await value.lease.release().catch(() => undefined)
      }
    },
    release(sessionId, token) {
      return owner(sessionId, token).lease.release()
    },
    control(sessionId, input) {
      const session = lookup(sessionId)
      const value = [...owners.values()].find((candidate) => candidate.session === session)
      if (!value) return undefined
      // Host knows this operation only journals explicit operator evidence; it never reruns effects.
      if (
        input.expectedRuntime.id !== 'jevloop' ||
        input.expectedRuntime.version !== '1' ||
        input.operation !== 'jev.resolveUnknown'
      )
        return value.session.controlRuntime(input)
      return value.pin.run(async () => {
        value.lease.check()
        const result = await value.lease.control(input)
        // Multiple unresolved effects remain pinned. Only an actually idle owner may release.
        await value.lease.release().catch(() => undefined)
        return result
      })
    },
    async cancel(sessionId, inputId, actor, onlyMatching) {
      const session = lookup(sessionId)
      if (!session) throw new CoreError('E_CLOSED', 'Configuration owner unavailable')
      const commandId = inputId ?? session.configurationAdmissionInputId
      if (commandId === undefined) {
        if (session.configurationReserved)
          throw new CoreError('E_RELATION', 'Configuration cancellation identity is unknown')
        return { inputId: null }
      }
      if (onlyMatching) {
        // The writer lock persists the exact command fence before proving absence.
        // A late reserve/enqueue must see it; unrelated admitted work is untouched.
        await session.cancelQueuedInput(commandId)
        if (commandId !== session.configurationAdmissionInputId) return { inputId: commandId }
      }
      if (session.executionActive)
        throw new CoreError('E_LANE_BUSY', 'Drain execution before cancelling admission')
      if (session.configurationReserved && commandId !== session.configurationAdmissionInputId)
        throw new CoreError('E_RELATION', 'Configuration cancellation identity differs')
      await session.abort(actor)
      await session.cancelQueuedInput(commandId)
      if (session.configurationReserved && session.op()) {
        await session.abort(actor)
        await session.resume({ mode: 'close' })
      }
      await session.cancelQueuedInput(commandId)
      if (session.configurationReserved)
        throw new CoreError('E_RELATION', 'Configuration cancellation is unconfirmed')
      return { inputId: commandId }
    },
  }
}

export const comparisonPayloadDigest = (content: readonly ContentBlock[]) => sha256Hex(canonicalJson(content))
