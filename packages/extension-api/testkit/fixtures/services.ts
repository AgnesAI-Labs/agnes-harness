import type { ServiceDef } from '../../src/services.js'
/** No I/O or implicit identity; suitable for author checks and Host boundary fixtures. */
export function serviceFixture(): ServiceDef<{ value: number }, { value: number }> {
  return {
    name: 'fixture.echo',
    kind: 'query',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    timeoutMs: 1000,
    maxResultBytes: 1024,
    async handler(input) {
      return { value: input.value }
    },
  }
}
