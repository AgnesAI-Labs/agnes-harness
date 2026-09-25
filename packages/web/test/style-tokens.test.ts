/**
 * `style.css` 的 token 门禁。
 *
 * 把语义 token 与主题约定变成可执行断言，让下面几类回归无法通过测试：
 *
 *   1. 深浅任一主题的文字对比度掉到 4.5:1 以下；
 *   2. 组件层（非 token 规则）又冒出裸色值；
 *   3. 最弱一档文字色被用到提示文案或可点控件上；
 *   4. 语义 token 又变成"声明了没人用"的空转词汇；
 *   5. 深浅两套 token 不再成对；
 *   6. 组件规则直接引用基础色层（`--agnes-color-*`），越过语义层；
 *   7. 组件规则引用了不存在的 token（var() 声明失效，background 之类会静默变透明）。
 *
 * 不引入 CSS 解析依赖：这里只需要"规则 → 声明"这一层结构，自写的最小解析器够用，
 * 且下面是显式断言而不是静默跳过——解析退化（规则数异常）本身就会红。
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const packageDirectory = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')
const stylePath = resolve(packageDirectory, 'public', 'style.css')

type Rule = { selector: string; body: string; atContext: string | null; line: number }

let rules: Rule[] = []

/** 去掉注释但保留换行，报错里的行号才仍然是原文件行号。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1
  return line
}

function parseRules(source: string): Rule[] {
  const found: Rule[] = []
  const walk = (start: number, end: number, atContext: string | null): void => {
    let i = start
    while (i < end) {
      const open = source.indexOf('{', i)
      if (open === -1 || open >= end) break
      const selector = source.slice(i, open).trim()
      let depth = 0
      let close = open
      for (; close < end; close += 1) {
        if (source[close] === '{') depth += 1
        else if (source[close] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (selector.startsWith('@')) walk(open + 1, close, selector)
      else found.push({ selector, body: source.slice(open + 1, close), atContext, line: lineAt(source, i) })
      i = close + 1
    }
  }
  walk(0, source.length, null)
  return found
}

type Declaration = { property: string; value: string }

function declarationsOf(rule: Rule): Declaration[] {
  const out: Declaration[] = []
  for (const chunk of rule.body.split(';')) {
    const text = chunk.trim()
    if (!text) continue
    const colon = text.indexOf(':')
    if (colon <= 0) continue
    out.push({
      property: text.slice(0, colon).trim(),
      value: text
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, ' '),
    })
  }
  return out
}

// ── token 解析 ────────────────────────────────────────────────────────────

type Color = { rgb: [number, number, number]; alpha: number }
type Theme = 'light' | 'dark'

const isBaseColor = (name: string): boolean => name.startsWith('--agnes-color-')
const isThemedToken = (name: string): boolean =>
  (name.startsWith('--agnes-') && !isBaseColor(name)) || name.startsWith('--shadow-')

const lightTokens = new Map<string, string>()
const darkTokens = new Map<string, string>()

function collectTokens(): void {
  for (const rule of rules) {
    // 媒体查询里的 :root（reduced-motion 的 --transition）不属于主题 token 层。
    const isLightRoot = rule.selector === ':root' && rule.atContext === null
    const isDarkRoot = rule.selector === '.dark'
    if (!isLightRoot && !isDarkRoot) continue
    for (const { property, value } of declarationsOf(rule)) {
      if (!property.startsWith('--')) continue
      if (isDarkRoot) darkTokens.set(property, value)
      else lightTokens.set(property, value)
    }
  }
  for (const [name, value] of lightTokens) if (!darkTokens.has(name)) darkTokens.set(name, value)
}

function hexToRgb(hex: string): [number, number, number] {
  let body = hex.replace('#', '')
  if (body.length === 3)
    body = body
      .split('')
      .map((c) => c + c)
      .join('')
  return [0, 2, 4].map((i) => Number.parseInt(body.slice(i, i + 2), 16)) as [number, number, number]
}

/** 只支持本文件里真实出现的写法：#rgb / #rrggbb / rgb(r g b) / rgb(r g b / n%)。 */
function parseColor(value: string): Color | null {
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (hex) return { rgb: hexToRgb(hex[0]), alpha: 1 }
  const fn = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+)%)?\s*\)$/)
  if (!fn) return null
  return {
    rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])],
    alpha: fn[4] === undefined ? 1 : Number(fn[4]) / 100,
  }
}

