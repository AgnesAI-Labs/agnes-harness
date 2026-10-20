import { defineAgnesPlugin, defineTool, readOnlyTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export const status = defineTool({
  name: 'acme_status',
  description: 'Record synthetic business consent; no external system is contacted.',
  parameters: Type.Object({}, { additionalProperties: false }),
  meta: readOnlyTool,
  async execute(_args, ctx) {
    ctx.signal.throwIfAborted()
    const handle = await ctx.decisions.request({
      key: `signature:${ctx.session.toolUseId}`,
      purpose: 'business.confirm',
      subject: { record: 'SYNTHETIC-1', revision: 0 },
      prompt: 'Sign synthetic record?',
      options: ['allowed-once', 'rejected'],
      presentation: {
        en: { title: 'Synthetic signature', fields: [], responseValue: 'I confirm this synthetic record.' },
      },
      responseSchema: { type: 'string', enum: ['I confirm this synthetic record.'] },
    })
    const answer = await ctx.decisions.wait(handle, { signal: ctx.signal })
    if (answer.status !== 'resolved' || answer.snapshot.result?.response?.option !== 'allowed-once')
      throw new Error('Signature unavailable')
    const result = answer.snapshot.result
    const admission = await ctx.decisions.admit(handle)
    await admission.verify()
    admission.assertActive()
    const structured = {
      signer: result.answeredBy.id,
      confirmationMode: result.code === 'full-access' ? 'auto-confirmed under full access' : 'manual',
      signedMeaning: result.response.value,
    }
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
  },
})
export const main = defineAgnesPlugin({
  apply(ctx) {
    ctx.tools.register(status)
  },
})
