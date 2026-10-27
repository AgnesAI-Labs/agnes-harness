/** @vitest-environment happy-dom */
/** @vitest-environment-options {"happyDOM":{"settings":{"disableIframePageLoading":true}}} */
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import type { Session } from '@agnes/sdk/browser'
import { fileViewerActions } from '@agnes/web-client'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { HTML_PREVIEW_FRAME } from '@agnes/web-ui/conversation'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewFileAction } from '../src/workbench/changes-panel.js'
import { fileType, formatSize, renderedKind } from '../src/workbench/file-types.js'
import {
  FILE_TABS_KEY,
  FilesPanel,
  MAX_FILE_TABS,
  TREE_DEFAULT,
  TREE_WIDTH_KEY,
  WRAP_KEY,
} from '../src/workbench/files-panel.js'
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

// happy-dom does not parse cascade layers; keep the production rules inside the app layer.
const panelCss = readFileSync(
  new NodeURL('../../web/public/styles/22-session-dock.css', import.meta.url),
  'utf8',
)
  .replace(/^@layer app \{/, '')
  .replace(/\}\s*$/, '')
let styles: HTMLStyleElement
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
  styles = document.createElement('style')
  styles.textContent = panelCss
  document.head.append(styles)
  observedWidth = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  unmountRegion(host)
  host.remove()
  styles.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(session: Session, extra: Record<string, unknown> = {}, headerId = '') {
  const context = {
    t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
    data: { session, disabled: false, mention: vi.fn(), workspace: { name: 'WorkLLM', path: '/w' } },
    ...extra,
  }
  renderRegion(host, <FilesPanel context={context} headerId={headerId} />)
  return context
}
const q = (selector: string) => host.querySelector(selector) as HTMLElement | null
const qa = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)]
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
  it.each([
    ['en', 320],
    ['en', 900],
    ['zh-CN', 320],
    ['zh-CN', 900],
  ] as const)('gives the tree the empty panel and opens a file in %s at %ipx', async (locale, width) => {
    observedWidth = width
    mount(fakeSession(), { t: createCatalogTranslator(workbenchLocaleCatalog, locale) })
    await vi.waitFor(() => expect(q('[data-path="main.ts"]')).not.toBeNull())
    expect(q('[data-testid="files-panel"]')?.dataset.layout).toBe('stacked')
    expect(q('[data-testid="files-divider"]')).toBeNull()
    expect(q('[data-testid="files-choose"]')).toBeNull()
    expect(q('.workbench-file-preview')).toBeNull()
    expect(q('.workbench-files-body')?.children).toHaveLength(1)
    expect(q('.workbench-files-body')?.firstElementChild).toBe(q('[data-testid="files-tree"]'))
    expect(getComputedStyle(q('[data-testid="files-panel"]') as HTMLElement).height).toBe('100%')
    expect(getComputedStyle(q('.workbench-files-body') as HTMLElement).flexGrow).toBe('1')
    expect(getComputedStyle(q('[data-testid="files-tree"]') as HTMLElement).flexGrow).toBe('1')
    expect(getComputedStyle(q('.workbench-tree-scroll') as HTMLElement).overflow).toBe('auto')
    expect(host.textContent).not.toMatch(/Choose a file|选一个文件查看内容|A created · M|本次会话新建 A/)
    await open('main.ts')
    expect(q('[data-testid="file-preview"]')?.textContent).toBe(TEXT['main.ts'])
    expect(q('[data-testid="files-panel"]')?.dataset.layout).toBe(width >= 640 ? 'split' : 'stacked')
    expect(q('[data-testid="files-divider"]') !== null).toBe(width >= 640)
  })

  it('splits from 640px, sizes the tree at 250px and persists divider drags and arrow keys', async () => {
    observedWidth = 900
    mount(fakeSession())
    await open('main.ts')
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
    await open('main.ts')
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
      await open('main.ts')
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
  it.each(['en', 'zh-CN'] as const)(
    'labels A / M badges and highlights the selection in %s',
    async (locale) => {
      const t = createCatalogTranslator(workbenchLocaleCatalog, locale)
      mount(fakeSession(), { t })
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
      expect(added.title).toBe(locale === 'en' ? 'Created in this session' : '本次会话新建')
      expect(added.querySelector('.agh-visually-hidden')?.textContent).toBe(added.title)
      const modified = q('[data-path="main.ts"] [data-testid="file-change-badge"]') as HTMLElement
      expect(modified.dataset.kind).toBe('modified')
      expect(modified.title).toBe(locale === 'en' ? 'Modified in this session' : '本次会话修改')
      expect(modified.querySelector('.agh-visually-hidden')?.textContent).toBe(modified.title)
      expect(modified.querySelector('[aria-hidden]')?.textContent).toBe('M')
      expect(q('[data-path="story.md"] [data-testid="file-change-badge"]')).toBeNull()
      click('[data-path="story.md"]')
      expect(q('[data-path="story.md"]')?.getAttribute('aria-pressed')).toBe('true')
      expect(q('[data-path="main.ts"]')?.getAttribute('aria-pressed')).toBe('false')
    },
  )

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

  it.each(['en', 'zh-CN'] as const)(
    'opens visibility rules from the header menu in %s and keeps footer notices',
    async (locale) => {
      const header = document.createElement('div')
      header.id = 'files-test-header'
      document.body.append(header)
      const t = createCatalogTranslator(workbenchLocaleCatalog, locale)
      try {
        mount(fakeSession({ truncated: true }), { t }, header.id)
        await vi.waitFor(() => expect(q('[data-testid="files-truncated"]')).not.toBeNull())
        expect(q('[data-testid="files-truncated"]')?.textContent).toBe(t('workbench.files.truncated'))
        expect(q('.workbench-files-summary')?.textContent).toBe(t('workbench.files.summary', { count: 6 }))
        expect(q('.workbench-files-footer button, .workbench-files-footer a')).toBeNull()
        expect(q('[data-testid="files-rules-text"]')).toBeNull()
        const more = header.querySelector('[data-testid="files-more"]') as HTMLElement
        const rulesItem = () => document.querySelector<HTMLElement>('[data-testid="files-rules"]')
        for (const shown of [true, false]) {
          flushSync(() => more.click())
          await vi.waitFor(() => expect(rulesItem()?.getAttribute('role')).toBe('menuitem'))
          expect(rulesItem()?.textContent).toBe(t('workbench.files.scope'))
          flushSync(() => rulesItem()?.click())
          await vi.waitFor(() => expect(more.getAttribute('aria-expanded')).toBe('false'))
          if (shown)
            expect(q('[data-testid="files-rules-text"]')?.textContent).toBe(t('workbench.files.ignore'))
          else expect(q('[data-testid="files-rules-text"]')).toBeNull()
        }
        expect(q('.workbench-files-footer button, .workbench-files-footer a')).toBeNull()
      } finally {
        unmountRegion(host)
        header.remove()
      }
    },
  )
})

