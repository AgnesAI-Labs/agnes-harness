import { expect, it } from 'vitest'
import { adminLocaleCatalog } from '../src/locales/admin.js'
import { adminConfirmationLocaleCatalog } from '../src/locales/admin-confirmation.js'
import { adminDetailLocaleCatalog } from '../src/locales/admin-detail.js'
import { adminDialogsLocaleCatalog } from '../src/locales/admin-dialogs.js'
import { adminListLocaleCatalog } from '../src/locales/admin-list.js'
import { computerUseUiCatalog } from '../src/locales/computer-use.js'
import { configFormCatalog } from '../src/locales/config-form.js'
import { conversationLocaleCatalog } from '../src/locales/conversation.js'
import { firstRunCatalog } from '../src/locales/first-run.js'
import { resourceDetailLocaleCatalog } from '../src/locales/resource-detail.js'
import { resourceListLocaleCatalog } from '../src/locales/resource-list.js'

const catalogs = [
  ['first run and doctor', firstRunCatalog],
  ['computer use', computerUseUiCatalog],
  ['config form', configFormCatalog],
  ['admin confirmation', adminConfirmationLocaleCatalog],
  ['admin dialogs', adminDialogsLocaleCatalog],
  ['admin detail', adminDetailLocaleCatalog],
  ['admin list', adminListLocaleCatalog],
  ['conversation', conversationLocaleCatalog],
  ['admin aggregate', adminLocaleCatalog],
  ['resource detail', resourceDetailLocaleCatalog],
  ['resource list', resourceListLocaleCatalog],
] as const

it('keeps web-ui catalogs paired and every translated value non-empty', () => {
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
