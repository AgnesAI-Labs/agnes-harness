import type { EventInput } from '@agnes/core-common/types'
import { isNestedCall } from '@agnes/core-ledger'
import { scanAll, scanPages } from '@agnes/core-ledger/log/scan-pages'
import { NESTED_RESULT_PREFIX } from '../../request/derive.js'
import type { SessionImpl } from '../../step/session.js'
import { approvalContinuation } from './parked.js'

/**
 * The `[nested result]` notes. A nested call and its result never reach the model: the tool that
 * made the call reads the result and answers for it. Some nested outcomes land where no running code
 * reads them -- an approval continuation, a refusal or deadline, a deferred job, an unknown outcome,
 * an outer call that failed after its nested calls wrote, an approved call that was then refused or
 * cancelled -- and the model would otherwise never learn of them. Each such outcome commits with one
 * of these notes, beside the result it describes.
 */
export type NestedOutcome = 'executed' | 'rejected' | 'deadline' | 'deferred' | 'unknown' | 'not-run'

/** How much of the result a note quotes. */
const PREVIEW_CHARS = 2000

const status = (isError: boolean | undefined) => (isError ? 'error' : 'ok')

/**
 * The note for one nested outcome. The header is the first text block; a preview of the result, when
 * there is one, is a second block and carries the result row's trust, so derive envelopes it as the
 * result itself would have been.
 */
export function nestedOutcomeNote(
  s: SessionImpl,
  n: {
    name: string
    parent: string
    outcome: NestedOutcome
    isError?: boolean
    /** The code a `not-run` call was closed with. */
    code?: string
    preview?: string
    trust?: EventInput['trust']
  },
): EventInput {
  const call = `the nested call ${n.name} inside ${n.parent}`
  const header = {
    executed: `The nested call ${n.name} inside ${n.parent} ran after approval (status: ${status(n.isError)}). Do not run it again. Preview:`,
    rejected: `The user rejected ${call}; it did not run. Do not retry it without asking.`,
    deadline: `Approval for ${call} expired; it did not run.`,
    deferred: `The nested call ${n.name} inside ${n.parent} finished later (status: ${status(n.isError)}). Preview:`,
    unknown: `The outcome of ${call} is unknown; check the current state before running it again.`,
    'not-run': `The nested call ${n.name} inside ${n.parent} was approved but did not run (${n.code}). Check the current state before trying it again.`,
  }[n.outcome]
  let preview = n.preview?.slice(0, PREVIEW_CHARS) ?? ''
  // A cut through a surrogate pair would leave half a character for the provider to reject.
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1)
  return s.ev(
    'user/message',
    {
      content: [
        { type: 'text', text: `${NESTED_RESULT_PREFIX}${header}` },
        ...(preview ? [{ type: 'text', text: preview }] : []),
      ],
      kind: 'runtime_context',
    },
    preview && n.trust ? { trust: n.trust } : {},
  )
}

/** The note for an outer call that failed after nested calls under it had written. */
export function outerFailureNote(
  s: SessionImpl,
  n: { parent: string; code: string; calls: ReadonlyArray<{ name: string; isError: boolean }> },
): EventInput {
  const calls = n.calls.map((c) => `${c.name} ${status(c.isError)}`).join('; ')
  return s.ev('user/message', {
    content: [
      {
        type: 'text',
        text: `${NESTED_RESULT_PREFIX}${n.parent} ended with ${n.code} after these nested calls had results: ${calls}. Check the current state before running them again.`,
      },
    ],
    kind: 'runtime_context',
  })
}

