// A plain mechanism fixture: recovery belongs to Core, with no application-specific workaround.
const Kind = Symbol.for('TypeBox.Kind')
export const argumentRecovery = {
  inject: ['tools'],
  apply(ctx) {
    const probe = {
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
    }
    ctx.tools.register(probe)
    let records = 0
    ctx.tools.register({
      ...probe,
      name: 'recovery_record',
      description: 'Record one synthetic progress observation in memory for completion-check acceptance.',
      meta: {
        ...probe.meta,
        isReadOnly: false,
        isConcurrencySafe: false,
        replay: 'never',
        requiresApproval: 'never',
      },
      async execute({ observation }) {
        records++
        return { content: [{ type: 'text', text: `Synthetic progress ${records}: ${observation}` }] }
      },
    })
  },
}
