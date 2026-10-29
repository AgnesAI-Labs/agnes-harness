import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { checkManifest, PLUGIN_FACET_NAMES, THEME_TOKEN_NAMES } from '../src/index.js'

const root = new URL('../../../', import.meta.url)
const generatedUrl = new URL(
  'packages/package-manager/bundled-plugins/plugin-helper/src/reference.generated.mjs',
  root,
)
const { authorContract, authorReference } = await import(generatedUrl.href)

it('keeps the shipped author reference and bilingual docs matched to the public API declarations', async () => {
  const { outputs } = await import(new URL('tools/authoring/reference.mjs', root).href)
  for (const [path, expected] of Object.entries(outputs()))
    expect(readFileSync(new URL(path, root), 'utf8'), path).toBe(expected)
  expect(authorContract.facets.map((s: string) => /readonly (\w+)/.exec(s)?.[1]).sort()).toEqual(
    [...PLUGIN_FACET_NAMES].sort(),
  )
  expect(authorContract.toolMembers).toContain('fs')
  expect(authorContract.toolMembers).toContain('store')
  expect(authorContract.execute).toBe('execute(args: Static<P>, ctx: ToolContext): Promise<ToolResult>')
  expect(authorReference).toContain('WORKSPACE access')
  expect(authorReference).toContain('capabilities.store: true')
})

it('advertises exactly the tokens accepted by the install validator, including text tokens and mixed invalid input', async () => {
  const { applySkinTokens } = await import(new URL('packages/web-foundation/src/skin.ts', root).href)
  const { applyTheme } = await import(new URL('packages/web-foundation/src/theme.ts', root).href)
  const values = new Map(),
    classes = new Map()
  const target = {
    classList: { toggle: (name: string, value: boolean) => classes.set(name, value) },
    style: {
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => values.delete(name),
    },
  }
  expect(authorContract.skinModes).toEqual(['light', 'dark'])
  for (const mode of authorContract.skinModes) {
    applyTheme(target, mode)
    applySkinTokens(
      target,
      { tokens: { '--agnes-text-primary': { light: 'light-value', dark: 'dark-value' } } },
      mode,
      [],
    )
    expect(classes.get(authorContract.darkClass)).toBe(mode === 'dark')
    expect(values.get('--agnes-text-primary')).toBe(`${mode}-value`)
  }
  expect(authorContract.tokens).toEqual([...THEME_TOKEN_NAMES])
  const manifest = {
    id: 'author/reference',
    version: '1.0.0',
    apiRange: '^5.0.0',
    entry: './index.mjs',
    capabilities: { ui: true },
    contributes: {
      skins: [
        {
          id: 'reference',
          name: 'Reference',
          css: './skin.css',
          tokens: Object.fromEntries(
            authorContract.tokens.map((token: string) => [token, { light: '#fff', dark: '#111' }]),
          ),
        },
      ],
    },
  }
  expect(checkManifest(manifest).ok).toBe(true)
  expect(authorContract.tokens).toContain('--agnes-text-primary')
  const evaluation = JSON.parse(
    readFileSync(
      new URL('packages/base/extensions/plugin-creator/test/authoring-behavior.eval.json', root),
      'utf8',
    ),
  )
  const session = evaluation.cases.find(
    (entry: { name: string }) => entry.name === 'skin with mixed valid and invalid tokens',
  )
  expect(authorContract.tokens).toContain(session.deterministic.validToken)
  expect(authorContract.tokens).not.toContain(session.deterministic.invalidToken)
  const skin = manifest.contributes.skins[0]
  if (!skin) throw new Error('Missing test skin')
  skin.tokens[session.deterministic.invalidToken] = { light: '#fff', dark: '#111' }
  expect(checkManifest(manifest).ok).toBe(false)
  delete skin.tokens[session.deterministic.invalidToken]
  expect(
    checkManifest({
      ...manifest,
      contributes: { skins: [{ ...skin, tokens: { '--agnes-text-primary': { light: '#fff' } } }] },
    }).ok,
  ).toBe(false)
})
