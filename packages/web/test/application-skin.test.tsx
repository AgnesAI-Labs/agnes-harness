/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { ApplicationState, SkinChoice, SkinListResult } from '@agnes/protocol'
import { LocaleService } from '@agnes/web-client'
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
const bindingDigest = 'd'.repeat(64)
const row = { id: 'acme', name: 'Acme', packageId: 'a', version: '1.0.0', bindingDigest }
const cssUrl = `/skins/${bindingDigest}/acme/skin.css`
const selected = {
  id: row.id,
  kind: 'application',
  bindingDigest,
  cssUrl,
  css: 'body { background-image: url("assets/paper.webp"); list-style-image: url("/skins/acme/assets/old.webp") }',
  tokens: { '--agnes-brand-primary': { light: '#123456', dark: '#654321' } },
} satisfies NonNullable<SkinListResult['selected']>
const roster: SkinListResult = {
  profile: 'local-dev',
  revision: 1,
  choice: { kind: 'application' },
  skins: [row],
  selected: null,
}
const painted = () => document.documentElement.style.getPropertyValue('--agnes-brand-primary')
const stops: (() => void)[] = []
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  projectApplication(undefined)
  for (const off of stops.splice(0)) off()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  document.body.replaceChildren()
  history.replaceState({}, '', '/')
})
async function controller(
  listSkins: () => Promise<unknown>,
  options: {
    backendIdentity?(): string
    selectSkin?(
      profile: string,
      revision: number,
      choice: SkinChoice,
      isCurrent: () => boolean,
    ): Promise<void>
  } = {},
) {
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
    backendIdentity: options.backendIdentity ?? (() => 'local'),
    listSkins,
    selectSkin: options.selectSkin ?? (async () => undefined),
  })
}

it('paints only a daemon-selected application skin and clears it synchronously when adoption changes', async () => {
  const css = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync')
  let current = roster
  const c = await controller(async () => current)
  const framework = [...document.adoptedStyleSheets]
  await c.skins.refresh()
  expect(painted()).toBe('')
  current = { ...roster, selected }
  projectApplication(app)
  await vi.waitFor(() => expect(painted()).toBe('#123456'))
  expect(css).toHaveBeenCalledWith(expect.stringContaining(`/skins/${bindingDigest}/acme/assets/paper.webp`))
  expect(css).toHaveBeenCalledWith(expect.stringContaining(`/skins/${bindingDigest}/acme/assets/old.webp`))
  localStorage.setItem('agnes-theme', 'dark')
  window.dispatchEvent(new Event('agnes:theme-changed'))
  expect(painted()).toBe('#654321')
  current = { ...roster, selected: null }
  projectApplication({ ...app, status: 'unresolved', effective: null, reason: 'disabled' })
  expect(painted()).toBe('')
  expect(document.adoptedStyleSheets).toEqual(framework)
  expect(localStorage.getItem('agnes-skin')).toBeNull()
})

it('discards a late skin reply after switching backends', async () => {
  let backend = 'A'
  let resolve!: (value: SkinListResult) => void
  const promise = new Promise<SkinListResult>((done) => {
    resolve = done
  })
  const c = await controller(async () => (backend === 'A' ? promise : roster), {
    backendIdentity: () => backend,
  })
  const old = c.skins.refresh()
  backend = 'B'
  c.skins.invalidate()
  await c.skins.refresh()
  resolve({ ...roster, selected })
  await old
  expect(painted()).toBe('')
})

it('ignores old browser data, bare URL IDs and an old protocol response', async () => {
  history.replaceState({}, '', '/?skin=acme')
  localStorage.setItem('agnes-skin-preference', 'acme')
  const stale = { ...selected, css: 'body { --stale-skin-test: 1 }' }
  localStorage.setItem(
    'agnes-skin',
    JSON.stringify({
      version: 1,
      id: stale.id,
      revision: 'old',
      css: stale.css,
      tokens: stale.tokens,
    }),
  )
  let current: unknown = roster
  const css = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync')
  const c = await controller(async () => current)
  const frameworkSheets = [...document.adoptedStyleSheets]
  await c.skins.refresh()
  expect(painted()).toBe('')
  current = { revision: 'old', skins: [{ ...row, ...stale }] }
  await c.skins.refresh()
  expect(painted()).toBe('')
  expect(document.adoptedStyleSheets).toEqual(frameworkSheets)
  expect(css).not.toHaveBeenCalledWith(expect.stringContaining('--stale-skin-test'))
})

it.each(['query', 'legacy'] as const)('keeps the host appearance with the %s none override', async (kind) => {
  if (kind === 'query') history.replaceState({}, '', '/?skin=none')
  else localStorage.setItem('agnes-skin-preference', 'none')
  const c = await controller(async () => ({ ...roster, revision: 0, selected }))
  await c.skins.refresh()
  expect(painted()).toBe('')
})

it('submits the exact roster identity and revision through the effect; AGH default suppresses the app skin', async () => {
  let current: SkinListResult = { ...roster, selected }
  const save = vi.fn(
    async (_profile: string, revision: number, choice: SkinChoice, _current: () => boolean) => {
      current = {
        ...current,
        revision: revision + 1,
        choice,
        selected: choice.kind === 'skin' ? { ...selected, kind: 'manual' } : null,
      }
    },
  )
  const c = await controller(async () => current, { selectSkin: save })
  await c.skins.refresh()
  const picker = document.querySelector<HTMLSelectElement>('#skin-select')
  if (!picker) throw new Error('missing skin picker')
  picker.value = bindingDigest
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(picker.value).toBe(bindingDigest))
  expect(save).toHaveBeenCalledWith('local-dev', 1, { kind: 'skin', bindingDigest }, expect.any(Function))
  picker.value = ''
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  expect(painted()).toBe('')
  await vi.waitFor(() => expect(picker.value).toBe(''))
  expect(save).toHaveBeenCalledWith('local-dev', 2, { kind: 'none' }, expect.any(Function))
  expect(localStorage.getItem('agnes-skin-preference')).toBeNull()
})
