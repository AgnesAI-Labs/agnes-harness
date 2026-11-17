/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type { PackageInstalledDescriptor, PackageProvenance } from '@agnes/protocol'
import { createRegionRenderer } from '@agnes/web-ui'
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { EnableFacts } from '../src/admin/plugins/admin/confirms.js'
import { ProvenanceReview } from '../src/admin/plugins/capability-review.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let stop: (() => void) | undefined
afterEach(async () => {
  await act(async () => stop?.())
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

it.each(['en', 'zh-CN'])(
  'shows a friendly source and localized install date with a copyable digest in %s',
  async (language) => {
    document.documentElement.lang = language
    const value: PackageProvenance = {
      source: { type: 'file', ref: 'file:/synthetic/' + 'folder/'.repeat(30) },
      sourceKind: 'local-folder',
      integrity: 'sha256-' + 'a'.repeat(64),
      installedAt: '2026-10-20T10:38:49.648Z',
      signatureVerified: false,
    }
    const root = createRegionRenderer(document.body)
    stop = () => root.unmount()
    await act(async () => root.render(<ProvenanceReview value={value} t={(key) => key} />))
    const facts = document.querySelector('.confirm-facts-list')
    expect(facts?.textContent).toContain(language === 'zh-CN' ? '本地文件夹或文件' : 'Local folder or file')
    expect(facts?.textContent).not.toContain('local-folder')
    expect(facts?.textContent).not.toContain(value.installedAt)
    expect(facts?.textContent).toContain(
      new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value.installedAt!),
      ),
    )
    expect(facts?.querySelector('pre')?.textContent).toBe(value.integrity)
    expect(facts?.querySelector('button')?.getAttribute('aria-label')).toBe(
      language === 'zh-CN' ? '复制' : 'Copy',
    )
  },
)

it('shows the proven shipped copy and its app access when an installed plugin is enabled later', async () => {
  const rows = readFileSync('packages/protocol/fixtures/package-admin/package-admin.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { name: string; kind: string; target: string; payload: unknown })
  const fixture = rows.find(
    (row) => row.target === 'config' && row.name === 'PackageInstalledDescriptor' && row.kind === 'valid',
  )?.payload as PackageInstalledDescriptor
  const superagent = JSON.parse(
    readFileSync('packages/package-manager/bundled-plugins/superagent/package.json', 'utf8'),
  )
  const installed: PackageInstalledDescriptor = {
    ...fixture,
    trusted: true,
    declaredCapabilities: superagent.agnes.plugins[0].capabilities,
    provenance: {
      source: { type: 'file', ref: 'file:./bundled-plugins/superagent' },
      integrity: fixture.integrity,
      signatureVerified: false,
    },
  }
  const text = (key: string) => pluginAdminLocaleCatalog.en[key] ?? key
  for (const item of [{ ...installed, bundledOrigin: { ownerApplication: true as const } }, installed]) {
    const root = createRegionRenderer(document.body)
    await act(async () => root.render(<EnableFacts item={item} t={text} />))
    const page = document.body.textContent ?? ''
    expect(page).toContain(text('capability.store'))
    if (item.bundledOrigin) {
      expect(document.querySelector('[data-testid="provenance-bundled"]')?.textContent).toBe(
        text('provenance.bundled'),
      )
      expect(page).toContain(text('provenance.bundledSignature'))
      expect(page).toContain(text('capability.ownerApplication'))
      expect(page).not.toContain(text('provenance.unverified'))
    } else {
      expect(document.querySelector('[data-testid="provenance-bundled"]')).toBeNull()
      expect(page).not.toContain(text('capability.ownerApplication'))
      expect(page).toContain(text('provenance.unverified'))
    }
    await act(async () => root.unmount())
    document.body.replaceChildren()
  }
})
