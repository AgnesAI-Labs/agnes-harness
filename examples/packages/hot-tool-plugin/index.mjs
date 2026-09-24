// A plain Cordis object plugin that gives the model a tool. It has no imports, so the installed
// snapshot needs no dependency: `ctx.extension()` hands the row its own tool / hook / event API.
// Tool parameters are TypeBox schemas: plain JSON Schema objects tagged with the TypeBox kind
// symbol. Tagging them by hand keeps this file free of imports; with @sinclair/typebox installed,
// `Type.Object({ text: Type.String({ maxLength: 8192 }) }, { additionalProperties: false })` is the same value.
const Kind = Symbol.for('TypeBox.Kind')
const parameters = {
  [Kind]: 'Object',
  type: 'object',
  properties: { text: { [Kind]: 'String', type: 'string', maxLength: 8192 } },
  required: ['text'],
  additionalProperties: false,
}

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

export const textStatsTool = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'demo_text_stats',
      description: 'Count characters and words in text.',
      parameters,
      meta,
      async execute({ text }) {
        const words = text.trim() ? text.trim().split(/\s+/u).length : 0
        const structured = { characters: text.length, words }
        return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
      },
    })
    // Observe-only hooks are open to plugin rows; the handler's return value is ignored.
    agnes.on('session_start', () => {
      agnes.ctx.log.info('demo_text_stats is available for this session')
    })
  },
}
