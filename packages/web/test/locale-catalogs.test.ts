import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  const css = readFileSync(resolve('packages/web/public/style.css'), 'utf8')
  expect(css.match(/content:\s*["'][^"']*\p{Script=Han}[^"']*["']/gu)).toBeNull()
})

function catalogFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory()
      ? catalogFiles(path)
      : /(?:\/locales\/.*|(?:locale|locales|locale-catalog)\.ts)$/.test(path) && path.endsWith('.ts')
        ? [path]
        : []
  })
}
it('keeps every exported frontend catalog paired across all four frontend packages', async () => {
  let count = 0
  for (const pkg of ['web', 'web-ui', 'web-units', 'web-client', 'resource-control-web'])
    for (const file of catalogFiles(resolve('packages', pkg, 'src'))) {
      const exports = await import(/* @vite-ignore */ pathToFileURL(file).href)
      for (const [name, value] of Object.entries(exports)) {
        if (!value || typeof value !== 'object' || !('en' in value)) continue
        const catalog = value as Record<string, Record<string, unknown>>
        if (!catalog.en || Array.isArray(catalog.en)) continue
        count += 1
        expect(catalog['zh-CN'], `${pkg}/${name}: Chinese catalog`).toBeDefined()
        expect(Object.keys(catalog.en).sort(), `${pkg}/${name}: key parity`).toEqual(
          Object.keys(catalog['zh-CN'] ?? {}).sort(),
        )
        for (const locale of ['en', 'zh-CN'])
          for (const [key, text] of Object.entries(catalog[locale] ?? {}))
            expect(
              typeof text === 'string' && text.trim().length > 0,
              `${pkg}/${name}/${locale}/${key}`,
            ).toBe(true)
      }
    }
  expect(count).toBeGreaterThan(25)
})
