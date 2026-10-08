// Synthetic tool stays in flight until the real session cancellation reaches its AbortSignal.
export const cancelTool = {
  inject: ['extension'],
  apply(ctx) {
    ctx.extension().registerTool({
      name: 'e2e_wait_for_cancel',
      description: 'Wait for explicit cancellation in the offline browser acceptance.',
      parameters: {
        [Symbol.for('TypeBox.Kind')]: 'Object',
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: undefined,
        deferLoading: false,
        requiresApproval: 'never',
      },
      async execute(_args, { signal }) {
        signal.throwIfAborted()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
  },
}
