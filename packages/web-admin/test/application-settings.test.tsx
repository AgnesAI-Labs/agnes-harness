/** @vitest-environment happy-dom */
import type { ApplicationPreview, ApplicationState } from '@agnes/protocol'
import { clearResources, createRegionRenderer } from '@agnes/web-ui'
import { fireEvent, getByRole, waitFor } from '@testing-library/dom'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { ApplicationPanel } from '../src/settings/application.js'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  document.body.replaceChildren()
  clearResources()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it.each(['known', 'unknown'])(
  'summarizes application consent (%s) and submits only the reviewed digest and CAS revision',
  async (diffStatus) => {
    document.documentElement.lang = 'en'
    const state: ApplicationState = {
      revision: 3,
      selection: null,
      status: 'host',
      effective: null,
      assets: {},
      candidates: [{ packageId: 'acme/kit', applicationId: 'acme', version: '1.0.0', available: true }],
    }
    const preview: ApplicationPreview = {
      packageId: 'acme/kit',
      version: '1.0.0',
      integrity: `sha256-${'a'.repeat(64)}`,
      source: { type: 'file', ref: 'file:./synthetic' },
      signature: 'unverified',
      assets: {},
      declaration: {
        id: 'acme',
        brand: { name: { en: 'Acme' }, assistantName: { en: 'Ava' } },
        presentation: {
          home: 'acme/kit#overview',
          navigation: { entries: ['acme/kit#overview'], hideBuiltin: ['automation'] },
        },
        agents: ['acme/kit#desk'],
        defaultAgent: 'acme/kit#desk',
      },
      declarationDigest: 'b'.repeat(64),
      consentDigest: 'c'.repeat(64),
      dependencies: [
        {
          packageId: 'acme/status',
          version: '2.0.0',
          capabilities: { filesystem: { read: ['/synthetic/status'] }, network: ['status.example'] },
        },
      ],
      replacedRoles: [
        { role: 'navigation', packageId: 'acme/kit', clientId: 'nav', entry: 'private-entry.js' },
      ],
      dependencyDiff: { status: diffStatus, added: ['acme/status'], removed: ['acme/old'] },
      scope: 'presentation-defaults-and-agent-catalogue',
      recovery: '/?admin; agh app clear',
      warning: 'trusted-javascript-is-not-a-sandbox',
    }
    const api = {
      application: vi.fn(async () => state),
      previewApplication: vi.fn(async () => preview),
      adoptApplication: vi.fn(async () => {
        throw new Error('CONFIG_REVISION_CONFLICT')
      }),
    }
    const root = createRegionRenderer(document.body)
    stop = () => root.unmount()
    await act(async () => root.render(<ApplicationPanel api={api as unknown as PluginAdminApi} canSave />))
    await waitFor(() =>
      expect(getByRole(document.body, 'button', { name: 'Preview' }).hasAttribute('disabled')).toBe(false),
    )
    await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: 'Preview' })))
    expect(document.body.textContent).toContain('Ava')
    expect(document.body.textContent).toContain('Trusted JavaScript')
    const summary = document.querySelector('[data-testid="consent-summary"]')
    expect(summary?.textContent).toContain('Ava')
    expect(summary?.textContent).toContain('acme/kit#overview')
    expect(summary?.textContent).toContain('Automation')
    expect(summary?.textContent).toContain('acme/kit#desk')
    expect(summary?.textContent).toContain('Navigation · acme/kit#nav')
    expect(summary?.textContent).toContain('Read files: /synthetic/status')
    expect(summary?.textContent).toContain('Network hosts: status.example')
    expect(summary?.textContent).not.toContain(preview.consentDigest)
    expect(summary?.textContent).not.toContain(preview.integrity)
    expect(summary?.textContent).not.toContain('private-entry.js')
    expect(summary?.querySelector('pre')).toBeNull()
    expect(summary?.textContent).toContain(
      diffStatus === 'known' ? 'Removed dependencies: acme/old' : 'Changes are unknown',
    )
    const technical = document.querySelector<HTMLElement>('[data-testid="consent-technical"]')
    if (!technical) throw new Error('technical details missing')
    const toggle = getByRole(technical, 'button', { name: 'Technical details' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => fireEvent.click(toggle))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(technical.textContent).toContain(preview.consentDigest)
    expect(technical.textContent).toContain(preview.declarationDigest)
    expect(technical.textContent).toContain(preview.integrity)
    expect(technical.textContent).toContain('private-entry.js')

    // A background read must not allow confirmation against a stale revision or discard the review.
    let finish: ((value: ApplicationState) => void) | undefined
    api.application.mockReturnValueOnce(
      new Promise<ApplicationState>((resolve) => {
        finish = resolve
      }),
    )
    await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: 'Refresh candidates' })))
    expect(getByRole(document.body, 'button', { name: 'Adopt this preview' }).hasAttribute('disabled')).toBe(
      true,
    )
    await act(async () => finish?.(state))
    await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: 'Adopt this preview' })))
    expect(api.adoptApplication).toHaveBeenCalledWith('acme/kit', 3, preview.consentDigest)
    expect(api.adoptApplication).toHaveBeenCalledTimes(1)
    expect(getByRole(document.body, 'alert').textContent).toContain('preview and confirm again')
    expect(document.body.textContent).not.toContain('Adopt this preview')
  },
)

