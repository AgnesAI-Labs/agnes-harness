/** @vitest-environment happy-dom */
/** @vitest-environment-options {"happyDOM":{"settings":{"disableIframePageLoading":true}}} */
import type { Session } from '@agnes/sdk/browser'
import { fileViewerActions } from '@agnes/web-client'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { HTML_PREVIEW_FRAME } from '@agnes/web-ui/conversation'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewFileAction } from '../src/workbench/changes-panel.js'
import { fileType, formatSize, renderedKind } from '../src/workbench/file-types.js'
import { FilesPanel, TREE_DEFAULT, TREE_WIDTH_KEY, WRAP_KEY } from '../src/workbench/files-panel.js'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'

type Entry = { name: string; kind: 'file' | 'directory' | 'other'; git?: string }
const TEXT: Record<string, string> = {
  'portal.html': '<!doctype html>\n<h1>Hi</h1>',
  'story.md': '# Story\n\nOnce.',
  'scene.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'main.ts': 'const a = 1\nconst b = "a very long line"\nexport { a, b }',
  'src/util.ts': 'export const util = 1',
}

function fakeSession({
  entries = {
    '': [
      { name: 'src', kind: 'directory' },
      { name: 'main.ts', kind: 'file' },
      { name: 'portal.html', kind: 'file' },
      { name: 'scene.svg', kind: 'file' },
      { name: 'story.md', kind: 'file' },
      { name: 'logo.png', kind: 'file' },
    ],
    src: [{ name: 'util.ts', kind: 'file' }],
  } as Record<string, Entry[]>,
  truncated = false,
  changes = true,
  read,
}: {
  entries?: Record<string, Entry[]>
  truncated?: boolean
  changes?: boolean
  read?: (path: string) => object
} = {}) {
  return {
    id: 's',
    workspaceList: vi.fn(async (path: string) => ({
      path,
      truncated,
      gitStatus: 'available',
      revision: 'r',
      observedAt: '2026-10-14T00:00:00Z',
      entries: entries[path] ?? [],
    })),
    workspaceRead: vi.fn(async (path: string) => ({
      path,
      revision: `rev-${path}`,
      observedAt: '2026-10-14T09:05:00Z',
      size: 2048,
      binary: false,
      truncated: false,
      text: TEXT[path] ?? '',
      ...read?.(path),
    })),
    ...(changes
      ? {
          workspaceChanges: vi.fn(async () => ({
            scope: 'session',
            files: [
              { path: 'portal.html', kind: 'added', added: 12, removed: 0 },
              { path: 'main.ts', kind: 'modified', added: 3, removed: 1 },
            ],
          })),
        }
      : {}),
  } as unknown as Session & { workspaceChanges?: ReturnType<typeof vi.fn> }
}

