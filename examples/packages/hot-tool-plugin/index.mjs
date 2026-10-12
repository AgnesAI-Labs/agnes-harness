// A plain Cordis object plugin that gives the model a tool. It has no imports, so the installed
// snapshot needs no dependency: `ctx.hooks` registers hooks, `ctx.self` carries the row's logger; ctx.tools registers tools.
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

  deferLoading: false,
  requiresApproval: 'never',
}

export const textStatsTool = {
  inject: ['tools', 'hooks', 'self'],
  apply(ctx) {
    ctx.tools.register({
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
    // session_start is observe-only, so the handler's return value is ignored.
    ctx.hooks.register('session_start', () => {
      ctx.self.log.info('demo_text_stats is available for this session')
    })
  },
}