it('previews a declared role without adopting an application and resets stale consent after a CAS conflict', async () => {
  document.documentElement.lang = 'zh-CN'
  const state: ApplicationState = {
    revision: 8,
    selection: null,
    status: 'host',
    effective: null,
    assets: {},
    candidates: [],
    roles: [
      {
        role: 'deliverables',
        selection: null,
        source: 'default',
        status: 'resolved',
        effective: null,
        candidates: [{ packageId: 'community/gallery', clientId: 'ui', version: '1.0.0' }],
      },
    ],
  }
  const preview: ApplicationPreview = {
    packageId: 'community/gallery',
    version: '1.0.0',
    integrity: 'sha256-synthetic',
    source: { type: 'file', ref: 'file:./synthetic' },
    signature: 'unverified',
    assets: {},
    declaration: {
      id: 'role-selection',
      presentation: { roles: { deliverables: { packageId: 'community/gallery', clientId: 'ui' } } },
    },
    declarationDigest: 'a'.repeat(64),
    consentDigest: 'b'.repeat(64),
    dependencies: [{ packageId: 'community/gallery', version: '1.0.0', capabilities: { ui: true } }],
    replacedRoles: [
      {
        role: 'deliverables',
        packageId: 'community/gallery',
        clientId: 'ui',
        entry: 'client.js',
        visibleParts: ['deliverable-cards', 'deliverables-workbench'],
      },
    ],
    dependencyDiff: { status: 'not-applicable' },
    scope: 'presentation-only-no-execution-change',
    recovery: '/?admin; agh app clear',
    warning: 'trusted-javascript-is-not-a-sandbox',
  }
  const api = {
    application: vi.fn(async () => state),
    previewRole: vi.fn(async () => preview),
    selectRole: vi.fn(async () => {
      throw new Error('CONFIG_REVISION_CONFLICT')
    }),
  }
  const root = createRegionRenderer(document.body)
  stop = () => root.unmount()
  await act(async () => root.render(<ApplicationPanel api={api as unknown as PluginAdminApi} canSave />))
  await waitFor(() =>
    expect(getByRole(document.body, 'button', { name: '预览' }).hasAttribute('disabled')).toBe(false),
  )
  await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: '预览' })))
  expect(document.body.textContent).toContain('仅影响展示，不改变执行')
  const summary = document.querySelector('[data-testid="consent-summary"]')
  expect(summary?.textContent).toContain('交付物卡片, 交付物工作区')
  expect(summary?.textContent).toContain('界面: 允许')
  expect(summary?.textContent).toContain('不适用依赖差异比较')
  expect(summary?.textContent).not.toContain(preview.consentDigest)
  expect(summary?.querySelector('pre')).toBeNull()
  const technical = document.querySelector<HTMLElement>('[data-testid="consent-technical"]')
  if (!technical) throw new Error('technical details missing')
  const toggle = getByRole(technical, 'button', { name: '技术详情' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await act(async () => fireEvent.click(toggle))
  expect(technical.textContent).toContain('deliverables-workbench')
  expect(technical.textContent).toContain(preview.consentDigest)
  expect(technical.textContent).toContain(preview.declarationDigest)

  await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: '使用此实现' })))
  expect(api.selectRole).toHaveBeenCalledWith(
    'deliverables',
    'community/gallery',
    'ui',
    8,
    preview.consentDigest,
  )
  expect(getByRole(document.body, 'alert').textContent).toContain('重新加载、预览并确认')
  expect(document.body.textContent).not.toContain('使用此实现')
})

