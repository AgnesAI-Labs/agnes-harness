/**
 * `04-diagnostics.css` 里的每条类选择器都必须还有页面在用。
 *
 * 这组规则里原本有一段 `.archived-*`：设置对话框里的归档面板在 318a8164b 移到侧栏时删掉了
 * 标记、单位与控制器，样式却留在原处，还靠更高的特异性压过侧栏自己的列表规则。删掉这些死
 * 规则之后，这里把「CSS 里的类 → 页面源码里的类」变成持续检查的约束：以后出现「页面删了、
 * 样式留着」，这条用例先红。将来若有运行时拼接的类名，在 EXCEPTIONS 里登记并写明理由，不
 * 直接放宽检查。
 *
 * 扫描范围是 `packages/<包名>/src` 下的 `.tsx` 与 `.html`：这些类由 web、web-ui、web-units
 * 渲染，诊断类（`.agnes-diagnostics-*`）由 web-admin 渲染。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')
const packagesRoot = resolve(packageRoot, '..')
const styleFile = resolve(packageRoot, 'public', 'styles', '04-diagnostics.css')

/** 运行时拼接、无法在源码里按字面找到的类名：类名 → 为什么找不到。 */
const EXCEPTIONS = new Map<string, string>()

/** 规则前导里的类选择器；注释与声明体不参与匹配。 */
function classSelectors(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  const found = new Set<string>()
  const walk = (start: number, end: number): void => {
    let i = start
    while (i < end) {
      const open = source.indexOf('{', i)
      if (open === -1 || open >= end) break
      const prelude = source.slice(i, open)
      const selector = prelude.slice(prelude.lastIndexOf(';') + 1).trim()
      let depth = 0
      let close = open
      for (; close < end; close += 1) {
        if (source[close] === '{') depth += 1
        else if (source[close] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (selector.startsWith('@')) walk(open + 1, close)
      else
        for (const match of selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
          if (match[1]) found.add(match[1])
        }
      i = close + 1
    }
  }
  walk(0, source.length)
  return [...found].sort()
}

function collectMarkup(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collectMarkup(full, out)
    } else if (/\.(tsx|html)$/.test(entry.name)) out.push(readFileSync(full, 'utf8'))
  }
}

function readMarkupSources(): string {
  const sources: string[] = []
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sourceDirectory = join(packagesRoot, entry.name, 'src')
    try {
      collectMarkup(sourceDirectory, sources)
    } catch {
      // 没有 src 的包（生成物、纯配置包）不参与检查。
    }
  }
  return sources.join('\n')
}

const selectors = classSelectors(readFileSync(styleFile, 'utf8'))
const markup = readMarkupSources()

describe('04-diagnostics.css class ownership', () => {
  it('finds class selectors to check', () => {
    expect(selectors.length).toBeGreaterThan(0)
  })

  it('has a page source for every class selector', () => {
    const unused = selectors.filter((name) => {
      if (EXCEPTIONS.has(name)) return false
      return !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(markup)
    })
    expect(unused).toEqual([])
  })
})
