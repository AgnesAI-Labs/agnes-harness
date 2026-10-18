import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PackageError, withLock } from '@agnes/package-manager'
import { type AgentPlan, jcs, parseAgentRef } from '@agnes/protocol'
import { readReceiptDates, saveReceiptJournal } from './receipt-journal.js'
import { OPERATION_CAPACITY, type RetainedOperation, sweepReceipts } from './receipt-retention.js'

type Caller = { principal: string; profile: string; workspace: string; activation: string }
type Review = { owner: string; activation: string; expires: number; plan: AgentPlan }
type Operation = RetainedOperation & {
  payload: string
  review: Review
  sessionId?: string
  code?: string
}
type State = { reviews: Record<string, Review>; operations: Record<string, Operation> }
export interface AgentLaunchBackend {
  /** Host caller context, never an agent's own UI row or package-management authority. */
  caller(): Promise<Caller>
  resolve(ref: string): Promise<AgentPlan>
  /** Re-enters ordinary session/workspace authorization with strict Host admission. */
  open(plan: AgentPlan, sessionKey: string): Promise<string>
}
const hash = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
const deny = (code = 'E_PACKAGE_PREVIEW_STALE'): never => {
  throw new Error(code)
}
const token = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : deny('INVALID_REQUEST')
const result = (op: Operation) => ({
  sessionId: op.sessionId,
  ...(op.review.plan.launch.prompt ? { draft: op.review.plan.launch.prompt } : {}),
})

/** Ordinary prepare/review/start branch. No installation, trust, enable or remove operations. */
export function createAgentLaunches(options: {
  directory: string
  backend: AgentLaunchBackend
  now?: () => number
}) {
  const { backend } = options
  const now = options.now ?? Date.now
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const file = join(options.directory, 'agent-operations.json')
  const read = (): State => {
    if (!existsSync(file)) return { reviews: {}, operations: {} }
    const body = readFileSync(file, 'utf8')
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) deny('OVERLOADED')
    const value = JSON.parse(body) as State
    if (!value.reviews || !value.operations) deny('E_PACKAGE_INTEGRITY')
    readReceiptDates(file, value)
    return value
  }
  const save = (state: State) => saveReceiptJournal(file, state)
  const scope = ({ principal, profile, workspace }: Caller) => hash({ principal, profile, workspace })
  const check = async (review: Review, caller: Caller, receipt = false) => {
    if (
      review.owner !== scope(caller) ||
      review.activation !== caller.activation ||
      (!receipt && review.expires <= now())
    )
      deny()
    const current = await backend.resolve(review.plan.ref)
    if (current.digest !== review.plan.digest) deny()
  }
  return {
    async call(request: Record<string, unknown>): Promise<unknown> {
      const fields: Record<string, string[]> = {
        resolve: ['agent'],
        prepare: ['agent'],
        start: ['launchTicket', 'operationId'],
        read: ['operationId'],
      }
      const action = typeof request.action === 'string' ? request.action : ''
      const keys = Object.hasOwn(fields, action) ? fields[action] : undefined
      if (
        !keys ||
        Object.keys(request).some((key) => key !== 'action' && !keys.includes(key)) ||
        keys.some((key) => typeof request[key] !== 'string')
      )
        deny('INVALID_REQUEST')
      // The atomic journal remains readable while start owns the write lock across backend.open.
      if (action === 'read') {
        const caller = await backend.caller()
        const signal = AbortSignal.timeout(1)
        let entered = false
        try {
          await withLock(
            options.directory,
            async () => {
              entered = true
              const state = read()
              if (sweepReceipts(state.operations, now())) await save(state)
            },
            { signal },
          )
        } catch (error) {
          if (
            entered ||
            !signal.aborted ||
            !(error instanceof PackageError) ||
            error.code !== 'E_PACKAGE_CANCELLED'
          )
            throw error
        }
        const owner = scope(caller)
        const op = read().operations[hash([owner, token(request.operationId)])]
        if (!op || op.review.owner !== owner || op.review.activation !== caller.activation)
          return deny('CAPABILITY_DENIED')
        return {
          state: op.state,
          ...(op.code ? { code: op.code } : {}),
          ...(op.sessionId ? result(op) : {}),
        }
      }
      return withLock(options.directory, async () => {
        const caller = await backend.caller()
        const owner = scope(caller)
        const state = read()
        if (action === 'resolve') return backend.resolve(parseAgentRef(request.agent))
        if (sweepReceipts(state.operations, now())) await save(state)
        if (action === 'prepare') {
          const plan = await backend.resolve(parseAgentRef(request.agent))
          // Caller activation may change while a container is being admitted.
          const review = { owner, activation: caller.activation, expires: now() + 300_000, plan }
          await check(review, await backend.caller())
          for (const [id, item] of Object.entries(state.reviews))
            if (item.expires <= now()) delete state.reviews[id]
          if (Object.keys(state.reviews).length >= 256) deny('OVERLOADED')
          const launchTicket = randomUUID()
          state.reviews[launchTicket] = review
          await save(state)
          return { launchTicket, presentation: plan }
        }
        const key = hash([owner, token(request.operationId)])
        let op = state.operations[key]
        const payload = hash(request)
        if (op) {
          if (op.payload !== payload) deny()
          await check(op.review, caller, true)
          if (op.state === 'completed') return result(op)
          if (op.state === 'running') {
            op.state = 'unknown'
            op.code = 'OUTCOME_UNKNOWN'
            op.terminalAt = now()
            await save(state)
          }
          return deny(op.code ?? 'OUTCOME_UNKNOWN')
        }
        const review = state.reviews[token(request.launchTicket)] ?? deny()
        await check(review, caller)
        if (Object.keys(state.operations).length >= OPERATION_CAPACITY) deny('OVERLOADED')
        op = { payload, review, state: 'running' }
        state.operations[key] = op
        await save(state)
        try {
          await check(review, await backend.caller())
          op.sessionId = await backend.open(review.plan, `agent:${key}`)
          await check(review, await backend.caller(), true)
          op.state = 'completed'
          op.terminalAt = now()
          await save(state)
          return result(op)
        } catch (error) {
          const value = error as { message?: unknown; data?: { code?: unknown } } | null
          const known = [
            'E_PACKAGE_PREVIEW_STALE',
            'E_PACKAGE_STATE',
            'E_PACKAGE_BLOCKED',
            'CAPABILITY_DENIED',
            'E_PRESET_UNRESOLVED',
            'E_PRESET_UNSUPPORTED',
            'E_MODEL_UNSUPPORTED',
          ]
          const code =
            [value?.data?.code, value?.message].find(
              (code): code is string => typeof code === 'string' && known.includes(code),
            ) ?? 'OUTCOME_UNKNOWN'
          op.state = code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed'
          op.code = code
          op.terminalAt = now()
          await save(state)
          return deny(code)
        }
      })
    },
  }
}
