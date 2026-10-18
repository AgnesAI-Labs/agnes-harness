/** @vitest-environment happy-dom */
import type { ApplicationPreview, ApplicationState } from '@agnes/protocol'
import { createRegionRenderer } from '@agnes/web-ui'
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
})
it('submits only the reviewed digest and CAS revision, and requires a new preview after a conflict', async () => {
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
    declaration: { id: 'acme', brand: { name: { en: 'Acme' }, assistantName: { en: 'Ava' } } },
    declarationDigest: 'b'.repeat(64),
    consentDigest: 'c'.repeat(64),
    dependencies: [],
    replacedRoles: [],
    dependencyDiff: {},
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
  await act(async () => fireEvent.click(getByRole(document.body, 'button', { name: 'Adopt this preview' })))
  expect(api.adoptApplication).toHaveBeenCalledWith('acme/kit', 3, preview.consentDigest)
  expect(api.adoptApplication).toHaveBeenCalledTimes(1)
  expect(getByRole(document.body, 'alert').textContent).toContain('preview and confirm again')
  expect(document.body.textContent).not.toContain('Adopt this preview')
})

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
    dependencies: [],
    replacedRoles: [
      {
        role: 'deliverables',
        entry: 'client.js',
        visibleParts: ['deliverable-cards', 'deliverables-workbench'],
      },
    ],
    dependencyDiff: {},
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
  expect(document.body.textContent).toContain('deliverables-workbench')
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