function resolveColor(name: string, theme: Theme, depth = 0): Color | null {
  const source = theme === 'dark' ? darkTokens : lightTokens
  const raw = source.get(name)
  if (raw === undefined) return null
  const direct = parseColor(raw)
  if (direct) return direct
  const alias = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  const target = alias?.[1]
  if (target && depth < 10) return resolveColor(target, theme, depth + 1)
  return null
}

function compositeOver(fg: Color, bg: Color): [number, number, number] {
  if (fg.alpha >= 1) return fg.rgb
  const out: [number, number, number] = [0, 0, 0]
  for (const i of [0, 1, 2] as const) out[i] = fg.rgb[i] * fg.alpha + bg.rgb[i] * (1 - fg.alpha)
  return out
}

const channel = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const luminance = (rgb: [number, number, number]): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])

function contrast(fgName: string, bgName: string, theme: Theme): number | null {
  const fg = resolveColor(fgName, theme)
  const bg = resolveColor(bgName, theme)
  if (!fg || !bg) return null
  const a = luminance(compositeOver(fg, bg))
  const b = luminance(bg.rgb)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// ── 断言用的常量 ──────────────────────────────────────────────────────────

/** 正文级：任一主题下都不得低于 4.5:1。 */
const TEXT_PAIRS: Array<[string, string]> = [
  ['--agnes-text-primary', '--agnes-bg-page'],
  ['--agnes-text-secondary', '--agnes-bg-page'],
  ['--agnes-text-tertiary', '--agnes-bg-page'],
  ['--agnes-text-emphasis', '--agnes-bg-page'],
  ['--agnes-text-primary', '--agnes-bg-app-content'],
  ['--agnes-text-secondary', '--agnes-bg-app-content'],
  ['--agnes-text-tertiary', '--agnes-bg-app-content'],
  ['--agnes-button-outline-content', '--agnes-bg-page'],
  ['--agnes-input-content-strong', '--agnes-input-surface'],
  ['--agnes-button-primary-content', '--agnes-button-primary-bg'],
  ['--agnes-button-primary-content', '--agnes-button-primary-bg-hover'],
  ['--agnes-status-warning-text', '--agnes-status-warning-bg'],
  ['--agnes-status-danger-text', '--agnes-status-danger-bg'],
  ['--agnes-status-success-text', '--agnes-bg-page'],
  ['--agnes-status-info-text', '--agnes-bg-page'],
  ['--agnes-status-warning-text', '--agnes-bg-page'],
  ['--agnes-text-inverse', '--agnes-status-danger-text'],
  ['--agnes-text-secondary', '--agnes-status-warning-bg'],
]

/** 占位符的下界：低于这个值就连"有提示"都看不出来。 */
const PLACEHOLDER_FLOOR = 2.8

/**
 * `--agnes-text-disabled` 的精确白名单：只允许出现在不可交互的装饰性标签上。
 * 新增使用点必须同步改这里——这份摩擦是刻意的。
 * `.user .node-label` 已随 DSH 对齐删除（DSH 的用户回合没有名字标签），故移出白名单。
 */
const TEXT_DISABLED_SELECTORS = [
  '#config-form .settings-rail-heading .eyebrow',
  '#config-form .config-detail-heading .eyebrow',
]

/**
 * 本产品没有消费点、且已在设计 §6.2 显式删除的语义 token 的"保留名单"。
 * 保持为空是目标：任何名字被加回来都会让 adoption 门禁提醒重新登记。
 */
const RESERVED_TOKENS = new Set<string>()

/** mask 的不透明停靠点不是主题色，按设计 §5.1 豁免。 */
const MASK_PROPERTIES = new Set(['mask', '-webkit-mask'])

/**
 * 不在 token 层定义、由 JS 运行时注入的自定义属性（`element.style.setProperty`）。
 * 新增使用点必须同步改这里——这份摩擦是刻意的。
 */
const DYNAMIC_CUSTOM_PROPERTIES = new Set([
  '--usage-pct', // packages/web/src/usage.ts 的用量环，var() 自带 0% 回退
])

beforeAll(async () => {
  rules = parseRules(stripComments(await readFile(stylePath, 'utf8')))
  collectTokens()
})

describe('style.css token 门禁', () => {
  it('键盘聚焦的按钮与表单控件保留可见焦点规则', () => {
    const buttonFocus = rules.find((rule) =>
      rule.selector.split(',').some((part) => part.trim() === 'button:focus-visible'),
    )
    const inputFocus = rules.find((rule) =>
      rule.selector.split(',').some((part) => part.trim() === 'input:focus-visible'),
    )
    expect(declarationsOf(buttonFocus as Rule)).toContainEqual({
      property: 'outline',
      value: '2px solid var(--agnes-input-border-focus)',
    })
    expect(declarationsOf(inputFocus as Rule)).toContainEqual({
      property: 'box-shadow',
      value: '0 0 0 3px var(--agnes-brand-focus-ring)',
    })
  })

  it('解析出了完整的规则集（防止解析退化导致的假通过）', () => {
    expect(rules.length).toBeGreaterThan(200)
    expect(lightTokens.size).toBeGreaterThan(60)
    expect(darkTokens.size).toBeGreaterThan(60)
  })

  it('深浅两套主题的正文对比度都不低于 4.5:1', () => {
    const failures: string[] = []
    for (const [fg, bg] of TEXT_PAIRS) {
      for (const theme of ['light', 'dark'] as const) {
        const ratio = contrast(fg, bg, theme)
        if (ratio === null) {
          failures.push(`${theme}: ${fg} on ${bg} —— token 解析失败（名字写错或链断了？）`)
          continue
        }
        if (ratio < 4.5) failures.push(`${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`)
      }
    }
    expect(failures.join('\n')).toBe('')
  })

  it('占位符比真实值弱、但仍可辨认（区间门禁，不是正文门禁）', () => {
    for (const theme of ['light', 'dark'] as const) {
      const placeholder = contrast('--agnes-input-placeholder', '--agnes-input-surface', theme)
      const value = contrast('--agnes-input-content-strong', '--agnes-input-surface', theme)
      expect(placeholder).not.toBeNull()
      expect(value).not.toBeNull()
      expect(placeholder as number).toBeGreaterThanOrEqual(PLACEHOLDER_FLOOR)
      expect(placeholder as number).toBeLessThan(value as number)
    }
  })

  it('组件层没有裸色值（mask 停靠点是唯一豁免）', () => {
    const violations: string[] = []
    const exemptions: string[] = []
    const bareColor = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/
    for (const rule of rules) {
      if (rule.selector === ':root' || rule.selector === '.dark') continue
      for (const { property, value } of declarationsOf(rule)) {
        if (!bareColor.test(value)) continue
        const where = `${rule.selector} @${rule.line} { ${property}: ${value} }`
        if (MASK_PROPERTIES.has(property)) exemptions.push(where)
        else violations.push(where)
      }
    }
    expect(violations.join('\n')).toBe('')
    // 豁免必须"正好是"已知的那两条，新增 mask 取巧会在这里变红。
    expect(exemptions).toHaveLength(2)
    for (const entry of exemptions) expect(entry).toContain('#000 50%')
  })

  it('最弱一档文字色只用在登记过的装饰性标签上', () => {
    const actual = rules
      .filter((rule) => rule.body.includes('var(--agnes-text-disabled)'))
      .map((rule) => rule.selector)
      .sort()
    expect(actual).toEqual([...TEXT_DISABLED_SELECTORS].sort())
  })

  it('每个语义 token 都有消费点（没有空转词汇）', () => {
    const referenced = new Set<string>()
    const source = rules.map((rule) => rule.body).join('\n')
    for (const match of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = match[1]
      if (name) referenced.add(name)
    }
    const idle = [...lightTokens.keys()]
      .filter(isThemedToken)
      .filter((name) => !referenced.has(name) && !RESERVED_TOKENS.has(name))
      .sort()
    expect(idle.join('\n')).toBe('')
  })

  it('组件规则引用的每个 token 都有定义（悬空的 var() 声明失效，background 会静默变全透明）', () => {
    const source = rules.map((rule) => rule.body).join('\n')
    const dangling = new Set<string>()
    for (const match of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = match[1]
      // 带回退值的引用同样要求登记：token 缺失时回退会被静默吃掉，语义层形同虚设。
      if (name && !DYNAMIC_CUSTOM_PROPERTIES.has(name) && !lightTokens.has(name)) dangling.add(name)
    }
    expect([...dangling].sort().join('\n')).toBe('')
  })

  it('深浅两套的主题 token 名字成对', () => {
    const light = [...lightTokens.keys()].filter(isThemedToken).sort()
    const dark = [...darkTokens.keys()].filter(isThemedToken).sort()
    expect(dark).toEqual(light)
  })

  it('组件规则不直接引用基础色层', () => {
    const violations = rules
      .filter((rule) => rule.selector !== ':root' && rule.selector !== '.dark')
      .filter((rule) => rule.body.includes('var(--agnes-color-'))
      .map((rule) => `${rule.selector} @${rule.line}`)
    expect(violations.join('\n')).toBe('')
  })
})
