import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../web/public/styles/01-tokens.css', import.meta.url), 'utf8')
const declarations = (body: string) =>
  Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
const light = Object.assign({}, ...[...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((m) => declarations(m[1]!)))
const dark = { ...light, ...declarations(css.match(/\.dark\s*\{([^}]+)\}/)![1]!) }
type Color = [number, number, number, number]
function color(name: string, tokens: Record<string, string>, seen: string[] = []): Color {
  if (seen.includes(name)) throw new Error(`Cyclic token: ${[...seen, name].join(' → ')}`)
  const value = tokens[name]
  if (!value) throw new Error(`Missing token: ${name}`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias) return color(alias[1]!, tokens, [...seen, name])
  if (/^#[a-f\d]{6}$/i.test(value))
    return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)).concat(1) as Color
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+)%)?\)$/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) / 100 : 1]
  throw new Error(`Unsupported color: ${name} = ${value}`)
}
function over(fg: Color, bg: Color): Color {
  return [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as Color
}
function luminance(rgb: Color): number {
  return rgb
    .slice(0, 3)
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
}
const pairs: [string, string, number][] = [
  ...['primary', 'secondary', 'tertiary', 'icon-secondary'].flatMap((role): [string, string, number][] =>
    [
      'page',
      'app-content',
      'app-sidebar',
      'surface',
      'popover',
      'subtle',
      'card',
      'hover',
      'selected',
      'fill',
      'code',
      'user-bubble',
    ].map((bg) => [
      role === 'icon-secondary' ? '--agnes-icon-secondary' : `--agnes-text-${role}`,
      `--agnes-bg-${bg}`,
      4.5,
    ]),
  ),
  ...['success', 'warning', 'danger', 'info'].map((tone): [string, string, number] => [
    `--agnes-status-${tone}-text`,
    `--agnes-status-${tone}-bg`,
    4.5,
  ]),
  ['--agnes-button-primary-content', '--agnes-button-primary-bg', 4.5],
  ['--agnes-text-emphasis', '--agnes-brand-emphasis-soft', 4.5],
  ['--agnes-button-primary-content', '--agnes-button-primary-bg-hover', 4.5],
  ['--agnes-input-content-strong', '--agnes-input-surface', 4.5],
  ['--agnes-input-placeholder', '--agnes-input-surface', 4.5],
  ...['border', 'border-emphasis', 'border-focus'].map((role): [string, string, number] => [
    `--agnes-input-${role}`,
    '--agnes-input-surface',
    3,
  ]),
  // The workbench filter is a flat field on the content surface, including hover and focus.
  ...['border', 'border-emphasis', 'border-focus'].map((role): [string, string, number] => [
    `--agnes-input-${role}`,
    '--agnes-bg-app-content',
    3,
  ]),
  ['--agnes-brand-focus-ring', '--agnes-bg-page', 3],
  ['--agnes-brand-mark', '--agnes-bg-app-sidebar', 4.5],
  ['--agnes-brand-mark', '--agnes-bg-app-content', 4.5],
  // Refinement layer: the highlighted menu row, the destructive row and the raised control surface.
  ['--agnes-menu-active-text', '--agnes-menu-active-bg', 4.5],
  ['--agnes-text-inverse', '--agnes-status-danger-text', 4.5],
  ['--agnes-text-primary', '--agnes-bg-control', 4.5],
  ['--agnes-text-secondary', '--agnes-bg-control', 4.5],
  ['--agnes-menu-active-bg', '--agnes-bg-popover', 3],
  ['--agnes-button-primary-content', '--agnes-brand-primary', 3],
]
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
describe('menu material keeps text contrast over any backdrop', () => {
  // A menu is the popover colour at 94% over a blurred backdrop; black and white bound what the
  // remaining 6% can contribute.
  const material =
    /--agnes-bg-popover-material:\s*color-mix\(in srgb, var\(--agnes-bg-popover\) (\d+)%, transparent\)/
  const opacity = Number(material.exec(css)![1]) / 100
  const backdrops: [string, Color][] = [
    ['black', [0, 0, 0, 1]],
    ['white', [255, 255, 255, 1]],
  ]
  for (const [theme, tokens] of Object.entries({ light, dark })) {
    for (const [name, backdrop] of backdrops) {
      it.each(['primary', 'secondary', 'tertiary'])(
        `${theme}: %s text on the material over ${name} ≥ 4.5:1`,
        (role) => {
          const [r, g, b] = color('--agnes-bg-popover', tokens)
          const surface = over([r, g, b, opacity], backdrop)
          const value = ratio(
            luminance(over(color(`--agnes-text-${role}`, tokens), surface)),
            luminance(surface),
          )
          expect(value, `${theme}/${name}: ${role} = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        },
      )
    }
  }
  it('declares the same 94% material in both themes', () => {
    expect(css.match(new RegExp(material, 'g'))).toHaveLength(2)
    expect(opacity).toBe(0.94)
  })
})
describe('default skin contrast table (pure CSS calculation)', () => {
  for (const [theme, tokens] of Object.entries({ light, dark })) {
    it(`${theme}: navigation and content follow the shared surface hierarchy`, () => {
      const navigation = luminance(color('--agnes-bg-app-sidebar', tokens))
      const content = luminance(color('--agnes-bg-app-content', tokens))
      const raised = luminance(color('--agnes-bg-surface', tokens))
      expect(navigation).toBeLessThan(content)
      if (theme === 'light') {
        expect(color('--agnes-bg-app-content', tokens)).toEqual([255, 255, 255, 1])
        expect(content).toBe(raised)
        for (const role of ['page', 'surface', 'popover', 'group', 'control'])
          expect(color(`--agnes-bg-${role}`, tokens), role).toEqual([255, 255, 255, 1])
        for (const role of ['app-sidebar', 'subtle', 'card', 'code', 'fill', 'user-bubble'])
          expect(color(`--agnes-bg-${role}`, tokens), role).toEqual([243, 243, 241, 1])
      } else expect(content).toBeLessThan(raised)
      for (const base of ['app-content', 'app-sidebar']) {
        const background = color(`--agnes-bg-${base}`, tokens)
        const hover = luminance(over(color('--agnes-bg-hover', tokens), background))
        const selected = luminance(over(color('--agnes-bg-selected', tokens), background))
        if (theme === 'light') {
          expect(selected).toBeLessThan(hover)
          expect(hover).toBeLessThan(luminance(background))
        } else {
          expect(selected).toBeGreaterThan(hover)
          expect(hover).toBeGreaterThan(luminance(background))
        }
      }
    })
    it.each(pairs)(`${theme}: %s on %s ≥ %s:1`, (fg, bg, floor) => {
      // Translucent hover/selection fills also appear over the darker navigation surface.
      for (const base of ['--agnes-bg-page', '--agnes-bg-app-sidebar']) {
        const background = over(color(bg, tokens), color(base, tokens))
        const a = luminance(over(color(fg, tokens), background)),
          b = luminance(background)
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        expect(ratio, `${theme}: ${fg} / ${bg} over ${base} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          floor,
        )
      }
    })
  }
})

// The generated UI renders on both themes from the same stylesheet, so it may only paint with
// semantic tokens. A literal colour or a palette primitive would keep its light value after the
// reader switches to dark.
describe('generated UI paints through the semantic theme only', () => {
  const ui = readFileSync(new URL('../src/intelligent-ui/styles.css', import.meta.url), 'utf8')
  const local = declarations(ui)
  const painted = [...ui.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)]
    .filter(([, property]) => !/mask|filter/.test(property!))
    .map(([, , value]) => value!.replace(/url\([^)]*\)/g, ''))

  it('writes no literal colour', () => {
    const literals = painted.flatMap((value) =>
      [...value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi)].map((match) => match[0]),
    )
    expect(literals).toEqual([])
  })

  it('never reaches for a palette primitive', () => {
    expect([...ui.matchAll(/var\((--agnes-color-[\w-]+)/g)].map((match) => match[1])).toEqual([])
  })

  it('references only tokens the theme declares', () => {
    const used = [...ui.matchAll(/var\((--[\w-]+)/g)].flatMap((match) => (match[1] ? [match[1]] : []))
    const missing = [...new Set(used)]
      .filter((token) => !(token in light) && !(token in dark) && !(token in local))
      .sort()
    expect(missing).toEqual([])
  })
})
