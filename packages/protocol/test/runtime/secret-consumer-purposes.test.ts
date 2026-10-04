import type { SecretConsumerBinding } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'

const binding = {
  secretId: 'credential',
  accountRef: null,
  serverRef: 'server',
  audience: 'selected-service',
  purpose: 'selected-operation',
}
const purposes: SecretConsumerBinding['consumer'][] = [
  'model',
  'mcp',
  'tls',
  'jwt',
  'source-auth',
  'surface',
  'exec',
  'artifact-ticket',
]
it.each(purposes)('registers %s without adding authorization fields', (consumer) => {
  const value: SecretConsumerBinding = { ...binding, consumer }
  expect(validateRuntime('SecretConsumerBinding', value)).toEqual({ ok: true, value })
})
it.each([
  { ...binding, consumer: 'unknown' },
  { ...binding, consumer: '' },
  { ...binding, consumer: null },
  { ...binding, consumer: 'exec', granted: true },
  { ...binding, consumer: 'artifact-ticket', secretId: 12 },
])('refuses unknown purposes and non-contract shapes: %j', (value) => {
  expect(validateRuntime('SecretConsumerBinding', value).ok).toBe(false)
})
