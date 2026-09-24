import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applySkinTokens,
  cacheSkinEntry,
  clearSkinCache,
  fetchSkinCss,
  planSkinReconcile,
  readSkinCache,
  SKIN_CACHE_VERSION,
  SKIN_NONE,
  SKIN_STORAGE_KEY,
  type SkinCache,
  type SkinRosterEntry,
  selectedSkin,
  skinOverride,
  syncSkinSheet,
  writeSkinCache,
} from '../src/skin.js'

function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    raw: store,
  }
}

const cache: SkinCache = {
  version: SKIN_CACHE_VERSION,
  id: 'midnight',
  revision: 'sha256-abc',
  css: '[data-agnes-region="app"] { background: #000; }',
  tokens: { '--agnes-bg-page': { light: '#fff', dark: '#000' } },
}

describe('skin cache', () => {
  it('round-trips a cache and clears it', () => {
    const storage = memory()
    expect(readSkinCache(storage)).toBeNull()
    writeSkinCache(storage, cache)
    expect(readSkinCache(storage)).toEqual(cache)
    clearSkinCache(storage)
    expect(readSkinCache(storage)).toBeNull()
  })
  it('treats a damaged, stale or malformed cache as no skin instead of guessing', () => {
    for (const value of [
      'not json',
      JSON.stringify({ ...cache, version: SKIN_CACHE_VERSION + 1 }),
      JSON.stringify({ ...cache, id: 'Light' }),
      JSON.stringify({ ...cache, id: '' }),
      JSON.stringify({ ...cache, revision: 7 }),
      JSON.stringify({ ...cache, css: null }),
      JSON.stringify({ ...cache, tokens: { '--a': { light: '#fff' } } }),
      JSON.stringify({ ...cache, tokens: { '--a': { light: '', dark: '#000' } } }),
      JSON.stringify({ ...cache, tokens: ['--a'] }),
      JSON.stringify([cache]),
      JSON.stringify(null),
    ])
      expect(readSkinCache(memory({ [SKIN_STORAGE_KEY]: value })), value).toBeNull()
  })
  it('degrades quietly when storage refuses to read or write', () => {
    const hostile = {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('quota')
      },
    }
    expect(readSkinCache(hostile)).toBeNull()
    expect(() => writeSkinCache(hostile, cache)).not.toThrow()
    expect(() => clearSkinCache(hostile)).not.toThrow()
  })
})

describe('skin one-shot override', () => {
  it('recognises only none and well-formed ids, ignoring everything else', () => {
    expect(skinOverride('?skin=none')).toBe(SKIN_NONE)
    expect(skinOverride('skin=none')).toBe(SKIN_NONE)
    expect(skinOverride('?skin=midnight')).toBe('midnight')
    expect(skinOverride('?skin=midnight&other=1')).toBe('midnight')
    expect(skinOverride('?skin=solarized-light')).toBe('solarized-light')
    // A typo must fall back to the stored choice rather than silently switching skins off.
    for (const search of ['', '?other=1', '?skin=', '?skin=Light', '?skin=--x', '?skin=a b'])
      expect(skinOverride(search), search).toBeNull()
  })
  it('lets the override win over the cache, including forcing the built-in look', () => {
    expect(selectedSkin(cache, null)).toBe(cache)
    expect(selectedSkin(cache, SKIN_NONE)).toBeNull()
    expect(selectedSkin(cache, 'midnight')).toBe(cache)
    // Forcing an id that is not the cached skin cannot materialise it at first paint.
    expect(selectedSkin(cache, 'aurora')).toBeNull()
    expect(selectedSkin(null, 'midnight')).toBeNull()
    expect(selectedSkin(null, null)).toBeNull()
  })
})

describe('skin token application', () => {
  const root = () => {
    const style = new Map<string, string>()
    return {
      style: {
        setProperty: (name: string, value: string) => void style.set(name, value),
        removeProperty: (name: string) => void style.delete(name),
      },
      style_: style,
    }
  }

  it('writes the mode-specific value and reports what it wrote', () => {
    const target = root()
    const applied = applySkinTokens(target, cache, 'dark', [])
    expect(target.style_.get('--agnes-bg-page')).toBe('#000')
    expect([...applied]).toEqual(['--agnes-bg-page'])
    const next = applySkinTokens(target, cache, 'light', applied)
    expect(target.style_.get('--agnes-bg-page')).toBe('#fff')
    expect(next).toEqual(applied)
  })
  it('removes exactly the properties it wrote before and nothing else', () => {
    const target = root()
    target.style_.set('--component-local', 'keep me')
    const applied = applySkinTokens(target, cache, 'dark', [])
    // A skin that now carries no tokens must clear its own leftovers only.
    const cleared = applySkinTokens(target, null, 'dark', applied)
    expect(cleared.size).toBe(0)
    expect(target.style_.has('--agnes-bg-page')).toBe(false)
    expect(target.style_.get('--component-local')).toBe('keep me')
  })
  it('never removes a property it was not told about', () => {
    const target = root()
    target.style_.set('--someone-else', 'value')
    applySkinTokens(target, null, 'dark', ['--never-written'])
    expect(target.style_.get('--someone-else')).toBe('value')
    expect(target.style_.has('--never-written')).toBe(false)
  })
})

