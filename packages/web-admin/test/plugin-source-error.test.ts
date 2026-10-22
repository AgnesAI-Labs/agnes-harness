import { describe, expect, it } from 'vitest'
import { adminErrorKey } from '../src/admin/plugins/admin/dom.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

describe('adminErrorKey for a refused package source', () => {
  it('explains a refused source instead of the generic operation failure', () => {
    const key = adminErrorKey('E_PACKAGE_SOURCE')
    expect(key).toBe('error.source-rejected')
    for (const locale of ['en', 'zh-CN'] as const)
      expect(pluginAdminLocaleCatalog[locale]?.[key]).toContain('SKILL.md')
  })

  it('keeps unmapped codes on the generic failure', () => {
    expect(adminErrorKey('E_SOMETHING_ELSE')).toBe('error.operation-failed')
  })
})
