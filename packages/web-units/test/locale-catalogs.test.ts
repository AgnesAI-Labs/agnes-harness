import { expect, it } from 'vitest'
import { diagnosticsCatalog } from '../src/diagnostics-locale.js'
import { composerLocaleCatalog } from '../src/locales/composer.js'
import { conversationLocaleCatalog } from '../src/locales/conversation.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'
import { settingsShellLocaleCatalog } from '../src/locales/settings-shell.js'
import { sidebarLocaleCatalog } from '../src/locales/sidebar.js'
import { toolLocaleCatalog } from '../src/locales/tool.js'
import { topbarLocaleCatalog } from '../src/locales/topbar.js'
import { traceCatalog } from '../src/trace-locale.js'

const catalogs = [
  ['composer', composerLocaleCatalog],
  ['conversation', conversationLocaleCatalog],
  ['settings shell', settingsShellLocaleCatalog],
  ['sidebar', sidebarLocaleCatalog],
  ['tool', toolLocaleCatalog],
  ['topbar', topbarLocaleCatalog],
  ['trace', traceCatalog],
  ['diagnostics', diagnosticsCatalog],
  ['web-units aggregate', webUnitsLocaleCatalog],
] as const

it('keeps web-units catalogs paired and every translated value non-empty', () => {
  for (const [name, catalog] of catalogs) {
    expect(Object.keys(catalog.en).sort(), `${name} English keys`).not.toHaveLength(0)
    expect(Object.keys(catalog.en).sort(), `${name} key parity`).toEqual(Object.keys(catalog['zh-CN']).sort())
    for (const [locale, dictionary] of Object.entries(catalog)) {
      const emptyValues = Object.entries(dictionary)
        .filter(([, value]) => !value.trim())
        .map(([key]) => key)
      expect(emptyValues, `${name} ${locale} empty values`).toEqual([])
    }
  }
})
