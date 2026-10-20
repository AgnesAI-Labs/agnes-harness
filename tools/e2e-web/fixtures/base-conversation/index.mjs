const Kind = Symbol.for('TypeBox.Kind')
const parameters = { [Kind]: 'Object', type: 'object', properties: {}, additionalProperties: false }

/** Synthetic application: exercises public presentation/evidence/decision contracts only. */
export const main = {
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'plain_review',
      description: 'Review the synthetic record and request a business signature.',
      parameters,
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'safe',
        requiresApproval: 'never',
        deferLoading: false,
        presentation: {
          title: '审阅记录 / Review record',
          description: 'Record-1 · 检查报告后签署 / Check the report before signing',
        },
      },
      async execute(_args, tool) {
        const handle = await tool.decisions.request({
          key: `signature:${tool.session.toolUseId}`,
          purpose: 'business.confirm',
          subject: { object: 'Record-1', revision: 1 },
          prompt: 'Review Record-1',
          presentation: {
            en: {
              title: 'Sign reviewed record',
              fields: [
                { label: 'Object', value: 'Record-1' },
                { label: 'Meaning', value: 'I reviewed this synthetic record.' },
              ],
              responseValue: 'reviewed',
            },
            'zh-CN': {
              title: '签署审阅记录',
              fields: [
                { label: '对象', value: 'Record-1' },
                { label: '签署含义', value: '我已审阅此合成记录。' },
              ],
              responseValue: 'reviewed',
            },
          },
          options: ['allowed-once', 'rejected'],
          responseSchema: { type: 'string', enum: ['reviewed'] },
        })
        const answer = await tool.decisions.wait(handle, { signal: tool.signal })
        if (
          answer.status !== 'resolved' ||
          answer.snapshot.result?.reason !== 'answered' ||
          answer.snapshot.result.response.option !== 'allowed-once'
        )
          return { content: [{ type: 'text', text: 'Signature declined' }], isError: true }
        return {
          content: [{ type: 'text', text: 'Reviewed Record-1' }],
          structured: {
            evidence: [
              { name: '审阅报告 / Review report', kind: 'report', status: 'available', path: 'report.html' },
            ],
          },
        }
      },
    })
  },
}