/** A result's text blocks, joined: what a note quotes of it. */
export function resultPreview(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .flatMap((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' ? [String(b.text ?? '')] : []))
    .join('')
}

/** The tool a nested call was made inside, read from its parent's `effect/intent` row. */
export async function nestedParentName(s: SessionImpl, parentEffectId: string | undefined): Promise<string> {
  const fallback = 'a tool'
  if (parentEffectId === undefined) return fallback
  const pending = s.state.pendingEffects.get(parentEffectId)?.tool?.name
  if (pending) return pending
  const pages = scanPages((q) => s.d.log.scan(q), {
    type: 'effect/intent',
    lane: s.lane,
    fromSeq: 1,
    toSeq: s.lastSeq,
    order: 'desc',
  })
  for await (const page of pages)
    for (const row of page) {
      const data = row.data as { effectId?: unknown; tool?: { name?: unknown } } | null
      if (data?.effectId === parentEffectId)
        return typeof data.tool?.name === 'string' ? data.tool.name : fallback
    }
  return fallback
}

/**
 * The nested calls under an effect that may have changed something and already have a result: every
 * tool intent whose `parentEffectId` chain reaches `effectId`, nested-of-nested included, whose
 * `tool/call` is not read-only and has a `tool/result`. In the order the calls began.
 */
export async function nestedWritesUnder(
  s: SessionImpl,
  effectId: string,
): Promise<Array<{ name: string; isError: boolean }>> {
  // Every descendant intent comes after its root's; a root already settled is read from the top.
  const range = {
    fromSeq: s.state.pendingEffects.get(effectId)?.intentSeq ?? 1,
    toSeq: s.lastSeq,
    lane: s.lane,
  }
  const read = (q: Parameters<SessionImpl['d']['log']['scan']>[0]) => s.d.log.scan(q)
  const owners = new Set([effectId])
  const toolUseIds = new Set<string>()
  for (const row of await scanAll(read, { ...range, type: 'effect/intent' })) {
    const data = row.data as {
      effectId?: unknown
      parentEffectId?: unknown
      kind?: unknown
      tool?: { toolUseId?: unknown }
    } | null
    if (typeof data?.parentEffectId !== 'string' || !owners.has(data.parentEffectId)) continue
    if (typeof data.effectId === 'string') owners.add(data.effectId)
    if (data.kind === 'tool' && typeof data.tool?.toolUseId === 'string') toolUseIds.add(data.tool.toolUseId)
  }
  if (toolUseIds.size === 0) return []
  type CallData = { toolUseId?: unknown; name?: unknown; resolvedPolicy?: { isReadOnly?: unknown } }
  const calls = new Map<string, CallData>()
  for (const row of await scanAll(read, { ...range, type: 'tool/call' })) {
    const data = row.data as CallData | null
    if (typeof data?.toolUseId === 'string' && toolUseIds.has(data.toolUseId)) calls.set(data.toolUseId, data)
  }
  const results = new Map<string, boolean>()
  for (const row of await scanAll(read, { ...range, type: 'tool/result' })) {
    const data = row.data as { toolUseId?: unknown; isError?: unknown } | null
    if (typeof data?.toolUseId === 'string' && toolUseIds.has(data.toolUseId))
      results.set(data.toolUseId, data.isError === true)
  }
  return [...toolUseIds].flatMap((id) => {
    const call = calls.get(id)
    const isError = results.get(id)
    if (!call || isError === undefined || !isNestedCall(call) || call.resolvedPolicy?.isReadOnly === true)
      return []
    return [{ name: String(call.name), isError }]
  })
}

/**
 * The note a synthesized failure of a call commits with, beside its `tool/result`. A nested call
 * whose outcome is unknown (its code says so, or the caller knows it, `unknown`) gets the unknown
 * note; an approved nested call no running code reads (`unconsumed`) that failed any other way gets
 * the not-run note; an outer call that failed after nested calls under it wrote gets the list of
 * them, under its real code. Anything else needs none.
 */
export async function failureNotes(
  s: SessionImpl,
  call: {
    name: string
    effectId: string
    nested: boolean
    unconsumed?: boolean
    unknown?: boolean
    parentEffectId?: string | undefined
  },
  code: string,
): Promise<EventInput[]> {
  if (call.nested) {
    const unknown = call.unknown === true || code === 'TOOL_OUTCOME_UNKNOWN'
    if (!unknown && !call.unconsumed) return []
    const parent = await nestedParentName(s, call.parentEffectId)
    return [
      nestedOutcomeNote(s, {
        name: call.name,
        parent,
        ...(unknown ? { outcome: 'unknown' } : { outcome: 'not-run', code }),
      }),
    ]
  }
  const calls = await nestedWritesUnder(s, call.effectId)
  return calls.length > 0 ? [outerFailureNote(s, { parent: call.name, code, calls })] : []
}

/**
 * `failureNotes` for a tool effect recovery closes, read from the call's `tool/call` row. A nested
 * root is an approval continuation. One blocked on its decision had been dispatched -- only its own
 * code opens a decision -- and was running when the process died, so its outcome is unknown.
 */
export function recoveryNotes(
  s: SessionImpl,
  root: { effectId: string; tool?: { name: string } | undefined },
  callData: unknown,
  code: string,
): Promise<EventInput[]> {
  return failureNotes(
    s,
    {
      name: root.tool?.name ?? 'a tool',
      effectId: root.effectId,
      nested: isNestedCall(callData),
      unknown: code === 'DECISION_CONTINUATION_BLOCKED',
      parentEffectId: (callData as { parentEffectId?: string } | undefined)?.parentEffectId,
    },
    code,
  )
}

/**
 * `failureNotes` for a call being executed: a synthesized failure no running code reads. A nested call is one at depth > 0; an approval
 * continuation has no `parentEffectId` of its own, so it reads the one the batch runner passed.
 */
export function callFailureNotes(
  s: SessionImpl,
  name: string,
  effectId: string,
  o: { depth: number; parentEffectId?: string; unconsumed?: { parentEffectId?: string | undefined } },
  code: string,
): Promise<EventInput[]> {
  const parentEffectId = o.parentEffectId ?? o.unconsumed?.parentEffectId
  return failureNotes(
    s,
    { name, effectId, nested: o.depth > 0, unconsumed: o.unconsumed !== undefined, parentEffectId },
    code,
  )
}

/**
 * The note a refusal of a call commits with, beside its `tool/result`. Only the call the batch runner
 * marks `unconsumed` has one: a nested call it runs itself, which is the approval continuation. It was
 * approved and is now refused or cancelled before it ran, and no running code reads that.
 */
export async function refusalNotes(s: SessionImpl, toolUseId: string, code: string): Promise<EventInput[]> {
  const op = s.op()
  const call =
    op?.phase.kind === 'tools' ? op.phase.batch.calls.find((c) => c.toolUseId === toolUseId) : undefined
  if (!call || (call.depth ?? 0) === 0 || (await approvalContinuation(s))?.toolUseId !== toolUseId) return []
  return [
    nestedOutcomeNote(s, {
      name: call.name,
      parent: await nestedParentName(s, call.parentEffectId),
      outcome: 'not-run',
      code,
    }),
  ]
}

/**
 * The note for a nested call that ran after approval, built from the `tool/result` row it committed.
 * Only a call the batch runner marked `unconsumed` that did not defer has one.
 */
export async function executedNotes(
  s: SessionImpl,
  name: string,
  o: { unconsumed?: { parentEffectId?: string | undefined } },
  resultRow: EventInput | undefined,
): Promise<EventInput[]> {
  if (!o.unconsumed || !resultRow) return []
  const data = resultRow.data as { content: unknown; isError: boolean }
  return [
    nestedOutcomeNote(s, {
      name,
      parent: await nestedParentName(s, o.unconsumed.parentEffectId),
      outcome: 'executed',
      isError: data.isError,
      preview: resultPreview(data.content),
      trust: resultRow.trust,
    }),
  ]
}

/** The note for a deferred job's result, when the call that started the job was nested. */
export async function deferredNestedNote(
  s: SessionImpl,
  toolUseId: string,
  result: { content: unknown; isError: boolean },
  trust: EventInput['trust'],
): Promise<EventInput | undefined> {
  const callSeq = s.state.toolCalls.get(toolUseId)?.seq
  if (callSeq === undefined) return undefined
  const [row] = await s.d.log.scan({ fromSeq: callSeq, toSeq: callSeq, lane: s.lane, limit: 1 })
  const call = row?.data as { toolUseId?: unknown; name?: unknown; parentEffectId?: string } | undefined
  if (row?.type !== 'tool/call' || call?.toolUseId !== toolUseId || !isNestedCall(call)) return undefined
  return nestedOutcomeNote(s, {
    name: String(call.name),
    parent: await nestedParentName(s, call.parentEffectId),
    outcome: 'deferred',
    isError: result.isError,
    preview: resultPreview(result.content),
    trust,
  })
}
