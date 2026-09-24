import { describe, expect, it } from 'vitest'
import { type ResourceAuthority, requireSecretUse } from '../src/resources/index.js'

const authority: ResourceAuthority = {
  audience: 'admin',
  principalId: 'p',
  clientId: 'c',
  permissions: ['mcp.manage'],
}
describe('resource conditional authority', () => {
  it('requires secrets.use only when a definition binds a SecretRef', () => {
    expect(() => requireSecretUse(authority, false)).not.toThrow()
    expect(() => requireSecretUse(authority, true)).toThrow()
    expect(() =>
      requireSecretUse({ ...authority, permissions: ['mcp.manage', 'secrets.use'] }, true),
    ).not.toThrow()
  })
})
