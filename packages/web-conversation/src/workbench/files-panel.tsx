import type { SessionWorkspaceListResult, SessionWorkspaceReadResult } from '@agnes/protocol'
import { fileViewerActions, type UiExtensionContext } from '@agnes/web-client'
import {
  appServerErrorMessage,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  SearchBar,
  SettingsState,
} from '@agnes/web-ui'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { panelContext } from './context.js'
import { FilePreview, type FileViewMode } from './files-preview.js'
import { FileTabs } from './files-tabs.js'
import { countVisible, FileTree, type SessionChange } from './files-tree.js'

/** At this panel width the tree moves beside the preview instead of above it. */
export const FILES_SPLIT_WIDTH = 640
export const TREE_DEFAULT = 250
const TREE_MIN = 160
const PREVIEW_MIN = 280
export const TREE_WIDTH_KEY = 'agnes.workbench.files.treeWidth'
export const WRAP_KEY = 'agnes.workbench.files.wrap'
/** Open files are remembered per session; the file contents themselves are never stored. */
export const FILE_TABS_KEY = (sessionId: string) => `agnes.workbench.files.tabs.${sessionId}`
export const MAX_FILE_TABS = 20

/** The last read of each tab stays cached so switching back shows it while the reread runs. */
type FileRecord = { file: SessionWorkspaceReadResult | undefined; error: string }

type StoredTabs = {
  tabs: string[]
  active: string
  modes: Record<string, FileViewMode>
}

/** Layout preferences are per browser; storage that throws or is absent leaves the defaults. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* the preference lasts for this panel only */
  }
}
function storedWidth(): number {
  const value = Number(stored(TREE_WIDTH_KEY))
  return Number.isFinite(value) && value >= TREE_MIN ? value : TREE_DEFAULT
}

/**
 * Stored tabs are untrusted: keep strings only, drop duplicates, cap the list and fall the active tab
 * back into it. A path that lost read access is kept and shows its read error; restoring grants nothing.
 */
function readStoredTabs(sessionId: string): StoredTabs | undefined {
  const raw = stored(FILE_TABS_KEY(sessionId))
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as { tabs?: unknown; active?: unknown; modes?: unknown }
    const tabs = Array.isArray(value.tabs)
      ? [
          ...new Set(
            value.tabs
              .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
              .slice(0, MAX_FILE_TABS),
          ),
        ]
      : []
    if (!tabs.length) return undefined
    const active =
      typeof value.active === 'string' && tabs.includes(value.active) ? value.active : (tabs[0] ?? '')
    const modes: Record<string, FileViewMode> = {}
    if (value.modes && typeof value.modes === 'object' && !Array.isArray(value.modes)) {
      const entries = value.modes as Record<string, unknown>
      for (const path of tabs) {
        const mode = entries[path]
        if (mode === 'source' || mode === 'preview') modes[path] = mode
      }
    }
    return { tabs, active, modes }
  } catch {
    return undefined
  }
}
function storeTabs(sessionId: string, value: StoredTabs) {
  try {
    localStorage.setItem(FILE_TABS_KEY(sessionId), JSON.stringify(value))
  } catch {
    /* the tabs last for this panel only */
  }
}

/** A path outside the workspace is absolute: no folder rows in the tree hold it. */
function outsideTree(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)
}

