import type { ContextBreakdownDiag, RequestComposition } from '@agnes/core-common/context-diagnostics'
import { canonicalJson } from '@agnes/core-common/request/hash'
import type { RequestBody } from '@agnes/protocol'
import type { DeriveOutput } from '../request/derive.js'
import type { RequestMessage } from '../request/mint.js'
import type { SessionImpl } from '../step/session.js'
import { estimateTokens } from './model-tokens.js'

/** Partition the serialized provider input; never return any of its text or arguments. */
export function requestComposition(
  wire: RequestBody,
  messages: readonly RequestMessage[],
  runtimeNotes: ReadonlySet<number>,
  previousRequestSeq: number,
): RequestComposition {
  const pieces = {
    fixedPrefix: canonicalJson(wire.system) + canonicalJson(wire.tools),
    conversation: '',
    toolResultsCurrentStep: '',
    toolResultsEarlier: '',
    thinking: '',
    runtimeNotes: '',
    framing: `{"messages":[],"system":,"tools":}${','.repeat(Math.max(0, wire.messages.length - 1))}`,
  }
  const names = new Map(
    wire.messages.flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls ?? []).map((call) => [call.toolUseId, call.name] as const)
        : [],
    ),
  )
  let toolResultCount = 0
  let largestToolResult: RequestComposition['largestToolResult'] = null
  for (const [index, message] of wire.messages.entries()) {
    const seq = messages[index]?.seq ?? 0
    let serialized = canonicalJson(message)
    if (message.role === 'tool_result') {
      toolResultCount++
      const bytes = new TextEncoder().encode(canonicalJson(message.content)).length
      if (!largestToolResult || bytes > largestToolResult.bytes)
        largestToolResult = { bytes, tool: names.get(message.toolUseId) ?? 'unknown' }
      pieces[seq > previousRequestSeq ? 'toolResultsCurrentStep' : 'toolResultsEarlier'] += serialized
    } else {
      for (const block of message.content) {
        if (block.type !== 'thinking') continue
        const part = canonicalJson(block)
        pieces.thinking += part
        serialized = serialized.replace(part, '')
      }
      pieces[
        message.role === 'user' && (seq === 0 || runtimeNotes.has(seq)) ? 'runtimeNotes' : 'conversation'
      ] += serialized
    }
  }
  // Carry rounding across buckets. Reordering JSON fragments preserves the estimator's character
  // counts, so the parts add up exactly, including JSON framing and escaped Unicode.
  let accumulated = ''
  let total = 0
  const tokens = {} as RequestComposition['tokens']
  for (const key of Object.keys(pieces) as Array<keyof typeof pieces>) {
    accumulated += pieces[key]
    const next = estimateTokens(accumulated)
    tokens[key] = next - total
    total = next
  }
  return { tokens, total, toolResultCount, largestToolResult }
}

/** Both the built-in inference segment and custom Loop streams use the same diagnostic. */
export async function recordRequestComposition(
  s: SessionImpl,
  out: DeriveOutput,
  wire: RequestBody,
  step: number,
): Promise<void> {
  if (wire.slot !== 'primary') return
  const [previous] = await s.scan({
    type: ['x/core/context-breakdown', 'turn/start'],
    lane: s.lane,
    order: 'desc',
    limit: 1,
  })
  await s.diag('context-breakdown', {
    turn: s.op()?.meta.turn ?? 0,
    step,
    composition: requestComposition(
      wire,
      out.request.messages,
      new Set(
        s.d.surface
          .nodes()
          .filter(
            (node) =>
              node.kind === 'user' && (node.event.data as { kind?: string }).kind === 'runtime_context',
          )
          .map((node) => node.seq),
      ),
      previous?.seq ?? 0,
    ),
    sections: out.request.sections.map((section) => ({
      id: section.id,
      order: section.order,
      source: section.source,
      tokens: estimateTokens(section.text),
    })),
  } satisfies ContextBreakdownDiag)
}