describe('FilesPanel preview', () => {
  it('puts path, size, read time and mention in one header and numbers the source lines', async () => {
    const context = mount(fakeSession())
    await open('main.ts')
    const header = q('[data-testid="file-header"]') as HTMLElement
    expect(header.querySelector('.workbench-file-crumb')?.textContent).toBe('WorkLLM/main.ts')
    // Paths are names, not prose: translation leaves the crumb, tree row and tab untouched.
    expect(header.querySelector('.workbench-file-crumb')?.getAttribute('translate')).toBe('no')
    expect(q('[data-path="main.ts"] .workbench-file-name')?.getAttribute('translate')).toBe('no')
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
    // The file tab belongs to the session, so a fresh panel would restore it; start from an empty list.
    localStorage.clear()
    mount(session, { selection: { path: 'src', directory: true } })
    await vi.waitFor(() => expect(q('[data-path="src"]')?.getAttribute('aria-expanded')).toBe('true'))
    expect(q('[data-testid="files-choose"]')).toBeNull()
    // A folder mention opens the folder only; it neither previews nor creates a file tab.
    expect(q('.workbench-file-preview')).toBeNull()
    expect(qa('[data-testid="file-tab"]')).toHaveLength(0)
    expect(q('.workbench-files-body')?.children).toHaveLength(1)
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

it.each(['source', 'preview'] as const)(
  'preserves %s content during an unchanged ledger refresh',
  async (mode) => {
    const session = fakeSession()
    const context = mount(session, { data: { session, timeline: { upto: 1 }, mention: vi.fn() } })
    await open('portal.html')
    if (mode === 'preview') click('[data-testid="file-view-preview"]')
    const selector = mode === 'preview' ? 'iframe' : '[data-testid="file-preview"]'
    await vi.waitFor(() => expect(q(selector)).not.toBeNull())
    const previous = q(selector)
    if (!previous) throw new Error('Missing file preview')
    let finish!: (value: unknown) => void
    vi.mocked(session.workspaceRead).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as typeof finish
        }),
    )
    await act(async () =>
      renderRegion(
        host,
        <FilesPanel context={{ ...context, data: { session, timeline: { upto: 2 }, mention: vi.fn() } }} />,
      ),
    )
    expect(finish).toBeTypeOf('function')
    const remainedWhileReading = previous.isConnected
    await act(async () =>
      finish({
        path: 'portal.html',
        revision: 'rev-portal.html',
        observedAt: '2026-10-14T09:05:00Z',
        size: 2048,
        binary: false,
        truncated: false,
        text: TEXT['portal.html'],
      }),
    )
    await vi.waitFor(() => expect(q(selector)).not.toBeNull())
    expect({ remainedWhileReading, sameNodeAfterRead: q(selector) === previous }).toEqual({
      remainedWhileReading: true,
      sameNodeAfterRead: true,
    })
    vi.mocked(session.workspaceRead).mockResolvedValueOnce({
      path: 'portal.html',
      revision: 'changed',
      observedAt: '2026-10-18T00:00:00Z',
      size: 20,
      binary: false,
      truncated: false,
      text: '<h1>Changed</h1>',
    })
    await act(async () =>
      renderRegion(
        host,
        <FilesPanel context={{ ...context, data: { session, timeline: { upto: 3 }, mention: vi.fn() } }} />,
      ),
    )
    expect(q('[data-testid="file-meta"] time')?.title).toBe('changed')
    if (mode === 'preview') expect(q('iframe')).not.toBe(previous)
    else expect(q(selector)?.textContent).toContain('Changed')
  },
)

it('clears a switched or unreadable file and ignores superseded reads', async () => {
  const session = fakeSession()
  const context = mount(session, { data: { session, timeline: { upto: 1 }, mention: vi.fn() } })
  await open('portal.html')
  const read = vi.mocked(session.workspaceRead)
  let finish!: (value: Awaited<ReturnType<Session['workspaceRead']>>) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () =>
    renderRegion(
      host,
      <FilesPanel context={{ ...context, data: { session, timeline: { upto: 2 }, mention: vi.fn() } }} />,
    ),
  )
  const oldFile = await read.mock.results[0]?.value
  if (!oldFile) throw new Error('Missing initial file read')
  read.mockImplementationOnce(() => new Promise(() => {}))
  click('[data-path="main.ts"]')
  expect(q('[data-testid="file-preview"]')).toBeNull()
  expect(q('[data-testid="file-read-loading"]')).not.toBeNull()
  await act(async () => finish(oldFile))
  expect(q('[data-testid="file-preview"]')).toBeNull()
  // Return to the first path and let a newer read supersede an older successful response.
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  click('[data-path="portal.html"]')
  read.mockResolvedValueOnce({ ...oldFile, revision: 'new', text: '<h1>New</h1>' })
  await act(async () =>
    renderRegion(
      host,
      <FilesPanel context={{ ...context, data: { session, timeline: { upto: 3 }, mention: vi.fn() } }} />,
    ),
  )
  await act(async () => finish(oldFile))
  expect(q('[data-testid="file-preview"]')?.textContent).toContain('New')
  read.mockRejectedValueOnce(new Error('Permission revoked or file deleted'))
  await act(async () =>
    renderRegion(
      host,
      <FilesPanel context={{ ...context, data: { session, timeline: { upto: 4 }, mention: vi.fn() } }} />,
    ),
  )
  expect(q('[data-testid="file-preview"]')).toBeNull()
  expect(q('[data-testid="file-read-error"]')).not.toBeNull()
  read.mockResolvedValueOnce(oldFile)
  click('[data-testid="file-read-retry"]')
  await vi.waitFor(() => expect(q('[data-testid="file-preview"]')).not.toBeNull())
  // A different read authority must also clear cached bytes, even with the same session id/path.
  const replacement = fakeSession()
  vi.mocked(replacement.workspaceRead).mockImplementation(() => new Promise(() => {}))
  await act(async () =>
    renderRegion(
      host,
      <FilesPanel
        context={{ ...context, data: { session: replacement, timeline: { upto: 4 }, mention: vi.fn() } }}
      />,
    ),
  )
  expect(q('[data-testid="file-preview"]')).toBeNull()
})

