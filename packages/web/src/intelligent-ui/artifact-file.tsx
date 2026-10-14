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
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
const fileKey = (laneId: string, file: UiArtifactFileData) => `${laneId}:${file.name}:${file.artifact.sha256}`

/** Display uses the same session-authorized resource loaders as the workspace document dock. */
export function ArtifactFile({
  file,
  laneId,
  resources,
  placement = 'workbench',
  onShowInWorkbench,
  earlier,
  source,
}: {
  file: UiArtifactFileData
  laneId: string
  resources: ClientResourceService | undefined
  placement?: 'inline' | 'workbench'
  /** Present when this file also has a workbench copy: previews open there, not in the conversation. */
  onShowInWorkbench?: (() => void) | undefined
  /** An older copy of a name presented again with other content: its card says which and how. */
  earlier?: EarlierVersion | undefined
  /** Who presented the newest copy, shown when its same-name history came from someone else too. */
  source?: string | undefined
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
      {...(earlier ? { 'data-version': 'earlier' } : {})}
    >
      <div className="deliverable-row">
        <span className="deliverable-tile" data-type={type} aria-hidden="true">
          <Icon name={TYPE_ICON[type]} />
        </span>
        <div className="deliverable-text">
          <h4 className="deliverable-name" title={file.name}>
            {file.name}
          </h4>
          <p className="deliverable-meta">{subtitle}</p>
        </div>
        <div className="deliverable-actions">
          <Button
            size="small"
            className="deliverable-open"
            data-testid="deliverable-open"
            disabled={!resources || busy}
            onClick={open}
            {...(delegated ? {} : { 'aria-expanded': opened })}
          >
            {t('ui.file.openShort')}
          </Button>
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
        <div className="deliverable-preview" data-testid="deliverable-preview" data-kind={kind ?? 'none'}>
          <div className="deliverable-preview-bar">
            <span className="deliverable-preview-name">{file.name}</span>
            {versionName && (
              <span className="deliverable-preview-version" data-testid="deliverable-preview-version">
                {t('ui.file.earlierLabel', { version: versionTime ?? versionName })}
              </span>
            )}
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
            <HtmlPreviewFrame key={file.artifact.sha256} html={preview.content ?? ''} title={file.name} />
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