it.each(['focus', 'agnes:plugins-invalidated', 'agnes:packages-changed', 'manual', 'visibility'])(
  'refreshes externally installed application and interface candidates via %s without losing them on a failed read',
  async (trigger) => {
    document.documentElement.lang = 'en'
    vi.useFakeTimers()
    let state: ApplicationState = {
      revision: 1,
      selection: null,
      status: 'host',
      effective: null,
      assets: {},
      candidates: [],
    }
    const api = { application: vi.fn(async () => state) }
    const root = createRegionRenderer(document.body)
    stop = () => root.unmount()
    await act(async () => root.render(<ApplicationPanel api={api as unknown as PluginAdminApi} canSave />))
    expect(document.querySelector('[data-testid="consent-summary"]')).toBeNull()
    state = {
      ...state,
      revision: 2,
      candidates: [{ packageId: 'acme/kit', applicationId: 'acme', version: '1.0.0', available: true }],
      roles: [
        {
          role: 'deliverables',
          selection: null,
          source: 'default',
          status: 'resolved',
          effective: null,
          candidates: [{ packageId: 'community/gallery', clientId: 'ui', version: '1.0.0' }],
        },
      ],
    }
    await act(async () => {
      if (trigger === 'focus' || trigger.startsWith('agnes:')) window.dispatchEvent(new Event(trigger))
      else if (trigger === 'visibility') {
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        await vi.advanceTimersByTimeAsync(5_000)
        expect(document.body.textContent).not.toContain('acme/kit@1.0.0')
        visibility.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
      } else fireEvent.click(getByRole(document.body, 'button', { name: 'Refresh candidates' }))
    })
    expect(document.body.textContent).toContain('acme/kit@1.0.0')
    expect(document.body.textContent).toContain('community/gallery#ui')
    expect(document.body.textContent).toContain('Current application: Agnes Harness')
    expect(document.querySelector('[data-testid="consent-summary"]')).toBeNull()
    api.application.mockRejectedValueOnce(new Error('temporarily offline'))
    await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: 'Refresh candidates' })))
    expect(getByRole(document.body, 'alert').textContent).toContain('Could not refresh applications')
    expect(document.body.textContent).toContain('community/gallery#ui')
    await act(async () => root.unmount())
    stop = undefined
    // Closing the panel removes both notification and return-to-page subscriptions.
    api.application.mockClear()
    await act(async () => {
      window.dispatchEvent(new Event('agnes:plugins-invalidated'))
      window.dispatchEvent(new Event('agnes:packages-changed'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(api.application).not.toHaveBeenCalled()
  },
)

it('makes no periodic application requests while the mounted page is idle', async () => {
  document.documentElement.lang = 'en'
  vi.useFakeTimers()
  const state: ApplicationState = {
    revision: 1,
    selection: null,
    status: 'host',
    effective: null,
    assets: {},
    candidates: [],
  }
  const api = { application: vi.fn(async () => state) }
  const root = createRegionRenderer(document.body)
  stop = () => root.unmount()
  await act(async () => root.render(<ApplicationPanel api={api as unknown as PluginAdminApi} canSave />))
  expect(document.body.textContent).toContain('Current application: Agnes Harness')
  expect(getByRole(document.body, 'heading', { name: 'Interface implementations' })).toBeDefined()
  // Count requests to the public client boundary after the initial page read has settled.
  api.application.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(api.application).not.toHaveBeenCalled()
})
