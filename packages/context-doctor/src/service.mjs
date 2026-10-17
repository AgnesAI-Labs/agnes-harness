/** @type {import("@agnes/extension-api").ServiceCapability} */
export const readService = {
  name: 'context.read',
  kind: 'query',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'status', 'snapshot'],
    properties: {
      version: {
        const: 1,
      },
      status: {
        enum: ['live', 'unknown'],
      },
      snapshot: {
        type: ['object', 'null'],
      },
    },
  },
  timeoutMs: 1000,
  maxResultBytes: 32768,
}
