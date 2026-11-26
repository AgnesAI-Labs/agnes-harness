/** @vitest-environment happy-dom */

import { enT, zhT } from '@agnes/web-foundation/testkit/locale'
import { mountSettingsSelectOptions, unmountRegion } from '@agnes/web-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAppearance, bindSkinGroup } from '../src/appearance.js'
import { setLocaleTranslator } from '../src/locale-bridge.js'
import { webLocaleCatalog } from '../src/locale-catalog.js'
import {
  applyLocaleText,
  syncLocaleRadios,
  UI_LOCALE_NAMES,
  UI_LOCALES,
  type UiLocale,
} from '../src/locale-preference.js'
import { FONT_SCALE_STORAGE_KEY, THEME_STORAGE_KEY } from '../src/theme.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    read: (key: string): string | undefined => map.get(key),
  }
}

function mount(): void {
  document.body.innerHTML = `
    <fieldset>
      <label><input type="radio" name="agnes-theme" value="system" /></label>
      <label><input type="radio" name="agnes-theme" value="light" /></label>
      <label><input type="radio" name="agnes-theme" value="dark" /></label>
    </fieldset>
  `
}

const radio = (value: string): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>(`input[name="agnes-theme"][value="${value}"]`)
  if (!found) throw new Error(`missing radio ${value}`)
  return found
}

/** 模拟用户点选：先改 checked，再派发 change（与浏览器单选组行为一致）。 */
function select(value: string): void {
  const input = radio(value)
  input.checked = true
  input.dispatchEvent(new Event('change'))
}

beforeEach(() => {
  mount()
  document.documentElement.classList.remove('dark')
})

