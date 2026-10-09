import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

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
it('keeps every exported frontend catalog paired across all frontend packages', async () => {
  let count = 0
  const discovered = new Set<string>()
  for (const pkg of [
    'web',
    'web-foundation',
    'web-conversation',
    'web-admin',
    'web-ui',
    'web-units',
    'web-client',
    'resource-control-web',
  ])
    for (const file of catalogFiles(resolve('packages', pkg, 'src'))) {
      const exports = await import(/* @vite-ignore */ pathToFileURL(file).href)
      for (const [name, value] of Object.entries(exports)) {
        if (!value || typeof value !== 'object' || !('en' in value)) continue
        const catalog = value as Record<string, Record<string, unknown>>
        if (!catalog.en || Array.isArray(catalog.en)) continue
        count += 1
        discovered.add(name)
        expect(Object.keys(catalog.en), `${pkg}/${name}: nonempty English keys`).not.toHaveLength(0)
        if (name === 'serverErrorCatalog')
          for (const key of Object.keys(catalog.en)) expect(key.startsWith('error.'), key).toBe(true)
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
  expect([...discovered]).toEqual(
    expect.arrayContaining([
      'computerUseCatalog', 'serverErrorCatalog', 'webLocaleCatalog', 'diagnosticsCatalog',
      'appLocaleCatalog', 'composerLocaleCatalog', 'indexShellLocaleCatalog', 'sessionLocaleCatalog',
      'settingsLocaleCatalog', 'timelineLocaleCatalog', 'pluginAdminShellLocaleCatalog',
    ]),
  )
  expect(count).toBeGreaterThan(25)
  const css = readWebStyleSource(resolve('packages/web/public/style.css'))
  expect(css.match(/content:\s*["'][^"']*\p{Script=Han}[^"']*["']/gu)).toBeNull()
})