let host: HTMLElement
let observedWidth = 0
class FakeResizeObserver {
  constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
  observe() {
    this.callback([{ contentRect: { width: observedWidth } }])
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  observedWidth = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  unmountRegion(host)
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(session: Session, extra: Record<string, unknown> = {}) {
  const context = {
    t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
    data: { session, disabled: false, mention: vi.fn(), workspace: { name: 'WorkLLM', path: '/w' } },
    ...extra,
  }
  renderRegion(host, <FilesPanel context={context} />)
  return context
}
const q = (selector: string) => host.querySelector(selector) as HTMLElement | null
const click = (selector: string) => flushSync(() => (q(selector) as HTMLElement).click())
async function open(path: string) {
  await vi.waitFor(() => expect(q(`[data-path="${path}"]`)).not.toBeNull())
  click(`[data-path="${path}"]`)
  await vi.waitFor(() => expect(q('[data-testid="file-meta"] time')?.title).toBe(`rev-${path}`))
}
function type(selector: string, value: string) {
  const input = q(selector) as HTMLInputElement
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('file type mapping', () => {
  it('labels known extensions, greys out unknown ones and offers rendering only for existing renderers', () => {
    expect(fileType('index.HTML')).toEqual({ label: 'HTML', tone: 'html' })
    expect(fileType('a.css')?.tone).toBe('css')
    expect(fileType('a.mjs')).toEqual({ label: 'JS', tone: 'js' })
    expect(fileType('a.tsx')).toEqual({ label: 'TSX', tone: 'ts' })
    expect(fileType('package.json')?.tone).toBe('json')
    expect(fileType('README.md')).toEqual({ label: 'MD', tone: 'md' })
    expect(fileType('logo.svg')?.tone).toBe('svg')
    expect(fileType('photo.jpeg')).toEqual({ label: 'JPG', tone: 'image' })
    expect(fileType('Makefile')).toBeUndefined()
    expect(fileType('.env')).toBeUndefined()
    expect(fileType('archive.xyz')).toBeUndefined()
    expect(renderedKind('site/index.html')).toBe('html')
    expect(renderedKind('notes.markdown')).toBe('markdown')
    expect(renderedKind('art/scene.svg')).toBe('svg')
    expect(renderedKind('photo.png')).toBeUndefined()
    expect(renderedKind('main.ts')).toBeUndefined()
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048, 'en')).toBe('2 KB')
    expect(formatSize(1.5 * 1024 * 1024, 'en')).toBe('1.5 MB')
  })
})

describe('FilesPanel layout', () => {
  it('stacks the tree above the preview in a narrow panel and has no divider', async () => {
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-path="main.ts"]')).not.toBeNull())
    expect(q('[data-testid="files-panel"]')?.dataset.layout).toBe('stacked')
    expect(q('[data-testid="files-divider"]')).toBeNull()
    expect(q('[data-testid="files-choose"]')?.textContent).toContain('Choose a file')
  })

  it('splits from 640px, sizes the tree at 250px and persists divider drags and arrow keys', async () => {
    observedWidth = 900
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-testid="files-panel"]')?.dataset.layout).toBe('split'))
    const panel = q('[data-testid="files-panel"]') as HTMLElement
    expect(panel.style.getPropertyValue('--workbench-tree-width')).toBe(`${TREE_DEFAULT}px`)
    const divider = q('[data-testid="files-divider"]') as HTMLElement
    expect(divider.getAttribute('role')).toBe('separator')
    flushSync(() => divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 250 })))
    flushSync(() => divider.dispatchEvent(new PointerEvent('pointermove', { clientX: 330 })))
    expect(panel.style.getPropertyValue('--workbench-tree-width')).toBe('330px')
    expect(localStorage.getItem(TREE_WIDTH_KEY)).toBeNull()
    flushSync(() => divider.dispatchEvent(new PointerEvent('pointerup', { clientX: 330 })))
    expect(localStorage.getItem(TREE_WIDTH_KEY)).toBe('330')
    flushSync(() => divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(localStorage.getItem(TREE_WIDTH_KEY)).toBe('314')
    // The preview keeps its minimum: the tree cannot be dragged past the panel width.
    flushSync(() => divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0 })))
    flushSync(() => divider.dispatchEvent(new PointerEvent('pointerup', { clientX: 5000 })))
    expect(localStorage.getItem(TREE_WIDTH_KEY)).toBe('620')
    flushSync(() => divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(localStorage.getItem(TREE_WIDTH_KEY)).toBe(String(TREE_DEFAULT))
  })

  it('restores a stored width and survives storage that throws', async () => {
    observedWidth = 900
    localStorage.setItem(TREE_WIDTH_KEY, '300')
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-testid="files-panel"]')?.dataset.layout).toBe('split'))
    expect(q('[data-testid="files-panel"]')?.style.getPropertyValue('--workbench-tree-width')).toBe('300px')
    unmountRegion(host)
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      mount(fakeSession())
      await vi.waitFor(() => expect(q('[data-testid="files-divider"]')).not.toBeNull())
      const panel = q('[data-testid="files-panel"]') as HTMLElement
      expect(panel.style.getPropertyValue('--workbench-tree-width')).toBe(`${TREE_DEFAULT}px`)
      const divider = q('[data-testid="files-divider"]') as HTMLElement
      flushSync(() =>
        divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
      )
      expect(panel.style.getPropertyValue('--workbench-tree-width')).toBe(`${TREE_DEFAULT + 16}px`)
      expect(setItem).toHaveBeenCalled()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})

