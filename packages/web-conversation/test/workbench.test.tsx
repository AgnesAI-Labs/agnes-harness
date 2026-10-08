/** @vitest-environment happy-dom */

import type { Session } from '@agnes/sdk/browser'
import { fileViewerActions } from '@agnes/web-client'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { FilesPanel } from '../src/workbench/files-panel.js'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'

it('loads directories lazily, previews text and mentions a relative path without submitting', async () => {
  const list = vi.fn(async (path: string) => ({
    path,
    truncated: false,
    entries:
      path === ''
        ? [
            { name: 'src', kind: 'directory' },
            { name: 'report.md', kind: 'file' },
          ]
        : [{ name: 'main.ts', kind: 'file' }],
  }))
  const session = {
    id: 's',
    workspaceList: list,
    workspaceRead: vi.fn(async (path) => ({
      path,
      revision: 'source-hash',
      observedAt: '2026-10-08T00:00:00Z',
      text: 'export const answer = 42',
      size: 24,
      binary: false,
      truncated: false,
    })),
  } as unknown as Session
  const removeAction = fileViewerActions.register({
    id: 'test.review',
    order: 1,
    component: ({ path, revision }) => <output>{`${path}:${revision}`}</output>,
  })
  const mention = vi.fn()
  const host = document.createElement('div')
  const header = document.createElement('div')
  header.id = 'test-header'
  document.body.append(header, host)
  try {
    renderRegion(
      host,
      <FilesPanel
        headerId="test-header"
        context={{
          t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
          data: { session, disabled: false, mention },
        }}
      />,
    )
    await vi.waitFor(() => expect(host.querySelector('[data-path="src"]')).not.toBeNull())
    expect(host.querySelector('[data-path="src/main.ts"]')).toBeNull()
    flushSync(() => (host.querySelector('[data-path="src"]') as HTMLButtonElement).click())
    await vi.waitFor(() => expect(host.querySelector('[data-path="src/main.ts"]')).not.toBeNull())
    flushSync(() => (host.querySelector('[data-path="src/main.ts"]') as HTMLButtonElement).click())
    await vi.waitFor(() => expect(host.querySelector('pre')?.textContent).toBe('export const answer = 42'))
    flushSync(() => (host.querySelector('[data-testid="file-mention"]') as HTMLButtonElement).click())
    expect(mention).toHaveBeenCalledWith('src/main.ts')
    expect(host.querySelector('output')?.textContent).toBe('src/main.ts:source-hash')
    flushSync(removeAction)
    expect(host.querySelector('output')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(header.querySelector('button')?.getAttribute('aria-label')).toBe('Refresh workspace files')
    expect(header.querySelector('button')?.textContent).toBe('')
    expect(host.querySelector('.workbench-files-footer summary')?.textContent).toBe('File visibility rules')
    expect(host.querySelector('.workbench-file-preview summary')?.textContent).not.toContain('2026-10-08T')
    expect(host.querySelector('time')?.dateTime).toBe('2026-10-08T00:00:00Z')
  } finally {
    removeAction()
    unmountRegion(host)
    host.remove()
    header.remove()
  }
})
