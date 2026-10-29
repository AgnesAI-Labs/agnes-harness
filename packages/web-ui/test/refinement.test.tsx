/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebUiStyleSource } from '../../../tools/web-style-source.mjs'
import { mountRegion, PageHeader, Segmented, Select } from '../src/index.js'

const root = resolve(import.meta.dirname, '../../..')
const tokens = readFileSync(resolve(root, 'packages/web/public/styles/01-tokens.css'), 'utf8')
const refinement = readFileSync(resolve(root, 'packages/web-ui/src/refinement.css'), 'utf8')

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})
function render(element: Parameters<typeof mountRegion>[1]) {
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(mountRegion(host, element))
  return host
}
const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim()

describe('refinement tokens', () => {
  it('declares the System Settings type scale and page rhythm', () => {
    expect(token('--font-size-title')).toBe('1.625rem')
    expect(token('--font-weight-bold')).toBe('700')
    expect(token('--font-size-caption')).toBe('0.78125rem')
    expect(token('--space-section')).toBe('28px')
    expect(token('--row-min-height')).toBe('2.875rem')
  })

  it('keeps the 8/10/14/20 radius scale and gives controls native proportions', () => {
    expect(['sm', 'md', 'lg', 'xl'].map((step) => token(`--radius-${step}`))).toEqual([
      '8px',
      '10px',
      '14px',
      '20px',
    ])
    expect(token('--control-height')).toBe('1.75rem')
    expect(token('--switch-width')).toBe('2.375rem')
    expect(token('--switch-height')).toBe('1.375rem')
    expect(token('--icon-stroke')).toBe('1.5')
    expect(token('--icon-stroke-strong')).toBe('1.75')
  })

  it('keeps motion between 160ms and 320ms and exits shorter than entrances', () => {
    const durations = ['short', 'medium', 'long'].map((step) =>
      Number.parseInt(token(`--motion-${step}`)!, 10),
    )
    expect(durations).toEqual([160, 260, 320])
    expect(Number(token('--motion-exit'))).toBeLessThan(1)
    expect(token('--press-scale')).toBe('0.97')
  })

  it('draws hairlines on dense screens and continuous corners only where the engine supports them', () => {
    expect(token('--hairline')).toBe('1px')
    expect(tokens).toMatch(/@media \(min-resolution: 2dppx\) \{\s*:root \{\s*--hairline: 0\.5px;/)
    expect(token('--corner-shape')).toBe('round')
    expect(tokens).toMatch(/@supports \(corner-shape: squircle\) \{\s*:root \{\s*--corner-shape: squircle;/)
    // Outside the @supports block no rule asks for a squircle.
    const outside = refinement.replace(/@supports \(corner-shape: squircle\) \{[\s\S]*?\n {2}\}\n/, '')
    expect(outside).not.toContain('corner-shape')
  })

  it('does not tighten CJK titles', () => {
    expect(tokens).toMatch(/:root:lang\(zh\),[\s\S]*?--tracking-title: 0;/)
  })
})

describe('refinement stylesheet', () => {
  it('is composed last into the theme bridge asset, inside canonical layers', () => {
    const composed = readWebUiStyleSource(resolve(root, 'packages/web-ui/src/tokens.css'))
    expect(composed).not.toContain('@import')
    expect(composed.indexOf('.agh-segmented {')).toBeGreaterThan(composed.indexOf('.agh-btn--primary'))
    expect(composed.trimEnd().endsWith('}')).toBe(true)
  })

  it('reads tokens only: no colour value, so a skin override reaches every control', () => {
    const body = refinement.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(body).not.toContain('--agnes-color-')
    expect(body).not.toContain('--ant-color-primary:')
  })

  it('keeps translucency to menus and option lists', () => {
    const rules = [
      ...refinement.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*backdrop-filter:[^{}]*\}/g),
    ].map((match) => match[1]?.replace(/\s+/g, ' ').trim())
    expect(rules).toEqual(['.agh-menu-popup .agh-menu, .ant-select-dropdown'])
  })

  it('declares every animation and spring transition under prefers-reduced-motion: no-preference', () => {
    const start = refinement.indexOf('@media (prefers-reduced-motion: no-preference)')
    expect(start).toBeGreaterThan(-1)
    const before = refinement.slice(0, start).replace(/@keyframes [\s\S]*?\n {2}\}\n/g, '')
    expect(before).not.toMatch(/\banimation(-name)?:/)
    // Outside the gate only colour, shadow and the press ease are declared; nothing glows.
    expect(before).not.toMatch(/transition:[^;]*box-shadow[^;]*var\(--motion-(medium|long)\)/)
  })

  it('animates keyboard-opened menus and disclosures only for the pointer', () => {
    expect(refinement).not.toMatch(/:root\[data-agnes-input="pointer"\]\s*:is\([^)]*\.agnes-ui-popover/)
    expect(refinement).toContain('.agnes-ui-popover--pointer:is(')

    for (const surface of ['.agh-menu-popup', '.agh-disclosure', '.ant-tabs-tabpane-active']) {
      const rule = new RegExp(
        `:root\\[data-agnes-input="pointer"\\][^{]*${surface.replace('.', '\\.')}[^{]*\\{[^}]*animation`,
      )
      expect(refinement, surface).toMatch(rule)
    }
  })
})

describe('refined primitives', () => {
  it('renders a segmented control as one radio group whose picked segment follows the value', () => {
    const onChange = vi.fn()
    const host = render(
      createElement(Segmented, {
        label: 'Text size',
        value: 'standard',
        onChange,
        testId: 'size',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'standard', label: 'Standard' },
          { value: 'large', label: 'Large', disabled: true },
        ],
      }),
    )
    const group = host.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Text size')
    expect(group.getAttribute('data-testid')).toBe('size')
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.map((radio) => radio.checked)).toEqual([false, true, false])
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1)
    expect(radios[2]?.disabled).toBe(true)
    expect(group.querySelectorAll('.agh-segmented-thumb')).toHaveLength(1)
    expect(readFileSync(resolve(import.meta.dirname, '../src/refinement.css'), 'utf8')).toMatch(
      /@media \(max-width: 767px\) \{\s*\.agh-segmented > \.agh-segmented-option \{[^}]*min-height: var\(--control-height-touch\);/,
    )
    radios[1]?.focus()
    radios[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(radios[0])
    expect(onChange).toHaveBeenLastCalledWith('small')
    radios[0]?.click()
    expect(onChange).toHaveBeenCalledWith('small')
    // Controlled: the picked segment moves only when the caller passes the new value.
    expect(radios[1]?.checked).toBe(true)
  })

  it('renders a page header as a title, one description and its actions', () => {
    const host = render(
      createElement(PageHeader, {
        title: 'Plugins',
        description: 'Add capabilities to Agnes.',
        headingId: 'plugins-title',
        actions: createElement('span', { 'data-testid': 'action' }),
      }),
    )
    const heading = host.querySelector('h1.agh-page-title')!
    expect(heading.id).toBe('plugins-title')
    expect(heading.textContent).toBe('Plugins')
    expect(host.querySelector('.agh-page-description')?.textContent).toBe('Add capabilities to Agnes.')
    expect(host.querySelector('.agh-page-header-actions [data-testid="action"]')).toBeTruthy()
    expect(render(createElement(PageHeader, { title: 'Automation' })).querySelector('p')).toBeNull()
  })

  it('ends plain and searchable selects in the same neutral down-chevron', () => {
    const options = [{ value: 'a', label: 'A' }]
    const plain = render(createElement(Select, { options, value: 'a', 'aria-label': 'Language' }))
    expect(plain.querySelector('.agh-popup-chevrons')?.getAttribute('aria-hidden')).toBe('true')
    const searchable = render(createElement(Select, { options, value: 'a', showSearch: true }))
    expect(searchable.querySelector('.agh-popup-chevrons')?.getAttribute('aria-hidden')).toBe('true')
  })
})
