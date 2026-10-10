import type { ArtifactRef } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import { Button } from '@agnes/web-ui'
import { useEffect, useMemo, useState } from 'react'

/** Fetch only a ledger artifact through the existing session-authorized resource service. */
export function ArtifactDownload({
  artifact,
  laneId,
  sessionId,
  context,
}: {
  artifact: ArtifactRef
  laneId: string
  sessionId: string
  context: UiExtensionContext
}) {
  const { resources, t } = context
  const owner = useMemo(
    () => ({ resources, sessionId, artifact, active: true, release: () => {} }),
    [resources, sessionId, artifact],
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(
    () => () => {
      owner.active = false
      owner.release()
    },
    [owner],
  )
  async function download() {
    if (!resources || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const file = await resources.files.load({ laneId, artifact })
      if (!owner.active) {
        file.release()
        return
      }
      const link = document.createElement('a')
      link.href = file.url
      const extension =
        artifact.mime === 'application/pdf' ? 'pdf' : artifact.mime.startsWith('text/') ? 'txt' : 'bin'
      link.download = `${artifact.sha256.slice(0, 12)}.${extension}`
      link.click()
      // Allow Chromium to begin reading the blob; unmount still releases it immediately.
      const timer = setTimeout(() => file.release(), 1000)
      owner.release = () => {
        clearTimeout(timer)
        file.release()
      }
    } catch {
      if (owner.active) setFailed(true)
    } finally {
      if (owner.active) setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="small"
        data-testid="artifact-download"
        disabled={!resources || busy}
        loading={busy}
        onClick={() => void download()}
      >
        {t('facts.download')}
      </Button>
      {failed && <p role="alert">{t('facts.downloadFailed')}</p>}
    </>
  )
}
