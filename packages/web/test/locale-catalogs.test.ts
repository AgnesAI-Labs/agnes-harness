import { expect, it } from 'vitest'
import { pluginAdminShellLocaleCatalog } from '../src/admin/plugins/locales/shell.js'
import { webLocaleCatalog } from '../src/locale-catalog.js'
import { appLocaleCatalog } from '../src/locales/app.js'
import { composerLocaleCatalog } from '../src/locales/composer.js'
import { indexShellLocaleCatalog } from '../src/locales/index-shell.js'
import { sessionLocaleCatalog } from '../src/locales/session.js'
import { settingsLocaleCatalog } from '../src/locales/settings.js'
import { timelineLocaleCatalog } from '../src/locales/timeline.js'

const catalogs = [
  ['web app', appLocaleCatalog],
  ['web composer', composerLocaleCatalog],
  ['web index shell', indexShellLocaleCatalog],
  ['web session', sessionLocaleCatalog],
  ['web settings', settingsLocaleCatalog],
  ['web timeline', timelineLocaleCatalog],
  ['web aggregate', webLocaleCatalog],
  ['plugin admin shell', pluginAdminShellLocaleCatalog],
] as const

it('keeps web catalogs paired and every translated value non-empty', () => {
  for (const [name, catalog] of catalogs) {
    expect(catalog.en, `${name} English dictionary`).toBeDefined()
    expect(catalog['zh-CN'], `${name} Chinese dictionary`).toBeDefined()
    const english = catalog.en ?? {}
    const chinese = catalog['zh-CN'] ?? {}
    expect(Object.keys(english).sort(), `${name} English keys`).not.toHaveLength(0)
    expect(Object.keys(english).sort(), `${name} key parity`).toEqual(Object.keys(chinese).sort())
    for (const [locale, dictionary] of Object.entries(catalog)) {
      const emptyValues = Object.entries(dictionary)
        .filter(([, value]) => !value.trim())
        .map(([key]) => key)
      expect(emptyValues, `${name} ${locale} empty values`).toEqual([])
    }
  }
})