describe('file tabs', () => {
  it('opens each file in its own tab, reuses an open path and keeps the strip accessible', async () => {
    mount(fakeSession())
    await open('main.ts')
    await open('story.md')
    expect(qa('[data-testid="file-tab"]')).toHaveLength(2)
    expect(q('[data-testid="file-tab"][data-path="story.md"]')?.dataset.active).toBe('true')
    // A toolbar, not a tablist: a tablist may own only tabs, and each tab also needs a close button.
    expect(q('[data-testid="file-tabs"]')?.getAttribute('role')).toBe('toolbar')
    expect(
      q('[data-testid="file-tab"][data-path="story.md"] [data-testid="file-tab-select"]')?.getAttribute(
        'translate',
      ),
    ).toBe('no')
    expect(
      q('[data-testid="file-tab"][data-path="story.md"] [data-testid="file-tab-select"]')?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true')
    expect(
      q('[data-testid="file-tab"][data-path="main.ts"] [data-testid="file-tab-select"]')?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('false')
    expect(q('#workbench-file-panel')?.getAttribute('aria-label')).toBe('Read-only file preview')
    // The highlighted tree row follows the active tab, not the last click.
    expect(q('[data-path="story.md"]')?.getAttribute('aria-pressed')).toBe('true')
    click('[data-path="main.ts"]')
    click('[data-path="main.ts"]')
    await vi.waitFor(() => expect(q('[data-testid="file-preview"]')?.textContent).toBe(TEXT['main.ts']))
    expect(qa('[data-testid="file-tab"]')).toHaveLength(2)
    expect(q('[data-path="main.ts"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-path="story.md"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('closes to the right neighbour, then the left, and returns focus to the tree after the last tab', async () => {
    mount(fakeSession())
    await open('main.ts')
    await open('story.md')
    await open('portal.html')
    const closeTab = (path: string) =>
      flushSync(() =>
        (
          q(`[data-testid="file-tab"][data-path="${path}"] [data-testid="file-tab-close"]`) as HTMLElement
        ).click(),
      )
    closeTab('story.md')
    expect(qa('[data-testid="file-tab"]').map((tab) => tab.dataset.path)).toEqual(['main.ts', 'portal.html'])
    expect(q('[data-testid="file-tab"][data-path="portal.html"]')?.dataset.active).toBe('true')
    expect(document.activeElement?.id).toBe('workbench-file-tab-1')
    closeTab('portal.html')
    expect(q('[data-testid="file-tab"][data-path="main.ts"]')?.dataset.active).toBe('true')
    expect(document.activeElement?.id).toBe('workbench-file-tab-0')
    closeTab('main.ts')
    expect(qa('[data-testid="file-tab"]')).toHaveLength(0)
    expect(q('.workbench-file-preview')).toBeNull()
    expect(q('.workbench-files-body')?.children).toHaveLength(1)
    expect(document.activeElement?.getAttribute('data-testid')).toBe('workspace-file')
  })

  it('keeps each tab view mode and source scroll position', async () => {
    mount(fakeSession())
    await open('portal.html')
    click('[data-testid="file-view-preview"]')
    expect(q('[data-testid="file-rendered"]')).not.toBeNull()
    await open('main.ts')
    const pre = q('[data-testid="file-preview"]') as HTMLElement
    flushSync(() => {
      pre.scrollTop = 120
      pre.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    click('[data-testid="file-tab"][data-path="portal.html"] [data-testid="file-tab-select"]')
    await vi.waitFor(() => expect(q('[data-testid="file-rendered"]')).not.toBeNull())
    click('[data-testid="file-tab"][data-path="main.ts"] [data-testid="file-tab-select"]')
    await vi.waitFor(() => expect(q('[data-testid="file-preview"]')).not.toBeNull())
    expect((q('[data-testid="file-preview"]') as HTMLElement).scrollTop).toBe(120)
    const saved = JSON.parse(localStorage.getItem(FILE_TABS_KEY('s')) ?? '{}')
    expect(saved.modes['portal.html']).toBe('preview')
  })

  it('restores the open tabs per session and ignores damaged storage', async () => {
    mount(fakeSession())
    await open('main.ts')
    await open('story.md')
    unmountRegion(host)
    mount(fakeSession())
    await vi.waitFor(() => expect(qa('[data-testid="file-tab"]')).toHaveLength(2))
    await vi.waitFor(() => expect(q('[data-testid="file-meta"] time')?.title).toBe('rev-story.md'))
    expect(q('[data-testid="file-preview"]')?.textContent).toBe(TEXT['story.md'])
    // Another session reads its own list, not this one.
    unmountRegion(host)
    const other = fakeSession()
    Object.defineProperty(other, 'id', { value: 'other' })
    mount(other)
    await vi.waitFor(() => expect(q('[data-path="main.ts"]')).not.toBeNull())
    expect(qa('[data-testid="file-tab"]')).toHaveLength(0)
    unmountRegion(host)
    localStorage.setItem(
      FILE_TABS_KEY('s'),
      JSON.stringify({
        tabs: ['portal.html', 'portal.html', 7, null, ''],
        active: 'gone',
        modes: { 'portal.html': 'preview' },
      }),
    )
    mount(fakeSession())
    await vi.waitFor(() => expect(qa('[data-testid="file-tab"]')).toHaveLength(1))
    await vi.waitFor(() => expect(q('[data-testid="file-rendered"]')).not.toBeNull())
    unmountRegion(host)
    localStorage.setItem(FILE_TABS_KEY('s'), '{not json')
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-path="main.ts"]')).not.toBeNull())
    expect(qa('[data-testid="file-tab"]')).toHaveLength(0)
  })

  it('reveals the restored tab in the tree by opening its folders', async () => {
    localStorage.setItem(
      FILE_TABS_KEY('s'),
      JSON.stringify({ tabs: ['src/util.ts', 'story.md'], active: 'src/util.ts' }),
    )
    mount(fakeSession())
    await vi.waitFor(() => expect(q('[data-path="src/util.ts"]')?.getAttribute('aria-pressed')).toBe('true'))
    expect(q('[data-path="src"]')?.getAttribute('aria-expanded')).toBe('true')
    // The other restored tab stays available without expanding anything else.
    expect(qa('[data-testid="file-tab"]')).toHaveLength(2)
  })

  it('keeps a failed read inside its own tab', async () => {
    const session = fakeSession()
    const read = session.workspaceRead as unknown as ReturnType<typeof vi.fn>
    const original = read.getMockImplementation() as (path: string) => Promise<object>
    read.mockImplementation(async (path: string) => {
      if (path === 'story.md') throw new Error('Permission denied for story.md')
      return original(path)
    })
    mount(session)
    await open('portal.html')
    click('[data-path="story.md"]')
    await vi.waitFor(() => expect(q('[data-testid="file-read-error"]')).not.toBeNull())
    expect(q('[data-testid="file-preview"]')).toBeNull()
    click('[data-testid="file-tab"][data-path="portal.html"] [data-testid="file-tab-select"]')
    await vi.waitFor(() => expect(q('[data-testid="file-preview"]')?.textContent).toBe(TEXT['portal.html']))
    expect(q('[data-testid="file-read-error"]')).toBeNull()
    click('[data-testid="file-tab"][data-path="story.md"] [data-testid="file-tab-select"]')
    await vi.waitFor(() => expect(q('[data-testid="file-read-error"]')).not.toBeNull())
    expect(q('[data-testid="file-preview"]')).toBeNull()
  })

  it('re-reads only the active tab on ledger changes', async () => {
    const session = fakeSession()
    const context = mount(session, { data: { session, timeline: { upto: 1 }, mention: vi.fn() } })
    await open('main.ts')
    click('[data-path="story.md"]')
    await vi.waitFor(() => expect(q('[data-testid="file-meta"] time')?.title).toBe('rev-story.md'))
    const read = vi.mocked(session.workspaceRead)
    const before = read.mock.calls.length
    await act(async () =>
      renderRegion(
        host,
        <FilesPanel context={{ ...context, data: { session, timeline: { upto: 2 }, mention: vi.fn() } }} />,
      ),
    )
    await vi.waitFor(() => expect(read.mock.calls.length).toBe(before + 1))
    expect(read.mock.calls.at(-1)?.[0]).toBe('story.md')
  })

  it('caps open tabs and says why a new one was refused', async () => {
    const entries = Array.from({ length: MAX_FILE_TABS + 1 }, (_, index) => ({
      name: `f${index}.ts`,
      kind: 'file' as const,
    }))
    mount(fakeSession({ entries: { '': entries } }))
    await vi.waitFor(() => expect(q('[data-path="f0.ts"]')).not.toBeNull())
    for (let index = 0; index < MAX_FILE_TABS; index += 1) click(`[data-path="f${index}.ts"]`)
    await vi.waitFor(() => expect(qa('[data-testid="file-tab"]')).toHaveLength(MAX_FILE_TABS))
    click(`[data-path="f${MAX_FILE_TABS}.ts"]`)
    expect(qa('[data-testid="file-tab"]')).toHaveLength(MAX_FILE_TABS)
    expect(q('[data-testid="files-tabs-limit"]')?.textContent).toBe(
      'Up to 20 files can be open at once. Close one first.',
    )
  })

  it('tells same-named files apart by their folder', async () => {
    mount(
      fakeSession({
        entries: {
          '': [
            { name: 'src', kind: 'directory' },
            { name: 'test', kind: 'directory' },
          ],
          src: [{ name: 'util.ts', kind: 'file' }],
          test: [{ name: 'util.ts', kind: 'file' }],
        },
      }),
    )
    await vi.waitFor(() => expect(q('[data-path="src"]')).not.toBeNull())
    click('[data-path="src"]')
    await open('src/util.ts')
    click('[data-path="test"]')
    await open('test/util.ts')
    expect(qa('.workbench-file-tab-name').map((element) => element.textContent)).toEqual([
      'src/util.ts',
      'test/util.ts',
    ])
  })
})
