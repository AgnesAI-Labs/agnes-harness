import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { satisfiesApiRange } from '@agnes/extension-api'
import { PackageError, withLock } from '@agnes/package-manager'
import type {
  AgentPlan,
  ClientModuleRosterRow,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackagePreview,
} from '@agnes/protocol'
import { jcs } from '@agnes/protocol'
import { readReceiptDates, saveReceiptJournal } from './receipt-journal.js'
import { OPERATION_CAPACITY, type RetainedOperation, sweepReceipts } from './receipt-retention.js'

type Owner = { version: string; principal: string; profile: string; row: ClientModuleRosterRow }
type Review = {
  owner: string
  parent: string
  expires: number
  entry: PackageCatalogDescriptor
  preview: PackagePreview
  removal?: boolean
  launch?: AgentPlan
}
type Operation = RetainedOperation & {
  owner: string
  digest: string
  code?: string
  sessionId?: string
  review: Review
}
type State = { version: 1; reviews: Record<string, Review>; operations: Record<string, Operation> }
export interface ExampleBackend {
  runtime(
    exampleId: string,
  ): Promise<{ state: 'starting' | 'running' | 'failed' | 'stopped' | 'unavailable'; code?: string }>
  stop(exampleId: string, commandId: string): Promise<void>
  remove(review: Review, commandId: string, check: () => Promise<void>): Promise<void>
  owner(rowId: string): Promise<Owner>
  catalog(): Promise<readonly PackageCatalogDescriptor[]>
  installed(): Promise<readonly PackageInstalledDescriptor[]>
  inspect(entry: PackageCatalogDescriptor, command: string): Promise<PackagePreview>
  enable(review: Review, command: string, check: () => Promise<void>): Promise<void>
  /** Must select this exact reviewed bundle/preset, with no model or permission fallback. */
  open(plan: AgentPlan, sessionKey: string): Promise<string>
  resolveAgent(ref: string): Promise<AgentPlan>
}
const digest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
function deny(code = 'CAPABILITY_DENIED'): never {
  throw new Error(code)
}
const identity = (owner: Owner) =>
  digest({ principal: owner.principal, profile: owner.profile, row: owner.row.rowId })
const parent = (owner: Owner) => owner.row.binding?.activationId ?? deny()
const id = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : deny('INVALID_REQUEST')
const field = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : deny('INVALID_REQUEST')

