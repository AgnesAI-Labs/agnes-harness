// @vitest-environment happy-dom
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { localeKeys, unresolvedLabels } from './i18n.js'

afterEach(() => {
  document.body.replaceChildren()
})

it('finds catalog keys in visible labels, accessible names and placeholders, including unknown namespaced keys', () => {
  document.body.innerHTML = `<button aria-label="catalog.custom">Settings</button>
    <input placeholder="settings.futureLabel"><textarea placeholder="composer.futureLabel">Literal draft</textarea><span>shell.collapseNav</span>
    <span>shell.collapseNav</span><span data-i18n="custom.future">custom.future</span>`
  expect(unresolvedLabels(['catalog.custom'])).toEqual([
    'catalog.custom',
    'settings.futureLabel',
    'composer.futureLabel',
    'shell.collapseNav',
    'custom.future',
  ])
})

it('accepts translated zh/en text and literal examples while ignoring hidden content', () => {
  document.body.innerHTML = `<button aria-label="设置">Settings</button><input placeholder="搜索">
    <pre>settings.example</pre><code>shell.example</code><textarea>composer.example</textarea>
    <span style="display:none">shell.hidden</span>`
  expect(unresolvedLabels(['shell.hidden'])).toEqual([])
})

it('loads nested catalogs and multiline translations without depending on product UI keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-locales-'))
  const folder = join(root, 'locales')
  try {
    await mkdir(join(folder, 'nested'), { recursive: true })
    await writeFile(
      join(folder, 'main.ts'),
      `export const catalog = { en: {
      'catalog.multiline':
        'A translated sentence',
    } }`,
    )
    await writeFile(
      join(folder, 'nested/shared.ts'),
      `export const catalog = {
      "nested.label": "Translated", 'bare': "Bare",
    }`,
    )
    expect(await localeKeys([folder])).toEqual(expect.arrayContaining(['catalog.multiline', 'nested.label']))
    expect(await localeKeys([folder])).not.toContain('bare')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