// The page CSP is `style-src 'self'` with no `unsafe-inline`, so an injected <style> element is
// blocked and its rules never apply — the CSP spike's negative control proved exactly that. This
// guards the choice rather than the symptom: a future edit that switches to injection would look
// correct in review and fail silently in the browser.
describe('first paint stays inside the page CSP', () => {
  const sources = ['../src/theme-boot.ts', '../src/skin.ts'].map((path) => ({
    path,
    text: readFileSync(new URL(path, import.meta.url), 'utf8'),
  }))
  it('never builds a <style> element or writes a style attribute', () => {
    for (const { path, text } of sources)
      for (const forbidden of [
        /createElement\(\s*['"]style['"]\s*\)/,
        /setAttribute\(\s*['"]style['"]/,
        /insertRule\s*\(/,
        /document\.write\s*\(/,
      ])
        expect(text, `${path} must not match ${String(forbidden)}`).not.toMatch(forbidden)
  })
  it('never references a data: URI, which the same policy refuses for images', () => {
    for (const { path, text } of sources) expect(text, path).not.toMatch(/['"]data:/)
  })
  it('adopts the stylesheet through the constructible-sheet API instead', () => {
    const [boot = '', skin = ''] = sources.map((source) => source.text)
    // The sheet mechanics live in skin.ts; theme-boot only decides when to call them.
    expect(skin).toContain('adoptedStyleSheets')
    expect(skin).toContain('replaceSync')
    expect(skin).toContain('CSSStyleSheet')
    expect(boot).toContain('syncSkinSheet')
  })
})

// Turning a skin off, or switching to a skin whose stylesheet the host did not inline, used to
// leave the previous sheet adopted: the tokens moved on while the old skin kept painting. These
// cases pin the ownership rule directly, without needing a CSS engine.
describe('skin stylesheet ownership', () => {
  const host = (): { adoptedStyleSheets: CSSStyleSheet[] } => ({ adoptedStyleSheets: [] })
  const fakeSheet = (): { sheet: CSSStyleSheet; read(): string } => {
    const state = { text: '' }
    const sheet = {
      replaceSync(css: string) {
        state.text = css
      },
    } as unknown as CSSStyleSheet
    return { sheet, read: () => state.text }
  }

  it('adopts exactly one sheet and fills it before anything else can see it', () => {
    const target = host()
    const created = fakeSheet()
    const next = syncSkinSheet(target, { sheet: undefined, css: undefined }, 'a{}', () => created.sheet)
    expect(target.adoptedStyleSheets).toEqual([created.sheet])
    expect(created.read()).toBe('a{}')
    expect(next).toEqual({ sheet: created.sheet, css: 'a{}' })
  })

  it('replaces its own sheet on change and never disturbs a foreign one', () => {
    const foreign = fakeSheet().sheet
    const target = { adoptedStyleSheets: [foreign] }
    const first = fakeSheet()
    let state = syncSkinSheet(target, { sheet: undefined, css: undefined }, 'a{}', () => first.sheet)
    const second = fakeSheet()
    state = syncSkinSheet(target, state, 'b{}', () => second.sheet)
    expect(target.adoptedStyleSheets).toEqual([foreign, second.sheet])
    expect(second.read()).toBe('b{}')
    expect(state.sheet).toBe(second.sheet)
  })

  it('removes its own sheet when the skin is turned off, and stays off', () => {
    const foreign = fakeSheet().sheet
    const target = { adoptedStyleSheets: [foreign] }
    const mine = fakeSheet()
    const refuse = (): CSSStyleSheet => {
      throw new Error('must not create a sheet while no skin is selected')
    }
    let state = syncSkinSheet(target, { sheet: undefined, css: undefined }, 'a{}', () => mine.sheet)
    state = syncSkinSheet(target, state, '', refuse)
    expect(target.adoptedStyleSheets).toEqual([foreign])
    expect(state).toEqual({ sheet: undefined, css: '' })
    // Idempotent: staying off must not re-adopt anything.
    expect(syncSkinSheet(target, state, '', refuse)).toBe(state)
    expect(target.adoptedStyleSheets).toEqual([foreign])
  })

  it('keeps the previous sheet when the engine refuses the new stylesheet', () => {
    const target = host()
    const first = fakeSheet()
    const state = syncSkinSheet(target, { sheet: undefined, css: undefined }, 'a{}', () => first.sheet)
    const refused = {
      replaceSync: () => {
        throw new Error('refused')
      },
    } as unknown as CSSStyleSheet
    expect(() => syncSkinSheet(target, state, 'bad{}', () => refused)).toThrow('refused')
    expect(target.adoptedStyleSheets).toEqual([first.sheet])
  })
})

const rosterEntry = (over: Partial<SkinRosterEntry> = {}): SkinRosterEntry => ({
  id: 'midnight',
  name: '午夜',
  packageName: '@acme/skins',
  revision: 'sha256-abc',
  cssUrl: '/skins/midnight/skin.css',
  css: 'a{}',
  tokens: {},
  ...over,
})

describe('skin roster reconciliation', () => {
  it('keeps a matching cache and does nothing at all without one', () => {
    expect(planSkinReconcile(null, [rosterEntry()])).toEqual({ kind: 'keep' })
    expect(planSkinReconcile(cache, [rosterEntry()])).toEqual({ kind: 'keep' })
  })
  it('clears a skin whose source was uninstalled or disabled', () => {
    expect(planSkinReconcile(cache, [rosterEntry({ id: 'aurora' })])).toEqual({ kind: 'clear' })
    expect(planSkinReconcile(cache, [])).toEqual({ kind: 'clear' })
  })
  it('refreshes a skin whose roster digest moved', () => {
    const moved = rosterEntry({ revision: 'sha256-def' })
    expect(planSkinReconcile(cache, [moved])).toEqual({ kind: 'refresh', entry: moved })
  })
})

describe('skin stylesheet fallback', () => {
  const origin = 'http://127.0.0.1:4177'
  const stub = (response: { ok: boolean; body?: string }) => {
    const calls: string[] = []
    return {
      calls,
      fetcher: async (input: string) => {
        calls.push(input)
        return { ok: response.ok, text: async () => response.body ?? '' }
      },
    }
  }

  it('fetches a same-origin skin route by path, dropping any query the roster carried', async () => {
    const { calls, fetcher } = stub({ ok: true, body: 'a{}' })
    await expect(fetchSkinCss('/skins/midnight/skin.css?v=2#x', { fetcher, origin })).resolves.toBe('a{}')
    expect(calls).toEqual(['/skins/midnight/skin.css'])
  })

  it('refuses an off-origin or out-of-namespace reference before any request is made', async () => {
    const { calls, fetcher } = stub({ ok: true, body: 'a{}' })
    for (const url of [
      'https://evil.example/x.css',
      '//evil.example/x.css',
      '/app.js',
      '/other/skin.css',
      'skin.css',
    ])
      await expect(fetchSkinCss(url, { fetcher, origin }), url).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('treats a failed or empty response as no stylesheet, so no half cache is written', async () => {
    for (const response of [
      { ok: false, body: 'a{}' },
      { ok: true, body: '' },
    ])
      await expect(
        fetchSkinCss('/skins/midnight/skin.css', { fetcher: stub(response).fetcher, origin }),
      ).rejects.toThrow()
  })
})

// The selection path: a roster row the host did not inline must still end up with real CSS in the
// cache. Writing `css: ''` here is what made such a skin look selected but paint nothing.
describe('caching one selected skin', () => {
  const origin = 'http://127.0.0.1:4177'
  const fetched = (body: string, ok = true) => {
    const calls: string[] = []
    return {
      calls,
      fetcher: async (input: string) => {
        calls.push(input)
        return { ok, text: async () => body }
      },
    }
  }

  it('uses the inlined text when the roster carried it, without any request', async () => {
    const storage = memory()
    const { calls, fetcher } = fetched('from-network{}')
    const cached = await cacheSkinEntry(storage, rosterEntry({ css: 'inlined{}' }), { fetcher, origin })
    expect(cached.css).toBe('inlined{}')
    expect(readSkinCache(storage)).toEqual(cached)
    expect(calls).toEqual([])
  })

  it('falls back to cssUrl when the roster omitted the text', async () => {
    const storage = memory()
    const { calls, fetcher } = fetched('fetched{}')
    const { css: _inlined, ...entry } = rosterEntry()
    const cached = await cacheSkinEntry(storage, entry, { fetcher, origin })
    expect(calls).toEqual(['/skins/midnight/skin.css'])
    expect(cached.css).toBe('fetched{}')
    expect(readSkinCache(storage)).toEqual(cached)
  })

  it('writes nothing at all when the stylesheet cannot be fetched', async () => {
    const storage = memory()
    const { fetcher } = fetched('', false)
    const { css: _inlined, ...entry } = rosterEntry()
    await expect(cacheSkinEntry(storage, entry, { fetcher, origin })).rejects.toThrow()
    expect(readSkinCache(storage)).toBeNull()
  })
})
