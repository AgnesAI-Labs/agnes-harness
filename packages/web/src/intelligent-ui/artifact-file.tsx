import type { UiArtifactFileData } from '@agnes/protocol/gen/intelligent-ui'
import type { ClientDocumentKind, ClientDocumentResource, ClientResourceService } from '@agnes/web-client'
import { Button, INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog, useUiText } from '@agnes/web-ui'
import { DocumentPreview } from '@agnes/web-ui/conversation'
import { useEffect, useMemo, useState } from 'react'

function previewKind(mime: string): ClientDocumentKind | undefined {
  if (mime === 'text/html') return 'html'
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return undefined
}

/** Display uses the same session-authorized resource loaders as the workspace document dock. */
export function ArtifactFile({
  file,
  laneId,
  resources,
}: {
  file: UiArtifactFileData
  laneId: string
  resources: ClientResourceService | undefined
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
  async function open() {
    if (opened) {
      setOpened(false)
      return
    }
    setOpened(true)
    if (!resources || !kind || size > 1024 * 1024 || preview) return
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
  return (
    <section data-testid="deliverable-file">
      <h4>{file.name}</h4>
      <p>{file.description}</p>
      <p>
        {file.name.includes('.') ? file.name.split('.').at(-1)?.toUpperCase() : file.artifact.mime} ·{' '}
        {formattedSize}
      </p>
      <Button
        data-testid="deliverable-open"
        disabled={!resources || busy}
        onClick={() => void open()}
        aria-expanded={opened}
      >
        {t(opened ? 'ui.file.close' : 'ui.file.open')}
      </Button>
      <Button
        data-testid="deliverable-download"
        disabled={!resources || busy}
        onClick={() => void download()}
      >
        {t('ui.file.download')}
      </Button>
      {failed && <p role="alert">{t('ui.file.failed')}</p>}
      {opened && (!kind || size > 1024 * 1024) && (
        <p role="status">{t(size > 1024 * 1024 ? 'ui.file.large' : 'ui.file.unsupported')}</p>
      )}
      {opened && preview && (
        <DocumentPreview
          kind={preview.kind}
          title={file.name}
          {...(preview.content === undefined ? {} : { content: preview.content })}
          {...(preview.url === undefined ? {} : { resourceUrl: preview.url })}
          t={hostT}
        />
      )}
    </section>
  )
}
