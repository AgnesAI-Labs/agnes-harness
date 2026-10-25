import type { SessionWorkspaceReadResult } from '@agnes/protocol'
import { fileViewerActions, type UiExtensionContext } from '@agnes/web-client'
import { Button, Segmented, SettingsState } from '@agnes/web-ui'
import { DocumentPreview, HtmlPreviewFrame } from '@agnes/web-ui/conversation'
import { useEffect, useState } from 'react'
import { formatSize, type RenderedKind, renderedKind } from './file-types.js'
import type { SessionChange } from './files-tree.js'
import { Highlight } from './highlight.js'

/** An SVG is drawn as an image from its own text: an `<img>` never runs the file's scripts. */
function SvgPreview({ text, title }: { text: string; title: string }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [text])
  return url ? <DocumentPreview kind="image" title={title} resourceUrl={url} /> : null
}

function Rendered({ kind, text, title }: { kind: RenderedKind; text: string; title: string }) {
  if (kind === 'html') return <HtmlPreviewFrame html={text} title={title} />
  if (kind === 'svg') return <SvgPreview text={text} title={title} />
  return (
    <DocumentPreview
      kind="markdown"
      title={title}
      content={text}
      theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
    />
  )
}

/** How one previewed file is shown; the panel stores this per open tab and per session. */
export type FileViewMode = 'source' | 'preview'

/** One line of header, an optional change strip, then the file as numbered source or rendered. */
export function FilePreview({
  context,
  path,
  file,
  error = '',
  retry,
  change,
  workspace,
  wrap,
  mention,
  mode,
  onModeChange,
  scrollTop,
  onScroll,
}: {
  context: UiExtensionContext
  path: string
  file: SessionWorkspaceReadResult | undefined
  /** Why this file could not be read; the panel's folder listing reports its own failures. */
  error?: string
  retry?: () => void
  change: SessionChange | undefined
  workspace: string | undefined
  wrap: boolean
  mention(path: string): void
  mode: FileViewMode
  onModeChange(mode: FileViewMode): void
  /** The source scroll offset this file was left at; rendered previews do not restore scroll. */
  scrollTop: number
  onScroll(top: number): void
}) {
  const { t } = context
  const segments = path.split('/')
  const name = segments.pop() ?? path
  const kind = renderedKind(path)
  const text = file?.text
  const lang = document.documentElement.lang || undefined
  const Review = fileViewerActions.get('review')?.component
  const lines = text === undefined ? 0 : text.split('\n').length
  return (
    <>
      <header className="workbench-file-header" data-testid="file-header">
        <span className="workbench-file-crumb" title={path}>
          {[workspace, ...segments].filter(Boolean).map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat and never reorder.
            <span key={index} className="workbench-file-crumb-part">
              {part}
              <span aria-hidden="true">/</span>
            </span>
          ))}
          <strong className="workbench-file-name">{name}</strong>
        </span>
        {file && (
          <span className="workbench-file-meta" data-testid="file-meta">
            {formatSize(file.size, lang)} ·{' '}
            <time dateTime={file.observedAt} title={file.revision}>
              {t('workbench.files.freshness', {
                time: new Date(file.observedAt).toLocaleTimeString(lang, {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </time>
          </span>
        )}
        <span className="workbench-file-actions">
          {kind && text !== undefined && (
            <Segmented<'source' | 'preview'>
              label={t('workbench.files.view')}
              value={mode}
              testId="file-view-mode"
              onChange={onModeChange}
              options={[
                { value: 'source', label: t('workbench.files.view.source'), testId: 'file-view-source' },
                { value: 'preview', label: t('workbench.files.view.preview'), testId: 'file-view-preview' },
              ]}
            />
          )}
          {file &&
            fileViewerActions
              .entries()
              .filter((action) => action.id !== 'review')
              .map(({ id, component: Action }) => (
                <Action key={id} context={context} path={path} revision={file.revision} />
              ))}
          <Button
            size="small"
            className="workbench-file-mention"
            data-testid="file-mention"
            title={t('workbench.files.mention')}
            aria-label={t('workbench.files.mention')}
            onClick={() => mention(path)}
          >
            <span aria-hidden="true">@</span>
            <span className="workbench-file-mention-label">{t('workbench.files.mentionShort')}</span>
          </Button>
        </span>
      </header>
      {change && (
        <p className="workbench-file-changed" role="status" data-testid="file-changed">
          <span>
            {t(`workbench.files.changed.${change.kind}`)}
            {change.added !== undefined &&
              t('workbench.files.changed.counts', { added: change.added, removed: change.removed ?? 0 })}
          </span>
          {file && Review && (
            <span className="workbench-file-review">
              <Review context={context} path={path} revision={file.revision} />
            </span>
          )}
        </p>
      )}
      {error && (
        <SettingsState tone="error" data-testid="file-read-error">
          {error}
          {retry && (
            <Button size="small" data-testid="file-read-retry" onClick={retry}>
              {t('workbench.retry')}
            </Button>
          )}
        </SettingsState>
      )}
      {!file && !error && (
        <SettingsState tone="loading" data-testid="file-read-loading">
          {t('workbench.files.reading')}
        </SettingsState>
      )}
      {file?.binary && <SettingsState tone="empty">{t('workbench.files.binary')}</SettingsState>}
      {file?.truncated && <SettingsState tone="empty">{t('workbench.files.large')}</SettingsState>}
      {text !== undefined &&
        (mode === 'preview' && kind ? (
          <div className="workbench-file-rendered" data-testid="file-rendered" data-kind={kind}>
            <Rendered key={file?.revision} kind={kind} text={text} title={name} />
          </div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: the pre is the scrollport, so it keeps the region role.
          <pre
            data-testid="file-preview"
            data-wrap={wrap || undefined}
            ref={(element) => {
              if (!element) return
              element.style.setProperty('--workbench-gutter', `${String(lines).length + 1}ch`)
              // The panel remembers each unsaved scroll offset, so a switched tab returns where it was.
              element.scrollTop = scrollTop
            }}
            onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the file preview scrolls on its own axis.
            tabIndex={0}
            role="region"
            aria-label={t('workbench.files.preview')}
          >
            <Highlight path={path} text={text} />
          </pre>
        ))}
    </>
  )
}
