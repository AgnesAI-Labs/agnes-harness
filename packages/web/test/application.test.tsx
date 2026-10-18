/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { ApplicationState } from '@agnes/protocol'
import {
  applicationBrand,
  applicationIdentity,
  homeEntries,
  homeNavigation,
  LocaleService,
  presentationDefault,
  presentationRoles,
  reserveHomeEntry,
} from '@agnes/web-client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  openApplicationHome,
  projectApplication,
  requestNewSession,
  updateApplicationTitle,
} from '../src/application.js'

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
    assets: {
      favicon:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
    },
    candidates: [],
  }
  let visible = ''
  const offRole = presentationRoles.register(
    'community-ui',
    {
      role: 'deliverables',
      mount() {
        visible = 'community'
        return () => {
          visible = ''
        }
      },
    },
    { packageId: 'community/gallery', clientId: 'ui', revision: 'one' },
  )
  state.roles = [
    {
      role: 'deliverables',
      source: 'choice',
      status: 'resolved',
      selection: null,
      effective: { packageId: 'community/gallery', clientId: 'ui' },
      candidates: [],
    },
  ]
  projectApplication(state)
  expect(visible).toBe('community')
  expect(document.title).toBe('Task · Acme Workbench')
  expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toContain('blob:synthetic-asset')
  expect(applicationBrand().name).toBe('Acme')
  expect(locale.t('brand.agent')).toBe('Ava')
  locale.setLocale('zh-CN')
  document.documentElement.lang = 'zh-CN'
  updateApplicationTitle()
  expect(document.title).toBe('Task · 艾克米工作台')
  expect(locale.t('brand.agent')).toBe('小艾')
  projectApplication({ ...state, status: 'host', effective: null })
  expect(visible).toBe('community')
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
  expect(visible).toBe('')
  offRole()
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

it('falls back to the host when the browser cannot decode a package asset, and ignores stale failures', async () => {
  const decode = vi.spyOn(Image.prototype, 'decode').mockRejectedValue(new Error('invalid raster'))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken-brand')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  document.head.innerHTML = '<title>Agnes Harness</title><link rel="icon" href="/favicon.png">'
  const state: ApplicationState = {
    revision: 1,
    status: 'active',
    selection: null,
    effective: { id: 'bad', brand: { title: { en: 'Bad' } } },
    assets: { favicon: 'data:image/png;base64,iVBORw0KGgo=' },
    candidates: [],
  }
  projectApplication(state)
  await Promise.resolve()
  expect(applicationIdentity.getSnapshot()).toMatchObject({
    status: 'unresolved',
    reason: 'asset-decode-failed',
    effective: null,
    assets: {},
  })
  expect(document.title).toBe('Agnes Harness')
  expect(document.querySelector('link')?.getAttribute('href')).toBe('/favicon.png')
  projectApplication(state)
  expect(applicationIdentity.getSnapshot()?.status).toBe('unresolved')
  decode.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        late = reject
      }),
  )
  let late: ((error: Error) => void) | undefined
  projectApplication({ ...state, revision: 2 })
  projectApplication(undefined)
  late?.(new Error('stale'))
  await Promise.resolve()
  expect(applicationIdentity.getSnapshot()).toBeUndefined()
})

it('never resolves an adopted home against another package with the same page name', () => {
  const off = reserveHomeEntry(
    'b-row',
    { id: 'overview', icon: 'home', titleKey: 'B', order: 0, component: () => null },
    'b',
  )
  try {
    projectApplication({
      revision: 1,
      status: 'active',
      selection: null,
      effective: { id: 'a', presentation: { home: 'a#overview' } },
      assets: {},
      candidates: [],
    })
    expect(homeNavigation.getSnapshot()).toBeUndefined()
    const stop = homeEntries.subscribe(openApplicationHome)
    off()
    const own = reserveHomeEntry(
      'a-row',
      { id: 'overview', icon: 'home', titleKey: 'A', order: 0, component: () => null },
      'a',
    )
    try {
      expect(homeNavigation.getSnapshot()?.pageRef).toBe('a#overview')
    } finally {
      stop()
      own()
    }
  } finally {
    off()
    homeNavigation.close()
  }
})

it.each(['automatic', 'url', 'workspace', 'late'] as const)(
  'keeps explicit new-session intent above the application home (%s)',
  (entry) => {
    const state: ApplicationState = {
      revision: 1,
      selection: null,
      status: 'active',
      assets: {},
      candidates: [],
      effective: { id: 'acme', presentation: { home: 'acme#desk' } },
    }
    const stop = homeEntries.subscribe(openApplicationHome)
    let off = () => {}
    try {
      if (entry === 'url') history.replaceState(null, '', '/?new=1')
      if (entry !== 'late')
        off = reserveHomeEntry(
          'acme-row',
          { id: 'desk', icon: 'home', titleKey: 'Desk', order: 0, component: () => null },
          'acme',
        )
      projectApplication(state)
      if (entry === 'workspace') {
        expect(homeNavigation.getSnapshot()?.pageRef).toBe('acme#desk')
        requestNewSession()
      }
      if (entry === 'late') {
        requestNewSession()
        off = reserveHomeEntry(
          'acme-row',
          { id: 'desk', icon: 'home', titleKey: 'Desk', order: 0, component: () => null },
          'acme',
        )
      }
      openApplicationHome()
      projectApplication({ ...state, revision: 2 })
      expect(homeNavigation.getSnapshot()?.pageRef).toBe(entry === 'automatic' ? 'acme#desk' : undefined)
    } finally {
      stop()
      off()
      homeNavigation.close()
    }
  },
)
