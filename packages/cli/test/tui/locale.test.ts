import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOCALE_KEYS, LOCALES, resolveLocale, t } from '../../src/tui/locale.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { Hints } from '../../src/tui/views/hints.js'

describe('locale (cli 稿 §9.4)', () => {
  it('has every key in every locale', () => {
    for (const locale of LOCALES) for (const key of LOCALE_KEYS) expect(t(key, locale)).not.toBe(key)
  })

  it('resolves AGNES_LOCALE before LANG and falls back to English', () => {
    expect(resolveLocale({ AGNES_LOCALE: 'zh-CN', LANG: 'en_US.UTF-8' })).toBe('zh-CN')
    expect(resolveLocale({ AGNES_LOCALE: 'unsupported', LANG: 'zh_CN.UTF-8' })).toBe('zh-CN')
    expect(resolveLocale({})).toBe('en')
  })

  it('interpolates variables and falls back to English for unknown locales', () => {
    expect(t('notice.resumed', 'en', { step: 4 })).toContain('4')
    expect(t('approval.allowOnce', 'fr')).toBe('Allow once')
  })

  it('hides idle key legends and only renders contextual surface actions', () => {
    const hints = new Hints()
    expect(hints.render(100)).toEqual([])
    hints.set([{ id: 'accept', label: 'Accept export' }])
    expect(hints.render(100)[0]?.trimEnd()).toBe('F1 Accept export')
  })

  it('keeps localized hint chrome to one bounded terminal row', () => {
    for (const locale of LOCALES) {
      const hints = new Hints()
      hints.set([{ id: 'accept', label: `${locale} action` }])
      for (const width of [1, 2, 10, 20, 40]) {
        const lines = hints.render(width)
        expect(lines).toHaveLength(1)
        expect(displayWidth(lines[0] as string)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('keeps tui source below the 4,000-line budget', () => {
    const dir = fileURLToPath(new URL('../../src/tui/', import.meta.url))
    const list = (path: string): string[] =>
      readdirSync(path).flatMap((entry) => {
        const child = join(path, entry)
        return statSync(child).isDirectory() ? list(child) : child.endsWith('.ts') ? [child] : []
      })
    const lines = list(dir).reduce(
      (total, file) =>
        total +
        readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.trim() && !line.trim().startsWith('//')).length,
      0,
    )
    expect(lines).toBeLessThanOrEqual(4_000)
  })
})
