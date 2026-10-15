import type { UiArtifactFileData } from '@agnes/protocol/gen/intelligent-ui'
import type { ClientDocumentKind, ClientDocumentResource, ClientResourceService } from '@agnes/web-client'
import {
  Button,
  Icon,
  IconButton,
  type IconName,
  INTELLIGENT_UI_NAMESPACE,
  intelligentUiCatalog,
  Menu,
  useUiText,
} from '@agnes/web-ui'
import { DocumentPreview, HtmlPreviewFrame } from '@agnes/web-ui/conversation'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  type DeliverableType,
  deliverableType,
  deliverableVersion,
  type EarlierVersion,
} from './deliverable-labels.js'

const PREVIEW_LIMIT = 1024 * 1024

function previewKind(mime: string): ClientDocumentKind | undefined {
  if (mime === 'text/html') return 'html'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return undefined
}
const TYPE_ICON: Record<DeliverableType, IconName> = {
  markdown: 'file-text',
  html: 'globe',
  pdf: 'file-text',
  sheet: 'list',
  image: 'eye',
  code: 'file-code',
  text: 'file-text',
  file: 'file',
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
// A request names the file by name and content: the same bytes under two names are two cards.
const fileKey = (sessionId: string, laneId: string, file: UiArtifactFileData) =>
  JSON.stringify([sessionId, laneId, file.name, file.artifact.sha256])

type ArtifactFileProps = {
  file: UiArtifactFileData
  sessionId: string
  laneId: string
  resources: ClientResourceService | undefined
  placement?: 'inline' | 'workbench'
  onShowInWorkbench?: (() => void) | undefined
  onPreviewRequested?: (() => void) | undefined
  earlier?: EarlierVersion | undefined
  source?: string | undefined
}
type Preview =
  | { status: 'loading' | 'failed' | 'unavailable' }
  | { status: 'ready'; resource: ClientDocumentResource }

/** Display uses the same session-authorized resource loaders as the workspace document dock. */
export function ArtifactFile(props: ArtifactFileProps) {
  return <ArtifactFileCard key={fileKey(props.sessionId, props.laneId, props.file)} {...props} />
}

function ArtifactFileCard({
  file,
  sessionId,
  laneId,
  resources,
  placement = 'workbench',
  onShowInWorkbench,
  onPreviewRequested,
  earlier,
  source,
}: ArtifactFileProps) {
  const { t, locale, hostT } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const owner = useMemo(
    () => ({ resources, active: true, request: 0, loading: false, releases: new Set<() => void>() }),
    [resources],
  )
  const [preview, setPreview] = useState<Preview>()
  const opened = preview !== undefined
  const row = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const previewId = useId()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    owner.active = true
    setPreview(undefined)
    setBusy(false)
    setFailed(false)
    return () => {
      owner.active = false
      owner.request++
      for (const release of owner.releases) release()
      owner.releases.clear()
    }
  }, [owner])
  const kind = previewKind(file.artifact.mime)
  const size = file.artifact.size
  const formatSize = (bytes: number) => {
    const units = bytes >= 1024 * 1024 ? ([1024 * 1024, 'MiB'] as const) : ([1024, 'KiB'] as const)
    return bytes > 0 && bytes < 1024
      ? '<1 KiB'
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / units[0])} ${units[1]}`
  }
  const formattedSize = formatSize(size)
  const type = deliverableType(file.name, file.artifact.mime)
  const version = deliverableVersion(file.description)
  const described = version && ('key' in version ? t(version.key) : version.text)
  // An earlier version names when it was presented and how its size differs from the latest.
  const versionTime =
    earlier?.presentedAt === undefined
      ? undefined
      : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
          new Date(earlier.presentedAt),
        )
  const versionName = earlier
    ? versionTime === undefined
      ? t('ui.file.versionN', { n: earlier.ordinal })
      : t('ui.file.versionAt', { time: versionTime })
    : undefined
  const subtitle = (
    earlier
      ? [
          earlier.source && t('ui.file.from', { source: earlier.source }),
          versionName,
          earlier.sizeDelta === 0
            ? t('ui.file.sameSize')
            : t(earlier.sizeDelta < 0 ? 'ui.file.smaller' : 'ui.file.larger', {
                size: formatSize(Math.abs(earlier.sizeDelta)),
              }),
          earlier.sameDescription ? undefined : described,
        ]
      : [source && t('ui.file.from', { source }), described, formattedSize]
  )
    .filter(Boolean)
    .join(' · ')
  const key = fileKey(sessionId, laneId, file)
  const delegated = placement === 'inline' && !!onShowInWorkbench

  const unavailable = !kind || size > PREVIEW_LIMIT
  async function show() {
    if (!resources || owner.loading || (preview && preview.status !== 'failed')) return
    if (unavailable) {
      setPreview({ status: 'unavailable' })
      return
    }
    const request = ++owner.request
    owner.loading = true
    setPreview({ status: 'loading' })
    try {
      const result = await resources.documents.load({ laneId, artifact: file.artifact, kind })
      if (!owner.active || request !== owner.request) {
        result.release()
        return
      }
      owner.releases.add(result.release)
      setPreview({ status: 'ready', resource: result })
    } catch {
      if (owner.active && request === owner.request) setPreview({ status: 'failed' })
    } finally {
      if (request === owner.request) owner.loading = false
    }
  }
  function close() {
    owner.request++
    owner.loading = false
    if (preview?.status === 'ready') {
      preview.resource.release()
      owner.releases.delete(preview.resource.release)
    }
    setPreview(undefined)
  }
  function open() {
    if (delegated) {
      previewRequest.set(key)
      onShowInWorkbench?.()
    } else if (opened) close()
    else void show()
  }
  // Requests are session-scoped and consumed even if this card is already open.
  const requested = useSyncExternalStore(previewRequest.subscribe, previewRequest.get) === key
  useEffect(
    () => () => {
      if (placement === 'inline' && previewRequest.get() === key) previewRequest.set(undefined)
    },
    [key, placement],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: a request is answered once, when it arrives
  useEffect(() => {
    if (!requested || placement !== 'workbench') return
    previewRequest.set(undefined)
    onPreviewRequested?.()
    void show()
    requestAnimationFrame(() => {
      if (!owner.active) return
      row.current?.scrollIntoView?.({ block: 'nearest' })
      trigger.current?.focus({ preventScroll: true })
    })
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
  const resource = preview?.status === 'ready' ? preview.resource : undefined
  return (
    <section
      ref={row}
      className="deliverable-file"
      data-testid="deliverable-file"
      data-placement={placement}
      data-open={opened}
      {...(earlier ? { 'data-version': 'earlier' } : {})}
    >
      {/* The real title button owns keyboard activation; selection and sibling actions stay independent. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation belongs to the title button. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: sibling title button owns the accessible action, as in ListRow. */}
      <div
        className="deliverable-row"
        onClick={
          delegated
            ? (event) => {
                if (
                  event.defaultPrevented ||
                  !event.currentTarget.contains(event.target as Node) ||
                  (event.target as Element).closest('button, a, [role="menuitem"]') ||
                  window.getSelection()?.toString()
                )
                  return
                trigger.current?.focus()
                if (resources) open()
              }
            : undefined
        }
      >
        <span className="deliverable-tile" data-type={type} aria-hidden="true">
          <Icon name={TYPE_ICON[type]} />
        </span>
        <div className="deliverable-text">
          <h4 className="deliverable-name" title={file.name}>
            {delegated ? (
              <Button
                ref={trigger}
                appearance="ghost"
                className="deliverable-target"
                data-testid="deliverable-target"
                disabled={!resources}
                aria-label={`${t('ui.file.inWorkbench')}: ${file.name}`}
                onClick={() => {
                  if (!window.getSelection()?.toString()) open()
                }}
              >
                {file.name}
              </Button>
            ) : (
              file.name
            )}
          </h4>
          <p className="deliverable-meta">{subtitle}</p>
        </div>
        <div className="deliverable-actions">
          {!delegated && (
            <Button
              ref={trigger}
              size="small"
              className="deliverable-open"
              data-testid="deliverable-open"
              disabled={!resources || (!opened && busy)}
              aria-busy={preview?.status === 'loading'}
              onClick={open}
              aria-expanded={opened}
              aria-controls={opened ? previewId : undefined}
            >
              {t(opened ? 'ui.file.closeShort' : 'ui.file.openShort')}
            </Button>
          )}
          <Menu
            label={t('ui.file.openWith')}
            trigger={
              <IconButton
                name="chevron-down"
                className="deliverable-open-with"
                data-testid="deliverable-open-with"
                label={t('ui.file.openWith')}
                disabled={!resources}
              />
            }
            items={[
              {
                id: 'workbench',
                label: t('ui.file.previewInWorkbench'),
                testId: 'deliverable-in-workbench',
                disabled: !resources || busy,
                onSelect: () => (delegated ? open() : void show()),
              },
              {
                id: 'download',
                label: t('ui.file.download'),
                testId: 'deliverable-download',
                disabled: !resources || busy,
                onSelect: () => void download(),
              },
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
        <div
          id={previewId}
          className="deliverable-preview"
          data-testid="deliverable-preview"
          data-kind={kind ?? 'none'}
        >
          {preview.status === 'failed' ? (
            <p className="deliverable-note" role="alert">
              {t('ui.file.failed')}
            </p>
          ) : unavailable ? (
            <p className="deliverable-note" role="status">
              {t(size > PREVIEW_LIMIT ? 'ui.file.large' : 'ui.file.unsupported')}
            </p>
          ) : !resource ? (
            <p className="deliverable-note" role="status">
              {t('ui.file.loading')}
            </p>
          ) : resource.kind === 'html' ? (
            <HtmlPreviewFrame key={file.artifact.sha256} html={resource.content ?? ''} title={file.name} />
          ) : (
            <DocumentPreview
              // Source files are shown as source: a scrollable monospace block, never running text.
              kind={resource.kind === 'text' ? 'code' : resource.kind}
              title={file.name}
              {...(resource.content === undefined ? {} : { content: resource.content })}
              {...(resource.url === undefined ? {} : { resourceUrl: resource.url })}
              t={hostT}
            />
          )}
        </div>
      )}
    </section>
  )
}
