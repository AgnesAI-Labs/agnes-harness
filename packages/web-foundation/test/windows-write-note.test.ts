import { describe, expect, it } from 'vitest'
import { sessionLocaleCatalog } from '../src/locales/session.js'

describe('the Windows write restriction note', () => {
  it('says in both languages that reads and network are not restricted', () => {
    const key = 'session.runtime.windowsAclIsolation'
    const catalog = sessionLocaleCatalog as unknown as Record<string, Record<string, string>>
    expect(catalog.en?.[key]).toMatch(/reads and network/i)
    expect(catalog['zh-CN']?.[key]).toMatch(/读取与网络/)
  })
})