/** A fixed catalogue-only facade. No action accepts a source, path, host ID, approval or admin method. */
export function createExamplePackages(options: {
  directory: string
  backend: ExampleBackend
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const backend = options.backend
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const file = join(options.directory, 'operations.json')
  function read(): State {
    if (!existsSync(file)) return { version: 1, reviews: {}, operations: {} }
    if (statSync(file).size > 16 * 1024 * 1024) return deny('E_PACKAGE_INTEGRITY')
    const state = JSON.parse(readFileSync(file, 'utf8')) as State
    if (state.version !== 1 || !state.reviews || !state.operations) return deny('E_PACKAGE_INTEGRITY')
    readReceiptDates(file, state)
    return state
  }
  const save = (state: State) => saveReceiptJournal(file, state)
  async function owner(rowId: string): Promise<Owner> {
    const value = await backend.owner(rowId)
    if (
      !value.row.enabled ||
      value.row.phase !== 'ready' ||
      value.row.binding?.lifetime !== 'profile' ||
      value.row.binding.availability !== 'active'
    )
      deny()
    return value
  }
  async function entries(who: Owner) {
    return (await backend.catalog()).filter(
      (entry) => entry.compatibility === 'supported' && entry.metadata?.exampleOf === who.row.packageId,
    )
  }
  async function current(review: Review, who: Owner, running = false) {
    if (
      review.owner !== identity(who) ||
      review.parent !== parent(who) ||
      (!running && review.expires <= now())
    )
      deny('E_PACKAGE_PREVIEW_STALE')
    const range = review.preview.dependencies[who.row.packageId ?? '']
    if (!range || !satisfiesApiRange(range, who.version)) deny('E_PACKAGE_BLOCKED')
    const entry = (await entries(who)).find((entry) => entry.id === review.entry.id)
    if (
      !entry ||
      entry.integrity !== review.entry.integrity ||
      digest([entry.metadata, entry.agents]) !== digest([review.entry.metadata, review.entry.agents])
    )
      deny('E_PACKAGE_PREVIEW_STALE')
    const installed = (await backend.installed()).find((item) => item.id === entry.id)
    if (
      installed &&
      (installed.integrity !== review.preview.integrity ||
        installed.capabilityHash !== review.preview.capabilityHash ||
        installed.blockers.length)
    )
      deny('E_PACKAGE_PREVIEW_STALE')
    if (review.launch && (await backend.resolveAgent(review.launch.ref)).digest !== review.launch.digest)
      deny('E_PACKAGE_PREVIEW_STALE')
    return installed
  }
  return {
    async call(rowId: string, request: Record<string, unknown>): Promise<unknown> {
      const keys: Record<string, string[]> = {
        list: [],
        stop: ['exampleId', 'operationId'],
        inspect: ['exampleId'],
        'inspect-remove': ['exampleId'],
        remove: ['reviewId', 'operationId'],
        enable: ['reviewId', 'operationId'],
        read: ['operationId'],
        prepare: ['exampleId', 'launchId'],
        start: ['launchTicket', 'operationId'],
      }
      const action = typeof request.action === 'string' ? request.action : ''
      const allowed = Object.hasOwn(keys, action) ? keys[action] : undefined
      if (
        !allowed ||
        Object.keys(request).some((key) => key !== 'action' && !allowed.includes(key)) ||
        allowed.some((key) => typeof request[key] !== 'string')
      )
        deny('INVALID_REQUEST')
      // Receipts are atomic files and can be read while a long activation is still running.
      if (action === 'read') {
        const who = await owner(rowId)
        // Give up acquiring the sweep lock promptly when an activation owns it.
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
        const op = read().operations[digest([identity(who), id(request.operationId)])]
        if (!op || op.owner !== identity(who)) deny()
        return {
          state: op.state,
          ...(op.code ? { code: op.code } : {}),
          ...(op.sessionId ? { sessionId: op.sessionId } : {}),
        }
      }
      return withLock(options.directory, async () => {
        const who = await owner(rowId)
        const scope = identity(who)
        const state = read()
        if (sweepReceipts(state.operations, now())) await save(state)
        if (action === 'stop') {
          const entry = (await entries(who)).find((entry) => entry.id === field(request.exampleId)) ?? deny()
          const installed = (await backend.installed()).find((item) => item.id === entry.id)
          if (!installed || installed.metadata?.exampleOf !== who.row.packageId) deny()
          await backend.stop(entry.id, id(request.operationId))
          return null
        }
        if (action === 'list') {
          const installed = await backend.installed()
          return Promise.all(
            (await entries(who)).map(async (entry) => {
              const item = installed.find((item) => item.id === entry.id)
              return {
                id: entry.id,
                version: entry.version,
                integrity: entry.integrity,
                metadata: entry.metadata,
                bundled: entry.source.ref.startsWith('file:./bundled-examples/'),
                runtime: item?.desired === 'enabled' ? await backend.runtime(entry.id) : { state: 'stopped' },
                installation: !item
                  ? 'not-installed'
                  : item.actual === 'failed'
                    ? 'failed'
                    : item.desired === 'enabled' && item.actual === 'running'
                      ? 'enabled'
                      : item.desired === 'enabled'
                        ? 'enabling'
                        : 'disabled',
              }
            }),
          )
        }
        if (action === 'inspect' || action === 'inspect-remove' || action === 'prepare') {
          const entry = (await entries(who)).find((entry) => entry.id === field(request.exampleId)) ?? deny()
          const preview = await backend.inspect(entry, randomUUID())
          if (
            preview.id !== entry.id ||
            preview.integrity !== entry.integrity ||
            !preview.capabilityHash ||
            preview.blockers.length
          )
            deny('E_PACKAGE_BLOCKED')
          const review: Review = {
            owner: scope,
            parent: parent(who),
            expires: now() + 300_000,
            entry,
            preview,
            ...(action === 'inspect-remove' ? { removal: true } : {}),
          }
          if (review.removal && !(await current(review, who))) deny('E_PACKAGE_STATE')
          if (action === 'prepare') {
            const installed = await current(review, who)
            if (!installed?.trusted || installed.desired !== 'enabled' || installed.actual !== 'running')
              deny('E_PACKAGE_STATE')
            const launchId = field(request.launchId)
            const declared = entry.agents?.find((agent) => agent.ref === `${entry.id}#${launchId}`) ?? deny()
            const plan = await backend.resolveAgent(declared.ref)
            if (plan.ref !== declared.ref || digest(plan.launch) !== digest(declared.launch))
              deny('E_PACKAGE_PREVIEW_STALE')
            review.launch = plan
          }
          for (const [key, item] of Object.entries(state.reviews))
            if (item.expires <= now()) delete state.reviews[key]
          if (Object.keys(state.reviews).length >= 256) deny('OVERLOADED')
          const ticket = randomUUID()
          state.reviews[ticket] = review
          await save(state)
          return action === 'prepare'
            ? {
                launchTicket: ticket,
                presentation: {
                  ...review.launch,
                  title: review.launch?.launch.title.en,
                  bundle: review.launch?.ref,
                  prompt: review.launch?.launch.prompt?.text.en ?? '',
                },
              }
            : {
                reviewId: ticket,
                integrity: preview.integrity,
                capabilityHash: preview.capabilityHash,
                presentation: {
                  ...(review.removal ? { action: 'remove' } : {}),
                  metadata: entry.metadata,
                  license: entry.license,
                  capabilities: preview.declaredCapabilities,
                  contributions: preview.contributions,
                },
              }
        }
        const operationId = id(request.operationId)
        const operationKey = digest([scope, operationId])
        const payload = digest(request)
        let op = state.operations[operationKey]
        if (op) {
          if (op.owner !== scope || op.digest !== payload) deny('E_PACKAGE_PREVIEW_STALE')
          await current(op.review, who, true)
          if (op.state === 'running') {
            op.state = 'unknown'
            op.code = 'OUTCOME_UNKNOWN'
            op.terminalAt = now()
            await save(state)
          }
          if (op.state === 'completed')
            return action === 'start'
              ? {
                  sessionId: op.sessionId,
                  ...(op.review.launch?.launch.prompt ? { draft: op.review.launch.launch.prompt } : {}),
                }
              : { operationId }
          if (op.state === 'failed' || op.state === 'unknown') deny(op.code ?? 'OUTCOME_UNKNOWN')
        } else {
          const review =
            state.reviews[field(action === 'start' ? request.launchTicket : request.reviewId)] ??
            deny('E_PACKAGE_PREVIEW_STALE')
          await current(review, who)
          if (
            (action === 'start') !== Boolean(review.launch) ||
            (action === 'remove') !== Boolean(review.removal)
          )
            deny()
          if (Object.keys(state.operations).length >= OPERATION_CAPACITY) deny('OVERLOADED')
          op = { owner: scope, digest: payload, state: 'running', review }
          state.operations[operationKey] = op
          await save(state)
        }
        const review = op.review
        const check = async () => {
          await current(review, await owner(rowId), true)
        }
        try {
          await check()
          if (action === 'remove') await backend.remove(review, operationKey, check)
          else if (action === 'enable') await backend.enable(review, operationKey, check)
          else {
            const launch = review.launch ?? deny()
            const installed = await current(review, await owner(rowId), true)
            if (!installed?.trusted || installed.desired !== 'enabled' || installed.actual !== 'running')
              deny('E_PACKAGE_STATE')
            if ((await backend.resolveAgent(launch.ref)).digest !== launch.digest)
              deny('E_PACKAGE_PREVIEW_STALE')
            op.sessionId = await backend.open(launch, `example:${operationKey}`)
            await save(state)
            await check()
          }
          op.state = 'completed'
          op.terminalAt = now()
          await save(state)
          return action === 'start'
            ? {
                sessionId: op.sessionId,
                ...(op.review.launch?.launch.prompt ? { draft: op.review.launch.launch.prompt } : {}),
              }
            : { operationId }
        } catch (error) {
          const code =
            error instanceof Error &&
            ['E_PACKAGE_STATE', 'E_PACKAGE_PREVIEW_STALE', 'E_PACKAGE_BLOCKED', 'CAPABILITY_DENIED'].includes(
              error.message,
            )
              ? error.message
              : 'OUTCOME_UNKNOWN'
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

export { type AgentLaunchBackend, createAgentLaunches } from './agent-launches.js'
