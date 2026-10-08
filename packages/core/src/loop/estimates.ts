import { canonicalJson } from '@agnes/core-common/request/hash'
import type { LoopRequest, LoopRequestEstimate } from '@agnes/extension-api'
import { compactionSettingsFor, contextWindowFor, fixedPrefixTokens } from '../step/gate.js'
import { estimateTokens } from '../step/inference.js'
import type { SessionImpl } from '../step/session.js'

/** No provider dispatch, calibration, budget holds or ledger mutations. */
export async function estimateLoopRequest(
  s: SessionImpl,
  request: LoopRequest,
): Promise<LoopRequestEstimate> {
  const textOnly = request.messages.every((message) =>
    message.content.every((block) => block.type === 'text' || block.type === 'thinking'),
  )
  const inputTokens = textOnly
    ? estimateTokens(
        canonicalJson({ system: request.system, messages: request.messages, tools: request.tools }),
      )
    : null
  const contextWindow = contextWindowFor(s, request.route, request.model, request.slot)
  const { reserveTokens } = compactionSettingsFor(s, contextWindow, fixedPrefixTokens(request))
  const projected =
    inputTokens === null
      ? null
      : await s.d.runtime.ledgerProjected({ tokensEstimate: inputTokens, model: request.model })
  return {
    inputTokens,
    source: textOnly ? 'estimate' : 'unknown',
    projectedCredits:
      projected && Number.isFinite(projected.credits) && projected.credits >= 0 ? projected.credits : null,
    contextWindow,
    reserveTokens,
    remainingTokens: inputTokens === null ? null : Math.max(0, contextWindow - reserveTokens - inputTokens),
    shouldCompact: inputTokens === null ? null : inputTokens >= contextWindow - reserveTokens,
  }
}
