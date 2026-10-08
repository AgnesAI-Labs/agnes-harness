import type { SessionWorkspaceListResult, SessionWorkspaceReadResult } from '@agnes/protocol'
import { fileViewerActions, type UiExtensionContext } from '@agnes/web-client'
import { appServerErrorMessage, Button, SettingsState } from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { panelContext } from './context.js'
import { Highlight } from './highlight.js'

export function FilesPanel({ context, headerId }: { context: UiExtensionContext; headerId?: string }) {
  const [header, setHeader] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeader(headerId ? document.getElementById(headerId) : null)
  }, [headerId])
  const { session, timeline, mention } = panelContext(context)
  const { t } = context
  useSyncExternalStore(fileViewerActions.subscribe, fileViewerActions.getSnapshot)
  const [directories, setDirectories] = useState<Record<string, SessionWorkspaceListResult>>({})
  const [expanded, setExpanded] = useState<string[]>([''])
  const [selected, setSelected] = useState('')
  const [file, setFile] = useState<SessionWorkspaceReadResult>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const version = timeline?.upto
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session resets the directory and preview state.
  useEffect(() => {
    setExpanded([''])
    setSelected('')
    setFile(undefined)
    setDirectories({})
  }, [session?.id])
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh and ledger watermarks invalidate workspace reads.
  useEffect(() => {
    let active = true
    setFile(undefined)
    if (!session || !selected) return
    void session
      .workspaceRead(selected)
      .then((value) => {
        if (active) {
          setFile(value)
          setError('')
        }
      })
      .catch((cause) => {
        if (active)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      })
    return () => {
      active = false
    }
  }, [session, selected, refresh, version, t])
  if (!session) return <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
  const tree = (path: string) => (
    <ul className="workbench-file-tree">
      {directories[path]?.entries.map((entry) => {
        const child = path ? `${path}/${entry.name}` : entry.name
        const directory = entry.kind === 'directory'
        const open = expanded.includes(child)
        return (
          <li key={child}>
            <Button
              type="text"
              size="small"
              disabled={entry.kind === 'other'}
              className="workbench-file-entry"
              data-testid="workspace-file"
              data-path={child}
              aria-expanded={directory ? open : undefined}
              aria-pressed={directory ? undefined : selected === child}
              onClick={() =>
                directory
                  ? setExpanded((paths) =>
                      open
                        ? paths.filter((value) => value !== child && !value.startsWith(`${child}/`))
                        : [...paths, child],
                    )
                  : setSelected(child)
              }
            >
              <span className="workbench-file-chevron" aria-hidden="true">
                {directory ? (open ? '▾' : '▸') : ''}
              </span>
              <svg className="workbench-file-icon" viewBox="0 0 24 24" aria-hidden="true">
                {directory ? (
                  <path d="M3 7V5h7l2 2h9v13H3Z" />
                ) : (
                  <>
                    <path d="M6 3h8l4 4v14H6Z" />
                    <path d="M14 3v5h4" />
                  </>
                )}
              </svg>
              <span className="workbench-file-name">{entry.name}</span>
              {entry.git && <span className="workbench-git-mark">{t(`workbench.git.${entry.git}`)}</span>}
            </Button>
            {directory && open && tree(child)}
          </li>
        )
      })}
      {directories[path]?.truncated && <li role="status">{t('workbench.files.truncated')}</li>}
    </ul>
  )
  return (
    <section
      className={`workbench-files${selected ? ' workbench-files-previewing' : ''}`}
      data-testid="files-panel"
      aria-label={t('workbench.files.title')}
    >
      {header &&
        createPortal(
          <Button
            type="text"
            size="small"
            title={t('workbench.files.refresh')}
            aria-label={t('workbench.files.refresh')}
            aria-busy={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 7v5h-5M4 17v-5h5M19 11a7 7 0 0 0-12-5L4 9m16 6-3 3A7 7 0 0 1 5 13" />
            </svg>
          </Button>,
          header,
        )}
      {error && <SettingsState tone="error">{error}</SettingsState>}
      <div className="workbench-tree-scroll">
        {tree('')}
        {directories['']?.entries.length === 0 && (
          <SettingsState tone="empty">{t('workbench.files.empty')}</SettingsState>
        )}
      </div>
      <section className="workbench-file-preview" aria-label={t('workbench.files.preview')}>
        {selected ? (
          <div className="workbench-panel-toolbar">
            <strong className="workbench-file-name">{selected}</strong>
            <Button size="small" data-testid="file-mention" onClick={() => mention(selected)}>
              {t('workbench.files.mention')}
            </Button>
          </div>
        ) : (
          <SettingsState tone="empty">{t('workbench.files.choose')}</SettingsState>
        )}
        {file && (
          <details>
            <summary>
              {t('workbench.files.freshness', {
                time: new Date(file.observedAt).toLocaleTimeString(
                  document.documentElement.lang || undefined,
                  { hour: '2-digit', minute: '2-digit' },
                ),
              })}
            </summary>
            <time dateTime={file.observedAt}>{file.observedAt}</time>
            <br />
            <code>{file.revision}</code>
          </details>
        )}
        {file &&
          fileViewerActions
            .entries()
            .map(({ id, component: Action }) => (
              <Action key={id} context={context} path={selected} revision={file.revision} />
            ))}
        {file?.binary && <SettingsState tone="empty">{t('workbench.files.binary')}</SettingsState>}
        {file?.truncated && <SettingsState tone="empty">{t('workbench.files.large')}</SettingsState>}
        {file?.text !== undefined && (
          <pre data-testid="file-preview">
            <Highlight path={selected} text={file.text} />
          </pre>
        )}
      </section>
      <footer className="workbench-files-footer">
        <details>
          <summary>{t('workbench.files.scope')}</summary>
          <p>{t('workbench.files.ignore')}</p>
        </details>
        {directories['']?.gitStatus === 'unavailable' && (
          <p role="status">{t('workbench.git.unavailable')}</p>
        )}
      </footer>
    </section>
  )
}
