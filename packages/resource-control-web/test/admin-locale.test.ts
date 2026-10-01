import { expect, it } from 'vitest'
import { resourceAdminLocaleCatalog } from '../src/locales/admin.js'

it('keeps English and Simplified Chinese resource admin keys paired', () => {
  expect(Object.keys(resourceAdminLocaleCatalog.en).sort()).toEqual(
    Object.keys(resourceAdminLocaleCatalog['zh-CN']).sort(),
  )
  expect(resourceAdminLocaleCatalog.en['shell.confirm.kicker']).toBe('Confirmation required')
  expect(resourceAdminLocaleCatalog['zh-CN']['shell.confirm.kicker']).toBe('需要确认')
})
