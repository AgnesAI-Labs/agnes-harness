import { createHash } from 'node:crypto'
import type { ToolContext } from '@agnes/extension-api'

/** Business signature, never a permission grant. Full access cannot answer this question. */
export async function sign<T extends { expectedRevision: number }>(
  ctx: ToolContext,
  input: T,
  meaning: string,
  target: string,
) {
  ctx.signal.throwIfAborted()
  const subjectRevision = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const handle = await ctx.decisions.request({
    key: `signature:${ctx.session.toolUseId}`,
    purpose: 'business.confirm',
    subject: { action: ctx.session.toolUseId, input: JSON.stringify(input), meaning, subjectRevision },
    prompt: `人工质量签署 / Human quality signature\n${target} · 审阅版本 / Reviewed revision ${input.expectedRevision}\n${meaning}\n请核对关联证据后签署。 / Review the linked evidence before signing.`,
    options: ['allowed-once', 'rejected'],
    responseSchema: { type: 'null' },
  })
  const answer = await ctx.decisions.wait(handle, { signal: ctx.signal })
  ctx.signal.throwIfAborted()
  if (answer.status !== 'resolved' || answer.snapshot.invalidation)
    throw new Error('Signature unavailable / 签名不可用')
  const result = answer.snapshot.result
  if (
    result?.reason !== 'answered' ||
    result.response.option !== 'allowed-once' ||
    ['system', 'agent'].includes(result.answeredBy.role)
  )
    throw new Error('Human quality signature required / 需要人工质量签名')
  return { requestId: handle.id, subjectRevision, answeredBy: result.answeredBy, signedAt: result.at }
}
