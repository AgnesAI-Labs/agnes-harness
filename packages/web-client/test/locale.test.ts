import { Context } from '@agnes/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleService, resolveUiLocale, SlotRegistry } from '../src/index.js'

async function createLocale(initial: string): Promise<LocaleService> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  return new LocaleService(ctx, initial)
}

describe('LocaleService', () => {
  it('falls back to English for an unknown locale', async () => {
    expect(resolveUiLocale('zh-CN')).toBe('zh-CN')
    expect(resolveUiLocale('en')).toBe('en')
    expect(resolveUiLocale('zh')).toBe('en')
    expect(resolveUiLocale(undefined)).toBe('en')
    const locale = await createLocale('fr')
    expect(locale.locale).toBe('en')
    expect(locale.getSnapshot()).toBe('en')
  })

  it('resolves the active catalog, then English, then the key', async () => {
    const locale = await createLocale('zh-CN')
    locale.register('core', {
      en: { 'only.en': 'English', both: 'Both EN', greet: 'Hello {name}' },
      'zh-CN': { both: '两者', greet: '你好 {name}' },
    })
    expect(locale.t('both')).toBe('两者')
    expect(locale.t('only.en')).toBe('English')
    expect(locale.t('missing')).toBe('missing')
    expect(locale.t('greet', { name: 'Ada' })).toBe('你好 Ada')
    expect(locale.t('greet', {})).toBe('你好 {name}')

    locale.setLocale('en')
    expect(locale.t('greet', { name: 'Ada' })).toBe('Hello Ada')
    locale.setLocale('fr')
    expect(locale.locale).toBe('en')
  })

  it('lets a later namespace override lookup and keeps a bound namespace first', async () => {
    const locale = await createLocale('en')
    locale.register('plugin', { en: { k: 'plugin' } })
    const removeHost = locale.register('host', { en: { k: 'host' } })
    expect(locale.t('k')).toBe('host')
    expect(locale.bind('plugin')('k')).toBe('plugin')
    removeHost()
    expect(locale.t('k')).toBe('plugin')
  })

  it('notifies subscribers only when the resolved locale changes', async () => {
    const locale = await createLocale('en')
    let calls = 0
    locale.subscribe(() => {
      calls += 1
    })
    locale.setLocale('en')
    locale.setLocale('nope')
    expect(calls).toBe(0)
    locale.setLocale('zh-CN')
    expect(calls).toBe(1)
    expect(locale.getSnapshot()).toBe('zh-CN')
  })
})
