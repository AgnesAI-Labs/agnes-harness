import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { Event, Seq } from '@agnes/core-common/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { EffectIntent } from '@agnes/core-ledger/reduce/shapes'
import type { DecisionSnapshot } from '@agnes/extension-api'
import { sessionIdentity } from '../../loop/scope.js'
import { hasTrustedToolCallProvenance } from '../../registry/tool-policy.js'
import type { SessionImpl } from '../../step/session.js'
import type { PlannedCall } from './tools.js'

const MARKER = 'x/core/uncertain-effect-fence'
const targetKeys = ['orderId', 'paymentId', 'transactionId', 'idempotencyKey', 'resourceId', 'id'] as const
type Targets = Partial<Record<(typeof targetKeys)[number], string>>
type Call = Pick<PlannedCall, 'name' | 'args' | 'toolUseId'> & {
  resolvedPolicy: { isReadOnly: boolean; replay: string }
  discoveryGroup?: string | undefined
}
type Verification = Pick<Call, 'name' | 'args' | 'discoveryGroup'> & {
  isReadOnly: boolean
  argsSeq?: Seq
  verifiesTools?: readonly string[]
}
type Answer = 'happened' | 'not-happened'
function pending(sessionKey: string, call: Call, effectId: string) {
  const { name: toolName, toolUseId, args, discoveryGroup } = call
  return {
    sessionKey,
    toolName,
    toolUseId,
    effectId,
    argsHash: sha256Hex(canonicalJson(args)),
    ...targetOf(args),
    ...(discoveryGroup?.trim() ? { discoveryGroup } : {}),
  }
}
export type PendingUncertainEffect = ReturnType<typeof pending> & {
  recordedAtSeq: Seq
  verifiedByToolUseId?: string
  answer?: Answer
}

function targetOf(args: unknown) {
  const input = (args ?? {}) as Record<string, unknown>
  const targets: Targets = {}
  for (const key of targetKeys) {
    const value = input[key]
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)))
      targets[key] = sha256Hex(canonicalJson(value))
  }
  const path = typeof input.path === 'string' ? input.path.replace(/\/+$/u, '') : ''
  const usable = path && !path.split('/').some((part) => part === '..' || part === '.')
  return usable ? { targets, path } : { targets }
}

type Change =
  | { kind: 'pending'; entry: ReturnType<typeof pending> }
  | { kind: 'verified'; toolUseId: string; verifiedByToolUseId: string }
  | { kind: 'human'; toolUseId: string; answer: Answer }

function identities(name: string, hash: string, targets: Targets) {
  const keys = [canonicalJson([name, hash])]
  for (const key of ['idempotencyKey', 'orderId', 'paymentId'] as const)
    if (targets[key]) keys.push(canonicalJson([name, key, targets[key]]))
  return keys
}

class Registry {
  through = 0
  entries = new Map<string, PendingUncertainEffect>()
  identities = new Map<string, PendingUncertainEffect[]>()
  add(entry: PendingUncertainEffect) {
    if (this.entries.has(entry.toolUseId)) return
    this.entries.set(entry.toolUseId, entry)
    for (const key of identities(entry.toolName, entry.argsHash, entry.targets)) {
      this.identities.set(key, [...(this.identities.get(key) ?? []), entry])
    }
  }
}
const registries = new WeakMap<object, Registry>()
const active = (entry: PendingUncertainEffect) =>
  entry.answer === 'happened' || (!entry.answer && !entry.verifiedByToolUseId)

async function apply(s: SessionImpl, registry: Registry, row: Event) {
  if (row.origin !== 'system' || row.trust !== 'trusted') return
  if (row.type === 'tool/result') return recoverUnknown(s, registry, row)
  if (row.type === 'decision/state') {
    const d = row.data as DecisionSnapshot
    if (
      d.handle.sessionId === s.key &&
      d.request.owner === 'core/unknown-outcome' &&
      d.request.sourcePackage === '@agnes/core' &&
      d.consumption &&
      !d.invalidation &&
      d.result?.reason === 'answered'
    ) {
      const entry = registry.entries.get(d.request.operationId)
      if (entry && entry.answer !== 'happened')
        entry.answer = d.result.response.option.startsWith('allowed') ? 'happened' : 'not-happened'
    }
    return
  }
  const change = row.data as Change & { sessionKey: string }
  if (change.sessionKey !== s.key) return
  if (change.kind === 'pending') {
    registry.add({ ...change.entry, recordedAtSeq: row.seq })
  } else {
    const entry = registry.entries.get(change.toolUseId)
    if (!entry || entry.answer === 'happened') return
    if (change.kind === 'human') entry.answer = change.answer
    if (change.kind === 'verified') entry.verifiedByToolUseId = change.verifiedByToolUseId
  }
}

