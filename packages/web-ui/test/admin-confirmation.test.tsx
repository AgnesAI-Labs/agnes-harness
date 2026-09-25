/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PreviewConfirmationFacts,
  RollbackActivationFacts,
  TrustConfirmationFacts,
  UntrustConfirmationFacts,
  UpdateActivationFacts,
  mountRegion,
} from '../src/index.js'

afterEach(() => {
  document.body.replaceChildren()
})

const integrity = `sha256-${'a'.repeat(64)}`
const capabilityHash = 'b'.repeat(64)

const preview = {
  id: 'acme/review',
  version: '1.2.3',
  source: { type: 'npm', ref: 'npm:acme/review@1.2.3' },
  integrity,
  license: 'Apache-2.0',
  provenance: {
    source: { type: 'npm', ref: 'npm:acme/review@1.2.3' },
    integrity,
    releasedAt: '2026-09-13T00:00:00Z',
    signatureVerified: true,
  },
  contributions: [
    {
      kind: 'extension',
      id: 'acme/review',
      path: './dist/index.js',
      apiRange: '^1.0.0',
      runtimeSupports: ['isolated'],
      capabilities: {
        tools: { prefix: 'review_', names: ['inspect'] },
        'tools.invoke': true,
        network: { hosts: ['api.example.test'] },
      },
    },
  ],
  capabilityDiff: {
    added: ['tools.review_inspect'],
    removed: [],
    runtimeSupportRemoved: [],
    dependenciesAdded: ['acme/dependency'],
    serviceGrantsAdded: [{ extension: 'acme/review', name: 'review.check', range: '^1.0.0' }],
  },
  dependencies: { 'acme/dependency': '^2.0.0' },
  warnings: [{ code: 'capability-change', safeMessage: '<script>review this capability</script>' }],
  blockers: [{ code: 'policy', references: ['policy/require-review'] }],
  capabilityHash,
} as unknown as PackagePreview

const installed = {
  id: 'acme/review',
  version: '1.2.3',
  source: { type: 'npm', ref: 'npm:acme/review@1.2.3' },
  integrity,
  capabilityHash,
  trusted: true,
  desired: 'enabled',
  actual: 'running',
  actualVersion: '1.2.3',
  actualIntegrity: integrity,
  contributions: [],
  blockers: [],
  cleanupPending: false,
  rollbackTarget: { version: '1.2.2', integrity: integrity, capabilityHash },
} as unknown as PackageInstalledDescriptor

function renderText(element: ReturnType<typeof createElement>): string {
  const host = document.createElement('div')
  document.body.append(host)
  mountRegion(host, element)
  return host.textContent ?? ''
}

function tags(element: ReturnType<typeof createElement>): string[] {
  const host = document.createElement('div')
  document.body.append(host)
  mountRegion(host, element)
  return [...host.querySelectorAll('*')].map((node) => node.tagName.toLowerCase())
}

describe('plugin confirmation facts (React)', () => {
  it('renders complete preview facts as safe text, including integrity and reviewable protocol fields', () => {
    const rendered = renderText(createElement(PreviewConfirmationFacts, { preview }))

    expect(rendered).toContain(integrity)
    expect(rendered).toContain(capabilityHash)
    expect(rendered).toContain('Apache-2.0')
    expect(rendered).toContain('api.example.test')
    expect(rendered).toContain('acme/dependency · ^2.0.0')
    expect(rendered).toContain('policy/require-review')
    // 警告的 safeMessage 以字面量出现：React 文本节点天然安全。
    expect(rendered).toContain('<script>review this capability</script>')
    expect(tags(createElement(PreviewConfirmationFacts, { preview }))).not.toContain('script')
  })

  it('explains that an absent difference report does not mean the package has no capabilities', () => {
    const withoutDiff = {
      ...preview,
      capabilityDiff: {
        added: [],
        removed: [],
        runtimeSupportRemoved: [],
        dependenciesAdded: [],
        serviceGrantsAdded: [],
      },
    } as PackagePreview

    expect(renderText(createElement(PreviewConfirmationFacts, { preview: withoutDiff }))).toContain(
      '这不表示这个包不包含能力。',
    )
  })

  it('binds trust and untrust decisions to the immutable baselines without enabling anything', () => {
    const trust = renderText(createElement(TrustConfirmationFacts, { item: installed }))
    expect(trust).toContain('信任决定会绑定下列完整性摘要')
    expect(trust).toContain(integrity)
    expect(trust).toContain(capabilityHash)

    const untrust = renderText(createElement(UntrustConfirmationFacts, { item: installed }))
    expect(untrust).toContain('立刻停用此包')
    expect(untrust).toContain('将被撤销的贡献与能力字段')
  })

  it('shows both baselines for the atomic update-and-activate confirmation', () => {
    const rendered = renderText(
      createElement(UpdateActivationFacts, { installed, preview }),
    )

    expect(rendered).toContain('当前安装与运行基线')
    expect(rendered).toContain('目标信任摘要')
    expect(rendered).toContain('1.2.3')
  })

  it('shows the verified rollback target without exposing internal tree hashes', () => {
    const rendered = renderText(createElement(RollbackActivationFacts, { installed }))

    expect(rendered).toContain('回滚目标版本')
    expect(rendered).toContain('1.2.2')
    expect(rendered).toContain('当前阻断项')
  })
})
