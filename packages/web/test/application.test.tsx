/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { ApplicationState } from '@agnes/protocol'
import { applicationBrand, applicationIdentity, LocaleService, presentationDefault } from '@agnes/web-client'
import { afterEach, expect, it, vi } from 'vitest'
import { projectApplication, updateApplicationTitle } from '../src/application.js'

afterEach(() => {
  projectApplication(undefined)
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.resetModules()
  history.replaceState({}, '', '/')
  document.documentElement.lang = 'en'
})
it('projects title, favicon and localized assistant display name, then restores host defaults on clear', () => {
  document.head.innerHTML =
    '<title>Task · Agnes Harness</title><link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/favicon.png">'
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-asset')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const ctx = new Context(),
    locale = new LocaleService(ctx, 'en')
  const state: ApplicationState = {
    revision: 1,
    status: 'active',
    selection: null,
    effective: {
      id: 'acme',
      brand: {
        name: { en: 'Acme', 'zh-CN': '艾克米' },
        title: { en: 'Acme Workbench', 'zh-CN': '艾克米工作台' },
        assistantName: { en: 'Ava', 'zh-CN': '小艾' },
      },
    },
    assets: { favicon: 'data:image/png;base64,iVBORw0KGgo=' },
    candidates: [],
  }
  projectApplication(state)
  expect(document.title).toBe('Task · Acme Workbench')
  expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toContain('blob:synthetic-asset')
  expect(applicationBrand().name).toBe('Acme')
  expect(locale.t('brand.agent')).toBe('Ava')
  locale.setLocale('zh-CN')
  document.documentElement.lang = 'zh-CN'
  updateApplicationTitle()
  expect(document.title).toBe('Task · 艾克米工作台')
  expect(locale.t('brand.agent')).toBe('小艾')
  projectApplication(undefined)
  expect(document.title).toBe('Task · Agnes Harness')
  expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href')).toBe(
    '/favicon.png',
  )
  expect(locale.t('brand.agent')).toBe('Agnes')
  expect(presentationDefault('url', 'user', 'app', 'host')).toBe('url')
  expect(presentationDefault(undefined, 'user', 'app', 'host')).toBe('user')
  expect(presentationDefault(undefined, undefined, 'app', 'host')).toBe('app')
  expect(presentationDefault(undefined, undefined, undefined, 'host')).toBe('host')
  expect(applicationIdentity.getSnapshot()).toBeUndefined()
})

it('chooses recovery before the workbench can load third-party modules, CSS, roles or navigation', async () => {
  history.replaceState({}, '', '/?admin')
  const recovery = vi.fn(() => ({}))
  const workbench = vi.fn(() => {
    throw new Error('third-party side effect')
  })
  vi.doMock('../src/app.js', workbench)
  vi.doMock('../src/recovery.js', recovery)
  await import('../src/bootstrap.js')
  expect(recovery).toHaveBeenCalledOnce()
  expect(workbench).not.toHaveBeenCalled()
  vi.doUnmock('../src/app.js')
  vi.doUnmock('../src/recovery.js')
})
