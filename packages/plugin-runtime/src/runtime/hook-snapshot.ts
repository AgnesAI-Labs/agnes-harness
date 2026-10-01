import { createHash } from 'node:crypto'
import { detectDependencyCycle } from '../dependency-graph.js'
import {
  AssemblyRefusal,
  type HookFailPolicy,
  PUBLIC_HOOK_EVENTS,
  type PublicHookEvent,
} from './cordis-adapter.js'

const DIGEST = /^[a-f0-9]{64}$/u
const INTERCEPTOR_EVENTS = [
  'resources_discover',
  'before_step',
  'context',
  'before_request',
  'tool_call',
  'tool_result',
  'turn_stopping',
  'approval_request',
  'before_compact',
] as const

export type InterceptorEvent = (typeof INTERCEPTOR_EVENTS)[number]

const INTERCEPTOR_EVENT_SET = new Set<string>(INTERCEPTOR_EVENTS)

export type HookBinding = {
  readonly bindingId: string
  readonly contract: string
  readonly logicalName: string
  readonly providerId: string
}

export type HookEffectRef = {
  readonly contract: string
  readonly logicalName: string
  readonly method: string
}

export type HookDeclaration = {
  readonly id: string
  readonly event: PublicHookEvent
  readonly source: 'legacy' | 'interceptor'
  readonly sourceKey: string
  readonly provider: HookBinding
  readonly codeDigest: string
  readonly execution?: 'pure' | 'opaque'
  readonly priority?: number
  readonly before?: readonly string[]
  readonly after?: readonly string[]
  readonly failPolicy?: HookFailPolicy
  readonly mandatory?: boolean
  readonly timeoutMs?: number
  readonly readFields?: readonly string[]
  readonly writeFields?: readonly string[]
  readonly permissions?: readonly Readonly<Record<string, string>>[]
  readonly effects?: readonly HookEffectRef[]
}

export type HookRegistrationSnapshot = {
  readonly registrationId: string
  readonly provider: HookBinding
  readonly codeDigest: string
  readonly ordinal: number
  readonly mode: 'parallel' | 'waterfall' | 'serial' | 'emit'
  readonly category: 'observe' | 'transform' | 'directive'
  readonly failPolicy: HookFailPolicy
  readonly replayOnResume: boolean
  readonly timeoutMs: number
}

export type EffectiveHookSnapshot = {
  readonly workspaceId: string
  readonly configRevision: number
  readonly event: InterceptorEvent
  readonly registrations: readonly HookRegistrationSnapshot[]
  readonly digest: string
}

export type HookSnapshotDraft = {
  readonly snapshot: EffectiveHookSnapshot
  /** Plain JSON hashed into the snapshot digest, including fields the wire snapshot does not repeat. */
  readonly digestMaterial: Readonly<Record<string, unknown>>
}

type Prepared = {
  readonly declaration: HookDeclaration
  readonly event: InterceptorEvent
  readonly priority: number
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly failPolicy: HookFailPolicy
  readonly mandatory: boolean
  readonly timeoutMs: number
  readonly execution: 'pure' | 'opaque'
  readonly phase: 'before' | 'after'
  readonly readFields: readonly string[]
  readonly writeFields: readonly string[]
  readonly permissions: readonly Readonly<Record<string, string>>[]
  readonly effects: readonly HookEffectRef[]
}

export function interceptorPhase(event: InterceptorEvent): 'before' | 'after' {
  return event === 'tool_result' ? 'after' : 'before'
}

export function normalizeHookSnapshots(input: {
  readonly workspaceId: string
  readonly configRevision: number
  readonly registrations: readonly HookDeclaration[]
}): readonly HookSnapshotDraft[] {
  assertId(input.workspaceId, 'workspace id')
  if (!Number.isSafeInteger(input.configRevision) || input.configRevision < 0) {
    throw new AssemblyRefusal('invalid_registration', 'config revision must be a non-negative integer')
  }
  const prepared = input.registrations.map((declaration) => prepare(declaration))
  const ids = new Set<string>()
  const sources = new Set<string>()
  const byEvent = new Map<InterceptorEvent, Prepared[]>()
  for (const item of prepared) {
    if (ids.has(item.declaration.id)) {
      throw new AssemblyRefusal(
        'duplicate_registration',
        `duplicate hook registration: ${item.declaration.id}`,
        {
          registrationId: item.declaration.id,
        },
      )
    }
    ids.add(item.declaration.id)
    if (sources.has(item.declaration.sourceKey)) {
      throw new AssemblyRefusal('duplicate_source', `duplicate hook source: ${item.declaration.sourceKey}`, {
        sourceKey: item.declaration.sourceKey,
      })
    }
    sources.add(item.declaration.sourceKey)
    const group = byEvent.get(item.event) ?? []
    group.push(item)
    byEvent.set(item.event, group)
  }
  const eventOf = new Map(prepared.map((item) => [item.declaration.id, item.event]))
  const drafts: HookSnapshotDraft[] = []
  for (const event of [...byEvent.keys()].sort()) {
    const group = byEvent.get(event) ?? []
    drafts.push(snapshotOf(input.workspaceId, input.configRevision, event, group, eventOf))
  }
  return Object.freeze(drafts)
}

