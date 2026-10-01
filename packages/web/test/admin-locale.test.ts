import { expect, it } from 'vitest'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

it('keeps English and Simplified Chinese plugin admin keys paired', () => {
  expect(Object.keys(pluginAdminLocaleCatalog.en).sort()).toEqual(
    Object.keys(pluginAdminLocaleCatalog['zh-CN']).sort(),
  )
})
