export const toolCatalog = [
  {
    name: 'status',
    description: 'Read simulated pump temperature and version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'cool',
    description: 'Constrained cooling request. Dry-run by default; local simulator only.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        expectedVersion: { type: 'integer' },
        targetC: { type: 'number', minimum: 20, maximum: 30 },
        dry_run: { type: 'boolean', default: true },
      },
      required: ['key', 'expectedVersion', 'targetC'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'receipt',
    description: 'Read a receipt without repeating an action.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
]
export function createFixture() {
  const state = { deviceId: 'sim-pump-1', temperatureC: 38, limitC: 30, version: 1 }
  const receipts = new Map()
  return {
    call(name, args) {
      let data
      if (name === 'status') {
        if (Object.keys(args).length) throw new Error('Status accepts no arguments')
        data = { ...state }
      } else if (name === 'cool') {
        if (
          typeof args.key !== 'string' ||
          !/^[a-zA-Z0-9:-]{1,128}$/.test(args.key) ||
          !Number.isInteger(args.expectedVersion) ||
          typeof args.targetC !== 'number' ||
          args.targetC < 20 ||
          args.targetC > 30 ||
          !Number.isFinite(args.targetC) ||
          (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') ||
          Object.keys(args).some((k) => !['key', 'expectedVersion', 'targetC', 'dry_run'].includes(k))
        )
          throw new Error('Invalid constrained action')
        const normalized = {
          key: args.key,
          expectedVersion: args.expectedVersion,
          targetC: args.targetC,
          dry_run: args.dry_run ?? true,
        }
        const old = receipts.get(args.key)
        if (old) {
          if (JSON.stringify(old.request) !== JSON.stringify(normalized))
            throw new Error('Idempotency key reused for a different action')
          data = old
        } else {
          if (args.expectedVersion !== state.version) throw new Error('Stale device state; read again')
          if (!normalized.dry_run) {
            state.temperatureC = args.targetC
            state.version++
          }
          data = {
            key: args.key,
            deviceId: state.deviceId,
            outcome: 'completed',
            dry_run: normalized.dry_run,
            request: normalized,
            observed: { ...state },
            effect: normalized.dry_run ? 'preview-only' : 'simulator-only',
          }
          receipts.set(args.key, data)
        }
      } else if (name === 'receipt') {
        if (Object.keys(args).some((k) => k !== 'key')) throw new Error('Unexpected receipt arguments')
        data = receipts.get(args.key)
        if (!data) throw new Error('Outcome unknown: inspect device state; do not replay')
      } else throw new Error('Unknown device action')
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
    },
  }
}
