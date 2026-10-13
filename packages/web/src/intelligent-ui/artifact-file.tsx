import type { UiArtifactFileData } from '@agnes/protocol/gen/intelligent-ui'
import type { ClientDocumentKind, ClientDocumentResource, ClientResourceService } from '@agnes/web-client'
import {
  Button,
  IconButton,
  type IconName,
  IconTile,
  INTELLIGENT_UI_NAMESPACE,
  intelligentUiCatalog,
  Menu,
  useUiText,
} from '@agnes/web-ui'
import { DocumentPreview } from '@agnes/web-ui/conversation'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

/** Served by the web server as an opaque-origin document with its own policy; see its module. */
const HTML_PREVIEW_FRAME = '/__agnes/deliverable-preview'
const PREVIEW_LIMIT = 1024 * 1024

function previewKind(mime: string): ClientDocumentKind | undefined {
  if (mime === 'text/html') return 'html'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return undefined
}
function typeIcon(kind: ClientDocumentKind | undefined): IconName {
  if (kind === 'html') return 'globe'
  if (kind === 'image') return 'eye'
  if (kind === 'text') return 'file-code'
  return kind ? 'file-text' : 'file'
}

/**
 * The conversation card asks; the workbench copy of the same file answers. A request names one file
 * and is consumed by the row that shows it, so a panel that mounts after the click still opens it.
 */
const listeners = new Set<() => void>()
let requestedKey: string | undefined
const previewRequest = {
  get: () => requestedKey,
  set(key: string | undefined) {
    requestedKey = key
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
const fileKey = (laneId: string, file: UiArtifactFileData) => `${laneId}:${file.artifact.sha256}`

/** An HTML deliverable runs in its own sandboxed document and is handed its text once, by message. */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target || event.data?.type !== 'agnes-preview-ready') return
      // The frame's origin is opaque, so there is no origin to name; the source check above binds it.
      target.postMessage({ type: 'agnes-preview-html', html }, '*')
    }
    window.addEventListener('message', ready)
    return () => window.removeEventListener('message', ready)
  }, [html])
  return (
    <section data-document-preview="html" aria-label={title}>
      <iframe
        ref={frame}
        src={HTML_PREVIEW_FRAME}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </section>
  )
}