function prepare(declaration: HookDeclaration): Prepared {
  assertId(declaration.id, 'registration id')
  assertId(declaration.sourceKey, 'source key')
  assertBinding(declaration.provider)
  if (!DIGEST.test(declaration.codeDigest)) {
    throw new AssemblyRefusal('invalid_registration', 'hook code digest must be 64 hexadecimal characters', {
      registrationId: declaration.id,
    })
  }
  if (!Object.hasOwn(PUBLIC_HOOK_EVENTS, declaration.event)) {
    throw new AssemblyRefusal('unknown_hook', `unknown hook event: ${declaration.event}`)
  }
  if (!INTERCEPTOR_EVENT_SET.has(declaration.event)) {
    throw new AssemblyRefusal('not_interceptor', `${declaration.event} stays on the observe path`, {
      event: declaration.event,
    })
  }
  const event = declaration.event as InterceptorEvent
  const table = PUBLIC_HOOK_EVENTS[event]
  const failPolicy = declaration.failPolicy ?? table.failPolicy
  if (failPolicy !== 'open' && failPolicy !== 'closed') {
    throw new AssemblyRefusal('invalid_registration', 'invalid hook failure policy', {
      registrationId: declaration.id,
    })
  }
  if (table.failPolicy === 'closed' && failPolicy === 'open') {
    throw new AssemblyRefusal('policy_widened', `${event} cannot widen a closed failure policy`, { event })
  }
  const mandatory = declaration.mandatory ?? failPolicy === 'closed'
  if (mandatory && failPolicy !== 'closed') {
    throw new AssemblyRefusal('policy_widened', 'mandatory interception requires a closed failure policy', {
      registrationId: declaration.id,
    })
  }
  const timeoutMs = declaration.timeoutMs ?? table.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > table.timeoutMs) {
    throw new AssemblyRefusal('invalid_registration', 'hook timeout exceeds the event limit', {
      registrationId: declaration.id,
    })
  }
  const priority = declaration.priority ?? 0
  if (!Number.isFinite(priority)) {
    throw new AssemblyRefusal('invalid_registration', 'hook priority must be a finite number', {
      registrationId: declaration.id,
    })
  }
  const execution = declaration.execution ?? (declaration.source === 'legacy' ? 'opaque' : undefined)
  if (execution !== 'pure' && execution !== 'opaque') {
    throw new AssemblyRefusal('invalid_registration', 'interceptor execution must be pure or opaque', {
      registrationId: declaration.id,
    })
  }
  const effects = (declaration.effects ?? []).map((effect) => ({
    contract: assertToken(effect.contract, 'effect contract'),
    logicalName: assertToken(effect.logicalName, 'effect name'),
    method: assertToken(effect.method, 'effect method'),
  }))
  if (execution === 'pure' && effects.length > 0) {
    throw new AssemblyRefusal('invalid_registration', 'a pure interceptor cannot request effects', {
      registrationId: declaration.id,
    })
  }
  return {
    declaration,
    event,
    priority,
    before: unique(declaration.before),
    after: unique(declaration.after),
    failPolicy,
    mandatory,
    timeoutMs,
    execution,
    phase: interceptorPhase(event),
    readFields: unique(declaration.readFields),
    writeFields: unique(declaration.writeFields),
    permissions: (declaration.permissions ?? []).map((permission) => Object.freeze({ ...permission })),
    effects,
  }
}

