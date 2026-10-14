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
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { panelContext } from './context.js'
import { FilePreview } from './files-preview.js'
import { countVisible, FileTree, type SessionChange } from './files-tree.js'

/** At this panel width the tree moves beside the preview instead of above it. */
export const FILES_SPLIT_WIDTH = 640
export const TREE_DEFAULT = 250
const TREE_MIN = 160
const PREVIEW_MIN = 280
export const TREE_WIDTH_KEY = 'agnes.workbench.files.treeWidth'
export const WRAP_KEY = 'agnes.workbench.files.wrap'

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
  const [selected, setSelected] = useState('')
  const [file, setFile] = useState<SessionWorkspaceReadResult>()
  const [changes, setChanges] = useState<ReadonlyMap<string, SessionChange>>(new Map())
  // Folder listing and file reading fail separately: one succeeding never hides the other's failure.
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [reread, setReread] = useState(0)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState(false)
  const [wrap, setWrap] = useState(() => stored(WRAP_KEY) === 'true')
  const [treeWidth, setTreeWidth] = useState(storedWidth)
  const [panel, ref, width] = usePanelWidth()
  const split = width >= FILES_SPLIT_WIDTH
  const maxTree = Math.max(TREE_MIN, width - PREVIEW_MIN)
  const shownWidth = Math.min(Math.max(treeWidth, TREE_MIN), maxTree)
  useLayoutEffect(() => {
    if (split) panel?.style.setProperty('--workbench-tree-width', `${shownWidth}px`)
    else panel?.style.removeProperty('--workbench-tree-width')
  }, [panel, split, shownWidth])
  const version = timeline?.upto
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session resets the directory and preview state.
  useEffect(() => {
    setExpanded([''])
    setSelected('')
    setFile(undefined)
    setDirectories({})
    setChanges(new Map())
    setQuery('')
  }, [session?.id])
  // A file chip asks for a path: open its folders and show the file, or open the folder itself.
  const requested = context.selection as { path?: unknown; directory?: unknown } | undefined
  useEffect(() => {
    if (!session || typeof requested?.path !== 'string') return
    const path = requested.path
    // A path outside the workspace is absolute: no folders of the tree hold it, so only the read is
    // tried, and the workspace's visibility rules answer it.
    const outside = path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)
    const parts = outside ? [] : path.split('/').filter(Boolean)
    const folders = parts.slice(0, requested.directory === true ? parts.length : -1)
    const ancestors = folders.map((_, index) => folders.slice(0, index + 1).join('/'))
    setQuery('')
    setExpanded((paths) => [...new Set([...paths, ...ancestors])])
    setSelected(requested.directory === true ? '' : path)
  }, [session, requested])
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and ledger watermarks invalidate workspace reads.
  useEffect(() => {
    let active = true
    if (!session) return
    setLoading(true)
    void Promise.all(expanded.map((path) => session.workspaceList(path)))
      .then((values) => {
        if (!active) return
        setDirectories(Object.fromEntries(values.map((value) => [value.path, value])))
        setError('')
      })
      .catch((cause) => {
        if (active)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [session, expanded, refresh, version, t])
  // The A / M marks reuse the review tab's session-scope change list; without it rows carry no mark.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and ledger watermarks invalidate the change list.
  useEffect(() => {
    let active = true
    if (typeof session?.workspaceChanges !== 'function') return
    session
      .workspaceChanges({ scope: 'session' })
      .then((result) => {
        if (active)
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
        if (active) setChanges(new Map())
      })
    return () => {
      active = false
    }
  }, [session, refresh, version])
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and ledger watermarks invalidate workspace reads.
  useEffect(() => {
    let active = true
    setFile(undefined)
    setReadError('')
    if (!session || !selected) return
    void session
      .workspaceRead(selected)
      .then((value) => {
        if (active) setFile(value)
      })
      .catch((cause) => {
        if (active)
          setReadError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      })
    return () => {
      active = false
    }
  }, [session, selected, refresh, reread, version, t])
  if (!session) return <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
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
  return (
    <section
      ref={ref}
      className={`workbench-files${selected ? ' workbench-files-previewing' : ''}`}
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
              selected={selected}
              query={query}
              changes={changes}
              t={t}
              select={setSelected}
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
              <Button
                type="link"
                size="small"
                data-testid="files-rules"
                aria-expanded={rules}
                title={t('workbench.files.scope')}
                onClick={() => setRules((value) => !value)}
              >
                {t('workbench.files.rules')}
              </Button>
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
        <section className="workbench-file-preview" aria-label={t('workbench.files.preview')}>
          {selected ? (
            <FilePreview
              context={context}
              path={selected}
              file={file}
              error={readError}
              retry={() => setReread((value) => value + 1)}
              change={changes.get(selected)}
              workspace={workspace?.name}
              wrap={wrap}
              mention={mention}
            />
          ) : (
            <div className="workbench-files-choose" data-testid="files-choose">
              <p>{t('workbench.files.choose')}</p>
              <p className="workbench-files-legend">{t('workbench.files.legend')}</p>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}
