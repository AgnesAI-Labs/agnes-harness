/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type { PackagePreview, PluginCapabilities } from '@agnes/protocol'
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { capabilityRequests } from '../src/admin/plugins/capability-review.js'
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
      for (const text of ['2,000', '8,000']) expect(disclosure?.textContent).toContain(text)
      expect(disclosure?.textContent).toContain(
        locale === 'en' ? 'Remote providers receive' : '远程服务会收到',
      )
      expect(disclosure?.textContent).toContain(locale === 'en' ? 'off by default' : '默认关闭')
      expect(disclosure?.textContent).toContain(locale === 'en' ? 'credential masking' : '遮蔽凭据')
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

const superagent = JSON.parse(
  readFileSync('packages/package-manager/bundled-plugins/superagent/package.json', 'utf8'),
)
const declared = superagent.agnes.plugins[0].capabilities
const bundledSource = { type: 'file', ref: 'file:./bundled-plugins/superagent' } as const
const shipped = {
  ...preview,
  id: superagent.name,
  version: superagent.version,
  metadata: superagent.agnes.metadata,
  license: superagent.license,
  source: bundledSource,
  provenance: { ...preview.provenance, source: bundledSource },
  declaredCapabilities: declared,
  warnings: [{ code: 'unverified-provenance', safeMessage: 'Package signature has not been verified.' }],
  bundledOrigin: { ownerApplication: true },
} satisfies PackagePreview
const text = (locale: 'en' | 'zh-CN', key: string) => pluginAdminLocaleCatalog[locale][key] ?? key
const declaredLines = (locale: 'en' | 'zh-CN') => [
  text(locale, 'capability.store'),
  `${text(locale, 'capability.hooks')}: context, tool_call`,
  `${text(locale, 'capability.tools')} (${declared.tools.names.length}): ${declared.tools.names[0]}`,
  `${text(locale, 'capability.profileServices')} (${declared.services.length}): ${declared.services[0].name}`,
  `${text(locale, 'capability.managedService')}: superagent`,
]
it.each(['en', 'zh-CN'] as const)(
  'shows the shipped copy apart from the publisher signature and lists what it gets in %s',
  async (locale) => {
    const f = await renderReview(locale, shipped)
    try {
      expect(f.host.querySelector('[data-testid="install-review-unverified"]')).toBeNull()
      const source = f.host.querySelector('[data-testid="install-review-source"]')?.textContent
      expect(source).toContain(text(locale, 'review.bundled'))
      expect(source).toContain(
        `${text(locale, 'review.signature')}${text(locale, 'review.signatureBundled')}`,
      )
      // The full sentence sits behind the source row's info and in the technical source record.
      expect(f.host.querySelector('[data-testid="provenance-bundled"]')?.textContent).toBe(
        text(locale, 'provenance.bundled'),
      )
      expect(f.host.textContent).not.toContain(text(locale, 'provenance.unverified'))
      expect(f.host.textContent).not.toContain(text(locale, 'provenance.verified'))
      const gets = f.host.querySelector('[data-testid="install-review-gets"]')?.textContent
      for (const line of [...declaredLines(locale), text(locale, 'capability.ownerApplication')])
        expect(gets).toContain(line)
    } finally {
      await f.close()
    }
  },
)
it('keeps the source warning and grants no app access without the exact bundled fact', async () => {
  const { bundledOrigin: _, ...external } = shipped
  for (const value of [external, { ...shipped, bundledOrigin: {} }]) {
    const f = await renderReview('en', value)
    try {
      const gets = f.host.querySelector('[data-testid="install-review-gets"]')?.textContent
      for (const line of declaredLines('en')) expect(gets).toContain(line)
      expect(gets).not.toContain(text('en', 'capability.ownerApplication'))
      const banner = f.host.querySelector('[data-testid="install-review-unverified"]')?.textContent
      if (value === external) {
        expect(banner).toContain(text('en', 'provenance.unverified'))
        expect(f.host.textContent).not.toContain(text('en', 'review.bundled'))
        expect(f.host.querySelector('[data-testid="provenance-bundled"]')).toBeNull()
      } else expect(banner).toBeUndefined()
    } finally {
      await f.close()
    }
  }
})
it.each(['en', 'zh-CN'] as const)('summarizes every capability a manifest can declare in %s', (locale) => {
  const schema = JSON.parse(readFileSync('packages/protocol/schema/extension-manifest.json', 'utf8'))
  const samples: Record<string, unknown> = {
    tools: { prefix: 'demo_' },
    'tools.invoke': true,
    hooks: ['context'],
    slots: ['composer.actions'],
    events: true,
    ui: true,
    resources: ['skill'],
    'network.publicRead': true,
    network: ['example.com'],
    exec: ['git'],
    secrets: ['DEMO_TOKEN'],
    credentials: ['demo'],
    filesystem: { read: ['**'], write: ['out/**'] },
    model: true,
    device: true,
    childAgents: true,
    sessionWork: true,
    autoTitle: true,
    wake: true,
    store: true,
    uiData: ['demo.read'],
    artifacts: true,
    subagent: true,
    services: [
      { name: 'demo.status', kind: 'query', scope: 'profile' },
      { name: 'demo.turn', kind: 'query' },
    ],
    projections: [{ name: 'demo.view' }],
    streams: [{ name: 'demo.stream' }],
    managedServices: [{ id: 'demo', scope: 'profile' }],
  }
  expect(Object.keys(samples).sort()).toEqual(Object.keys(schema.$defs.Capabilities.properties).sort())
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(samples)) {
    const lines = capabilityRequests({ [key]: value } as PluginCapabilities, (k) => text(locale, k))
    expect(lines.length, key).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, key).not.toContain('capability.')
      expect(seen.has(line), line).toBe(false)
      seen.add(line)
    }
  }
  // Technical details print no UI data or stream names, so the summary never shortens those lists.
  const names = ['a.one', 'a.two', 'a.three', 'a.four', 'a.five']
  const full = capabilityRequests(
    { uiData: names, streams: names.map((name) => ({ name })) } as PluginCapabilities,
    (k) => text(locale, k),
  )
  for (const line of full) expect(line).toContain('a.five')
})
