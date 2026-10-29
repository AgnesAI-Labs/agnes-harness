import type { ContentBlock, ReferenceSelection } from '@agnes/protocol'
import type { Client } from './client.js'
import { ProtocolViolation } from './errors.js'

export type TurnLimits = {
  creditLimit?: number | undefined
  maxSteps?: number | undefined
  timeLimitMs?: number | undefined
}
/** Longest time limit a server accepts: one day. */
const TIME_LIMIT_MAX_MS = 86_400_000
/** Per-prompt metadata: the limits above, and whether a person attends the turn. */
export type TurnOptions = TurnLimits & { unattended?: boolean | undefined }

/** Negotiation is mandatory: older ACP servers silently ignore unknown metadata. */
export async function checkTurnLimits(
  client: Client,
  limits: TurnLimits,
  signal?: AbortSignal,
): Promise<void> {
  const { creditLimit, maxSteps, timeLimitMs } = limits
  if (creditLimit === undefined && maxSteps === undefined && timeLimitMs === undefined) return
  signal?.throwIfAborted()
  if (
    creditLimit !== undefined &&
    (!Number.isFinite(creditLimit) || creditLimit < 0 || creditLimit > Number.MAX_SAFE_INTEGER / 1_000_000)
  )
    throw new ProtocolViolation('invalid turn credit limit')
  if (maxSteps !== undefined && !(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000))
    throw new ProtocolViolation('invalid turn step cap')
  if (
    timeLimitMs !== undefined &&
    !(Number.isInteger(timeLimitMs) && timeLimitMs >= 1 && timeLimitMs <= TIME_LIMIT_MAX_MS)
  )
    throw new ProtocolViolation('invalid turn time limit')
  const info = await client.initialize()
  const meta = (info.capabilities._meta as Record<string, unknown> | undefined)?.['ai.agnes.harness'] as
    | { hardTurnBudget?: boolean; turnMaxSteps?: boolean; turnTimeLimit?: boolean }
    | undefined
  if (creditLimit !== undefined && meta?.hardTurnBudget !== true)
    throw new ProtocolViolation('server does not support hard turn budgets')
  if (maxSteps !== undefined && meta?.turnMaxSteps !== true)
    throw new ProtocolViolation('server does not support turn step caps')
  if (timeLimitMs !== undefined && meta?.turnTimeLimit !== true)
    throw new ProtocolViolation('server does not support turn time limits')
  signal?.throwIfAborted()
}

export function promptMetadata(
  titleLocale?: 'en' | 'zh-CN',
  references?: readonly ReferenceSelection[],
  limits: TurnOptions = {},
) {
  const { creditLimit, maxSteps, timeLimitMs, unattended } = limits
  return titleLocale ||
    references?.length ||
    creditLimit !== undefined ||
    maxSteps !== undefined ||
    timeLimitMs !== undefined ||
    unattended === true
    ? {
        _meta: {
          'ai.agnes.harness': {
            ...(titleLocale ? { titleLocale } : {}),
            ...(references?.length ? { references } : {}),
            ...(creditLimit === undefined ? {} : { creditLimit }),
            ...(maxSteps === undefined ? {} : { maxSteps }),
            ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
            ...(unattended === true ? { unattended: true } : {}),
          },
        },
      }
    : {}
}

export function toContentBlocks(input: ContentBlock[] | string): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}
