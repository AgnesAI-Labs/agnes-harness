/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { reviewDependentUpdates } from '../src/admin/plugins/admin/dependent-update.js'
import type { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { PluginInstallReview } from '../src/admin/plugins/install-review.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it.each(['en', 'zh-CN'] as const)(
  'offers a digest-bound joint review in %s without updating before confirmation',
  async (locale) => {
    const parent = {
      id: '@acme/parent',
      version: '0.1.0-alpha.0',
      integrity: 'old-parent',
      trusted: true,
      blockers: [],
      source: { type: 'file', ref: 'file:./parent' },
    } as unknown as PackageInstalledDescriptor
    const child = {
      ...parent,
      id: '@acme/example',
      version: '1.0.0',
      integrity: 'old-child',
      source: { type: 'file', ref: 'file:./example' },
    }
    const preview = {
      ...parent,
      version: '0.1.0-alpha.1',
      integrity: 'new-parent',
      capabilityHash: 'parent-cap',
      capabilityDiff: {
        added: [],
        removed: [],
        runtimeSupportRemoved: [],
        dependenciesAdded: [],
        serviceGrantsAdded: [],
      },
      blockers: [{ code: 'dependency', references: [child.id] }],
      warnings: [],
      contributions: [],
      provenance: {
        signatureVerified: false,
        source: parent.source,
        integrity: 'new-parent',
        version: '0.1.0-alpha.1',
      },
      license: 'Apache-2.0',
      dependencies: {},
    } as unknown as PackagePreview
    const dependent = {
      ...preview,
      id: child.id,
      version: '1.1.0',
      integrity: 'new-child',
      capabilityHash: 'child-cap',
      source: child.source,
      dependencies: { [parent.id]: preview.version },
      blockers: [{ code: 'dependency', references: ['example-parent-unavailable', parent.id] }],
    } as PackagePreview
    const t = (key: string) => pluginAdminLocaleCatalog[locale][key] ?? key
    const api = {
      inspect: vi.fn(async () => ({ operationId: 'inspect-child' })),
      operation: vi.fn(async () => ({ state: 'completed', preview: dependent })),
      update: vi.fn(async () => ({ operationId: 'joint-update' })),
    } as unknown as PluginAdminApi
    let confirmation: Parameters<PluginAdminPage['configureConfirm']>[0] | undefined
    const page = {
      viewContext: () => ({ state: { installed: [parent, child] }, t }),
      activeIntegrity: (item: PackageInstalledDescriptor) => item.integrity,
      can: () => true,
      canEffect: () => true,
      nameOf: (item: PackagePreview) => item.id,
      configureConfirm: (value: typeof confirmation) => {
        confirmation = value
      },
      submitPackage: async (_id: string, submit: () => Promise<unknown>) => submit(),
      cancelReview: vi.fn(),
      track: vi.fn(),
    } as unknown as PluginAdminPage
    document.documentElement.lang = locale
    const localeState = createDocumentLocaleSource({ plugins: pluginAdminLocaleCatalog })
    const host = document.body.appendChild(document.createElement('div')),
      root = createRoot(host)
    const onReview = vi.fn()
    try {
      await act(async () =>
        root.render(
          createElement(
            UiLocaleProvider,
            { source: localeState.source },
            createElement(PluginInstallReview, {
              review: {
                preview,
                mode: 'update',
                current: parent,
                combined: true,
                enables: false,
                enableAfter: false,
                busy: false,
                error: undefined,
              },
              name: parent.id,
              kind: undefined,
              tier: undefined,
              t,
              onCancel() {},
              onConfirm() {},
              onReviewDependents: onReview,
            }),
          ),
        ),
      )
      expect(host.textContent).toContain(child.id)
      expect(host.querySelector<HTMLButtonElement>('[data-testid="install-review-confirm"]')?.disabled).toBe(
        true,
      )
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="review-dependent-updates"]')?.click(),
      )
      expect(onReview).toHaveBeenCalled()
      await reviewDependentUpdates(page, api, preview, new AbortController().signal)
      expect(api.update).not.toHaveBeenCalled()
      expect(confirmation?.facts).toBeDefined()
      await confirmation?.run()
      expect(api.update).toHaveBeenCalledWith(
        parent.id,
        preview.source,
        preview.integrity,
        expect.objectContaining({ expectedInstalledIntegrity: parent.integrity }),
        [
          expect.objectContaining({
            id: child.id,
            expectedIntegrity: dependent.integrity,
            activation: expect.objectContaining({ expectedInstalledIntegrity: child.integrity }),
          }),
        ],
      )
      expect(page.track).toHaveBeenCalledWith('joint-update', { packageId: parent.id })
    } finally {
      await act(async () => root.unmount())
      localeState.dispose()
      host.remove()
    }
  },
)
