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
})