function snapshotOf(
  workspaceId: string,
  configRevision: number,
  event: InterceptorEvent,
  group: readonly Prepared[],
  eventOf: ReadonlyMap<string, InterceptorEvent>,
): HookSnapshotDraft {
  const present = new Set(group.map((item) => item.declaration.id))
  const declared: { from: string; to: string }[] = []
  for (const item of group) {
    for (const target of item.before)
      link(item.declaration.id, target, 'before', present, event, eventOf, declared)
    for (const target of item.after)
      link(item.declaration.id, target, 'after', present, event, eventOf, declared)
  }
  const legacy = group.filter((item) => item.declaration.source === 'legacy')
  const locked: { from: string; to: string }[] = []
  for (let index = 1; index < legacy.length; index += 1) {
    const previous = legacy[index - 1]
    const current = legacy[index]
    if (!previous || !current) continue
    locked.push({ from: current.declaration.id, to: previous.declaration.id })
  }
  const nodes = group.map((item) => item.declaration.id)
  if (detectDependencyCycle(nodes, declared)) {
    throw new AssemblyRefusal('dependency_cycle', `hook order cycles for ${event}`, { event })
  }
  if (detectDependencyCycle(nodes, [...declared, ...locked])) {
    throw new AssemblyRefusal(
      'order_contradiction',
      `hook order contradicts the locked legacy sequence for ${event}`,
      {
        event,
      },
    )
  }
  const ordered = order(group, [...declared, ...locked])
  const table = PUBLIC_HOOK_EVENTS[event]
  const registrations = ordered.map((item, ordinal) =>
    Object.freeze({
      registrationId: item.declaration.id,
      provider: Object.freeze({ ...item.declaration.provider }),
      codeDigest: item.declaration.codeDigest,
      ordinal,
      mode: table.mode,
      category: table.category,
      failPolicy: item.failPolicy,
      replayOnResume: table.replayOnResume,
      timeoutMs: item.timeoutMs,
    }),
  )
  const digestMaterial = {
    configRevision,
    event,
    registrations: ordered.map((item, ordinal) => ({
      after: item.after,
      before: item.before,
      category: table.category,
      codeDigest: item.declaration.codeDigest,
      effects: item.effects,
      execution: item.execution,
      failPolicy: item.failPolicy,
      mandatory: item.mandatory,
      mode: table.mode,
      ordinal,
      permissions: item.permissions,
      phase: item.phase,
      priority: item.priority,
      provider: { ...item.declaration.provider },
      readFields: item.readFields,
      registrationId: item.declaration.id,
      replayOnResume: table.replayOnResume,
      timeoutMs: item.timeoutMs,
      writeFields: item.writeFields,
    })),
    workspaceId,
  }
  const snapshot = Object.freeze({
    workspaceId,
    configRevision,
    event,
    registrations: Object.freeze(registrations),
    digest: createHash('sha256').update(canonicalJson(digestMaterial)).digest('hex'),
  })
  return Object.freeze({ snapshot, digestMaterial: Object.freeze(digestMaterial) })
}

function link(
  id: string,
  target: string,
  direction: 'before' | 'after',
  present: ReadonlySet<string>,
  event: InterceptorEvent,
  eventOf: ReadonlyMap<string, InterceptorEvent>,
  edges: { from: string; to: string }[],
): void {
  if (target === id) {
    throw new AssemblyRefusal('invalid_registration', 'hook ordering cannot reference itself', {
      registrationId: id,
    })
  }
  if (!present.has(target)) {
    const other = eventOf.get(target)
    if (other && other !== event) {
      throw new AssemblyRefusal('cross_event', 'hook order cannot cross events', {
        registrationId: id,
        event: other,
      })
    }
    throw new AssemblyRefusal('missing_target', `missing hook order target: ${target}`, {
      registrationId: id,
      target,
    })
  }
  edges.push(direction === 'before' ? { from: target, to: id } : { from: id, to: target })
}

function order(group: readonly Prepared[], edges: readonly { from: string; to: string }[]): Prepared[] {
  const byId = new Map(group.map((item) => [item.declaration.id, item]))
  const waiting = new Map(group.map((item) => [item.declaration.id, 0]))
  const after = new Map<string, string[]>(group.map((item) => [item.declaration.id, []]))
  for (const edge of edges) {
    waiting.set(edge.from, (waiting.get(edge.from) ?? 0) + 1)
    after.get(edge.to)?.push(edge.from)
  }
  const ready = group
    .filter((item) => waiting.get(item.declaration.id) === 0)
    .map((item) => item.declaration.id)
  const ordered: Prepared[] = []
  while (ready.length > 0) {
    ready.sort((left, right) => compare(byId.get(left), byId.get(right)))
    const id = ready.shift()
    const item = id ? byId.get(id) : undefined
    if (!id || !item) break
    ordered.push(item)
    for (const next of after.get(id) ?? []) {
      const left = (waiting.get(next) ?? 1) - 1
      waiting.set(next, left)
      if (left === 0) ready.push(next)
    }
  }
  if (ordered.length !== group.length) {
    throw new AssemblyRefusal('dependency_cycle', 'hook order cycles')
  }
  return ordered
}

function compare(left: Prepared | undefined, right: Prepared | undefined): number {
  const priority = (left?.priority ?? 0) - (right?.priority ?? 0)
  if (priority !== 0) return priority
  const leftId = left?.declaration.id ?? ''
  const rightId = right?.declaration.id ?? ''
  if (leftId < rightId) return -1
  if (leftId > rightId) return 1
  return 0
}

function unique(values: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values ?? []) {
    assertId(value, 'hook field')
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  result.sort()
  return Object.freeze(result)
}

function assertBinding(provider: HookBinding): void {
  assertId(provider.bindingId, 'binding id')
  assertId(provider.providerId, 'provider id')
  assertToken(provider.contract, 'contract')
  assertToken(provider.logicalName, 'logical name')
}

function assertToken(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || hasControlCharacter(value)) {
    throw new AssemblyRefusal('invalid_registration', `invalid ${label}`)
  }
  return value
}

function assertId(value: string, label: string): void {
  if (value.length === 0 || value.length > 256 || hasControlCharacter(value)) {
    throw new AssemblyRefusal('invalid_registration', `invalid ${label}`)
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key])
    return sorted
  }
  return value
}
