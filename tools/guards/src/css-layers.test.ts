import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { readWebStyleSource, readWebUiStyleSource } from '../../web-style-source.mjs'
import { cssLayerFindings, cssLayerOrders } from './css-layers.js'
import { listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const policy = JSON.parse(readFileSync(join(root, 'tools/guards/css-layers.json'), 'utf8')) as {
  order: string[]
  source: string
  wrappedInputs: Record<string, { count: number; layer: string; reason: string }>
}
const cssFiles = listSourceFiles(
  ['packages', 'examples', 'tools'].map((path) => join(root, path)),
  {
    extensions: ['.css'],
  },
)
const relativePath = (file: string) => relative(root, file).replaceAll('\\', '/')

it('detects unlayered rules inside conditional blocks, without reading strings or comments as rules', () => {
  expect(cssLayerFindings('@layer app { @media (width < 900px) { .row { color: red } } }')).toEqual([])
  expect(cssLayerFindings('@layer app { .row {} } @media print { .row { color: red } }')).toEqual(['.row'])
  expect(cssLayerFindings('/* .row {} */ @layer app { .row { content: "} ; {" } }')).toEqual([])
  expect(
    cssLayerFindings('@import "./app.css" layer(app); @layer app { @keyframes pulse { to {} } }'),
  ).toEqual([])
  expect(cssLayerOrders('@layer tokens, base, vendor, ui, app, skin; @layer app, ui;')).toHaveLength(2)
  expect(cssLayerOrders('@layer ui { @layer base, components; }')).toEqual([])
  expect(cssLayerFindings('@layer surprise { .row {} }', ['app'])).toEqual(['@layer surprise'])
  expect(cssLayerFindings('@keyframes pulse { to {} }')).toEqual(['@keyframes pulse'])
  expect(() => cssLayerFindings('@layer app { .row {}')).toThrow('Unclosed CSS rule')
})

it('keeps one canonical layer order and emits it once before the Web rules', () => {
  const order = `@layer ${policy.order.join(', ')};`
  expect(readFileSync(join(root, policy.source), 'utf8').trim()).toBe(order)
  const declarations = cssFiles.flatMap((file) =>
    policy.wrappedInputs[relativePath(file)]
      ? []
      : cssLayerOrders(readFileSync(file, 'utf8')).map(() => relativePath(file)),
  )
  expect(declarations).toEqual([policy.source])
  const app = readWebStyleSource(join(root, 'packages/web/public/style.css'))
  const ui = readWebUiStyleSource(join(root, 'packages/web-ui/src/tokens.css'))
  expect(ui).not.toMatch(/@import\s/)
  expect(app.startsWith(`${order}\n`)).toBe(true)
  expect(`${app}\n${ui}`.split(order)).toHaveLength(2)
  for (const page of ['index', 'admin', 'resources']) {
    const html = readFileSync(join(root, `packages/web/public/${page}.html`), 'utf8')
    const firstStyle = /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1]
    expect(firstStyle, page).toBe('/style.css')
  }
})

it('requires layers for every stylesheet and exact, explained allowances for wrapped inputs', () => {
  const seen = new Set<string>()
  const errors: string[] = []
  for (const file of cssFiles) {
    const path = relativePath(file)
    const source = readFileSync(file, 'utf8')
    const wrapped = policy.wrappedInputs[path]
    const findings = cssLayerFindings(source, wrapped ? undefined : policy.order)
    if (wrapped) {
      seen.add(path)
      expect(wrapped.reason.trim(), path).not.toBe('')
      expect(policy.order, path).toContain(wrapped.layer)
      expect(findings.length, `${path}: wrapper allowance is exact`).toBe(wrapped.count)
    } else {
      errors.push(...findings.map((rule) => `${path}: ${rule}`))
      for (const imported of source.matchAll(/@import\s+"([^"]+)"([^;]*);/g)) {
        const layer = /\blayer\s*\(([\w.-]+)\)/.exec(imported[2] ?? '')?.[1]
        if (layer) {
          expect(policy.order, `${path}: imported layer must belong to the canonical order`).toContain(
            layer.split('.')[0],
          )
          continue
        }
        const dependency = resolve(dirname(file), imported[1] ?? '')
        expect(cssFiles, `${path}: unlayered imports must reference a checked stylesheet`).toContain(
          dependency,
        )
        expect(
          policy.wrappedInputs[relativePath(dependency)],
          `${path}: raw wrapped inputs need an import layer`,
        ).toBeUndefined()
      }
    }
    if (path.startsWith('packages/web/public/styles/'))
      expect(basename(path), 'fold overrides into their owning stylesheet').not.toMatch(/overrides/i)
  }
  expect(errors, errors.join('\n')).toEqual([])
  expect([...seen].sort()).toEqual(Object.keys(policy.wrappedInputs).sort())
})