describe('FilesPanel tree', () => {
  it('draws type badges, marks session changes A / M and highlights the selection', async () => {
    mount(fakeSession())
    await vi.waitFor(() =>
      expect(q('[data-path="portal.html"] [data-testid="file-change-badge"]')).not.toBeNull(),
    )
    expect(q('[data-path="portal.html"] .workbench-file-type')?.textContent).toBe('HTML')
    expect(q('[data-path="portal.html"] .workbench-file-type')?.dataset.tone).toBe('html')
    expect(q('[data-path="story.md"] .workbench-file-type')?.textContent).toBe('MD')
    expect(q('[data-path="src"] .workbench-file-type')).toBeNull()
    expect(q('[data-path="src"] .workbench-file-icon')).not.toBeNull()
    const added = q('[data-path="portal.html"] [data-testid="file-change-badge"]') as HTMLElement
    expect(added.dataset.kind).toBe('added')
    expect(added.textContent).toBe('ACreated in this session')
    const modified = q('[data-path="main.ts"] [data-testid="file-change-badge"]') as HTMLElement
    expect(modified.dataset.kind).toBe('modified')
    expect(modified.querySelector('[aria-hidden]')?.textContent).toBe('M')
    expect(q('[data-path="story.md"] [data-testid="file-change-badge"]')).toBeNull()
    click('[data-path="story.md"]')
    expect(q('[data-path="story.md"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-path="main.ts"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows no marks when the change list is unavailable', async () => {
    mount(fakeSession({ changes: false }))
    await vi.waitFor(() => expect(q('[data-path="portal.html"]')).not.toBeNull())
    expect(q('[data-testid="file-change-badge"]')).toBeNull()
  })

  it('filters loaded entries by name, keeps folders that hold a match and says when nothing matches', async () => {
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-path="src"]')).not.toBeNull())
    click('[data-path="src"]')
    await vi.waitFor(() => expect(q('[data-path="src/util.ts"]')).not.toBeNull())
    expect(q('.workbench-files-summary')?.textContent).toContain('7 shown')
    type('[data-testid="files-filter"]', 'UTIL')
    expect(q('[data-path="src"]')).not.toBeNull()
    expect(q('[data-path="src/util.ts"]')).not.toBeNull()
    expect(q('[data-path="main.ts"]')).toBeNull()
    expect(q('.workbench-files-summary')?.textContent).toContain('2 shown')
    type('[data-testid="files-filter"]', 'src')
    expect(q('[data-path="src/util.ts"]')).not.toBeNull()
    type('[data-testid="files-filter"]', 'nothing-here')
    expect(q('[data-testid="workspace-file"]')).toBeNull()
    expect(host.textContent).toContain('No open folder has a matching file.')
    type('[data-testid="files-filter"]', '')
    expect(q('[data-path="main.ts"]')).not.toBeNull()
  })

  it('opens the visibility rules from the footer and keeps the 500-entry notice', async () => {
    mount(fakeSession({ truncated: true }))
    await vi.waitFor(() => expect(q('[data-testid="files-truncated"]')).not.toBeNull())
    expect(q('[data-testid="files-truncated"]')?.textContent).toBe('Only the first 500 entries are shown.')
    expect(q('[data-testid="files-rules-text"]')).toBeNull()
    expect(q('[data-testid="files-rules"]')?.getAttribute('aria-expanded')).toBe('false')
    click('[data-testid="files-rules"]')
    expect(q('[data-testid="files-rules-text"]')?.textContent).toContain('.gitignore and .aghignore')
    expect(q('[data-testid="files-rules"]')?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('FilesPanel preview', () => {
  it('puts path, size, read time and mention in one header and numbers the source lines', async () => {
    const context = mount(fakeSession())
    await open('main.ts')
    const header = q('[data-testid="file-header"]') as HTMLElement
    expect(header.querySelector('.workbench-file-crumb')?.textContent).toBe('WorkLLM/main.ts')
    expect(q('[data-testid="file-meta"]')?.textContent).toMatch(/^2 KB · Read at /)
    expect(q('[data-testid="file-view-mode"]')).toBeNull()
    const pre = q('[data-testid="file-preview"]') as HTMLElement
    expect(pre.querySelectorAll('.workbench-code-line')).toHaveLength(3)
    expect(pre.textContent).toBe(TEXT['main.ts'])
    expect(pre.style.getPropertyValue('--workbench-gutter')).toBe('2ch')
    expect(pre.querySelector('.workbench-code-keyword')?.textContent).toBe('const')
    expect(pre.dataset.wrap).toBeUndefined()
    click('[data-testid="file-mention"]')
    expect((context.data as { mention: ReturnType<typeof vi.fn> }).mention).toHaveBeenCalledWith('main.ts')
    expect(q('[data-testid="file-mention"]')?.getAttribute('aria-label')).toBe('Mention in prompt')
  })

  it('shows the breadcrumb of a nested file and wraps lines when the stored preference says so', async () => {
    localStorage.setItem(WRAP_KEY, 'true')
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-path="src"]')).not.toBeNull())
    click('[data-path="src"]')
    await open('src/util.ts')
    expect(q('.workbench-file-crumb')?.textContent).toBe('WorkLLM/src/util.ts')
    expect(q('[data-testid="file-preview"]')?.dataset.wrap).toBe('true')
  })

  it('toggles line wrapping from the panel menu and remembers it', async () => {
    const header = document.createElement('div')
    header.id = 'files-test-header'
    document.body.append(header)
    try {
      renderRegion(
        host,
        <FilesPanel
          headerId="files-test-header"
          context={{
            t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
            data: { session: fakeSession(), disabled: false, mention: vi.fn() },
          }}
        />,
      )
      await open('main.ts')
      expect(q('[data-testid="file-preview"]')?.dataset.wrap).toBeUndefined()
      flushSync(() => (header.querySelector('[data-testid="files-more"]') as HTMLElement).click())
      await vi.waitFor(() => expect(document.querySelector('[data-testid="files-wrap"]')).not.toBeNull())
      expect(document.querySelector('[data-testid="files-wrap"]')?.textContent).toBe('Wrap long lines')
      flushSync(() => (document.querySelector('[data-testid="files-wrap"]') as HTMLElement).click())
      await vi.waitFor(() => expect(q('[data-testid="file-preview"]')?.dataset.wrap).toBe('true'))
      expect(localStorage.getItem(WRAP_KEY)).toBe('true')
    } finally {
      unmountRegion(host)
      header.remove()
    }
  })

  it('shows the change strip only for a changed file and its link opens the review', async () => {
    const remove = fileViewerActions.get('review')
      ? () => {}
      : fileViewerActions.register({ id: 'review', order: 10, component: ReviewFileAction })
    const openPanel = vi.fn()
    try {
      mount(fakeSession(), { openPanel })
      await vi.waitFor(() =>
        expect(q('[data-path="main.ts"] [data-testid="file-change-badge"]')).not.toBeNull(),
      )
      await open('story.md')
      expect(q('[data-testid="file-changed"]')).toBeNull()
      expect(q('[data-testid="file-review"]')).toBeNull()
      await open('main.ts')
      await vi.waitFor(() => expect(q('[data-testid="file-review"]')).not.toBeNull())
      expect(q('[data-testid="file-changed"]')?.textContent).toContain(
        'This session modified this file (+3 −1)',
      )
      click('[data-testid="file-review"]')
      expect(openPanel).toHaveBeenCalledWith('changed-files', {
        sessionId: 's',
        path: 'main.ts',
        revision: 'rev-main.ts',
      })
      await open('portal.html')
      await vi.waitFor(() =>
        expect(q('[data-testid="file-changed"]')?.textContent).toContain('This session created this file'),
      )
    } finally {
      remove()
    }
  })

  it('renders HTML in the sandboxed deliverable frame, Markdown and SVG through the document preview', async () => {
    mount(fakeSession())
    await open('portal.html')
    expect(q('[data-testid="file-view-mode"]')).not.toBeNull()
    expect(q('[data-testid="file-rendered"]')).toBeNull()
    click('[data-testid="file-view-preview"]')
    const frame = q('[data-testid="file-rendered"] iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(HTML_PREVIEW_FRAME)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(q('[data-testid="file-preview"]')).toBeNull()
    click('[data-testid="file-view-source"]')
    expect(q('[data-testid="file-preview"]')).not.toBeNull()

    await open('story.md')
    expect(q('[data-testid="file-preview"]')).not.toBeNull()
    click('[data-testid="file-view-preview"]')
    await vi.waitFor(() =>
      expect(q('[data-testid="file-rendered"] [data-document-preview="markdown"]')?.textContent).toContain(
        'Story',
      ),
    )
    expect(q('[data-testid="file-rendered"] h1')).not.toBeNull()

    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL: () => 'blob:http://localhost/svg', revokeObjectURL })
    try {
      await open('scene.svg')
      click('[data-testid="file-view-preview"]')
      await vi.waitFor(() =>
        expect(
          q('[data-testid="file-rendered"] [data-document-preview="image"] img')?.getAttribute('src'),
        ).toBe('blob:http://localhost/svg'),
      )
      // Back to source: the object URL is released with the rendered view.
      click('[data-testid="file-view-source"]')
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/svg')
    } finally {
      Object.assign(URL, { createObjectURL: original.create, revokeObjectURL: original.revoke })
    }
  })

  it('keeps the binary and size notices and offers no rendering for images', async () => {
    mount(
      fakeSession({
        read: (path) =>
          path === 'logo.png'
            ? { binary: true, text: undefined }
            : path === 'story.md'
              ? { truncated: true, text: undefined, size: 2 * 1024 * 1024 }
              : {},
      }),
    )
    await open('logo.png')
    expect(host.textContent).toContain('This binary file cannot be previewed.')
    expect(q('[data-testid="file-view-mode"]')).toBeNull()
    expect(q('[data-testid="file-preview"]')).toBeNull()
    await open('story.md')
    await vi.waitFor(() => expect(host.textContent).toContain('exceeds the 1 MiB preview limit'))
    expect(q('[data-testid="file-view-mode"]')).toBeNull()
  })
})

describe('opening a file chip and naming a folder', () => {
  it('opens a requested file with its folders expanded, and a requested folder', async () => {
    const session = fakeSession()
    mount(session, { selection: { path: 'src/util.ts', directory: false } })
    await vi.waitFor(() => expect(q('[data-path="src"]')?.getAttribute('aria-expanded')).toBe('true'))
    await vi.waitFor(() => expect(q('[data-path="src/util.ts"]')?.getAttribute('aria-pressed')).toBe('true'))
    await vi.waitFor(() => expect(session.workspaceRead).toHaveBeenCalledWith('src/util.ts'))
    unmountRegion(host)
    mount(session, { selection: { path: 'src', directory: true } })
    await vi.waitFor(() => expect(q('[data-path="src"]')?.getAttribute('aria-expanded')).toBe('true'))
    expect(q('[data-testid="files-choose"]')).not.toBeNull()
  })

  it('names a folder in the prompt from its row', async () => {
    const context = mount(fakeSession())
    const button = await vi.waitFor(() => {
      const found = q('[data-path="src"]')
        ?.closest('li')
        ?.querySelector<HTMLElement>('[data-testid="workspace-folder-mention"]')
      expect(found?.getAttribute('aria-label')).toBe('Mention folder src in prompt')
      return found as HTMLElement
    })
    flushSync(() => button.click())
    expect((context.data as { mention: ReturnType<typeof vi.fn> }).mention).toHaveBeenCalledWith('src', true)
  })
})

describe('separate folder and file read results', () => {
  it('keeps a failed file read on screen when a folder listing succeeds afterwards, and retries only the file', async () => {
    const session = fakeSession()
    let fail = true
    const read = session.workspaceRead as unknown as ReturnType<typeof vi.fn>
    const original = read.getMockImplementation() as (path: string) => Promise<object>
    read.mockImplementation(async (path: string) => {
      if (path === 'main.ts' && fail) throw new Error('Permission denied for main.ts')
      return original(path)
    })
    mount(session)
    await vi.waitFor(() => expect(q('[data-path="main.ts"]')).not.toBeNull())
    click('[data-path="main.ts"]')
    await vi.waitFor(() =>
      expect(q('[data-testid="file-read-error"]')?.textContent).toContain('could not load'),
    )
    // The failure belongs to the file, so the panel-level (folder) error stays empty.
    expect(q('.workbench-files > .agnes-settings-state[data-tone="error"]')).toBeNull()
    // A folder listing that succeeds after the failed read must not clear the file's error.
    click('[data-path="src"]')
    await vi.waitFor(() => expect(q('[data-path="src/util.ts"]')).not.toBeNull())
    expect(q('[data-testid="file-read-error"]')?.textContent).toContain('could not load')
    expect(q('[data-testid="file-preview"]')).toBeNull()
    const lists = (session.workspaceList as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    fail = false
    click('[data-testid="file-read-retry"]')
    await vi.waitFor(() => expect(q('[data-testid="file-preview"]')?.textContent).toContain('const a = 1'))
    expect(q('[data-testid="file-read-error"]')).toBeNull()
    // The retry rereads the file, not the folders.
    expect((session.workspaceList as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(lists)
  })

  it('keeps a failed folder listing on screen when a file read succeeds afterwards', async () => {
    const session = fakeSession()
    const list = session.workspaceList as unknown as ReturnType<typeof vi.fn>
    const original = list.getMockImplementation() as (path: string) => Promise<object>
    list.mockImplementation(async (path: string) => {
      if (path === 'src') throw new Error('Folder src is unavailable')
      return original(path)
    })
    mount(session)
    await vi.waitFor(() => expect(q('[data-path="src"]')).not.toBeNull())
    click('[data-path="src"]')
    const folderError = '.workbench-files > .agnes-settings-state[data-tone="error"]'
    await vi.waitFor(() => expect(q(folderError)).not.toBeNull())
    click('[data-path="main.ts"]')
    await vi.waitFor(() => expect(q('[data-testid="file-preview"]')?.textContent).toContain('const a = 1'))
    // A successful file read never clears the folder listing's failure.
    expect(q(folderError)).not.toBeNull()
    expect(q('[data-testid="file-read-error"]')).toBeNull()
  })

  it('says a file is being read instead of showing a blank preview', async () => {
    const session = fakeSession()
    const read = session.workspaceRead as unknown as ReturnType<typeof vi.fn>
    read.mockImplementation(() => new Promise(() => {}))
    mount(session)
    await vi.waitFor(() => expect(q('[data-path="main.ts"]')).not.toBeNull())
    click('[data-path="main.ts"]')
    expect(q('[data-testid="file-read-loading"]')?.textContent).toContain('Reading this file')
  })
})
