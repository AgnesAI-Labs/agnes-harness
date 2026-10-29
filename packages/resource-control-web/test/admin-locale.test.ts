import { expect, it } from 'vitest'
import { resourceAdminLocaleCatalog } from '../src/locales/admin.js'
import { resourceAdminShellLocaleCatalog } from '../src/locales/shell.js'

it('keeps resource catalogs paired and every translated value non-empty', () => {
  for (const [name, catalog] of [
    ['resource admin', resourceAdminLocaleCatalog],
    ['resource admin shell', resourceAdminShellLocaleCatalog],
  ] as const) {
    expect(Object.keys(catalog.en).sort(), `${name} English keys`).not.toHaveLength(0)
    expect(Object.keys(catalog.en).sort(), `${name} key parity`).toEqual(Object.keys(catalog['zh-CN']).sort())
    for (const [locale, dictionary] of Object.entries(catalog)) {
      const emptyValues = Object.entries(dictionary)
        .filter(([, value]) => !value.trim())
        .map(([key]) => key)
      expect(emptyValues, `${name} ${locale} empty values`).toEqual([])
    }
  }
  expect(resourceAdminLocaleCatalog.en['shell.confirm.kicker']).toBe('Confirmation required')
  expect(resourceAdminLocaleCatalog['zh-CN']['shell.confirm.kicker']).toBe('需要确认')
})

it('discloses the existing enablement behavior in both scan confirmations', () => {
  expect(resourceAdminLocaleCatalog.en['action.refresh-skills']).toContain(
    'Newly discovered skills will be enabled.',
  )
  expect(resourceAdminLocaleCatalog['zh-CN']['action.refresh-skills']).toContain('新发现的技能会启用。')
})