describe('bindAppearance', () => {
  it('初始回填：无存储时选中 system', () => {
    bindAppearance({ scope: document, root: document.documentElement, storage: fakeStorage() })
    expect(radio('system').checked).toBe(true)
    expect(radio('light').checked).toBe(false)
    expect(radio('dark').checked).toBe(false)
  })

  it('初始回填：按已存偏好选中', () => {
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }),
    })
    expect(radio('dark').checked).toBe(true)
    expect(radio('system').checked).toBe(false)
  })

  it('非法存储值回填成 system', () => {
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage({ [THEME_STORAGE_KEY]: 'neon' }),
    })
    expect(radio('system').checked).toBe(true)
  })

  it('选深色：写存储并立即给根元素加 dark', () => {
    const storage = fakeStorage()
    bindAppearance({ scope: document, root: document.documentElement, storage })
    select('dark')
    expect(storage.read(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('选回浅色：写存储并移除 dark', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })
    document.documentElement.classList.add('dark')
    bindAppearance({ scope: document, root: document.documentElement, storage })
    select('light')
    expect(storage.read(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('跟随系统时按系统偏好解析', () => {
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage(),
      prefersDark: () => true,
    })
    select('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('跟随系统 + 系统为浅色时不加 dark', () => {
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage(),
      prefersDark: () => false,
    })
    select('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('存储写入失败不回滚已应用的外观，也不抛', () => {
    const hostile = {
      getItem: (): string | null => null,
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      },
    }
    bindAppearance({ scope: document, root: document.documentElement, storage: hostile })
    expect(() => select('dark')).not.toThrow()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('未选中的项派发 change 时被忽略', () => {
    const storage = fakeStorage()
    bindAppearance({ scope: document, root: document.documentElement, storage })
    radio('dark').dispatchEvent(new Event('change')) // 没有 checked = true
    expect(storage.read(THEME_STORAGE_KEY)).toBeUndefined()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('sync() 重新拉取被外部改动的偏好', () => {
    const storage = fakeStorage()
    const controller = bindAppearance({
      scope: document,
      root: document.documentElement,
      storage,
    })
    expect(radio('system').checked).toBe(true)
    storage.setItem(THEME_STORAGE_KEY, 'dark')
    controller.sync()
    expect(radio('dark').checked).toBe(true)
  })
})

describe('bindAppearance 字号组', () => {
  function mountFont(): void {
    document.body.innerHTML = `
      <fieldset>
        <label><input type="radio" name="agnes-theme" value="system" /></label>
        <label><input type="radio" name="agnes-font-scale" value="small" /></label>
        <label><input type="radio" name="agnes-font-scale" value="normal" /></label>
        <label><input type="radio" name="agnes-font-scale" value="large" /></label>
      </fieldset>
    `
  }
  const fontRadio = (value: string): HTMLInputElement => {
    const found = document.querySelector<HTMLInputElement>(`input[name="agnes-font-scale"][value="${value}"]`)
    if (!found) throw new Error(`missing font radio ${value}`)
    return found
  }
  const pick = (value: string): void => {
    const input = fontRadio(value)
    input.checked = true
    input.dispatchEvent(new Event('change'))
  }

  beforeEach(() => {
    mountFont()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.fontSize = ''
  })

  it('初始回填：无存储时选中 normal', () => {
    document.body.innerHTML = '<div id="font-scale-choices"></div><select id="locale-select"></select>'
    const host = document.querySelector<HTMLElement>('#font-scale-choices')!
    const stopLocale = mountSettingsSelectOptions(
      document.querySelector<HTMLSelectElement>('#locale-select')!,
    )
    const storage = fakeStorage()
    let locale: UiLocale = 'zh-CN'
    setLocaleTranslator(zhT)
    try {
      const controller = bindAppearance({
        scope: document,
        root: document.documentElement,
        storage,
        locale: {
          rendered: true,
          current: () => locale,
          select(value) {
            locale = value
            setLocaleTranslator(value === 'en' ? enT : zhT)
          },
          text: (key) => (locale === 'en' ? enT : zhT)(key),
        },
      })
      expect([...host.querySelectorAll('label')].map((label) => label.textContent)).toEqual([
        '小',
        '标准',
        '大',
      ])
      const language = document.querySelector<HTMLSelectElement>('#locale-select')!
      language.value = 'en'
      language.dispatchEvent(new Event('change'))
      expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Font size')
      expect([...host.querySelectorAll('label')].map((label) => label.textContent)).toEqual([
        'Small',
        'Standard',
        'Large',
      ])
      expect(fontRadio('normal').checked).toBe(true)
      fontRadio('large').click()
      expect(storage.read(FONT_SCALE_STORAGE_KEY)).toBe('large')
      expect(document.documentElement.style.fontSize).toBe('112.5%')
      storage.setItem(FONT_SCALE_STORAGE_KEY, 'small')
      controller.sync()
      expect(fontRadio('small').checked).toBe(true)
    } finally {
      stopLocale()
      unmountRegion(host)
      setLocaleTranslator(zhT)
    }
  })

  it('初始回填：按已存字号选中', () => {
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage({ [FONT_SCALE_STORAGE_KEY]: 'large' }),
    })
    expect(fontRadio('large').checked).toBe(true)
  })

  it('选大号：写存储并把根元素字号调到 112.5%', () => {
    const storage = fakeStorage()
    bindAppearance({ scope: document, root: document.documentElement, storage })
    pick('large')
    expect(storage.read(FONT_SCALE_STORAGE_KEY)).toBe('large')
    expect(document.documentElement.style.fontSize).toBe('112.5%')
  })

  it('选小号：回到 87.5%', () => {
    const storage = fakeStorage({ [FONT_SCALE_STORAGE_KEY]: 'large' })
    bindAppearance({ scope: document, root: document.documentElement, storage })
    pick('small')
    expect(document.documentElement.style.fontSize).toBe('87.5%')
  })

  it('字号与配色互不干扰', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })
    document.documentElement.classList.add('dark')
    bindAppearance({ scope: document, root: document.documentElement, storage })
    pick('large')
    expect(document.documentElement.style.fontSize).toBe('112.5%')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(storage.read(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('存储写入失败不回滚已应用的字号', () => {
    const hostile = {
      getItem: (): string | null => null,
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      },
    }
    bindAppearance({ scope: document, root: document.documentElement, storage: hostile })
    expect(() => pick('large')).not.toThrow()
    expect(document.documentElement.style.fontSize).toBe('112.5%')
  })
})

describe('bindSkinGroup', () => {
  const skins = [
    { value: 'exact-midnight', name: '午夜', packageName: '@acme/skins', version: '1.0.0' },
    { value: 'exact-paper', name: '纸质', packageName: '@acme/skins', version: '1.0.0' },
  ]
  const available = { selected: 'application', skins, unavailable: false }
  // The picker is a select whose options are the installed skins; these helpers read it as a list.
  let unmount: (() => void) | undefined
  function mountSkin(): void {
    unmount?.()
    document.body.innerHTML =
      '<fieldset><select id="skin-select"></select><div id="skin-option-items"></div></fieldset>'
    unmount = mountSettingsSelectOptions(select())
  }
  const select = (): HTMLSelectElement => {
    const found = document.querySelector<HTMLSelectElement>('#skin-select')
    if (!found) throw new Error('missing skin select')
    return found
  }
  const inputs = (): { value: string; checked: boolean }[] =>
    [...select().options].map((option) => ({ value: option.value, checked: select().value === option.value }))
  const input = (value: string): { value: string; checked: boolean } => {
    const found = inputs().find((candidate) => candidate.value === value)
    if (!found) throw new Error(`missing skin option ${value}`)
    return found
  }
  const pick = (value: string): void => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  }

  beforeEach(mountSkin)

  it('renders both host choices and each candidate with its package and version', async () => {
    const group = bindSkinGroup({
      scope: document,
      list: async () => available,
      select: async () => undefined,
    })
    await group.refresh()
    expect(inputs().map((entry) => entry.value)).toEqual(['application', '', 'exact-midnight', 'exact-paper'])
    expect(document.body.textContent).toContain('来自 @acme/skins 1.0.0')
    expect(input('application').checked).toBe(true)
  })

  it('does not replace the reported selection when the backend refuses a change', async () => {
    let selected = 'exact-paper'
    const group = bindSkinGroup({
      scope: document,
      list: async () => ({ ...available, selected }),
      select: async (value) => {
        if (value === 'exact-midnight') throw new Error('conflict')
        selected = value
      },
    })
    await group.refresh()
    pick('exact-midnight')
    await vi.waitFor(() => expect(select().disabled).toBe(false))
    expect(input('exact-paper').checked).toBe(true)
    expect(document.body.textContent).toContain('无法保存皮肤选择')
    pick('')
    await vi.waitFor(() => expect(input('').checked).toBe(true))
  })

  it('shows an unavailable saved skin and lets the user choose a replacement', async () => {
    const group = bindSkinGroup({
      scope: document,
      list: async () => ({ ...available, selected: '', unavailable: true }),
      select: async () => undefined,
    })
    await group.refresh()
    expect(document.body.textContent).toContain('已选皮肤不可用')
    expect(select().disabled).toBe(false)
  })

  it('offers a retry if reading the backend fails', async () => {
    let fail = true
    const group = bindSkinGroup({
      scope: document,
      list: async () => {
        if (fail) throw new Error('offline')
        return available
      },
      select: async () => undefined,
    })
    await group.refresh()
    expect(select().disabled).toBe(true)
    expect(document.body.textContent).toContain('皮肤清单读取失败')
    fail = false
    document.querySelector<HTMLButtonElement>('#skin-option-items button')?.click()
    await vi.waitFor(() => expect(select().disabled).toBe(false))
    expect(inputs().map((entry) => entry.value)).toContain('exact-paper')
  })

  it('ignores a late roster after the pane unmounts', async () => {
    let resolve!: (value: typeof available) => void
    const promise = new Promise<typeof available>((done) => {
      resolve = done
    })
    const group = bindSkinGroup({ scope: document, list: () => promise, select: async () => undefined })
    const refresh = group.refresh()
    const retired = select().closest('fieldset')!
    unmount?.()
    document.body.replaceChildren()
    const before = retired.innerHTML
    resolve(available)
    await refresh
    expect(retired.innerHTML).toBe(before)
  })
})

describe('bindAppearance 语言组', () => {
  function mountLocale(): void {
    document.body.innerHTML = `
      <section data-i18n-aria="settings.appearance.language" aria-label="Language">
        <span data-i18n="settings.appearance.language">Language</span>
        <label><input type="radio" name="agnes-theme" value="system" /></label>
        <label><input type="radio" name="agnes-theme" value="light" /></label>
        <label><input type="radio" name="agnes-theme" value="dark" /></label>
        <label><input type="radio" name="agnes-locale" value="en" /></label>
        <label><input type="radio" name="agnes-locale" value="zh-CN" /></label>
      </section>
    `
  }
  const localeRadio = (value: string): HTMLInputElement => {
    const found = document.querySelector<HTMLInputElement>(`input[name="agnes-locale"][value="${value}"]`)
    if (!found) throw new Error(`missing locale radio ${value}`)
    return found
  }
  const pickLocale = (value: string): void => {
    const input = localeRadio(value)
    input.checked = true
    input.dispatchEvent(new Event('change'))
  }

  beforeEach(() => {
    mountLocale()
    document.documentElement.lang = 'en'
  })

  it('无选择时回填英文，并保持语言开关文案为英文', () => {
    let current: UiLocale = 'en'
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage(),
      locale: {
        current: () => current,
        select: (value) => {
          current = value
        },
        text: (key) => webLocaleCatalog[current]?.[key] ?? key,
      },
    })
    expect(localeRadio('en').checked).toBe(true)
    expect(localeRadio('zh-CN').checked).toBe(false)
    expect(document.querySelector('[data-i18n="settings.appearance.language"]')?.textContent).toBe('Language')
    expect(document.querySelector('section')?.getAttribute('aria-label')).toBe('Language')
  })

  it('切换到简体中文后回填语言开关文案', () => {
    let current: UiLocale = 'en'
    const onLocale = (): void => {
      syncLocaleRadios(document, current)
      applyLocaleText(document, (key) => webLocaleCatalog[current]?.[key] ?? key)
    }
    window.addEventListener('agnes:locale-changed', onLocale)
    try {
      bindAppearance({
        scope: document,
        root: document.documentElement,
        storage: fakeStorage(),
        locale: {
          current: () => current,
          select: (value) => {
            current = value
            document.documentElement.lang = value
            window.dispatchEvent(new CustomEvent('agnes:locale-changed'))
          },
          text: (key) => webLocaleCatalog[current]?.[key] ?? key,
        },
      })
      pickLocale('zh-CN')
      expect(current).toBe('zh-CN')
      expect(document.documentElement.lang).toBe('zh-CN')
      expect(document.querySelector('[data-i18n="settings.appearance.language"]')?.textContent).toBe('语言')
      expect(document.querySelector('section')?.getAttribute('aria-label')).toBe('语言')
      expect(localeRadio('zh-CN').checked).toBe(true)
    } finally {
      window.removeEventListener('agnes:locale-changed', onLocale)
    }
  })

  it('语言切换不改配色存储', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })
    document.documentElement.classList.add('dark')
    let current: UiLocale = 'en'
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage,
      locale: {
        current: () => current,
        select: (value) => {
          current = value
        },
        text: (key) => webLocaleCatalog[current]?.[key] ?? key,
      },
    })
    pickLocale('zh-CN')
    expect(storage.read(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(radio('dark').checked).toBe(true)
  })

  it('未选中的语言项派发 change 时被忽略', () => {
    let current: UiLocale = 'en'
    bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage(),
      locale: {
        current: () => current,
        select: (value) => {
          current = value
        },
        text: () => 'x',
      },
    })
    localeRadio('zh-CN').dispatchEvent(new Event('change'))
    expect(current).toBe('en')
  })
})

// The language picker reads the list of interface languages; nothing about a language is written
// into the page, so a new one needs no change here or in the settings markup.
describe('bindAppearance language picker', () => {
  it('lists every interface language in its own name, shows the current one and switches on change', () => {
    document.body.innerHTML = '<section><select id="locale-select"></select></section>'
    const select = document.querySelector<HTMLSelectElement>('#locale-select')
    if (!select) throw new Error('missing locale select')
    const unmount = mountSettingsSelectOptions(select)
    let current: UiLocale = 'zh-CN'
    const chosen: UiLocale[] = []
    const appearance = bindAppearance({
      scope: document,
      root: document.documentElement,
      storage: fakeStorage(),
      locale: {
        rendered: true,
        current: () => current,
        select: (value) => {
          current = value
          chosen.push(value)
        },
        text: (key) => key,
      },
    })
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual(
      UI_LOCALES.map((value) => [value, UI_LOCALE_NAMES[value]]),
    )
    expect(select.value).toBe('zh-CN')
    select.value = 'en'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(chosen).toEqual(['en'])
    // Another document changed the language: reopening the pane shows it.
    current = 'zh-CN'
    appearance.sync()
    expect(select.value).toBe('zh-CN')
    unmount()
  })
})
