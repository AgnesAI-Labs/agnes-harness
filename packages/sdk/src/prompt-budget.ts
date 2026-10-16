import type { ContentBlock, ReferenceSelection } from '@agnes/protocol'
import type { Client } from './client.js'
import { ProtocolViolation } from './errors.js'

/** Negotiation is mandatory: older ACP servers silently ignore unknown metadata. */
export async function checkTurnCreditLimit(
  client: Client,
  creditLimit?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (creditLimit !== undefined) {
    signal?.throwIfAborted()
    if (!Number.isFinite(creditLimit) || creditLimit < 0 || creditLimit > Number.MAX_SAFE_INTEGER / 1_000_000)
      throw new ProtocolViolation('invalid turn credit limit')
    const info = await client.initialize()
    const meta = info.capabilities._meta as Record<string, unknown> | undefined
    if ((meta?.['ai.agnes.harness'] as { hardTurnBudget?: boolean } | undefined)?.hardTurnBudget !== true)
      throw new ProtocolViolation('server does not support hard turn budgets')
    signal?.throwIfAborted()
  }
}

export function promptMetadata(
  titleLocale?: 'en' | 'zh-CN',
  references?: readonly ReferenceSelection[],
  creditLimit?: number,
) {
  return titleLocale || references?.length || creditLimit !== undefined
    ? {
        _meta: {
          'ai.agnes.harness': {
            ...(titleLocale ? { titleLocale } : {}),
            ...(references?.length ? { references } : {}),
            ...(creditLimit === undefined ? {} : { creditLimit }),
          },
        },
      }
    : {}
}

export function toContentBlocks(input: ContentBlock[] | string): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}
