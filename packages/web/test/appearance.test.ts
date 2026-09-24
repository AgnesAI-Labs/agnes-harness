/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest'
import { bindAppearance, bindSkinGroup } from '../src/appearance.js'
import { SKIN_CACHE_VERSION, SKIN_STORAGE_KEY } from '../src/skin.js'
import { FONT_SCALE_STORAGE_KEY, THEME_STORAGE_KEY } from '../src/theme.js'

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
    bindAppearance({ scope: document, root: document.documentElement, storage: fakeStorage() })
    expect(fontRadio('normal').checked).toBe(true)
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

// The skin group is the only writer of the `agnes-skin` cache: without it a selected skin can never
// reach first paint. These cases pin what the user sees and, more importantly, that a failed
// selection leaves no fake checked state behind.
describe('bindSkinGroup', () => {
  const skins = [
    { id: 'midnight', name: '午夜', packageName: '@acme/skins' },
    { id: 'paper', name: '纸质', packageName: '@acme/skins' },
  ]
  const cached = (id: string): Record<string, string> => ({
    [SKIN_STORAGE_KEY]: JSON.stringify({
      version: SKIN_CACHE_VERSION,
      id,
      revision: 'sha256-x',
      css: '.a{}',
      tokens: {},
    }),
  })
  function mountSkin(): void {
    document.body.innerHTML = '<fieldset><div id="skin-option-items"></div></fieldset>'
  }
  const inputs = (): HTMLInputElement[] => [
    ...document.querySelectorAll<HTMLInputElement>('input[name="agnes-skin"]'),
  ]
  const input = (value: string): HTMLInputElement => {
    const found = inputs().find((candidate) => candidate.value === value)
    if (!found) throw new Error(`missing skin radio ${value}`)
    return found
  }
  const pick = (value: string): void => {
    const target = input(value)
    target.checked = true
    target.dispatchEvent(new Event('change'))
  }

  beforeEach(mountSkin)

  it('renders the built-in default plus every installed skin, with its source package', async () => {
    const group = bindSkinGroup({
      scope: document,
      storage: fakeStorage(),
      list: async () => skins,
      select: () => undefined,
    })
    await group.refresh()
    expect(inputs().map((entry) => entry.value)).toEqual(['', 'midnight', 'paper'])
    expect(document.body.textContent).toContain('午夜')
    expect(document.body.textContent).toContain('来自 @acme/skins')
    expect(input('').checked).toBe(true)
  })
  it('back-fills the cached choice and reports it without refetching', async () => {
    let calls = 0
    const group = bindSkinGroup({
      scope: document,
      storage: fakeStorage(cached('paper')),
      list: async () => {
        calls += 1
        return skins
      },
      select: () => undefined,
    })
    await group.refresh()
    expect(input('paper').checked).toBe(true)
    expect(input('').checked).toBe(false)
    group.sync()
    expect(calls).toBe(1)
  })
  it('selects a skin, and the default selects no skin at all', async () => {
    const chosen: Array<string | null> = []
    const group = bindSkinGroup({
      scope: document,
      storage: fakeStorage(),
      list: async () => skins,
      select: (id) => void chosen.push(id),
    })
    await group.refresh()
    pick('midnight')
    pick('')
    expect(chosen).toEqual(['midnight', null])
  })
  it('keeps the previous choice when applying a new one fails, and says so', async () => {
    let reject = true
    const group = bindSkinGroup({
      scope: document,
      storage: fakeStorage(cached('paper')),
      list: async () => skins,
      select: (id) => (id === 'midnight' && reject ? Promise.reject(new Error('fetch failed')) : undefined),
    })
    await group.refresh()
    expect(input('paper').checked).toBe(true)
    pick('midnight')
    await Promise.resolve()
    await Promise.resolve()
    // The failed selection must not leave a checked radio that no skin backs.
    expect(input('paper').checked).toBe(true)
    expect(input('midnight').checked).toBe(false)
    // Nor may it fail silently: the user has to learn why the radio snapped back (design §8).
    expect(document.body.textContent).toContain('这份皮肤没有生效，已保留原选择。')
    // A later successful selection clears the message again.
    reject = false
    pick('midnight')
    await Promise.resolve()
    await Promise.resolve()
    expect(input('midnight').checked).toBe(true)
    expect(document.body.textContent).not.toContain('这份皮肤没有生效')
  })
  it('shows a visible failure with a retry instead of pretending there are no skins', async () => {
    let attempts = 0
    const group = bindSkinGroup({
      scope: document,
      storage: fakeStorage(),
      list: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('offline')
        return skins
      },
      select: () => undefined,
    })
    await group.refresh()
    expect(inputs()).toHaveLength(0)
    expect(document.body.textContent).toContain('皮肤清单读取失败')
    const retry = document.querySelector('button')
    expect(retry).not.toBeNull()
    retry?.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(inputs().map((entry) => entry.value)).toEqual(['', 'midnight', 'paper'])
  })
})
