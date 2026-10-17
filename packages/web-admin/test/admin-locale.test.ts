import { expect, it } from 'vitest'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

it('keeps plugin admin keys paired and both translations non-empty', () => {
  const english = Object.keys(pluginAdminLocaleCatalog.en).sort()
  expect(english).not.toHaveLength(0)
  expect(english).toEqual(Object.keys(pluginAdminLocaleCatalog['zh-CN']).sort())
  for (const key of english) {
    expect(pluginAdminLocaleCatalog.en[key], `en ${key}`).toBeTruthy()
    expect(pluginAdminLocaleCatalog['zh-CN'][key], `zh-CN ${key}`).toBeTruthy()
  }
  for (const locale of ['en', 'zh-CN'] as const) {
    const catalog = pluginAdminLocaleCatalog[locale]
    expect(catalog['confirm.disable.description']).toContain(
      locale === 'en' ? 'Existing sessions keep its tools and panels' : '已有会话保留它的工具和面板',
    )
    for (const key of ['drain.tooltip', 'drain.summary', 'drain.summaryUnknown'])
      expect(catalog[key]).not.toMatch(/Updated|update is ready|新版本已就绪|已更新/)
  }
})
