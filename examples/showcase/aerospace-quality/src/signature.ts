import { createHash } from 'node:crypto'
import type { ToolContext } from '@agnes/extension-api'

/** Host-bound business consent; full access signs for the human principal with an explicit mode. */
export async function sign<T extends { expectedRevision: number }>(
  ctx: ToolContext,
  input: T,
  meanings: { en: string; 'zh-CN': string },
  target: string,
) {
  ctx.signal.throwIfAborted()
  const subjectRevision = createHash('sha256').update(JSON.stringify({ input, meanings })).digest('hex')
  const presentation = Object.fromEntries(
    (['en', 'zh-CN'] as const).map((locale) => {
      const zh = locale === 'zh-CN'
      return [
        locale,
        {
          title: zh ? '人工质量签署' : 'Human quality signature',
          fields: [
            { label: zh ? '业务对象' : 'Object', value: target },
            { label: zh ? '审阅版本' : 'Reviewed revision', value: String(input.expectedRevision) },
            { label: zh ? '签名含义' : 'Signature meaning', value: meanings[locale] },
            {
              label: zh ? '关联证据' : 'Evidence',
              value: zh ? '查看本次调查与质量档案' : 'Review the investigation and quality dossier',
              href: `/?session=${encodeURIComponent(ctx.session.key)}`,
            },
          ],
          responseValue: meanings[locale],
        },
      ]
    }),
  )
  const handle = await ctx.decisions.request({
    key: `signature:${ctx.session.toolUseId}`,
    purpose: 'business.confirm',
    subject: { action: ctx.session.toolUseId, input: JSON.stringify(input), meanings, subjectRevision },
    prompt: `Human quality signature: ${target}, revision ${input.expectedRevision}. ${meanings.en}`,
    presentation,
    options: ['allowed-once', 'rejected'],
    responseSchema: { type: 'string', enum: Object.values(meanings) },
  })
  const answer = await ctx.decisions.wait(handle, { signal: ctx.signal })
  ctx.signal.throwIfAborted()
  if (answer.status !== 'resolved' || answer.snapshot.invalidation)
    throw new Error('Signature unavailable / 签名不可用')
  const result = answer.snapshot.result
  if (
    result?.reason !== 'answered' ||
    result.response.option !== 'allowed-once' ||
    ['system', 'agent'].includes(result.answeredBy.role) ||
    typeof result.response.value !== 'string' ||
    !Object.values(meanings).includes(result.response.value) ||
    (result.code === 'full-access' &&
      result.answeredBy.attrs.confirmationMode !== 'auto-confirmed under full access')
  )
    throw new Error('Human quality signature required / 需要人工质量签名')
  if (result.code === 'full-access' && !ctx.decisions.admit)
    throw new Error('Host signature admission unavailable')
  const admission = await ctx.decisions.admit?.(handle)
  if (result.code === 'full-access' && !admission) throw new Error('Host signature admission unavailable')
  await admission?.verify()
  return {
    ...(admission ? { admission } : {}),
    confirmationMode:
      result.code === 'full-access' ? ('auto-confirmed under full access' as const) : ('manual' as const),
    signedMeaning: result.response.value,
    requestId: handle.id,
    subjectRevision,
    answeredBy: result.answeredBy,
    signedAt: result.at,
  }
}
