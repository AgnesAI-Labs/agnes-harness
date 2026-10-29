import { readdirSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'

function catalogFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory()
      ? catalogFiles(path)
      : /(?:\/locales\/.*|(?:locale|locales|locale-catalog)\.ts)$/.test(path.split(sep).join('/')) &&
          path.endsWith('.ts')
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
        if (name === 'factChainCatalog') {
          // The activity record lives in the trace now; its links all say where they go.
          expect(catalog.en['facts.toolLink']).toBe('View in trace')
          expect(catalog['zh-CN']?.['facts.toolLink']).toBe('在轨迹中查看')
        }
        if (name === 'settingsShellLocaleCatalog') {
          expect(catalog.en['settings-shell.jobs']).toBe('Jobs')
          expect(catalog['zh-CN']?.['settings-shell.jobs']).toBe('作业')
          expect(catalog.en['settings-shell.voice']).toBe('Voice')
          expect(catalog['zh-CN']?.['settings-shell.voice']).toBe('语音')
        }
        for (const [language, entries] of Object.entries(catalog)) {
          if (!entries || typeof entries !== 'object') continue
          for (const [key, text] of Object.entries(entries)) {
            if (typeof text !== 'string') continue
            // Only this explanation, rendered inside Technical details, names the wire concepts.
            const technical =
              ['settingsCatalog', 'shellCatalog'].includes(name) && key === 'compositionDetailsHelp'
            expect(text, `${name}/${language}/${key}`).not.toMatch(
              technical ? /\bFDE\b/ : /\b(?:FDE|Bundle|Preset)s?\b/,
            )
          }
        }
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
      'computerUseCatalog',
      'serverErrorCatalog',
      'webLocaleCatalog',
      'diagnosticsCatalog',
      'appLocaleCatalog',
      'composerLocaleCatalog',
      'indexShellLocaleCatalog',
      'sessionLocaleCatalog',
      'settingsLocaleCatalog',
      'timelineLocaleCatalog',
      'pluginAdminShellLocaleCatalog',
      'voiceSettingsCatalog',
    ]),
  )
  expect(count).toBeGreaterThan(25)
  const { settingsCatalog } = await import('../src/settings/locales.js')
  const { adminListLocaleCatalog } = await import('@agnes/web-ui')
  for (const [locale, execution, edit, leftover, standard, readTools] of [
    ['en', 'Running mode', 'Edit workspace', 'Leftover usage', 'Standard', 'Read tools only'],
    ['zh-CN', '运行方式', '可修改工作区', '遗留占用', '标准', '只暴露读类工具'],
  ] as const) {
    expect(settingsCatalog[locale]['provider.loop']).toBe(execution)
    expect(settingsCatalog[locale]['choice.workspace-write']).toBe(edit)
    // `standard` is a preset now, not a permission level; the minimal preset only exposes read tools.
    expect(settingsCatalog[locale]['choice.standard']).toBe(standard)
    expect(settingsCatalog[locale]['choiceHelp.minimal']).toBe(readTools)
    expect(settingsCatalog[locale].workspaceWrite).toBe(edit)
    expect(adminListLocaleCatalog[locale]['orphan.title']).toBe(leftover)
  }
  const css = readWebStyleSource(resolve('packages/web/public/style.css'))
  expect(css.match(/content:\s*["'][^"']*\p{Script=Han}[^"']*["']/gu)).toBeNull()
})

it('names the built-in payload-only adapter and its payload capabilities in both languages', async () => {
  const { settingsCatalog } = await import('../src/settings/locales.js')
  for (const locale of ['en', 'zh-CN'] as const)
    for (const key of [
      'providerName.typesafe-systemone',
      'providerName.openai-audio',
      'providerCapability.payload',
      'providerCapability.payloadOnly',
    ])
      expect(settingsCatalog[locale][key], `${locale}/${key}`).toEqual(expect.any(String))
})

it('localizes shipped presentation plugin names and purposes for Chinese and English', async () => {
  const { resolvePluginMetadata } = await import('@agnes/protocol')
  for (const [name, en, zh] of [
    ['goal-ui', 'Goals and progress', '目标与进度'],
    ['jev-loop', 'Jev Agent Loop', 'Jev 运行方式'],
    ['interaction-ui', 'Questions and confirmations', '交互与确认'],
    ['deliverables-ui', 'Files and deliverables', '交付物展示'],
  ]) {
    const manifest = JSON.parse(
      readFileSync(resolve(`packages/package-manager/bundled-plugins/${name}/package.json`), 'utf8'),
    )
    for (const metadata of [manifest.agnes.metadata, manifest.agnes.plugins[0].metadata]) {
      expect(resolvePluginMetadata(metadata, 'en')?.displayName).toBe(en)
      expect(resolvePluginMetadata(metadata, 'zh-CN')?.displayName).toBe(zh)
      expect(resolvePluginMetadata(metadata, 'zh-CN')?.summary).toMatch(/\p{Script=Han}/u)
      expect(resolvePluginMetadata(metadata, 'en')?.summary).not.toMatch(/\p{Script=Han}/u)
    }
  }
})
