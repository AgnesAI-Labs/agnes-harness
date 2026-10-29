/** @vitest-environment happy-dom */
import type { PackageProvenance } from '@agnes/protocol'
import { createRegionRenderer } from '@agnes/web-ui'
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { ProvenanceReview } from '../src/admin/plugins/capability-review.js'

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
