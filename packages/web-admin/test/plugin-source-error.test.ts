/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'
import { adminErrorKey } from '../src/admin/plugins/admin/dom.js'
import type { PluginAdminViewContext } from '../src/admin/plugins/admin/page.js'
import { pluginNotice } from '../src/admin/plugins/admin/views.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

describe('adminErrorKey for a refused package source', () => {
  it.each([
    ['E_PACKAGE_SOURCE', 'install', 'error.source-rejected', 'SKILL.md', 'SKILL.md'],
    ['E_PACKAGE_STATE', 'remove', 'error.remove-state', 'Disable', '停用'],
    ['E_PACKAGE_STATE', 'enable', 'error.state-changed', 'enabling', '启用'],
  ] as const)('explains %s for %s in the operation notice', (code, operation, key, en, zh) => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const catalog = pluginAdminLocaleCatalog[locale]
      const message = pluginNotice({
        state: { connection: 'connected', error: { code }, lastOperation: { operation } },
        t: (_key: string, values: { operation: string; message: string }) =>
          `${values.operation}: ${values.message}`,
        adminT: (key: string) => key,
        errorMessage: (error, kind) => catalog[adminErrorKey(error.code, kind)],
      } as PluginAdminViewContext).message
      expect(adminErrorKey(code, operation)).toBe(key)
      expect(message).toContain(locale === 'en' ? en : zh)
      if (operation === 'remove') expect(message).not.toMatch(/enabling|再次启用/)
    }
  })

  it('keeps unmapped codes on the generic failure', () => {
    expect(adminErrorKey('E_SOMETHING_ELSE')).toBe('error.operation-failed')
  })
})
