import type { SessionWorkspaceChangesResult, SessionWorkspaceReadResult } from '@agnes/protocol'
import { factChainLinks, type UiExtensionContext } from '@agnes/web-client'
import {
  appServerErrorMessage,
  Button,
  Disclosure,
  Icon,
  IconButton,
  Segmented,
  SettingsState,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { panelContext } from './context.js'
import { type DiffRow, diffSide, foldDiff, parseDiff, textRows } from './diff-lines.js'
import { fileType } from './file-types.js'
import { changesCount } from './tab-counts.js'
import { visiblePoll } from './visible-poll.js'

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

type Version = 'before' | 'after' | 'current'

function SessionChangesPanel({ context }: { context: UiExtensionContext; headerId?: string }) {
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
  const [version, setVersion] = useState<Version>('after')
  useEffect(() => {
    setPath(incoming?.path ?? '')
    setExpectedRevision(incoming?.revision)
    setSnapshot(undefined)
    setError('')
    setOutsideHistory(false)
  }, [incoming?.path, incoming?.revision])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newly chosen file opens on its recorded change.
  useEffect(() => {
    setVersion('after')
    setOutsideHistory(false)
  }, [path])
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh invalidates the polling request.
  useEffect(() => {
    if (!session) return
    let alive = true
    const read = async () => {
      try {
        const result = await session.workspaceChanges({
          scope,
          ...(path ? { path } : {}),
          ...(expectedRevision ? { expectedRevision } : {}),
        })
        if (!alive) return
        setSnapshot(result)
        if (scope === 'session') changesCount.set(session.id, result.files.length)
        setError('')
      } catch (cause) {
        if (alive)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      } finally {
        if (alive) setLoading(false)
      }
    }
    setLoading(true)
    const stop = visiblePoll(read, 3000)
    return () => {
      alive = false
      stop()
    }
  }, [session, scope, path, expectedRevision, refresh, t])
  if (!session)
    return (
      <section
        className="workbench-changes"
        data-testid="changes-panel"
        aria-label={t('workbench.changes.title')}
      >
        <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
      </section>
    )
  const refreshButton = (
    <IconButton
      name="refresh-cw"
      label={t('workbench.changes.refresh')}
      aria-busy={loading}
      onClick={() => setRefresh((value) => value + 1)}
      data-testid="changes-refresh"
    />
  )
  const selected = snapshot?.selected?.path === path ? snapshot.selected : undefined
  const files = snapshot?.files ?? []
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0)
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0)
  const latest = selected?.effects.at(-1)
  const openRecord = () => {
    if (!latest) return
    setOutsideHistory(
      !latest.laneId ||
        !factChainLinks.open({
          sessionId: session.id,
          laneId: latest.laneId,
          anchor: { kind: 'tool', toolUseId: latest.toolUseId },
        }),
    )
  }
  return (
    <section
      className="workbench-changes"
      data-testid="changes-panel"
      aria-label={t('workbench.changes.title')}
    >
      <div className="workbench-tab-toolbar">
        <Segmented
          label={t('workbench.changes.scope')}
          value={scope}
          testId="changes-scope"
          onChange={(value) => {
            setScope(value as 'session' | 'turn')
            setSnapshot(undefined)
          }}
          options={(['session', 'turn'] as const).map((value) => ({
            value,
            label: t(`workbench.changes.scope.${value}`),
            testId: `changes-scope-${value}`,
          }))}
        />
        {snapshot && (
          <span className="workbench-tab-summary" data-testid="changes-summary">
            {t('workbench.changes.summary', { count: files.length })}
            {files.length > 0 && (
              <>
                {' · '}
                <span className="workbench-diff-count">
                  <span className="workbench-diff-added">+{added}</span>{' '}
                  <span className="workbench-diff-removed">−{removed}</span>
                </span>
              </>
            )}
          </span>
        )}
        <span className="workbench-tab-spacer" />
        {refreshButton}
      </div>
      {error && (
        <SettingsState tone="error">
          {error}
          <Button size="small" onClick={() => setRefresh((value) => value + 1)}>
            {t('workbench.retry')}
          </Button>
        </SettingsState>
      )}
      {loading && !snapshot && <SettingsState tone="loading">{t('workbench.changes.loading')}</SettingsState>}
      <div className="workbench-changes-body">
        {files.length > 0 && (
          <ul className="workbench-changes-list" aria-label={t('workbench.changes.files')}>
            {files.map((file) => {
              const type = fileType(file.path.slice(file.path.lastIndexOf('/') + 1))
              const slash = file.path.lastIndexOf('/')
              return (
                <li key={file.path}>
                  <Button
                    type="text"
                    className="workbench-changes-file"
                    aria-pressed={path === file.path}
                    data-testid="changed-file"
                    data-path={file.path}
                    onClick={() => {
                      setPath(file.path)
                      setExpectedRevision(undefined)
                    }}
                  >
                    {type ? (
                      <span className="workbench-file-type" data-tone={type.tone} aria-hidden="true">
                        {type.label}
                      </span>
                    ) : (
                      <Icon name="file" className="workbench-file-icon" />
                    )}
                    <span className="workbench-changes-path" title={file.path} translate="no">
                      {slash >= 0 && (
                        <span className="workbench-changes-dir">{file.path.slice(0, slash + 1)}</span>
                      )}
                      <strong>{file.path.slice(slash + 1)}</strong>
                    </span>
                    <span className="workbench-tag" data-tone={file.kind === 'added' ? 'ok' : 'warn'}>
                      {t(`workbench.changes.kind.${file.kind}`)}
                    </span>
                    {file.added === undefined ? (
                      <span
                        className="workbench-tag"
                        data-testid="changed-file-unavailable"
                        title={t(`workbench.changes.${file.diffStatus}`)}
                      >
                        {t(`workbench.changes.short.${file.diffStatus}`)}
                      </span>
                    ) : (
                      <span className="workbench-diff-count">
                        <span className="workbench-diff-added">+{file.added}</span>{' '}
                        <span className="workbench-diff-removed">−{file.removed}</span>
                      </span>
                    )}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {snapshot && !files.length && (
          <SettingsState tone="empty">{t('workbench.changes.empty')}</SettingsState>
        )}
        {selected ? (
          <article className="workbench-change-preview" aria-label={t('workbench.changes.diff')}>
            <header className="workbench-change-head">
              <strong className="workbench-change-name" title={selected.path} translate="no">
                {selected.path.slice(selected.path.lastIndexOf('/') + 1)}
              </strong>
              {latest && (
                <span className="workbench-tab-summary">
                  {t('workbench.changes.turnTool', { turn: latest.turn, tool: latest.tool })}
                </span>
              )}
              <span className="workbench-tab-spacer" />
              <Segmented
                label={t('workbench.changes.version')}
                value={version}
                testId="changes-version"
                onChange={(value) => setVersion(value as Version)}
                options={(['before', 'after', 'current'] as const).map((value) => ({
                  value,
                  label: t(`workbench.changes.version.${value}`),
                  testId: `changes-version-${value}`,
                  disabled:
                    (value !== 'current' && selected.diffStatus !== 'available') ||
                    (value === 'before' && selected.kind === 'added'),
                }))}
              />
              {latest && (
                <Button type="link" size="small" data-testid="changes-provenance" onClick={openRecord}>
                  {t('workbench.changes.recordLink')}
                  <Icon name="arrow-right" />
                </Button>
              )}
              <Button
                type="text"
                size="small"
                className="workbench-file-mention"
                data-testid="changes-mention"
                aria-label={t('workbench.files.mention')}
                title={t('workbench.files.mention')}
                onClick={() => mention(selected.path)}
              >
                <span aria-hidden="true">@</span>
                <span className="workbench-file-mention-label">{t('workbench.files.mentionShort')}</span>
              </Button>
            </header>
            {outsideHistory && (
              <p className="workbench-strip" role="status">
                {t('workbench.changes.unlinked')}
              </p>
            )}
            {selected.freshness === 'changed' && (
              <p className="workbench-strip" role="status">
                {t('workbench.changes.changed')}
              </p>
            )}
            {selected.freshness === 'unavailable' && (
              <p className="workbench-strip" role="status">
                {t('workbench.changes.freshnessUnavailable')}
              </p>
            )}
            {selected.viewerChanged && (
              <p className="workbench-strip" role="status">
                {t('workbench.changes.viewerChanged')}
              </p>
            )}
            {selected.basis === 'latest-effect' && (
              <p className="workbench-strip" role="status">
                {t('workbench.changes.latestEffect')}
              </p>
            )}
            {version === 'current' ? (
              <CurrentFile key={`${session.id}:${selected.path}`} context={context} path={selected.path} />
            ) : selected.diffStatus === 'available' ? (
              <DiffView
                key={`${selected.path}:${selected.afterRevision}:${version}`}
                rows={
                  version === 'before'
                    ? diffSide(parseDiff(selected.diff ?? ''), 'before')
                    : parseDiff(selected.diff ?? '')
                }
                label={t('workbench.changes.diff')}
                t={t}
              />
            ) : (
              <SettingsState tone="empty">{t(`workbench.changes.${selected.diffStatus}`)}</SettingsState>
            )}
            <Disclosure className="workbench-change-evidence" summary={t('facts.details')}>
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
                    data-testid="changes-effect"
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
                        {new Date(effect.observedAt).toLocaleString(document.documentElement.lang || 'en')}
                      </time>
                    </dd>
                  </dl>
                </div>
              ))}
            </Disclosure>
          </article>
        ) : snapshot && path ? (
          <SettingsState tone="empty">{t('workbench.changes.noFile')}</SettingsState>
        ) : null}
      </div>
      <footer className="workbench-tab-footer workbench-changes-footer">
        <Icon name="info" size={16} />
        {snapshot?.truncated && <p role="status">{t('workbench.changes.truncatedShort')}</p>}
        {snapshot?.unrecorded && <p role="status">{t('workbench.changes.unrecordedShort')}</p>}
        {!snapshot?.truncated && !snapshot?.unrecorded && <p>{t('workbench.changes.footer')}</p>}
        <Disclosure variant="plain" summary={t('workbench.changes.coverage')}>
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
        </Disclosure>
      </footer>
    </section>
  )
}

/** Numbered diff rows with add/remove backgrounds; long unchanged runs and long tails fold. */
function DiffView({ rows, label, t }: { rows: DiffRow[]; label: string; t: UiExtensionContext['t'] }) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const shown = foldDiff(rows, opened)
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the read-only diff scrolls with keyboard arrows.
    <section tabIndex={0} aria-label={label} data-testid="changes-diff" className="workbench-diff-scroll">
      <pre className="workbench-diff">
        {shown.map((row, index) =>
          row.kind === 'fold' ? (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one immutable diff render.
              key={index}
              type="text"
              size="small"
              className="workbench-diff-fold"
              data-testid="changes-diff-fold"
              onClick={() => setOpened((value) => new Set(value).add(row.id))}
            >
              {t(row.id === 'tail' ? 'workbench.changes.foldRest' : 'workbench.changes.fold', {
                count: row.hidden.length,
              })}
            </Button>
          ) : (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: rows of one immutable diff render.
              key={index}
              className={`workbench-diff-line workbench-diff-${row.kind}`}
              data-kind={row.kind}
            >
              {row.kind === 'hunk' ? (
                <span className="workbench-diff-text">{row.text}</span>
              ) : (
                <>
                  <span className="workbench-diff-number" aria-hidden="true">
                    {row.old ?? ''}
                  </span>
                  <span className="workbench-diff-number" aria-hidden="true">
                    {row.new ?? ''}
                  </span>
                  <span className="workbench-diff-sign">
                    {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                  </span>
                  <span className="workbench-diff-text">{row.text}</span>
                </>
              )}
              {'\n'}
            </span>
          ),
        )}
      </pre>
    </section>
  )
}

/** The file as it is now, read with the workspace permissions every file read uses. */
function CurrentFile({ context, path }: { context: UiExtensionContext; path: string }) {
  const { session } = panelContext(context),
    { t } = context
  const [file, setFile] = useState<SessionWorkspaceReadResult>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    if (!session) return
    void session
      .workspaceRead(path)
      .then((value) => {
        if (alive) setFile(value)
      })
      .catch((cause) => {
        if (alive)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      })
    return () => {
      alive = false
    }
  }, [session, path, t])
  if (error) return <SettingsState tone="error">{error}</SettingsState>
  if (!file) return <SettingsState tone="loading">{t('workbench.files.loading')}</SettingsState>
  if (file.binary) return <SettingsState tone="empty">{t('workbench.files.binary')}</SettingsState>
  return (
    <>
      {file.truncated && (
        <p className="workbench-strip" role="status">
          {t('workbench.files.large')}
        </p>
      )}
      {file.text !== undefined && (
        <DiffView rows={textRows(file.text)} label={t('workbench.files.preview')} t={t} />
      )}
    </>
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
      type="link"
      size="small"
      disabled={!session || !context.openPanel}
      data-testid="file-review"
      onClick={() =>
        session && context.openPanel?.('changed-files', { sessionId: session.id, path, revision })
      }
    >
      {context.t('workbench.changes.review')}
      <Icon name="arrow-right" />
    </Button>
  )
}
