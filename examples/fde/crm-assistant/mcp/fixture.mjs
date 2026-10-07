import { readFileSync } from 'node:fs'

const accounts = JSON.parse(readFileSync(new URL('../fixtures/accounts.json', import.meta.url)))
export const toolCatalog = [
  {
    name: 'lookup',
    description: 'Read a synthetic CRM account.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'note',
    description: 'Append a synthetic CRM note after approval.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' } },
      required: ['id', 'text', 'key'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
]
export function createFixture() {
  const receipts = new Map()
  return {
    call(name, args) {
      const account = accounts.find((a) => a.id === args.id)
      if (!account) throw new Error('Unknown CRM account')
      let data
      if (name === 'lookup') {
        if (Object.keys(args).some((k) => k !== 'id')) throw new Error('Unexpected CRM arguments')
        data = account
      } else if (name === 'note') {
        if (
          typeof args.text !== 'string' ||
          !args.text.trim() ||
          args.text.length > 4000 ||
          typeof args.key !== 'string' ||
          !/^[a-zA-Z0-9:-]{1,128}$/.test(args.key) ||
          Object.keys(args).some((k) => !['id', 'text', 'key'].includes(k))
        )
          throw new Error('Invalid CRM note')
        const old = receipts.get(args.key)
        if (old && (old.id !== args.id || old.text !== args.text))
          throw new Error('Idempotency key reused for a different note')
        data = old ?? { id: args.id, text: args.text, status: 'simulated-recorded', receipt: args.key }
        receipts.set(args.key, data)
      } else throw new Error('Unknown CRM tool')
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
    },
  }
}