/** Display uses the same session-authorized resource loaders as the workspace document dock. */
export function ArtifactFile({
  file,
  laneId,
  resources,
  placement = 'workbench',
  onShowInWorkbench,
}: {
  file: UiArtifactFileData
  laneId: string
  resources: ClientResourceService | undefined
  placement?: 'inline' | 'workbench'
  /** Present when this file also has a workbench copy: previews open there, not in the conversation. */
  onShowInWorkbench?: (() => void) | undefined
}) {
  const { t, locale, hostT } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const owner = useMemo(
    () => ({ file, laneId, resources, active: true, releases: new Set<() => void>() }),
    [file, laneId, resources],
  )
  const [preview, setPreview] = useState<ClientDocumentResource>()
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    owner.active = true
    setPreview(undefined)
    setOpened(false)
    setBusy(false)
    setFailed(false)
    return () => {
      owner.active = false
      for (const release of owner.releases) release()
      owner.releases.clear()
    }
  }, [owner])
  const kind = previewKind(file.artifact.mime)
  const size = file.artifact.size
  const units = size >= 1024 * 1024 ? ([1024 * 1024, 'MiB'] as const) : ([1024, 'KiB'] as const)
  const formattedSize =
    size > 0 && size < 1024
      ? '<1 KiB'
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size / units[0])} ${units[1]}`
  const type = file.name.includes('.') ? file.name.split('.').at(-1)?.toUpperCase() : file.artifact.mime
  const key = fileKey(laneId, file)
  const delegated = placement === 'inline' && !!onShowInWorkbench

  async function show() {
    setOpened(true)
    if (!resources || !kind || size > PREVIEW_LIMIT || preview) return
    setBusy(true)
    setFailed(false)
    try {
      const result = await resources.documents.load({ laneId, artifact: file.artifact, kind })
      if (!owner.active) {
        result.release()
        return
      }
      owner.releases.add(result.release)
      setPreview(result)
    } catch {
      if (owner.active) {
        setFailed(true)
        setOpened(false)
      }
    } finally {
      if (owner.active) setBusy(false)
    }
  }
  function open() {
    if (delegated) {
      previewRequest.set(key)
      onShowInWorkbench?.()
    } else if (opened) setOpened(false)
    else void show()
  }
  // The workbench row opens the preview its conversation card asked for, then clears the request.
  const requested = useSyncExternalStore(previewRequest.subscribe, previewRequest.get) === key
  // biome-ignore lint/correctness/useExhaustiveDependencies: a request is answered once, when it arrives
  useEffect(() => {
    if (!requested || placement !== 'workbench') return
    previewRequest.set(undefined)
    void show()
  }, [requested, placement])
  async function download() {
    if (!resources || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const result = await resources.files.load({ laneId, artifact: file.artifact })
      if (!owner.active) {
        result.release()
        return
      }
      const link = document.createElement('a')
      link.href = result.url
      link.download = file.name
      link.click()
      const release = () => {
        clearTimeout(timer)
        result.release()
        owner.releases.delete(release)
      }
      const timer = setTimeout(release, 1000)
      owner.releases.add(release)
    } catch {
      if (owner.active) setFailed(true)
    } finally {
      if (owner.active) setBusy(false)
    }
  }
  async function copyName() {
    try {
      await navigator.clipboard.writeText(file.name)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const unavailable = !kind || size > PREVIEW_LIMIT
  return (
    <section
      className="deliverable-file"
      data-testid="deliverable-file"
      data-placement={placement}
      data-open={opened}
    >
      <div className="deliverable-row">
        <IconTile name={typeIcon(kind)} />
        <div className="deliverable-text">
          <h4 className="deliverable-name" title={file.name}>
            {file.name}
          </h4>
          <p className="deliverable-meta">
            {file.description && <span className="deliverable-description">{file.description}</span>}
            <span>
              {type} · {formattedSize}
            </span>
          </p>
        </div>
        <div className="deliverable-actions">
          <Button
            appearance="primary"
            size="small"
            data-testid="deliverable-open"
            disabled={!resources || busy}
            onClick={open}
            {...(delegated ? {} : { 'aria-expanded': opened })}
          >
            {t('ui.file.preview')}
          </Button>
          <IconButton
            name="download"
            label={t('ui.file.download')}
            data-testid="deliverable-download"
            disabled={!resources || busy}
            onClick={() => void download()}
          />
          <Menu
            label={t('ui.file.more')}
            trigger={<IconButton name="ellipsis" label={t('ui.file.more')} />}
            items={[
              ...(delegated
                ? [
                    {
                      id: 'workbench',
                      label: t('ui.file.inWorkbench'),
                      testId: 'deliverable-in-workbench',
                      onSelect: () => onShowInWorkbench?.(),
                    },
                  ]
                : []),
              {
                id: 'copy-name',
                label: t(copied ? 'ui.file.nameCopied' : 'ui.file.copyName'),
                testId: 'deliverable-copy-name',
                onSelect: () => void copyName(),
              },
            ]}
          />
        </div>
      </div>
      {failed && (
        <p className="deliverable-note" role="alert">
          {t('ui.file.failed')}
        </p>
      )}
      {opened && (
        <div className="deliverable-preview" data-testid="deliverable-preview" data-kind={kind ?? 'none'}>
          <div className="deliverable-preview-bar">
            <span className="deliverable-preview-name">{file.name}</span>
            <IconButton
              name="download"
              label={t('ui.file.download')}
              disabled={!resources || busy}
              onClick={() => void download()}
            />
            <IconButton
              name="x"
              label={t('ui.file.close')}
              data-testid="deliverable-preview-close"
              onClick={() => setOpened(false)}
            />
          </div>
          {unavailable ? (
            <p className="deliverable-note" role="status">
              {t(size > PREVIEW_LIMIT ? 'ui.file.large' : 'ui.file.unsupported')}
            </p>
          ) : !preview ? (
            <p className="deliverable-note" role="status">
              {t('ui.file.loading')}
            </p>
          ) : preview.kind === 'html' ? (
            <HtmlPreview key={file.artifact.sha256} html={preview.content ?? ''} title={file.name} />
          ) : (
            <DocumentPreview
              // Source files are shown as source: a scrollable monospace block, never running text.
              kind={preview.kind === 'text' ? 'code' : preview.kind}
              title={file.name}
              {...(preview.content === undefined ? {} : { content: preview.content })}
              {...(preview.url === undefined ? {} : { resourceUrl: preview.url })}
              t={hostT}
            />
          )}
        </div>
      )}
    </section>
  )
}
