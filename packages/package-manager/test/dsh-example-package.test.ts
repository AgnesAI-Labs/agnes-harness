import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkManifest } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { resolveClientAssets } from '../src/client-assets.js'

const examples = fileURLToPath(new URL('../../../examples/packages', import.meta.url))
const cases = [
  { family: 'dsh-input-controls', slots: ['conversation.input.right'] },
  { family: 'dsh-model-picker-a', slots: ['conversation.input.model'] },
  { family: 'dsh-model-picker-b', slots: ['conversation.input.model'] },
  { family: 'dsh-tool-view', slots: ['tool.call.toolview'] },
] as const
const resourceCases = cases

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('DSH example package metadata', () => {
  it.each(['v1', 'v2', 'broken'])('%s declares a valid DSH client contract for every family', (release) => {
    for (const { family, slots } of cases) {
      const root = `${examples}/${family}/${release}`
      const pkg = json(`${root}/package.json`)
      const descriptor = json(`${root}/extensions/main/agnes.client.json`)
      const manifestResult = checkManifest({
        id: 'client/descriptor',
        version: pkg.version,
        apiRange: '*',
        entry: './index.mjs',
        capabilities: { ui: ['client'] },
        contributes: descriptor,
      })

      expect(manifestResult.ok).toBe(true)
      if (!manifestResult.ok) continue
      const client = manifestResult.value.contributes?.client
      expect(pkg).toMatchObject({
        name: `@agnes-examples/${family}`,
        version: release === 'v1' ? '1.0.0' : release === 'v2' ? '2.0.0' : '3.0.0',
        agnes: {
          plugins: [{ id: `ext:examples/${family}/main`, runtime: 'in-process', export: 'main' }],
          clientDescriptors: [
            { rowId: `ext:examples/${family}/main`, path: './extensions/main/agnes.client.json' },
          ],
        },
      })
      expect(client).toMatchObject({
        entry: './client/index.js',
        styles: ['./client/index.css'],
        slots,
        slotCatalogVersion: 'dsh-client-slots/v1',
        services: [],
        projections: [],
      })
      const label = (client?.publicConfig as { label?: unknown } | undefined)?.label
      expect(typeof label).toBe('string')
      expect(label).toContain('DSH ')
      expect(label).toContain(' · ')
    }
  })

  it.each(['v1', 'v2', 'broken'])('%s resolves its package-local client entry and stylesheet', (release) => {
    for (const { family } of resourceCases) {
      const root = `${examples}/${family}/${release}/extensions/main`
      const checked = checkManifest({
        id: 'client/descriptor',
        version: '1.0.0',
        apiRange: '*',
        entry: './index.mjs',
        capabilities: { ui: ['client'] },
        contributes: json(`${root}/agnes.client.json`),
      })
      expect(checked.ok).toBe(true)
      if (!checked.ok) continue

      const assets = resolveClientAssets(root, checked.value)
      expect(assets?.entryPath).toBe(`${root}/client/index.js`)
      expect(assets?.stylePaths).toEqual([`${root}/client/index.css`])
    }
  })
})
