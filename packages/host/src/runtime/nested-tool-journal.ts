import { CoreError, canonicalJson, type EventInput, type SessionImpl, scanAll } from '@agnes/core'
import type { ToolResult } from '@agnes/extension-api'
import type { JsonValue, ToolOutcome } from '@agnes/jev-runtime'

export const JEV_NESTED_EVENT = 'x/host/jev-nested'

export interface NestedToolBinding {
  readonly version: 1
  readonly sessionKey: string
  readonly writerRunId: string
  readonly lane: string
  readonly turn: number
  readonly step: number
  readonly rootIntentId: string
  readonly rootDispatchSeq: number
  readonly registryHash: string
  readonly toolUseId: string
  readonly parentToolUseId: string
  readonly depth: number
  readonly callSeq: number
}

export interface NestedToolEvidence extends NestedToolBinding {
  readonly dispatchSeq?: number
  readonly settledSeq?: number
  readonly effect?: ToolOutcome['effect']
  readonly phase?: 'not_sent' | 'responded' | 'may_have_sent'
  readonly result?: ToolResult
  readonly observedResult?: ToolResult
  readonly timedOut?: boolean
  readonly cancelled?: boolean
  readonly questionCancellation?: JsonValue
  readonly childCreationRefusal?: JsonValue
}

export function nestedResolutionEvidence(child: NestedToolEvidence): string {
  return `jev-nested:${child.toolUseId}:${child.dispatchSeq}`
}

