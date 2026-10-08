import { describe, expect, it } from 'vitest'
import {
  applyFontScale,
  applyTheme,
  FONT_SCALE_STORAGE_KEY,
  isFontScale,
  isThemePreference,
  readFontScale,
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  watchSystemTheme,
  writeFontScale,
  writeThemePreference,
} from '../src/theme.js'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    read: (key: string): string | undefined => map.get(key),
  }
}

function fakeRoot() {
  const classes = new Set<string>()
  return {
    classList: {
      toggle: (name: string, force?: boolean): void => {
        if (force === true) classes.add(name)
        else classes.delete(name)
      },
    },
    has: (name: string): boolean => classes.has(name),
  }
}

function fakeMediaQuery(matches: boolean) {
  const listeners = new Set<() => void>()
  return {
    query: {
      matches,
      addEventListener: (_type: string, listener: () => void): void => void listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void): void => void listeners.delete(listener),
    },
    /** 模拟系统在运行中切换深浅色。 */
    fire: (): void => {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: (): number => listeners.size,
  }
}

const withMatchMedia = (query: unknown) => ({ matchMedia: () => query })

describe('readThemePreference', () => {
  it('缺失时回落 system', () => {
    expect(readThemePreference(fakeStorage())).toBe('system')
  })

  it('读取合法值', () => {
    expect(readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
    expect(readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light')
    expect(readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: 'system' }))).toBe('system')
  })

  it.each(['DARK', '', 'null', 'auto', '  dark  '])('非法值 %j 回落 system', (raw) => {
    expect(readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: raw }))).toBe('system')
  })

  it('存储读取抛异常时不冒泡，回落 system', () => {
    const hostile = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
    }
    expect(readThemePreference(hostile)).toBe('system')
  })
})

describe('writeThemePreference', () => {
  it('写入偏好', () => {
    const storage = fakeStorage()
    writeThemePreference(storage, 'dark')
    expect(storage.read(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('写入抛异常时不冒泡', () => {
    const hostile = {
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => writeThemePreference(hostile, 'dark')).not.toThrow()
  })
})

describe('resolveTheme', () => {
  it.each([
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
  ] as const)('%s + prefersDark=%s → %s', (preference, prefersDark, expected) => {
    expect(resolveTheme(preference, prefersDark)).toBe(expected)
  })
})

describe('applyTheme', () => {
  it('加/去 dark 类', () => {
    const root = fakeRoot()
    applyTheme(root, 'dark')
    expect(root.has('dark')).toBe(true)
    applyTheme(root, 'light')
    expect(root.has('dark')).toBe(false)
  })
})

describe('isThemePreference', () => {
  it.each([
    ['system', true],
    ['light', true],
    ['dark', true],
    ['Dark', false],
    ['', false],
  ])('%j → %s', (value, expected) => {
    expect(isThemePreference(value)).toBe(expected)
  })

  it('非字符串一律 false', () => {
    expect(isThemePreference(null)).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
    expect(isThemePreference(1)).toBe(false)
  })
})

describe('systemPrefersDark', () => {
  it('matchMedia 不可用时按浅色处理', () => {
    expect(systemPrefersDark({})).toBe(false)
  })

  it('返回 matchMedia 的结果', () => {
    expect(systemPrefersDark(withMatchMedia(fakeMediaQuery(true).query))).toBe(true)
    expect(systemPrefersDark(withMatchMedia(fakeMediaQuery(false).query))).toBe(false)
  })
})

describe('watchSystemTheme', () => {
  it('matchMedia 不可用时返回空操作且不抛', () => {
    const off = watchSystemTheme({}, () => undefined)
    expect(() => off()).not.toThrow()
  })

  it('订阅后系统变化触发回调', () => {
    const media = fakeMediaQuery(false)
    let calls = 0
    watchSystemTheme(withMatchMedia(media.query), () => {
      calls++
    })
    expect(media.listenerCount()).toBe(1)
    media.fire()
    expect(calls).toBe(1)
    media.fire()
    expect(calls).toBe(2)
  })

  it('解绑后系统变化不再触发回调', () => {
    const media = fakeMediaQuery(false)
    let calls = 0
    const off = watchSystemTheme(withMatchMedia(media.query), () => {
      calls++
    })
    off()
    expect(media.listenerCount()).toBe(0)
    media.fire()
    expect(calls).toBe(0)
  })
})

describe('safeThemeStorage', () => {
  it('localStorage 属性访问抛异常时退化成空实现', () => {
    const hostile = {
      get localStorage(): never {
        throw new Error('SecurityError')
      },
    }
    const storage = safeThemeStorage(hostile)
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(() => storage.setItem(THEME_STORAGE_KEY, 'dark')).not.toThrow()
  })

  it('不可用对象（缺少方法）时退化成空实现', () => {
    expect(safeThemeStorage({ localStorage: {} }).getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('正常时透传底层存储', () => {
    const inner = fakeStorage()
    const storage = safeThemeStorage({ localStorage: inner })
    storage.setItem(THEME_STORAGE_KEY, 'light')
    expect(inner.read(THEME_STORAGE_KEY)).toBe('light')
  })
})

describe('字号偏好', () => {
  it('缺失时回落 normal', () => {
    expect(readFontScale(fakeStorage())).toBe('normal')
  })

  it('读取合法值', () => {
    expect(readFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: 'large' }))).toBe('large')
    expect(readFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: 'small' }))).toBe('small')
  })

  it.each(['LARGE', '', 'huge', '1.5'])('非法值 %j 回落 normal', (raw) => {
    expect(readFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: raw }))).toBe('normal')
  })

  it('存储读取抛异常时不冒泡', () => {
    const hostile = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
    }
    expect(readFontScale(hostile)).toBe('normal')
  })

  it('写入抛异常时不冒泡', () => {
    const hostile = {
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => writeFontScale(hostile, 'large')).not.toThrow()
  })

  it('应用到根元素：三档各自落到对应百分比', () => {
    const root = { style: { fontSize: '' } }
    applyFontScale(root, 'small')
    expect(root.style.fontSize).toBe('87.5%')
    applyFontScale(root, 'normal')
    expect(root.style.fontSize).toBe('100%')
    applyFontScale(root, 'large')
    expect(root.style.fontSize).toBe('112.5%')
  })

  it('isFontScale 拒绝非字符串', () => {
    expect(isFontScale(null)).toBe(false)
    expect(isFontScale(2)).toBe(false)
  })
})
