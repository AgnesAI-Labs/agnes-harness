import type { FactChainResult } from '@agnes/protocol'
import { FactChainPanel } from '../src/workbench/fact-chain-panel.js'
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

it('clears fact records on session changes and ignores an old response while keeping hashes collapsed', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  let oldReply: (result: FactChainResult) => void = () => undefined
  const oldRead = new Promise<FactChainResult>((resolve) => {
    oldReply = resolve
  })
  const result = (sessionId: string, model: string): FactChainResult => ({
    sessionId,
    laneId: 'main',
    atSeq: 1,
    edges: [],
    gaps: [],
    nodes: [
      {
        id: 'generation:existing',
        kind: 'generation',
        generationId: 'existing',
        packages: [
          {
            packageId: '@agnes/document-reader',
            version: '0.1.2',
            snapshotId: 'existing',
            integrity: 'sha256-retained',
            treeIntegrity: 'sha256-retained-tree',
          },
        ],
      },
      {
        id: 'request:existing',
        kind: 'request',
        callId: 'existing',
        seq: 1,
        model,
        generationId: null,
        derivedHash: 'a'.repeat(64),
        promptHash: null,
        toolSchemaHash: null,
        messagesHash: null,
        memoryRevision: null,
        memoryHash: null,
        hashBasis: 'ledger-stamp',
        incomplete: true,
      },
    ],
  })
  const render = (id: string, read: () => Promise<FactChainResult>) =>
    renderRegion(
      host,
      <FactChainPanel
        context={{
          t: createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN'),
          data: {
            session: { id, factChain: read },
            factChain: { sessionId: id, laneId: 'main', anchor: { kind: 'request', callId: 'existing' } },
          },
        }}
      />,
    )
  try {
    render('old', () => oldRead)
    await vi.waitFor(() => expect(host.textContent).toContain('正在读取执行记录'))
    render('new', async () => result('new', 'NEW_MODEL'))
    await vi.waitFor(() => expect(host.querySelector('ol')?.textContent).toContain('NEW_MODEL'))
    oldReply(result('old', 'OLD_PRIVATE'))
    await Promise.resolve()
    await Promise.resolve()
    expect(host.textContent).not.toContain('OLD_PRIVATE')
    expect(host.querySelector('details')?.open).toBe(false)
    expect(host.querySelector('ol')?.textContent).not.toContain('a'.repeat(64))
    expect(host.querySelector('summary')?.textContent).toBe('技术详情')
    expect(host.querySelector('ol')?.textContent).toContain('文档读取 · 0.1.2')
  } finally {
    unmountRegion(host)
    host.remove()
  }
})
