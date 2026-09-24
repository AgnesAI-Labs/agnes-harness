export const backend = {
  apply(ctx) {
    ctx.services.register({
      name: 'data.read',
      kind: 'query',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
          },
        },
        required: ['version'],
        additionalProperties: false,
      },
      timeoutMs: 1000,
      maxResultBytes: 1024,
      async handler() {
        return { version: '2.0.0' }
      },
    })
  },
}
