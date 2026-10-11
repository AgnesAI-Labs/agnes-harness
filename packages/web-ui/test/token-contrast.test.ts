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
    ['page', 'surface', 'popover', 'subtle', 'card', 'hover'].map((bg) => [
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
  ['--agnes-button-primary-content', '--agnes-button-primary-bg-hover', 4.5],
  ['--agnes-input-content-strong', '--agnes-input-surface', 4.5],
  ['--agnes-input-placeholder', '--agnes-input-surface', 4.5],
  ...['border', 'border-emphasis', 'border-focus'].map((role): [string, string, number] => [
    `--agnes-input-${role}`,
    '--agnes-input-surface',
    3,
  ]),
  ['--agnes-brand-focus-ring', '--agnes-bg-page', 3],
]
describe('default skin contrast table (pure CSS calculation)', () => {
  for (const [theme, tokens] of Object.entries({ light, dark })) {
    it.each(pairs)(`${theme}: %s on %s ≥ %s:1`, (fg, bg, floor) => {
      const background = over(color(bg, tokens), color('--agnes-bg-page', tokens))
      const a = luminance(over(color(fg, tokens), background)),
        b = luminance(background)
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      expect(ratio, `${theme}: ${fg} / ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor)
    })
  }
})
