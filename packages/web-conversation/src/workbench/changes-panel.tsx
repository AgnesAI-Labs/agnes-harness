import type { SessionWorkspaceChangesResult } from '@agnes/protocol'
import { factChainLinks, type UiExtensionContext } from '@agnes/web-client'
import { appServerErrorMessage, Button, Select, SettingsState } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { panelContext } from './context.js'

type Selection = { sessionId: string; path: string; revision?: string }
function fileSelection(value: unknown, sessionId?: string): Selection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<Selection>
  return typeof item.sessionId === 'string' && item.sessionId === sessionId && typeof item.path === 'string'
    ? {
        sessionId: item.sessionId,
        path: item.path,
        ...(typeof item.revision === 'string' ? { revision: item.revision } : {}),
      }
    : undefined
}

/** Review is a bounded projection of confirmed effects. Navigation confers no file authority. */
export function ChangesPanel({ context, headerId }: { context: UiExtensionContext; headerId?: string }) {
  return (
    <SessionChangesPanel
      key={panelContext(context).session?.id ?? 'no-session'}
      context={context}
      {...(headerId ? { headerId } : {})}
    />
  )
}

function SessionChangesPanel({ context, headerId }: { context: UiExtensionContext; headerId?: string }) {
  const { session, mention } = panelContext(context),
    { t } = context
  const incoming = fileSelection(context.selection, session?.id)
  const [scope, setScope] = useState<'session' | 'turn'>('session')
  const [path, setPath] = useState(incoming?.path ?? '')
  const [expectedRevision, setExpectedRevision] = useState(incoming?.revision)
  const [snapshot, setSnapshot] = useState<SessionWorkspaceChangesResult>()
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true)
  const [outsideHistory, setOutsideHistory] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    setPath(incoming?.path ?? '')
    setExpectedRevision(incoming?.revision)
    setSnapshot(undefined)
    setError('')
    setOutsideHistory(false)
  }, [incoming?.path, incoming?.revision])
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh invalidates the polling request.
  useEffect(() => {
    if (!session) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const result = await session.workspaceChanges({
          scope,
          ...(path ? { path } : {}),
          ...(expectedRevision ? { expectedRevision } : {}),
        })
        if (!alive) return
        setSnapshot(result)
        setError('')
      } catch (cause) {
        if (alive)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      } finally {
        if (alive) {
          setLoading(false)
          timer = setTimeout(() => void read(), 3000)
        }
      }
    }
    setLoading(true)
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [session, scope, path, expectedRevision, refresh, t])
  const header = headerId ? document.getElementById(headerId) : null
  const refreshButton = (
    <Button
      type="text"
      size="small"
      title={t('workbench.changes.refresh')}
      aria-label={t('workbench.changes.refresh')}
      onClick={() => setRefresh((value) => value + 1)}
      data-testid="changes-refresh"
    >
      <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
        <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M18 17a7 7 0 0 1-12 1l-2-6" />
      </svg>
    </Button>
  )
  const selected = snapshot?.selected
  return (
    <section
      className="workbench-changes"
      data-testid="changes-panel"
      aria-label={t('workbench.changes.title')}
    >
      {header ? createPortal(refreshButton, header) : refreshButton}
      {!session ? (
        <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
      ) : (
        <>
          <div className="workbench-panel-toolbar">
            <Select
              aria-label={t('workbench.changes.scope')}
              value={scope}
              onChange={(value) => {
                setScope(value)
                setSnapshot(undefined)
              }}
              options={(['session', 'turn'] as const).map((value) => ({
                value,
                label: t(`workbench.changes.scope.${value}`),
              }))}
            />
          </div>
          {error && <SettingsState tone="error">{error}</SettingsState>}
          {loading && !snapshot && (
            <SettingsState tone="loading">{t('workbench.changes.loading')}</SettingsState>
          )}
          <div className={`workbench-changes-split${selected ? ' has-selection' : ''}`}>
            <nav className="workbench-changes-list" aria-label={t('workbench.changes.files')}>
              {snapshot?.files.map((file) => (
                <Button
                  key={file.path}
                  type="text"
                  className="workbench-changes-file"
                  aria-pressed={path === file.path}
                  data-testid="changed-file"
                  data-path={file.path}
                  onClick={() => {
                    setPath(file.path)
                    setExpectedRevision(undefined)
                    setSnapshot(undefined)
                  }}
                >
                  <span>{file.path}</span>
                  <span className="workbench-change-counts">
                    {file.added === undefined ? (
                      t('workbench.changes.unavailable')
                    ) : (
                      <>
                        <span className="workbench-diff-added">+{file.added}</span>{' '}
                        <span className="workbench-diff-removed">−{file.removed}</span>
                      </>
                    )}
                  </span>
                </Button>
              ))}
              {snapshot && !snapshot.files.length && (
                <SettingsState tone="empty">{t('workbench.changes.empty')}</SettingsState>
              )}
            </nav>
            {selected ? (
              <article className="workbench-change-preview" aria-label={t('workbench.changes.diff')}>
                <div className="workbench-panel-toolbar">
                  <code>{selected.path}</code>
                  <Button size="small" data-testid="changes-mention" onClick={() => mention(selected.path)}>
                    {t('workbench.files.mention')}
                  </Button>
                </div>
                {selected.freshness === 'changed' && <p role="status">{t('workbench.changes.changed')}</p>}
                {selected.freshness === 'unavailable' && (
                  <p role="status">{t('workbench.changes.freshnessUnavailable')}</p>
                )}
                {selected.viewerChanged && <p role="status">{t('workbench.changes.viewerChanged')}</p>}
                {selected.basis === 'latest-effect' && (
                  <p role="status">{t('workbench.changes.latestEffect')}</p>
                )}
                {selected.diffStatus === 'available' ? (
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: the read-only diff is scrollable with keyboard arrows.
                  <section tabIndex={0} aria-label={t('workbench.changes.diff')} data-testid="changes-diff">
                    <pre>
                      <code>
                        {selected.diff?.split('\n').map((line, index) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: immutable plain-text lines have no state or identity.
                            key={index}
                            className={`workbench-diff-line${line.startsWith('+') && !line.startsWith('+++') ? ' workbench-diff-added' : line.startsWith('-') && !line.startsWith('---') ? ' workbench-diff-removed' : ''}`}
                          >
                            {line}
                            {'\n'}
                          </span>
                        ))}
                      </code>
                    </pre>
                  </section>
                ) : (
                  <SettingsState tone="empty">{t(`workbench.changes.${selected.diffStatus}`)}</SettingsState>
                )}
                <details className="workbench-change-evidence">
                  <summary>{t('workbench.changes.evidence')}</summary>
                  <dl>
                    <dt>{t('workbench.changes.before')}</dt>
                    <dd>{selected.beforeRevision}</dd>
                    <dt>{t('workbench.changes.after')}</dt>
                    <dd>{selected.afterRevision}</dd>
                    <dt>{t('workbench.changes.current')}</dt>
                    <dd>{selected.currentRevision}</dd>
                  </dl>
                  {selected.effects.map((effect) => (
                    <div key={effect.receiptSeq}>
                      <Button
                        type="link"
                        size="small"
                        data-testid="changes-provenance"
                        onClick={() =>
                          setOutsideHistory(
                            !effect.laneId ||
                              !factChainLinks.open({
                                sessionId: session.id,
                                laneId: effect.laneId,
                                anchor: { kind: 'tool', toolUseId: effect.toolUseId },
                              }),
                          )
                        }
                      >
                        {t('workbench.changes.record', { tool: effect.tool, turn: effect.turn })}
                      </Button>
                      <dl>
                        <dt>{t('workbench.changes.coordinates')}</dt>
                        <dd>
                          {effect.callSeq} / {effect.resultSeq} / {effect.receiptSeq}
                        </dd>
                        <dt>{t('workbench.changes.toolUseId')}</dt>
                        <dd>{effect.toolUseId}</dd>
                        <dt>{t('workbench.changes.decision')}</dt>
                        <dd>
                          {effect.decisionId} · {effect.enforcement}
                        </dd>
                        <dt>{t('workbench.changes.time')}</dt>
                        <dd>
                          <time dateTime={effect.observedAt}>
                            {new Date(effect.observedAt).toLocaleString(
                              document.documentElement.lang || 'en',
                            )}
                          </time>
                        </dd>
                      </dl>
                    </div>
                  ))}
                  {outsideHistory && <p role="status">{t('workbench.changes.unlinked')}</p>}
                </details>
              </article>
            ) : snapshot && path ? (
              <SettingsState tone="empty">{t('workbench.changes.noFile')}</SettingsState>
            ) : null}
          </div>
          <footer className="workbench-changes-footer">
            {snapshot?.truncated && <p role="status">{t('workbench.changes.truncated')}</p>}
            {snapshot?.unrecorded && <p role="status">{t('workbench.changes.unrecorded')}</p>}
            <details>
              <summary>{t('workbench.changes.coverage')}</summary>
              <p>{t('workbench.changes.rules')}</p>
              {snapshot && (
                <dl>
                  <dt>{t('workbench.changes.window')}</dt>
                  <dd>
                    {snapshot.fromSeq}–{snapshot.toSeq}
                  </dd>
                  <dt>{t('workbench.changes.revision')}</dt>
                  <dd>{snapshot.revision}</dd>
                  <dt>{t('workbench.changes.time')}</dt>
                  <dd>
                    <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time>
                  </dd>
                </dl>
              )}
            </details>
          </footer>
        </>
      )}
    </section>
  )
}

export function ReviewFileAction({
  context,
  path,
  revision,
}: {
  context: UiExtensionContext
  path: string
  revision: string
}) {
  const { session } = panelContext(context)
  return (
    <Button
      size="small"
      disabled={!session || !context.openPanel}
      data-testid="file-review"
      onClick={() =>
        session && context.openPanel?.('changed-files', { sessionId: session.id, path, revision })
      }
    >
      {context.t('workbench.changes.review')}
    </Button>
  )
}
