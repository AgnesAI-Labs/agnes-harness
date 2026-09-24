import type { PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  renderPreviewConfirmationFacts,
  renderRollbackActivationFacts,
  renderTrustConfirmationFacts,
  renderUpdateActivationFacts,
} from '../src/admin/plugins/confirmation.js'

class FakeElement {
  className = ''
  textContent = ''
  open = false
  children: FakeElement[] = []

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }
}

const originalDocument = globalThis.document

function installDom(): void {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new FakeDocument() })
}

function text(node: FakeElement): string {
  return [node.textContent, ...node.children.map(text)].filter(Boolean).join('\n')
}

function tags(node: FakeElement): string[] {
  return [node.tagName, ...node.children.flatMap(tags)]
}

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

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
})

describe('plugin confirmation facts', () => {
  it('renders complete preview facts as safe text, including integrity and reviewable protocol fields', () => {
    installDom()
    const host = new FakeElement('div')

    renderPreviewConfirmationFacts(host as unknown as HTMLElement, preview)

    const rendered = text(host)
    expect(rendered).toContain(integrity)
    expect(rendered).toContain(capabilityHash)
    expect(rendered).toContain('Apache-2.0')
    expect(rendered).toContain('api.example.test')
    expect(rendered).toContain('acme/dependency · ^2.0.0')
    expect(rendered).toContain('policy/require-review')
    expect(rendered).toContain('<script>review this capability</script>')
    expect(tags(host)).not.toContain('script')
  })

  it('explains that an absent difference report does not mean the package has no capabilities', () => {
    installDom()
    const host = new FakeElement('div')
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

    renderPreviewConfirmationFacts(host as unknown as HTMLElement, withoutDiff)

    expect(text(host)).toContain('这不表示这个包不包含能力。')
  })

  it('warns before install or trust when a client declares a slot the Web host cannot render', () => {
    installDom()
    const host = new FakeElement('div')
    const unsupported = {
      ...preview,
      contributions: [
        {
          ...preview.contributions[0],
          client: {
            entry: './client/index.js',
            styles: [],
            slots: ['sidebar.action'],
            services: [],
            projections: [],
          },
        },
      ],
    } as unknown as PackagePreview

    renderPreviewConfirmationFacts(host as unknown as HTMLElement, unsupported)

    expect(text(host)).toContain('Web 宿主暂不支持：sidebar.action')
  })

  it('binds a trust confirmation to the full installed integrity and capability hash', () => {
    installDom()
    const host = new FakeElement('div')
    const installed = {
      id: preview.id,
      version: preview.version,
      source: preview.source,
      integrity,
      trusted: false,
      desired: 'installed-disabled',
      actual: 'not-running',
      contributions: preview.contributions,
      blockers: preview.blockers,
      capabilityHash,
    } as unknown as PackageInstalledDescriptor

    renderTrustConfirmationFacts(host as unknown as HTMLElement, installed)

    const rendered = text(host)
    expect(rendered).toContain(integrity)
    expect(rendered).toContain(capabilityHash)
    expect(rendered).toContain('工具：前缀 review_；名称 inspect')
    expect(rendered).toContain('信任本身不会启用插件。')
  })

  it('renders distinct installed, actual, target and verified rollback identities', () => {
    installDom()
    const installed = {
      id: preview.id,
      version: '2.0.0',
      source: preview.source,
      integrity: `sha256-${'d'.repeat(64)}`,
      trusted: true,
      desired: 'enabled',
      actual: 'running',
      actualVersion: '1.2.3',
      actualIntegrity: integrity,
      actualReason: 'previous revision retained',
      cleanupPending: true,
      rollbackTarget: { version: '1.2.3', integrity, capabilityHash },
      contributions: preview.contributions,
      blockers: preview.blockers,
      capabilityHash: 'd'.repeat(64),
    } as unknown as PackageInstalledDescriptor
    const updateHost = new FakeElement('div')
    const rollbackHost = new FakeElement('div')

    renderUpdateActivationFacts(updateHost as unknown as HTMLElement, installed, preview)
    renderRollbackActivationFacts(rollbackHost as unknown as HTMLElement, installed)

    expect(text(updateHost)).toContain('当前安装版本\n2.0.0')
    expect(text(updateHost)).toContain('当前运行版本\n1.2.3')
    expect(text(updateHost)).toContain('目标信任摘要')
    expect(text(rollbackHost)).toContain('回滚目标版本\n1.2.3')
    expect(text(rollbackHost)).toContain(capabilityHash)
    expect(text(rollbackHost)).not.toContain('treeIntegrity')
  })
})
