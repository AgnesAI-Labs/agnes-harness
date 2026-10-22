/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { ApplicationState } from '@agnes/protocol'
import { LocaleService } from '@agnes/web-client'
import { SKIN_STORAGE_KEY } from '@agnes/web-foundation/skin'
import { createRegionRenderer, SettingsOptionSelect } from '@agnes/web-ui'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppearanceController } from '../src/app/appearance-controller.js'
import { projectApplication } from '../src/application.js'
import '../src/theme-boot.js'

const app: ApplicationState = {
  revision: 1,
  status: 'active',
  assets: {},
  candidates: [],
  selection: {
    packageId: 'a',
    applicationId: 'a',
    integrity: 'a',
    declarationDigest: 'a'.repeat(64),
    consentDigest: 'b'.repeat(64),
    bindingDigest: 'c'.repeat(64),
  },
  effective: { id: 'a', presentation: { skin: 'acme' } },
}
const row = {
  id: 'acme',
  name: 'Acme',
  packageName: 'a',
  cssUrl: '/skins/acme/skin.css',
  css: 'body { --application-test: 1 }',
  tokens: { '--agnes-brand-primary': { light: '#123456', dark: '#654321' } },
}
const stops: (() => void)[] = []
afterEach(() => {
  projectApplication(undefined)
  window.dispatchEvent(new Event('pagehide'))
  for (const off of stops.splice(0)) off()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  document.body.replaceChildren()
  history.replaceState({}, '', '/')
})
async function controller(skins = [row] as (Omit<typeof row, 'css'> & { css?: string })[]) {
  document.body.innerHTML = '<div id="skin-option-items"></div><div id="select-host"></div>'
  const host = document.getElementById('select-host')
  if (!host) throw new Error('missing host')
  const root = createRegionRenderer(host)
  await act(async () => root.render(<SettingsOptionSelect id="skin-select" />))
  stops.push(() => root.unmount())
  localStorage.setItem('agnes-theme', 'light')
  const ctx = new Context()
  stops.push(() => {
    void ctx.fiber.dispose()
  })
  return createAppearanceController({
    locale: new LocaleService(ctx, 'en'),
    profile: () => 'local-dev',
    listSkins: async () => ({ revision: 'one', skins }),
  })
}
it.each(['skin-first', 'application-first', 'runtime-ready'])(
  'applies and synchronously revokes application CSS/tokens with %s arrival',
  async (order) => {
    const css = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync')
    if (order === 'application-first') projectApplication(app)
    const available = order === 'runtime-ready' ? [] : [row]
    const c = await controller(available)
    const frameworkSheets = [...document.adoptedStyleSheets]
    await c.skins.refresh()
    if (order !== 'application-first') projectApplication(app)
    if (order === 'runtime-ready') {
      expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
      available.push(row)
      window.dispatchEvent(new CustomEvent('agnes:plugins-invalidated'))
      await vi.waitFor(() =>
        expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#123456'),
      )
    }
    expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#123456')
    expect(css).toHaveBeenCalledWith(expect.stringContaining(row.css))
    projectApplication({ ...app, status: 'unresolved', effective: null, reason: 'disabled' })
    expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
    expect(document.adoptedStyleSheets).toEqual(frameworkSheets)
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBeNull()
  },
)
it('ignores late application CSS after revoke while preserving the explicit user skin', async () => {
  let finish: ((response: Response) => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  const { css: _css, ...remote } = row
  const c = await controller([remote])
  const frameworkSheets = [...document.adoptedStyleSheets]
  await c.skins.refresh()
  projectApplication(app)
  expect(finish).toBeDefined()
  localStorage.setItem('agnes-skin-preference', 'user')
  localStorage.setItem(
    SKIN_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      id: 'user',
      revision: 'one',
      css: '',
      tokens: { '--agnes-brand-primary': { light: '#abcdef', dark: '#abcdef' } },
    }),
  )
  projectApplication({ ...app, status: 'unresolved', effective: null })
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#abcdef')
  await act(async () => {
    finish?.(new Response('body { --late-application-css: 1 }', { headers: { 'Content-Type': 'text/css' } }))
  })
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#abcdef')
  expect(document.adoptedStyleSheets).toEqual(frameworkSheets)
  expect(localStorage.getItem('agnes-skin-preference')).toBe('user')
})

it('keeps the chosen skin across a missing roster and restores it when the skin returns', async () => {
  const available = [row]
  const c = await controller(available)
  await c.skins.refresh()
  const select = document.getElementById('skin-select') as HTMLSelectElement
  await act(async () => {
    select.value = 'acme'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await vi.waitFor(() => expect(localStorage.getItem('agnes-skin-preference')).toBe('acme'))
  const painted = () => document.documentElement.style.getPropertyValue('--agnes-brand-primary')
  expect(painted()).toBe('#123456')
  // Generation swap or truly removed: the roster has no skin. Display falls back, the choice stays.
  available.length = 0
  await c.skins.refresh()
  expect(painted()).toBe('')
  expect(localStorage.getItem('agnes-skin-preference')).toBe('acme')
  // The skin is present again: applied again without the user doing anything.
  available.push(row)
  window.dispatchEvent(new CustomEvent('agnes:plugins-invalidated'))
  await vi.waitFor(() => expect(painted()).toBe('#123456'))
  expect(localStorage.getItem('agnes-skin-preference')).toBe('acme')
  expect(JSON.parse(localStorage.getItem(SKIN_STORAGE_KEY) ?? '{}').id).toBe('acme')
})
it('does not bring a skin back after the user chose the built-in look', async () => {
  const available = [row]
  const c = await controller(available)
  await c.skins.refresh()
  const select = document.getElementById('skin-select') as HTMLSelectElement
  for (const value of ['acme', '']) {
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  await vi.waitFor(() => expect(localStorage.getItem('agnes-skin-preference')).toBe('none'))
  await c.skins.refresh()
  expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBeNull()
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
})
