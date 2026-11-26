import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applySkinTokens, syncSkinSheet } from '../src/skin.js'

const skin = {
  tokens: { '--agnes-bg-page': { light: '#fff', dark: '#000' } },
}

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
    const applied = applySkinTokens(target, skin, 'dark', [])
    expect(target.style_.get('--agnes-bg-page')).toBe('#000')
    expect([...applied]).toEqual(['--agnes-bg-page'])
    const next = applySkinTokens(target, skin, 'light', applied)
    expect(target.style_.get('--agnes-bg-page')).toBe('#fff')
    expect(next).toEqual(applied)
  })
  it('removes exactly the properties it wrote before and nothing else', () => {
    const target = root()
    target.style_.set('--component-local', 'keep me')
    const applied = applySkinTokens(target, skin, 'dark', [])
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
  const sources = ['../../web/src/app/appearance-controller.ts', '../src/skin.ts'].map((path) => ({
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
    // The controller applies one sheet only after the current backend supplies an exact selection.
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
    expect(created.read()).toBe('@layer skin {\na{}\n}')
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
    expect(second.read()).toBe('@layer skin {\nb{}\n}')
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
describe('skin token names', () => {
  it('never writes a non-custom property from reported tokens', () => {
    const written = new Map<string, string>()
    const target = {
      style: {
        setProperty: (name: string, value: string) => void written.set(name, value),
        removeProperty: (name: string) => void written.delete(name),
      },
    }
    const tampered = {
      tokens: {
        display: { light: 'none', dark: 'none' },
        '--agnes-bg-page': { light: '#fff', dark: '#000' },
      },
    }
    expect([...applySkinTokens(target, tampered, 'light', [])]).toEqual(['--agnes-bg-page'])
    expect(written.has('display')).toBe(false)
  })
})