/** A compound operator decision must name every exact child dispatch whose effect is uncertain. */
export async function assertJevNestedResolution(
  session: SessionImpl,
  payload: { intentId: string; evidence: readonly string[] },
): Promise<void> {
  const rows = await scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
  const bySeq = new Map(rows.map((row) => [row.seq, row]))
  const callsById = new Map(
    rows
      .filter((row) => row.type === 'tool/call')
      .map((row) => [String((row.data as { toolUseId?: string }).toolUseId), row]),
  )
  const children = new Map<string, NestedToolEvidence>()
  const bindings = new Map<string, NestedToolBinding>()
  const invalid = () => new CoreError('E_LEDGER_INTEGRITY', 'Invalid Host nested tool journal binding')
  for (const row of rows) {
    if (row.type !== JEV_NESTED_EVENT || row.lane !== session.lane) continue
    const data = row.data as {
      phase?: unknown
      binding?: NestedToolBinding
      evidence?: NestedToolEvidence
    } | null
    const binding = data?.binding
    if (!data || !binding || typeof binding.rootIntentId !== 'string' || !binding.rootIntentId)
      throw invalid()
    if (binding.rootIntentId !== payload.intentId) continue
    const root = bySeq.get(binding.rootDispatchSeq)
    const rootData = root?.data as
      | { runtime?: { id?: string; version?: string }; record?: { kind?: string; intentId?: string } }
      | undefined
    const call = bySeq.get(binding.callSeq)
    const callData = call?.data as { toolUseId?: string; parentEffectId?: string; depth?: number } | undefined
    const parent = callsById.get(binding.parentToolUseId)
    const parentEvidence = children.get(binding.parentToolUseId)
    const rootCall = session.state.toolCalls.get(binding.rootIntentId)
    const recordedCall = session.state.toolCalls.get(binding.toolUseId)
    if (
      row.origin !== 'system' ||
      row.trust !== 'trusted' ||
      row.ignorable !== true ||
      binding.version !== 1 ||
      binding.sessionKey !== session.key ||
      binding.lane !== session.lane ||
      typeof binding.writerRunId !== 'string' ||
      !binding.writerRunId ||
      typeof binding.registryHash !== 'string' ||
      !binding.registryHash ||
      !Number.isSafeInteger(binding.depth) ||
      binding.depth < 1 ||
      !Number.isSafeInteger(binding.rootDispatchSeq) ||
      !Number.isSafeInteger(binding.callSeq) ||
      binding.rootDispatchSeq >= binding.callSeq ||
      binding.callSeq >= row.seq ||
      root?.type !== 'runtime/record' ||
      root.origin !== 'system' ||
      root.trust !== 'trusted' ||
      root.lane !== binding.lane ||
      rootData?.runtime?.id !== session.runtimeIdentity.id ||
      rootData.runtime.version !== session.runtimeIdentity.version ||
      rootData.record?.kind !== 'action.dispatching' ||
      rootData.record.intentId !== binding.rootIntentId ||
      call?.type !== 'tool/call' ||
      call.origin !== 'system' ||
      call.trust !== 'trusted' ||
      call.lane !== binding.lane ||
      callData?.toolUseId !== binding.toolUseId ||
      callData.parentEffectId !== binding.parentToolUseId ||
      callData.depth !== binding.depth ||
      !call.sourceEventSeqs?.includes(binding.rootDispatchSeq) ||
      !parent ||
      parent.seq >= call.seq ||
      parent.lane !== binding.lane ||
      parent.origin !== 'system' ||
      parent.trust !== 'trusted' ||
      (parent.data as { depth?: number }).depth !== binding.depth - 1 ||
      rootCall?.turn !== binding.turn ||
      rootCall.step !== binding.step ||
      rootCall.seq >= binding.rootDispatchSeq ||
      recordedCall?.seq !== binding.callSeq ||
      recordedCall.turn !== binding.turn ||
      recordedCall.step !== binding.step ||
      (binding.depth === 1
        ? binding.parentToolUseId !== binding.rootIntentId
        : !parentEvidence ||
          parentEvidence.rootDispatchSeq !== binding.rootDispatchSeq ||
          parentEvidence.writerRunId !== binding.writerRunId ||
          parentEvidence.registryHash !== binding.registryHash ||
          parentEvidence.dispatchSeq === undefined ||
          parentEvidence.dispatchSeq >= binding.callSeq ||
          parentEvidence.settledSeq !== undefined) ||
      !row.sourceEventSeqs?.includes(binding.rootDispatchSeq) ||
      !row.sourceEventSeqs.includes(binding.callSeq)
    )
      throw invalid()
    const original = bindings.get(binding.toolUseId)
    if (original && canonicalJson(original) !== canonicalJson(binding)) throw invalid()
    bindings.set(binding.toolUseId, binding)
    const previous = children.get(binding.toolUseId)
    if (data.phase === 'dispatching') {
      if (previous) throw new CoreError('E_LEDGER_INTEGRITY', 'Duplicate nested dispatch')
      children.set(binding.toolUseId, { ...binding, dispatchSeq: row.seq })
    } else if (data.phase === 'settled') {
      const evidence = data.evidence
      if (
        !evidence ||
        previous?.settledSeq ||
        !['none', 'not_applied', 'acknowledged', 'applied', 'unknown'].includes(String(evidence.effect)) ||
        !['not_sent', 'responded', 'may_have_sent'].includes(String(evidence.phase)) ||
        !evidence.result ||
        !Array.isArray(evidence.result.content) ||
        Object.keys(binding).some(
          (key) =>
            canonicalJson(evidence[key as keyof NestedToolBinding]) !==
            canonicalJson(binding[key as keyof NestedToolBinding]),
        ) ||
        (previous
          ? evidence.dispatchSeq !== previous.dispatchSeq ||
            previous.dispatchSeq === undefined ||
            !row.sourceEventSeqs?.includes(previous.dispatchSeq)
          : evidence.dispatchSeq !== undefined ||
            evidence.effect !== 'not_applied' ||
            evidence.phase !== 'not_sent')
      )
        throw new CoreError('E_LEDGER_INTEGRITY', 'Invalid nested tool settlement')
      children.set(binding.toolUseId, { ...binding, ...previous, ...evidence, settledSeq: row.seq })
    } else throw invalid()
  }
  const missing = [...children.values()]
    .filter((child) => child.settledSeq === undefined || child.effect === 'unknown')
    .map(nestedResolutionEvidence)
    .filter((reference) => !payload.evidence.includes(reference))
  if (missing.length)
    throw new CoreError(
      'E_FORMAT',
      `Compound UNKNOWN resolution must cover child evidence: ${missing.join(', ')}`,
    )
}

export async function appendNestedToolJournal(
  session: SessionImpl,
  binding: NestedToolBinding,
  phase: 'dispatching' | 'settled',
  evidence?: NestedToolEvidence,
  resultEvent?: EventInput,
): Promise<number> {
  return session.locked(async () => {
    const receipt = await session.d.log.append([
      session.ev(
        JEV_NESTED_EVENT,
        {
          phase,
          binding,
          ...(evidence ? { evidence } : {}),
        },
        {
          origin: 'system',
          trust: 'trusted',
          ignorable: true,
          sourceEventSeqs: [
            binding.rootDispatchSeq,
            binding.callSeq,
            ...(evidence?.dispatchSeq ? [evidence.dispatchSeq] : []),
          ],
        },
      ),
      ...(resultEvent ? [resultEvent] : []),
    ])
    return receipt.firstSeq
  })
}
