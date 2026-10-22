import type { ContentBlock, ReferenceSelection } from '@agnes/protocol'
import type { Client } from './client.js'
import { ProtocolViolation } from './errors.js'

export type TurnLimits = { creditLimit?: number | undefined; maxSteps?: number | undefined }

/** Negotiation is mandatory: older ACP servers silently ignore unknown metadata. */
export async function checkTurnLimits(
  client: Client,
  limits: TurnLimits,
  signal?: AbortSignal,
): Promise<void> {
  const { creditLimit, maxSteps } = limits
  if (creditLimit === undefined && maxSteps === undefined) return
  signal?.throwIfAborted()
  if (
    creditLimit !== undefined &&
    (!Number.isFinite(creditLimit) || creditLimit < 0 || creditLimit > Number.MAX_SAFE_INTEGER / 1_000_000)
  )
    throw new ProtocolViolation('invalid turn credit limit')
  if (maxSteps !== undefined && !(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000))
    throw new ProtocolViolation('invalid turn step cap')
  const info = await client.initialize()
  const meta = (info.capabilities._meta as Record<string, unknown> | undefined)?.['ai.agnes.harness'] as
    | { hardTurnBudget?: boolean; turnMaxSteps?: boolean }
    | undefined
  if (creditLimit !== undefined && meta?.hardTurnBudget !== true)
    throw new ProtocolViolation('server does not support hard turn budgets')
  if (maxSteps !== undefined && meta?.turnMaxSteps !== true)
    throw new ProtocolViolation('server does not support turn step caps')
  signal?.throwIfAborted()
}

export function promptMetadata(
  titleLocale?: 'en' | 'zh-CN',
  references?: readonly ReferenceSelection[],
  limits: TurnLimits = {},
) {
  const { creditLimit, maxSteps } = limits
  return titleLocale || references?.length || creditLimit !== undefined || maxSteps !== undefined
    ? {
        _meta: {
          'ai.agnes.harness': {
            ...(titleLocale ? { titleLocale } : {}),
            ...(references?.length ? { references } : {}),
            ...(creditLimit === undefined ? {} : { creditLimit }),
            ...(maxSteps === undefined ? {} : { maxSteps }),
          },
        },
      }
    : {}
}

export function toContentBlocks(input: ContentBlock[] | string): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}