// Recovery can synthesize the unknown result after a crash before the live call recorded its marker.
async function recoverUnknown(s: SessionImpl, registry: Registry, row: Event) {
  const result = row.data as { code?: string; toolUseId: string }
  const seq = row.sourceEventSeqs?.[0]
  if (result.code !== 'TOOL_OUTCOME_UNKNOWN' || !seq || registry.entries.has(result.toolUseId)) return
  const [bound] = await s.scan({ type: 'tool/call', fromSeq: seq, toSeq: seq, limit: 1 })
  if (!bound || !hasTrustedToolCallProvenance(bound)) return
  const call = bound.data as Call
  if (call.toolUseId !== result.toolUseId || call.resolvedPolicy?.isReadOnly) return
  const query = { type: 'effect/intent', fromSeq: seq, toSeq: row.seq }
  for await (const rows of scanPages((q) => s.scan(q), query)) {
    for (const event of rows) {
      const intent = event.data as EffectIntent
      if (event.origin !== 'system' || event.trust !== 'trusted') continue
      if (intent.tool?.toolUseId === call.toolUseId && intent.replay === 'never') {
        registry.add({ ...pending(s.key, call, intent.effectId), recordedAtSeq: row.seq })
        return
      }
    }
  }
}

/** Read only committed markers, including those appended by another execution lane. Caller owns the session lock. */
async function restored(s: SessionImpl) {
  const owner = sessionIdentity(s)
  const registry = registries.get(owner) ?? new Registry()
  registries.set(owner, registry)
  const toSeq = s.lastSeq
  if (registry.through < toSeq) {
    for await (const rows of scanPages((q) => s.scan(q), {
      type: [MARKER, 'tool/result', 'decision/state'],
      fromSeq: Math.max(registry.through, s.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq,
    })) {
      for (const row of rows) await apply(s, registry, row)
    }
    registry.through = toSeq
  }
  return registry
}

function marker(s: SessionImpl, change: Change) {
  return s.ev(MARKER, { ...change, sessionKey: s.key }, { ignorable: true })
}

export async function recordUncertainEffect(s: SessionImpl, call: Call, effectId: string) {
  if (call.resolvedPolicy.isReadOnly || call.resolvedPolicy.replay !== 'never') return
  await s.locked(async () => {
    if ((await restored(s)).entries.has(call.toolUseId)) return
    const entry = pending(s.key, call, effectId)
    await s.d.log.append([marker(s, { kind: 'pending', entry })])
  })
}

export async function restoreUncertainEffectFence(s: SessionImpl): Promise<void> {
  await s.locked(() => restored(s))
}

export async function listUncertainEffects(s: SessionImpl) {
  return s.locked(async () => structuredClone([...(await restored(s)).entries.values()].filter(active)))
}

export async function checkUncertainRetryFence(s: SessionImpl, call: Call) {
  if (call.resolvedPolicy.isReadOnly || call.resolvedPolicy.replay !== 'never') return
  const hash = sha256Hex(canonicalJson(call.args))
  const { targets } = targetOf(call.args)
  const matches = await s.locked(async () => {
    const registry = await restored(s)
    return identities(call.name, hash, targets)
      .flatMap((key) => registry.identities.get(key) ?? [])
      .filter(active)
  })
  if (!matches.length) return
  const happened = matches.some((entry) => entry.answer === 'happened')
  const message = happened
    ? `The user confirmed that ${call.name} already happened. Do not repeat it.`
    : `The previous ${call.name} may have taken effect. Inspect external state with a related read-only tool before retrying.`
  return { blocked: true, code: happened ? 'E_ALREADY_APPLIED' : 'E_VERIFICATION_REQUIRED', message } as const
}

// A verb or transport prefix (e.g. get_, mcp_) does not identify a business entity.
function entity(name: string) {
  return /^(order|payment|transaction|ticket|resource|invoice|account|booking|shipment)[_.-]/u.exec(name)?.[1]
}

function correlates(entry: PendingUncertainEffect, read: Verification) {
  const { targets, path } = targetOf(read.args)
  if (read.argsSeq !== undefined && read.argsSeq <= entry.recordedAtSeq) return false
  const shared = targetKeys.filter((key) => targets[key] && entry.targets[key])
  if (shared.some((key) => entry.targets[key] !== targets[key])) return false
  if (path && entry.path)
    return entry.path === path || entry.path.startsWith(`${path}/`) || path.startsWith(`${entry.path}/`)
  return (
    shared.length > 0 ||
    read.verifiesTools?.includes(entry.toolName) ||
    (entry.discoveryGroup && entry.discoveryGroup === read.discoveryGroup) ||
    (entity(read.name) && entity(read.name) === entity(entry.toolName))
  )
}

/** Called only for a successful, final read-only response. Never infer verification from a tool's mere dispatch. */
export async function markUncertainEffectsVerified(s: SessionImpl, readId: string, read?: Verification) {
  if (!read?.isReadOnly) return
  await s.locked(async () => {
    const changes = [...(await restored(s)).entries.values()]
      .filter((entry) => !entry.answer && !entry.verifiedByToolUseId && correlates(entry, read))
      .map((entry) =>
        marker(s, { kind: 'verified', toolUseId: entry.toolUseId, verifiedByToolUseId: readId }),
      )
    if (changes.length) await s.d.log.append(changes)
  })
}

export async function resolveUncertainEffectFromHuman(s: SessionImpl, toolUseId: string, answer: Answer) {
  await s.locked(async () => {
    const entry = (await restored(s)).entries.get(toolUseId)
    if (entry && entry.answer !== 'happened')
      await s.d.log.append([marker(s, { kind: 'human', toolUseId, answer })])
  })
}
