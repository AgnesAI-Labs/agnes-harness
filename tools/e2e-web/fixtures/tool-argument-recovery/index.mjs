// A plain read-only fixture: recovery belongs to Core, with no application-specific workaround.
const Kind = Symbol.for('TypeBox.Kind')
export const argumentRecovery = {
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'recovery_probe',
      description: 'Read one synthetic observation for the tool argument recovery acceptance.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          observation: { [Kind]: 'String', type: 'string' },
        },
        required: ['observation'],
        additionalProperties: false,
      },
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        deferLoading: false,
        invalidArgumentLimit: 2,
      },
      async execute({ observation }) {
        return { content: [{ type: 'text', text: `Synthetic observation: ${observation}` }] }
      },
    })
  },
}