/** The folder rows that hold a workspace-relative path, outermost first. */
function treeFolders(path: string): string[] {
  if (!path || outsideTree(path)) return []
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** Two open files with the same name are told apart by their parent folder. */
function tabNames(tabs: readonly string[]): Map<string, string> {
  const segments = new Map(tabs.map((path) => [path, path.split(/[\\/]/u).filter(Boolean)]))
  const counts = new Map<string, number>()
  for (const parts of segments.values()) {
    const name = parts.at(-1) ?? ''
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return new Map(
    [...segments].map(([path, parts]) => {
      const name = parts.at(-1) ?? path
      const parent = parts.at(-2)
      return [path, (counts.get(name) ?? 0) > 1 && parent ? `${parent}/${name}` : name] as const
    }),
  )
}

/** The panel's own width, not the window's: the dock can be dragged or expanded independently. */
function usePanelWidth() {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [element, setElement, width] as const
}

export function FilesPanel({ context, headerId }: { context: UiExtensionContext; headerId?: string }) {
  const [header, setHeader] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeader(headerId ? document.getElementById(headerId) : null)
  }, [headerId])
  const { session, timeline, mention, workspace } = panelContext(context)
  const { t } = context
  useSyncExternalStore(fileViewerActions.subscribe, fileViewerActions.getSnapshot)
  const [directories, setDirectories] = useState<Record<string, SessionWorkspaceListResult>>({})
  const [expanded, setExpanded] = useState<string[]>([''])
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [records, setRecords] = useState<Record<string, FileRecord>>({})
  const [modes, setModes] = useState<Record<string, FileViewMode>>({})
  // Session id whose saved tabs were loaded: persistence must not write the pre-restore empty list.
  const [restoredFor, setRestoredFor] = useState('')
  const [limit, setLimit] = useState(false)
  const [changes, setChanges] = useState<ReadonlyMap<string, SessionChange>>(new Map())
  // Folder listing and file reading fail separately: one succeeding never hides the other's failure.
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [reread, setReread] = useState(0)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState(false)
  const [wrap, setWrap] = useState(() => stored(WRAP_KEY) === 'true')
  const [treeWidth, setTreeWidth] = useState(storedWidth)
  const [panel, ref, width] = usePanelWidth()
  const activeIndex = tabs.indexOf(active)
  const split = activeIndex >= 0 && width >= FILES_SPLIT_WIDTH
  const maxTree = Math.max(TREE_MIN, width - PREVIEW_MIN)
  const shownWidth = Math.min(Math.max(treeWidth, TREE_MIN), maxTree)
  // Scroll offsets stay in memory only: a page reload changes the text height they would point into.
  const scroll = useRef<Record<string, number>>({})
  // Per-path request ordinals discard a superseded read without letting one tab's response write another.
  const reads = useRef(new Map<string, number>())
  const previousSession = useRef<typeof session>()
  // A tab click or close moves focus once its DOM update has committed; the tree is the fallback.
  const focusAfter = useRef<string | 'tree' | null>(null)
  useLayoutEffect(() => {
    if (split) panel?.style.setProperty('--workbench-tree-width', `${shownWidth}px`)
    else panel?.style.removeProperty('--workbench-tree-width')
  }, [panel, split, shownWidth])
  const version = timeline?.upto
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session resets the tree and restores its saved tabs.
  useEffect(() => {
    if (!session) return
    const saved = readStoredTabs(session.id)
    // The restored tab is highlighted only when its folders are open, so reveal its row as well.
    setExpanded(['', ...treeFolders(saved?.active ?? '')])
    setDirectories({})
    setChanges(new Map())
    setQuery('')
    setTabs(saved?.tabs ?? [])
    setActive(saved?.active ?? '')
    setModes(saved?.modes ?? {})
    setRecords({})
    setLimit(false)
    scroll.current = {}
    setRestoredFor(session.id)
  }, [session?.id])
  // A replaced session object is a new read authority: the tabs stay, their cached bytes do not.
  useLayoutEffect(() => {
    const previous = previousSession.current
    previousSession.current = session
    if (!session || !previous || previous === session || previous.id !== session.id) return
    setRecords({})
  }, [session])
  // Only the tab list, the active tab and the view modes are stored; reads and errors are not.
  useEffect(() => {
    if (!session || restoredFor !== session.id) return
    storeTabs(session.id, { tabs, active, modes })
  }, [session, restoredFor, tabs, active, modes])
  // A file chip asks for a path: open its folders and show the file tab, or open the folder itself.
  const requested = context.selection as { path?: unknown; directory?: unknown } | undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new request opens its folders and tab once.
  useEffect(() => {
    if (!session || typeof requested?.path !== 'string') return
    const path = requested.path
    // Outside the workspace only the read is tried; the workspace's visibility rules answer it.
    const parts = outsideTree(path) ? [] : path.split('/').filter(Boolean)
    const folders = parts.slice(0, requested.directory === true ? parts.length : -1)
    const ancestors = folders.map((_, index) => folders.slice(0, index + 1).join('/'))
    setQuery('')
    setExpanded((paths) => [...new Set([...paths, ...ancestors])])
    if (requested.directory !== true) openPath(path)
  }, [session, requested])
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and ledger watermarks invalidate workspace lists.
  useEffect(() => {
    let live = true
    if (!session) return
    setLoading(true)
    void Promise.all(expanded.map((path) => session.workspaceList(path)))
      .then((values) => {
        if (!live) return
        setDirectories(Object.fromEntries(values.map((value) => [value.path, value])))
        setError('')
      })
      .catch((cause) => {
        if (live)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [session, expanded, refresh, version, t])
  // The A / M marks reuse the review tab's session-scope change list; without it rows carry no mark.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and ledger watermarks invalidate the change list.
  useEffect(() => {
    let live = true
    if (typeof session?.workspaceChanges !== 'function') return
    session
      .workspaceChanges({ scope: 'session' })
      .then((result) => {
        if (live)
          setChanges(
            new Map(
              result.files.map(({ path, kind, added, removed }) => [
                path,
                {
                  kind,
                  ...(added === undefined ? {} : { added }),
                  ...(removed === undefined ? {} : { removed }),
                },
              ]),
            ),
          )
      })
      .catch(() => {
        if (live) setChanges(new Map())
      })
    return () => {
      live = false
    }
  }, [session, refresh, version])
  // Only the active tab re-reads on refresh, retry and ledger changes; the others re-read when activated.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh, retry and ledger watermarks re-read the active tab.
  useEffect(() => {
    let live = true
    if (!session || !active) return
    const path = active
    const request = (reads.current.get(path) ?? 0) + 1
    reads.current.set(path, request)
    // The previous text stays on screen during a reread; an error is stale the moment the read starts.
    setRecords((previous) => ({ ...previous, [path]: { file: previous[path]?.file, error: '' } }))
    void session
      .workspaceRead(path)
      .then((value) => {
        if (!live || reads.current.get(path) !== request) return
        setRecords((previous) => {
          const current = previous[path]?.file
          const same =
            current?.revision === value.revision &&
            current.text === value.text &&
            current.binary === value.binary &&
            current.truncated === value.truncated &&
            current.size === value.size
          return { ...previous, [path]: { file: same ? current : value, error: '' } }
        })
      })
      .catch((cause) => {
        // A failed read cannot establish continuing visibility (including deletion/revocation).
        if (!live || reads.current.get(path) !== request) return
        setRecords((previous) => ({
          ...previous,
          [path]: {
            file: undefined,
            error: appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'),
          },
        }))
      })
    return () => {
      live = false
    }
  }, [session, active, refresh, reread, version, t])
  // The closed tab's neighbour takes focus; closing the last tab returns focus to the file tree.
  useLayoutEffect(() => {
    const target = focusAfter.current
    if (target === null) return
    focusAfter.current = null
    if (target === 'tree') {
      panel?.querySelector<HTMLElement>('[data-testid="workspace-file"]')?.focus()
      return
    }
    const element = [...(panel?.querySelectorAll<HTMLElement>('[data-testid="file-tab"]') ?? [])].find(
      (tab) => tab.dataset.path === target,
    )
    element?.querySelector<HTMLElement>('[data-testid="file-tab-select"]')?.focus()
    // No dependency list: a queued focus request is applied once the DOM of the commit above exists.
  })
  if (!session) return <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
  const openPath = (path: string) => {
    if (!path) return
    if (tabs.includes(path)) {
      setActive(path)
      return
    }
    if (tabs.length >= MAX_FILE_TABS) {
      setLimit(true)
      return
    }
    setLimit(false)
    setTabs([...tabs, path])
    setActive(path)
  }
  const activatePath = (path: string) => {
    if (tabs.includes(path)) setActive(path)
  }
  const closePath = (path: string) => {
    const index = tabs.indexOf(path)
    if (index < 0) return
    const remaining = tabs.filter((entry) => entry !== path)
    const neighbour = remaining[index] ?? remaining[index - 1] ?? ''
    focusAfter.current = neighbour || 'tree'
    setLimit(false)
    setTabs(remaining)
    setRecords((previous) => {
      const next = { ...previous }
      delete next[path]
      return next
    })
    setModes((previous) => {
      const next = { ...previous }
      delete next[path]
      return next
    })
    delete scroll.current[path]
    if (active === path) setActive(neighbour)
  }
  const showMode = (mode: FileViewMode) => {
    if (!active) return
    setModes((previous) => ({ ...previous, [active]: mode }))
  }
  const rememberScroll = (top: number) => {
    if (active) scroll.current[active] = top
  }
  const rereadActive = () => setReread((value) => value + 1)
  const resize = (next: number, persist: boolean) => {
    const value = Math.round(Math.min(Math.max(next, TREE_MIN), maxTree))
    setTreeWidth(value)
    if (persist) store(TREE_WIDTH_KEY, String(value))
  }
  const toggleWrap = () =>
    setWrap((value) => {
      store(WRAP_KEY, String(!value))
      return !value
    })
  const root = directories['']
  const visible = countVisible(directories, expanded, query)
  const names = tabNames(tabs)
  const record = records[active]
  return (
    <section
      ref={ref}
      className={`workbench-files${activeIndex >= 0 ? ' workbench-files-previewing' : ''}`}
      data-layout={split ? 'split' : 'stacked'}
      data-testid="files-panel"
      aria-label={t('workbench.files.title')}
    >
      {header &&
        createPortal(
          <>
            <Button
              type="text"
              size="small"
              title={t('workbench.files.refresh')}
              aria-label={t('workbench.files.refresh')}
              aria-busy={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <Icon name="refresh-cw" />
            </Button>
            <Menu
              label={t('workbench.files.more')}
              trigger={
                <IconButton name="ellipsis" label={t('workbench.files.more')} data-testid="files-more" />
              }
              items={[
                {
                  id: 'rules',
                  label: t('workbench.files.scope'),
                  testId: 'files-rules',
                  onSelect: () => setRules((value) => !value),
                },
                {
                  id: 'wrap',
                  label: t(wrap ? 'workbench.files.wrapOff' : 'workbench.files.wrapOn'),
                  testId: 'files-wrap',
                  onSelect: toggleWrap,
                },
              ]}
            />
          </>,
          header,
        )}
      {error && (
        <SettingsState tone="error">
          {error}
          <Button size="small" onClick={() => setRefresh((value) => value + 1)}>
            {t('workbench.retry')}
          </Button>
        </SettingsState>
      )}
      <div className="workbench-files-body">
        <div className="workbench-files-tree" data-testid="files-tree">
          <SearchBar
            className="workbench-files-filter"
            label={t('workbench.files.filter')}
            placeholder={t('workbench.files.filter')}
            value={query}
            onChange={setQuery}
            inputProps={{ 'data-testid': 'files-filter' }}
          />
          <div className="workbench-tree-scroll">
            <FileTree
              directories={directories}
              expanded={expanded}
              selected={active}
              query={query}
              changes={changes}
              t={t}
              select={openPath}
              mentionFolder={(path) => mention(path, true)}
              toggle={(path) =>
                setExpanded((paths) =>
                  paths.includes(path)
                    ? paths.filter((value) => value !== path && !value.startsWith(`${path}/`))
                    : [...paths, path],
                )
              }
            />
            {query.trim() && root && visible === 0 && (
              <p className="workbench-files-note" role="status">
                {t('workbench.files.noMatch')}
              </p>
            )}
            {root?.entries.length === 0 && (
              <EmptyState
                icon={<Icon name="folder" size={48} />}
                title={t('workbench.files.empty')}
                description={t('workbench.files.emptyHelp')}
              />
            )}
          </div>
          <footer className="workbench-files-footer">
            {Object.values(directories).some((value) => value.truncated) && (
              <p role="status" data-testid="files-truncated">
                {t('workbench.files.truncated')}
              </p>
            )}
            {root?.gitStatus === 'unavailable' && <p role="status">{t('workbench.git.unavailable')}</p>}
            <p className="workbench-files-summary">
              <span>{t('workbench.files.summary', { count: visible })}</span>
            </p>
            {rules && (
              <p className="workbench-files-rules" data-testid="files-rules-text">
                {t('workbench.files.ignore')}
              </p>
            )}
          </footer>
        </div>
        {split && (
          // biome-ignore lint/a11y/useSemanticElements: a focusable splitter is a separator with a value, not an <hr>.
          <div
            className="workbench-files-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.files.resize')}
            title={t('workbench.files.resizeHint')}
            aria-valuemin={TREE_MIN}
            aria-valuemax={maxTree}
            aria-valuenow={shownWidth}
            tabIndex={0}
            data-testid="files-divider"
            onDoubleClick={() => resize(TREE_DEFAULT, true)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              resize(shownWidth + (event.key === 'ArrowLeft' ? -16 : 16), true)
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              const element = event.currentTarget
              element.setPointerCapture?.(event.pointerId)
              const origin = event.clientX
              const start = shownWidth
              element.dataset.dragging = 'true'
              let last = start
              const move = (next: PointerEvent) => {
                last = start + next.clientX - origin
                resize(last, false)
              }
              const end = (event: PointerEvent) => {
                delete element.dataset.dragging
                resize(event.type === 'pointerup' ? start + event.clientX - origin : last, true)
                element.removeEventListener('pointermove', move)
                element.removeEventListener('pointerup', end)
                element.removeEventListener('pointercancel', end)
              }
              element.addEventListener('pointermove', move)
              element.addEventListener('pointerup', end)
              element.addEventListener('pointercancel', end)
            }}
          />
        )}
        {activeIndex >= 0 && (
          <div className="workbench-file-pane" data-testid="file-pane">
            <FileTabs
              tabs={tabs}
              active={active}
              t={t}
              label={(path) => names.get(path) ?? path}
              closeLabel={(path) => t('workbench.files.tabs.close', { name: names.get(path) ?? path })}
              activate={activatePath}
              close={closePath}
            />
            {limit && (
              <p className="workbench-files-note" role="status" data-testid="files-tabs-limit">
                {t('workbench.files.tabs.limit', { count: MAX_FILE_TABS })}
              </p>
            )}
            <section
              className="workbench-file-preview"
              id="workbench-file-panel"
              aria-label={t('workbench.files.preview')}
            >
              <FilePreview
                context={context}
                path={active}
                file={record?.file}
                error={record?.error ?? ''}
                retry={rereadActive}
                change={changes.get(active)}
                workspace={workspace?.name}
                wrap={wrap}
                mention={mention}
                mode={modes[active] ?? 'source'}
                onModeChange={showMode}
                scrollTop={scroll.current[active] ?? 0}
                onScroll={rememberScroll}
              />
            </section>
          </div>
        )}
      </div>
    </section>
  )
}
