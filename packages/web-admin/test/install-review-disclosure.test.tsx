/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type { PackagePreview } from '@agnes/protocol'
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PluginInstallReview } from '../src/admin/plugins/install-review.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const manifest = JSON.parse(
  readFileSync('packages/package-manager/bundled-plugins/judgment/package.json', 'utf8'),
)
const preview = {
  id: manifest.name,
  version: manifest.version,
  metadata: manifest.agnes.metadata,
  integrity: 'sha256-fixture',
  capabilityHash: 'sha256-capability',
  license: manifest.license,
  source: { type: 'file', ref: 'file:./bundled-plugins/judgment' },
  provenance: {
    signatureVerified: false,
    integrity: 'sha256-fixture',
    source: { type: 'file', ref: 'file:./bundled-plugins/judgment' },
  },
  declaredCapabilities: {},
  contributions: [],
  dependencies: {},
  blockers: [],
  warnings: [],
  capabilityDiff: {
    added: [],
    removed: [],
    runtimeSupportRemoved: [],
    dependenciesAdded: [],
    serviceGrantsAdded: [],
  },
} satisfies PackagePreview

async function renderReview(locale: 'en' | 'zh-CN', value: PackagePreview) {
  document.documentElement.lang = locale
  const localeState = createDocumentLocaleSource({ plugins: pluginAdminLocaleCatalog })
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host)
  const confirm = vi.fn()
  await act(async () =>
    root.render(
      createElement(
        UiLocaleProvider,
        { source: localeState.source },
        createElement(PluginInstallReview, {
          review: {
            preview: value,
            mode: 'install',
            current: undefined,
            combined: false,
            enables: true,
            enableAfter: true,
            busy: false,
            error: undefined,
          },
          name: 'Judgment',
          kind: undefined,
          tier: undefined,
          t: (key: string) => pluginAdminLocaleCatalog[locale][key] ?? key,
          onCancel() {},
          onConfirm: confirm,
        }),
      ),
    ),
  )
  return {
    host,
    confirm,
    async close() {
      await act(async () => root.unmount())
      host.remove()
      localeState.dispose()
    },
  }
}
it.each(['en', 'zh-CN'] as const)(
  'shows the real package data-use disclosure before confirmation in %s',
  async (locale) => {
    const f = await renderReview(locale, preview)
    try {
      const disclosure = f.host.querySelector('[data-testid="install-review-data-use"]')
      expect(disclosure).not.toBeNull()
      expect(disclosure?.textContent).toContain(
        locale === 'en'
          ? manifest.agnes.metadata.description
          : manifest.agnes.metadata.locales['zh-CN'].description,
      )
      for (const text of ['sideCall', '2,000', '8,000']) expect(disclosure?.textContent).toContain(text)
      expect(disclosure?.textContent).toContain(locale === 'en' ? 'conversation messages' : '对话消息')
      expect(disclosure?.textContent).toContain(locale === 'en' ? 'off by default' : '默认关闭')
      expect(disclosure?.textContent).toContain(locale === 'en' ? 'credential redaction' : '凭据遮蔽')
      expect(disclosure?.closest('details, [hidden]')).toBeNull()
      const confirm = f.host.querySelector('[data-testid="install-review-confirm"]')!
      expect(disclosure!.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(f.host.textContent).toContain(
        locale === 'en' ? 'No additional permission scopes listed' : '未列出额外权限范围',
      )
      expect(f.host.textContent).not.toContain(
        locale === 'en' ? 'No capabilities requested' : '未请求任何能力',
      )
      expect(f.confirm).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  },
)
it('keeps older previews without metadata usable and renders descriptions as plain text', async () => {
  const { metadata: _, ...old } = preview
  const f = await renderReview('en', old)
  try {
    expect(f.host.querySelector('[data-testid="install-review-data-use"]')).toBeNull()
    expect(f.host.querySelector<HTMLButtonElement>('[data-testid="install-review-confirm"]')?.disabled).toBe(
      false,
    )
  } finally {
    await f.close()
  }
  const text = '<img src=x onerror=alert(1)>'
  const g = await renderReview('en', { ...preview, metadata: { ...preview.metadata, description: text } })
  try {
    expect(g.host.querySelector('[data-testid="install-review-data-use"]')?.textContent).toContain(text)
    expect(g.host.querySelector('[data-testid="install-review-data-use"] img')).toBeNull()
  } finally {
    await g.close()
  }
})
