/** @vitest-environment happy-dom */
// Load the real panel registry during collection, outside the interaction deadline.
// Keep it isolated from Dock tests that deliberately register their own panel set.
import '@agnes/web-conversation/workbench'
import {
  FileMentionChip,
  fileMentionBlock,
  fileMentionLinks,
  fileMentionOf,
  renderRegion,
  unmountRegion,
} from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { Dock } from '../src/workbench/dock.js'

it('opens Windows resource links through the real Dock and FilesPanel request path', async () => {
  localStorage.clear()
  document.body.innerHTML =
    '<div class="workbench-split"><div id="controls"></div><div id="message"></div><aside id="workbench-right" hidden><div id="workbench-right-content"></div></aside><aside id="workbench-bottom" hidden><div id="workbench-bottom-content"></div></aside></div>'
  const host = document.getElementById('controls') as HTMLElement
  const message = document.getElementById('message') as HTMLElement
  const session = {
    id: 'windows-mention',
    workspaceList: vi.fn(async (path: string) => ({
      path,
      truncated: false,
      entries: path === '' ? [{ name: 'src', kind: 'directory' }] : [{ name: '中文 #%.ts', kind: 'file' }],
    })),
    workspaceRead: vi.fn(async (path: string) => ({
      path,
      text: 'const opened = true',
      binary: false,
      truncated: false,
      size: 19,
      revision: 'r',
      observedAt: '2026-10-15T00:00:00Z',
    })),
  }
  try {
    renderRegion(
      host,
      <Dock
        context={{
          t: (key) => key,
          data: { session, disabled: false, workspace: { name: 'repo', path: 'C:\\work\\repo' } },
        }}
      />,
    )
    for (const directory of [true, false]) {
      const original = {
        path: directory ? 'C:\\work\\repo\\src' : 'c:\\work\\repo\\src\\中文 #%.ts',
        name: directory ? 'src' : '中文 #%.ts',
        directory,
      }
      const mention = fileMentionOf(fileMentionBlock(original))!
      renderRegion(message, <FileMentionChip mention={mention} onOpen={fileMentionLinks.open} />)
      flushSync(() => message.querySelector<HTMLButtonElement>('button')!.click())
      await vi.waitFor(() =>
        expect(document.querySelector('[data-path="src"]')?.getAttribute('aria-expanded')).toBe('true'),
      )
      expect(session.workspaceList).toHaveBeenCalledWith('src')
      if (!directory) {
        await vi.waitFor(() => expect(session.workspaceRead).toHaveBeenCalledWith('src/中文 #%.ts'))
        await vi.waitFor(() =>
          expect(document.getElementById('workbench-right')?.textContent).toContain('const opened = true'),
        )
      }
    }
    // Referring to the same file again activates its tab instead of opening a duplicate.
    const reopened = { path: 'c:\\work\\repo\\src\\中文 #%.ts', name: '中文 #%.ts', directory: false }
    const reopenedMention = fileMentionOf(fileMentionBlock(reopened))
    if (!reopenedMention) throw new Error('Missing reopened file mention')
    renderRegion(message, <FileMentionChip mention={reopenedMention} onOpen={fileMentionLinks.open} />)
    flushSync(() => message.querySelector<HTMLButtonElement>('button')?.click())
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="file-tab"]')).toHaveLength(1))
  } finally {
    unmountRegion(message)
    unmountRegion(host)
    document.body.replaceChildren()
    localStorage.clear()
  }
})
